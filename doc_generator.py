"""文档生成核心逻辑 - 大纲生成 + 逐章内容生成"""
import json
import logging
import re
from typing import AsyncGenerator

from llm_client import LLMClient, OUTLINE_SYSTEM_PROMPT, OUTLINE_USER_TEMPLATE, CHAPTER_SYSTEM_PROMPT, CHAPTER_USER_TEMPLATE, GLOBAL_CONTEXT_SYSTEM_PROMPT, GLOBAL_CONTEXT_USER_TEMPLATE

logger = logging.getLogger(__name__)


class DocGenerator:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    async def generate_outline(self, topic: str, doc_type: str, audience: str, requirements: str, depth: int = 3) -> dict:
        """生成文档大纲"""
        user_prompt = OUTLINE_USER_TEMPLATE.format(
            topic=topic,
            doc_type=doc_type,
            audience=audience,
            requirements=requirements,
            depth=depth,
            depth_example=self._build_depth_example(depth),
            depth_id_example=".".join(["1"] * depth),
        )
        raw = await self.llm.generate(OUTLINE_SYSTEM_PROMPT, user_prompt, temperature=0.7)
        outline = self._parse_outline_json(raw)

        before_depth = self._get_actual_depth(outline["chapters"])
        logger.info("大纲生成完成，LLM返回的实际深度=%d，用户要求深度=%d", before_depth, depth)

        # 后端强制校验+截断超层级节点
        outline["chapters"] = self._enforce_max_depth(outline["chapters"], depth)
        self._renumber_chapters(outline["chapters"])

        after_depth = self._get_actual_depth(outline["chapters"])
        logger.info("截断后实际深度=%d", after_depth)
        return outline

    async def generate_global_context(
        self,
        topic: str,
        doc_type: str,
        audience: str,
        requirements: str,
        outline_toc: str,
    ) -> str:
        """生成全局上下文摘要"""
        user_prompt = GLOBAL_CONTEXT_USER_TEMPLATE.format(
            topic=topic,
            doc_type=doc_type,
            audience=audience,
            requirements=requirements,
            outline_toc=outline_toc,
        )
        return await self.llm.generate(GLOBAL_CONTEXT_SYSTEM_PROMPT, user_prompt, temperature=0.5)

    async def stream_chapter(
        self,
        doc_title: str,
        chapter_id: str,
        chapter_title: str,
        chapter_description: str,
        global_context: str,
        outline_toc: str,
        prev_chapter_summary: str = "",
        min_words: int = 800,
    ) -> AsyncGenerator[str, None]:
        """流式生成单章内容"""
        if prev_chapter_summary:
            prev_section = f"【前一章摘要】\n{prev_chapter_summary}"
        else:
            prev_section = "（这是文档的第一个章节，无前序章节）"

        user_prompt = CHAPTER_USER_TEMPLATE.format(
            doc_title=doc_title,
            global_context=global_context,
            chapter_id=chapter_id,
            chapter_title=chapter_title,
            chapter_description=chapter_description,
            outline_toc=outline_toc,
            prev_chapter_section=prev_section,
            min_words=min_words,
        )
        async for token in self.llm.stream_generate(CHAPTER_SYSTEM_PROMPT, user_prompt, temperature=0.7):
            yield token

    def _parse_outline_json(self, raw: str) -> dict:
        """从LLM输出中提取JSON大纲"""
        # 尝试提取 ```json ... ``` 代码块
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
        if m:
            text = m.group(1).strip()
        else:
            text = raw.strip()

        # 去除可能存在的 BOM 和前后空白
        text = text.lstrip("\ufeff").strip()

        try:
            outline = json.loads(text)
        except json.JSONDecodeError:
            # 尝试修复常见问题：尾逗号
            text = re.sub(r",\s*([}\]])", r"\1", text)
            try:
                outline = json.loads(text)
            except json.JSONDecodeError as e:
                logger.error("大纲JSON解析失败: %s\n原始内容: %s", e, raw[:500])
                raise ValueError(f"大纲JSON解析失败: {e}")

        self._clean_titles(outline)
        self._validate_outline(outline)
        return outline

    @staticmethod
    def _clean_titles(outline: dict):
        """清除章节 title 中的序号前缀（序号由 id 字段表示）"""
        # 匹配开头的数字编号模式，如 "1 概述"、"1.1 项目背景"、"1.1.1 行业现状"
        # 也匹配中文编号如 "第一章 概述"
        title_pattern = re.compile(
            r"^(?:"
            r"\d+(?:\.\d+)*\s+"       # 1, 1.1, 1.1.1 等数字编号
            r"|第[一二三四五六七八九十百千零\d]+[章节篇部分]\s+"  # 第一章、第二节 等
            r")"
        )

        def clean(chapters: list):
            for ch in chapters:
                t = ch.get("title", "")
                cleaned = title_pattern.sub("", t)
                if cleaned != t:
                    logger.debug("清除title序号: %r -> %r", t, cleaned)
                    ch["title"] = cleaned
                children = ch.get("children", [])
                if children:
                    clean(children)

        clean(outline.get("chapters", []))

    @staticmethod
    def _validate_outline(outline: dict):
        """校验大纲结构"""
        if "title" not in outline:
            raise ValueError("大纲缺少 title 字段")
        if "chapters" not in outline:
            raise ValueError("大纲缺少 chapters 字段")

        def check_chapters(chapters: list, prefix: str = ""):
            for ch in chapters:
                if "id" not in ch or "title" not in ch:
                    raise ValueError(f"章节缺少 id 或 title: {ch}")
                children = ch.get("children", [])
                if not isinstance(children, list):
                    raise ValueError(f"章节 {ch['id']} 的 children 不是数组")
                check_chapters(children, ch["id"])

        check_chapters(outline["chapters"])

    @staticmethod
    def _enforce_max_depth(chapters: list, max_depth: int) -> list:
        """强制截断超过 max_depth 层级的节点，并将被截断的子节点信息合并到父节点 description 中。

        max_depth 含义：
        - max_depth=1：当前节点是最后一层，children 必须为空
        - max_depth=2：当前节点下面还能有1层子节点
        - 以此类推

        截断策略：将被截断子节点的标题和描述合并到父节点的 description 中，
        确保信息不丢失，后续生成内容时仍能参考这些子主题。
        """
        if max_depth <= 1:
            # 已到达允许的最深层，将子节点信息合并到当前节点的 description
            for ch in chapters:
                children = ch.get("children", [])
                if children:
                    logger.debug("截断节点 %s 的 %d 个子节点", ch.get("id", "?"), len(children))
                    merged = DocGenerator._merge_children_into_desc(ch, children)
                    ch["description"] = merged
                    ch["children"] = []
            return chapters

        for ch in chapters:
            children = ch.get("children", [])
            if children:
                # 递归处理子节点，剩余可延伸层数减1
                DocGenerator._enforce_max_depth(children, max_depth - 1)
        return chapters

    @staticmethod
    def _merge_children_into_desc(parent: dict, children: list) -> str:
        """将被截断的子节点信息合并到父节点的 description 中。

        递归收集所有后代节点的标题和描述，以结构化文本追加到父节点 description。
        """
        parts = [parent.get("description", "").rstrip()]

        def collect_descendants(nodes: list, indent: int = 0):
            for node in nodes:
                prefix = "  " * indent + "- "
                title = node.get("title", "")
                desc = node.get("description", "")
                if desc:
                    parts.append(f"{prefix}{title}：{desc}")
                else:
                    parts.append(f"{prefix}{title}")
                sub = node.get("children", [])
                if sub:
                    collect_descendants(sub, indent + 1)

        if children:
            parts.append("\n\n包括")
            collect_descendants(children)

        return "\n".join(parts)

    @staticmethod
    def _get_actual_depth(chapters: list) -> int:
        """计算大纲树的实际最大深度"""
        if not chapters:
            return 0
        max_d = 1
        for ch in chapters:
            children = ch.get("children", [])
            if children:
                d = 1 + DocGenerator._get_actual_depth(children)
                if d > max_d:
                    max_d = d
        return max_d

    @staticmethod
    def _build_depth_example(depth: int) -> str:
        """为每种 depth 生成具体的输出结构示例。
        关键：示例中每个分支都必须达到目标深度，不能有浅层分支。
        """
        if depth == 1:
            return """depth=1 的正确示例（只有1层，所有children为空）：
1  概述
2  需求分析
3  方案设计
4  实施计划

JSON结构：
{"id":"1","title":"概述","description":"...","children":[]}
{"id":"2","title":"需求分析","description":"...","children":[]}

注意：id格式为"1","2","3"，绝不允许出现"1.1"这样的二级id！"""

        if depth == 2:
            return """depth=2 的正确示例（恰好2层，第2层children为空）：
1  概述
  1.1  项目背景
  1.2  建设目标
2  需求分析
  2.1  功能需求
  2.2  非功能需求

JSON结构：
{"id":"1","title":"概述","description":"...","children":[
  {"id":"1.1","title":"项目背景","description":"...","children":[]},
  {"id":"1.2","title":"建设目标","description":"...","children":[]}
]}

注意：id最深到"1.1"格式，绝不允许出现"1.1.1"这样的三级id！"""

        if depth == 3:
            return """depth=3 的正确示例（恰好3层，第3层children为空）：
1  概述
  1.1  项目背景
    1.1.1  行业现状
    1.1.2  痛点分析
  1.2  建设目标
    1.2.1  近期目标
    1.2.2  远期目标
2  需求分析
  2.1  功能需求
    2.1.1  核心功能
    2.1.2  扩展功能
  2.2  非功能需求
    2.2.1  性能要求
    2.2.2  安全要求

注意：每个分支都必须到达第3层！不允许出现"1.2"下没有子节点的情况。
id最深到"1.1.1"格式，绝不允许出现"1.1.1.1"这样的四级id！"""

        if depth == 4:
            return """depth=4 的正确示例（恰好4层，第4层children为空）：
1  概述
  1.1  项目背景
    1.1.1  行业现状
      1.1.1.1  政策环境
      1.1.1.2  技术趋势
    1.1.2  痛点分析
      1.1.2.1  业务痛点
      1.1.2.2  技术痛点
  1.2  建设目标
    1.2.1  总体目标
      1.2.1.1  定性目标
      1.2.1.2  定量目标
    1.2.2  阶段目标
      1.2.2.1  近期目标
      1.2.2.2  远期目标

注意：每个分支都必须到达第4层！不允许任何分支停留在第3层。
id最深到"1.1.1.1"格式，绝不允许出现"1.1.1.1.1"这样的五级id！"""

        # depth >= 5
        id_example = ".".join(["1"] * depth)
        forbid_id = ".".join(["1"] * (depth + 1))
        return f"""depth={depth} 的正确示例（恰好{depth}层，第{depth}层children为空）：
id最深到"{id_example}"格式，绝不允许出现"{forbid_id}"这样的{depth+1}级id！
第{depth}层（叶子层）节点的children必须为空数组[]。
**每个分支都必须到达第{depth}层**，不允许任何分支在浅层就停下！"""

    @staticmethod
    def _renumber_chapters(chapters: list, prefix: str = ""):
        """重新编号所有章节的id，确保连续正确"""
        for i, ch in enumerate(chapters):
            num = f"{prefix}.{i + 1}" if prefix else str(i + 1)
            ch["id"] = num
            children = ch.get("children", [])
            if children:
                DocGenerator._renumber_chapters(children, num)

    @staticmethod
    def flatten_chapters(outline: dict) -> list[dict]:
        """将大纲树展平为有序列表，便于逐章生成"""
        result = []

        def walk(chapters: list, depth: int = 0):
            for ch in chapters:
                result.append({
                    "id": ch["id"],
                    "title": ch["title"],
                    "description": ch.get("description", ""),
                    "depth": depth,
                })
                walk(ch.get("children", []), depth + 1)

        walk(outline.get("chapters", []))
        return result

    @staticmethod
    def build_prev_chapter_summary(finished_chapters: dict, flat_chapters: list[dict], current_id: str) -> str:
        """获取当前章节的前一个已生成章节的摘要，保证上下文连贯。

        边界处理：
        - 第一章无前序章节，返回空字符串
        - 前一章未生成内容，返回空字符串
        """
        # 找到当前章节在 flat 列表中的位置
        current_idx = None
        for i, ch in enumerate(flat_chapters):
            if ch["id"] == current_id:
                current_idx = i
                break

        if current_idx is None or current_idx == 0:
            return ""

        # 取前一章的内容
        prev_ch = flat_chapters[current_idx - 1]
        prev_content = finished_chapters.get(prev_ch["id"], "")
        if not prev_content:
            return ""

        # 截取摘要（前300字）
        summary = prev_content[:300].replace("\n", " ")
        if len(prev_content) > 300:
            summary += "..."
        return f"[{prev_ch['id']} {prev_ch['title']}] 摘要：{summary}"

    @staticmethod
    def build_outline_tree(outline: dict) -> str:
        """生成大纲目录的文本表示（仅含id和title，不含description）"""
        lines = []

        def walk(chapters, depth=0):
            for ch in chapters:
                indent = "  " * depth
                lines.append(f"{indent}{ch['id']} {ch['title']}")
                walk(ch.get("children", []), depth + 1)

        walk(outline.get("chapters", []))
        return "\n".join(lines)

    @staticmethod
    def build_outline_toc(outline: dict, current_id: str) -> str:
        """生成大纲目录的文本表示，标注当前章节"""
        lines = []

        def walk(chapters, depth=0):
            for ch in chapters:
                indent = "  " * depth
                marker = " ★ 当前章节" if ch["id"] == current_id else ""
                lines.append(f"{indent}{ch['id']} {ch['title']}{marker}")
                walk(ch.get("children", []), depth + 1)

        walk(outline.get("chapters", []))
        return "\n".join(lines)
