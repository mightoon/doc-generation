"""LLM客户端 - 支持OpenAI兼容接口，自动处理qwen3系列thinking模式"""
import asyncio
import json
import logging
import re
from typing import AsyncGenerator, Optional

from openai import AsyncOpenAI, APIConnectionError, AuthenticationError, APIError, RateLimitError

logger = logging.getLogger(__name__)


def detect_model_type(model_name: str) -> str:
    """
    检测模型类型：
    - "qwen3":  qwen3- 开头的模型（如 qwen3-30b-a3b），需要 enable_thinking=False
    - "qwen3x": qwen3后跟非'-'字符的模型（如 qwen35, qwen3.5, qwen3-72b-instruct），
                需要 chat_template_kwargs 关闭 thinking
    - "other":  其他模型，无需特殊处理

    判断逻辑：
    - qwen3- 开头 → qwen3 类型
    - qwen3 后紧跟非'-'字符 → qwen3x 类型
    """
    name = model_name.lower().strip()
    if name.startswith("qwen3-"):
        return "qwen3"
    if re.match(r"^qwen3[^-]", name):
        return "qwen3x"
    return "other"


# ── 全局单例客户端 ──────────────────────────────────────────────
_global_client: Optional[AsyncOpenAI] = None
_global_base_url: str = ""
_global_api_key: str = ""


def _get_shared_client(base_url: str, api_key: str) -> AsyncOpenAI:
    """获取全局共享的 AsyncOpenAI 客户端，避免每次请求都新建连接池"""
    global _global_client, _global_base_url, _global_api_key
    if _global_client is None or _global_base_url != base_url or _global_api_key != api_key:
        # 配置变更时重建客户端
        if _global_client is not None:
            # 旧客户端需要关闭，但不阻塞当前请求
            try:
                asyncio.get_event_loop().create_task(_global_client.close())
            except RuntimeError:
                pass
        _global_client = AsyncOpenAI(base_url=base_url, api_key=api_key)
        _global_base_url = base_url
        _global_api_key = api_key
        logger.info("AsyncOpenAI 客户端已重建: base_url=%s", base_url)
    return _global_client


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.client = _get_shared_client(base_url, api_key)
        self.model = model
        self.model_type = detect_model_type(model)

    def _build_extra_body(self) -> Optional[dict]:
        """根据模型类型构建 extra_body 参数，用于关闭 thinking 模式"""
        if self.model_type == "qwen3":
            return {"enable_thinking": False}
        elif self.model_type == "qwen3x":
            return {
                "chat_template_kwargs": {
                    "enable_thinking": False,
                    "thinking": False,
                }
            }
        return None

    async def generate(self, system_prompt: str, user_prompt: str, temperature: float = 0.7) -> str:
        """一次性生成完整回复"""
        kwargs = dict(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
        )
        extra = self._build_extra_body()
        if extra:
            kwargs["extra_body"] = extra

        response = await self.client.chat.completions.create(**kwargs)
        return response.choices[0].message.content

    async def stream_generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_retries: int = 3,
        retry_delay: float = 2.0,
    ) -> AsyncGenerator[str, None]:
        """流式生成，逐token返回，带自动重试"""
        kwargs = dict(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            stream=True,
        )
        extra = self._build_extra_body()
        if extra:
            kwargs["extra_body"] = extra

        for attempt in range(1, max_retries + 1):
            try:
                stream = await self.client.chat.completions.create(**kwargs)
                async for chunk in stream:
                    if chunk.choices and chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
                return  # 成功完成，退出重试循环
            except (APIError, APIConnectionError, RateLimitError) as e:
                logger.warning(
                    "流式生成失败（第 %d/%d 次尝试）: %s: %s",
                    attempt, max_retries, type(e).__name__, e,
                )
                if attempt < max_retries:
                    wait = retry_delay * attempt  # 递增等待
                    logger.info("等待 %.1f 秒后重试...", wait)
                    await asyncio.sleep(wait)
                else:
                    logger.error("流式生成重试 %d 次后仍失败，放弃", max_retries)
                    raise

    async def verify(self) -> dict:
        """
        验证模型是否可用。
        返回 {"ok": True/False, "message": "...", "model_type": "..."}
        """
        try:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
            )
            return {
                "ok": True,
                "message": f"模型 {self.model} ({self.model_type}) 验证通过",
                "model_type": self.model_type,
                "model": self.model,
            }
        except AuthenticationError as e:
            return {"ok": False, "message": f"认证失败: {e}", "model_type": self.model_type, "model": self.model}
        except APIConnectionError as e:
            return {"ok": False, "message": f"连接失败: {e}", "model_type": self.model_type, "model": self.model}
        except Exception as e:
            return {"ok": False, "message": f"验证失败: {type(e).__name__}: {e}", "model_type": self.model_type, "model": self.model}


# ── 提示词模板 ──────────────────────────────────────────────

OUTLINE_SYSTEM_PROMPT = """你是一位专业的文档架构师。你的任务是根据用户提供的文档需求，生成一个多级目录大纲。

核心要求：
1. 大纲必须是严格的JSON格式，不要包含任何其他文字说明
2. 每个节点包含 id, title, description 字段
3. id 格式为 "1", "1.1", "1.1.1" 这样的层级编号
4. **title 中只写章节名称，不要包含任何序号或编号**（序号由 id 字段表示，title 中不要出现"1."、"第一章"等编号前缀）
5. description 是该章节的简要内容说明（1-2句话，说明该节要写什么）
6. children 是子章节数组
6. **目录层级深度由用户指定，你必须严格遵守，不得超过**
7. 确保大纲覆盖用户需求的全部内容，不遗漏任何方面

返回格式示例：
{
  "title": "文档总标题",
  "chapters": [
    {
      "id": "1",
      "title": "概述",
      "description": "本章说明项目背景与总体目标...",
      "children": [
        {
          "id": "1.1",
          "title": "项目背景",
          "description": "说明项目发起的背景和原因",
          "children": []
        }
      ]
    }
  ]
}"""

OUTLINE_USER_TEMPLATE = """请为以下文档需求生成多级目录大纲：

文档主题：{topic}
文档类型：{doc_type}
目标读者：{audience}
详细需求：
{requirements}

【硬性约束 - 目录层级深度 = {depth} 级】
目录层级深度为 {depth} 级，这是硬性约束，绝对不允许超过。

"层级深度为N"意味着目录树从根到叶子恰好有N层，id中最多有{depth}个数字段。

{depth_example}

规则重申：
1. 目录最深恰好 {depth} 层，id格式最深到类似 "{depth_id_example}"
2. 超过 {depth} 层的节点**绝对不允许出现**
3. **所有分支必须达到 {depth} 层深度**，不允许任何分支少于 {depth} 层。如果某个主题内容较少不足以细分到 {depth} 层，请将该主题合并到上级节点，而不是在浅层就停下
4. 第 {depth} 层（叶子层）节点的 children 必须为空数组 []

请生成覆盖该主题的完整大纲，确保结构合理、逻辑清晰、层次分明。"""

CHAPTER_SYSTEM_PROMPT = """你是一位专业的技术文档撰写专家。你需要根据提供的章节信息和上下文，撰写该章节的完整内容。

要求：
1. 内容专业、准确、详实
2. 语言流畅、逻辑清晰
3. 使用Markdown格式输出
4. 内容要有足够的深度和广度，不要过于简略
5. 不要重复标题，直接开始正文内容
6. **禁止使用"本章旨在"、"本节旨在"、"本章将"等套话开头**，直接进入实质内容

【极其重要的格式要求】
- **禁止在内容中创建任何级别的标题（禁止使用 #、##、### 等 Markdown 标题语法）**
- **禁止在内容中创建子章节或子目录**
- 如果需要组织内容结构，只能使用加粗文字、列表（- 或 1. 2. 3.）、表格等非标题格式
- 所有内容必须以段落、列表、表格、加粗小节等形式呈现，绝不允许出现新的标题层级
- 大纲中已经规划好了完整的目录结构，你只需要为当前章节撰写纯内容，不需要再自己规划子目录

【关于包含子主题的章节】
- 如果章节说明中包含"子标题："字样，说明该章节下有子章节
- 这类章节的写作结构**必须**遵循以下顺序：
  1. **先总述**：先用2-3段话对该章节本身的主题进行介绍和阐述，说明该章节要讨论什么、为什么重要、涉及哪些方面。总述部分**不要使用加粗小标题**，直接以段落形式展开
  2. **再分述**：然后对"子标题："列出的每个子主题进行**简要概述**（每个1-3句话），让读者了解各子主题的核心要点
  3. **后总结**：最后用1-2段话对本章内容进行总结，点明各子主题之间的关联和整体脉络
- **绝对不能**一上来就列举子主题，必须先有对当前章节主题本身的展开叙述
- **不要对子主题展开过细**，因为每个子主题都有独立的子章节来撰写详细内容"""

GLOBAL_CONTEXT_SYSTEM_PROMPT = """你是一位专业的文档分析专家。你的任务是根据提供的文档需求和大纲信息，生成一份全局上下文摘要。

这份摘要将用于后续每个章节的内容生成，确保所有章节的内容都与文档整体主题保持一致、不偏离方向。

要求：
1. 摘要应涵盖文档的核心主题、关键要点、主要论述方向
2. 篇幅控制在300-500字
3. 语言精炼，突出重点
4. 只输出摘要内容，不要输出其他说明文字"""

GLOBAL_CONTEXT_USER_TEMPLATE = """请根据以下信息生成文档的全局上下文摘要：

文档主题：{topic}
文档类型：{doc_type}
目标读者：{audience}

用户需求：
{requirements}

文档大纲：
{outline_toc}

请生成该文档的全局上下文摘要。"""

CHAPTER_USER_TEMPLATE = """请撰写以下章节的详细内容：

文档总标题：{doc_title}

【文档全局摘要】
{global_context}

【完整文档目录结构】（★ 标注的是你当前正在撰写的章节）
{outline_toc}

【当前章节信息】
章节ID：{chapter_id}
章节标题：{chapter_title}
章节说明：{chapter_description}

{prev_chapter_section}

请撰写 "{chapter_title}" 的完整内容。

【再次强调格式要求】
- 直接撰写正文内容，不要使用任何Markdown标题语法（#、##、###等）
- 不要创建子章节或子目录，大纲中已经规划好完整的目录结构
- 如果需要分段，请使用加粗文字作为段落引导，或使用列表、表格等格式
- **禁止以"本章旨在"、"本节旨在"、"本章将"等套话开头**，直接写实质性内容
- 字数不少于{min_words}字
- 内容要专业、详实、有深度"""
