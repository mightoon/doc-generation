"""文档生成智能体 - 主应用"""
import asyncio
import base64
import io
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, APIRouter, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, RedirectResponse
from pydantic import BaseModel

from llm_client import LLMClient, detect_model_type
from doc_generator import DocGenerator
from doc_exporter import export_to_docx
from file_parser import parse_file

# ── 配置 ─────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# 应用路径前缀
ROOT_PATH = "/doc-generation"

# 持久化配置文件路径
MODELS_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models_config.json")

# LLM配置 - 优先从持久化文件读取，否则从环境变量
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "sk-your-key-here")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")

# ── 已验证模型列表 ──────────────────────────────────────────────
verified_models: list[dict] = []  # [{"base_url", "api_key", "model", "display_name", "model_type"}]


# ── 模型配置持久化 ──────────────────────────────────────────────

def _b64_encode(text: str) -> str:
    """将字符串编码为 base64"""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _b64_decode(text: str) -> str:
    """从 base64 解码字符串，若解码失败则原样返回（兼容旧明文格式）"""
    try:
        decoded = base64.b64decode(text).decode("utf-8")
        if decoded.isprintable():
            return decoded
    except Exception:
        pass
    return text


def _load_models_config():
    """启动时从JSON文件加载模型配置"""
    global LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, verified_models
    if not os.path.exists(MODELS_CONFIG_FILE):
        return
    try:
        with open(MODELS_CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        raw_list = cfg.get("verified_models", [])
        verified_models = []
        for m in raw_list:
            model_id = m.get("model", "")
            verified_models.append({
                "base_url": m.get("base_url", ""),
                "api_key": _b64_decode(m.get("api_key", "")),
                "model": model_id,
                "display_name": m.get("display_name", "") or model_id,
                "model_type": m.get("model_type", ""),
            })
        current = cfg.get("current_model")
        if current:
            LLM_BASE_URL = current.get("base_url", LLM_BASE_URL)
            LLM_API_KEY = _b64_decode(current.get("api_key", LLM_API_KEY))
            LLM_MODEL = current.get("model", LLM_MODEL)
        logger.info("已从 %s 加载模型配置（%d 个已验证模型，当前: %s）", MODELS_CONFIG_FILE, len(verified_models), LLM_MODEL)
    except Exception as e:
        logger.warning("加载模型配置失败: %s", e)


def _save_models_config():
    """将模型配置保存到JSON文件，api_key 使用 base64 编码"""
    try:
        encoded_models = []
        for m in verified_models:
            encoded_models.append({
                "base_url": m["base_url"],
                "api_key": _b64_encode(m["api_key"]),
                "model": m["model"],
                "display_name": m.get("display_name", ""),
                "model_type": m.get("model_type", ""),
            })
        cfg = {
            "verified_models": encoded_models,
            "current_model": {
                "base_url": LLM_BASE_URL,
                "api_key": _b64_encode(LLM_API_KEY),
                "model": LLM_MODEL,
            },
        }
        with open(MODELS_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        logger.info("模型配置已保存到 %s", MODELS_CONFIG_FILE)
    except Exception as e:
        logger.warning("保存模型配置失败: %s", e)

# ── 内存存储 ──────────────────────────────────────────────────
sessions: dict[str, dict] = {}


def _new_session() -> dict:
    return {
        "outline": None,
        "chapters_content": {},
        "generating": False,
        "current_chapter": None,
        "global_context": "",
        "outline_tree": "",
        "topic": "",
        "doc_type": "",
        "audience": "",
        "requirements": "",
    }


def _get_llm_client() -> LLMClient:
    return LLMClient(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)


# ── 应用 ──────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_models_config()
    logger.info("文档生成智能体启动, LLM模型: %s, BaseURL: %s", LLM_MODEL, LLM_BASE_URL)
    yield

app = FastAPI(title="文档生成智能体", lifespan=lifespan)


# ── 根路径重定向 ──────────────────────────────────────────────
@app.get("/")
async def redirect_to_app():
    return RedirectResponse(url=ROOT_PATH + "/")


# ── API 路由 ──────────────────────────────────────────────────

router = APIRouter()

class ConfigRequest(BaseModel):
    base_url: str
    api_key: str = ""
    model: str
    display_name: str = ""

class OutlineRequest(BaseModel):
    session_id: str
    topic: str
    doc_type: str = "技术文档"
    audience: str = "技术人员"
    requirements: str
    depth: int = 3

class ChapterGenerateRequest(BaseModel):
    session_id: str
    chapter_id: str
    min_words: int = 800


# ── 模型管理 ──────────────────────────────────────────────────

@router.post("/api/config")
async def update_config(req: ConfigRequest):
    """设置当前使用的模型"""
    global LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
    LLM_BASE_URL = req.base_url
    LLM_API_KEY = req.api_key
    LLM_MODEL = req.model
    _save_models_config()
    return {"status": "ok", "model": LLM_MODEL, "model_type": detect_model_type(LLM_MODEL)}


@router.get("/api/config")
async def get_config():
    """获取当前LLM配置"""
    # 查找当前模型的 display_name
    current_display_name = ""
    for m in verified_models:
        if m["model"] == LLM_MODEL and m["base_url"] == LLM_BASE_URL:
            current_display_name = m.get("display_name", "")
            break
    return {
        "base_url": LLM_BASE_URL,
        "api_key": LLM_API_KEY[:8] + "..." if len(LLM_API_KEY) > 8 else ("***" if LLM_API_KEY else ""),
        "model": LLM_MODEL,
        "display_name": current_display_name,
        "model_type": detect_model_type(LLM_MODEL),
    }


@router.post("/api/verify-model")
async def verify_model(req: ConfigRequest):
    """验证模型是否可用，验证成功后自动设为当前模型"""
    global LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, verified_models
    # 检查显示名称是否重复
    display_name = req.display_name.strip() or req.model
    for m in verified_models:
        if m.get("display_name") == display_name:
            raise HTTPException(400, f"显示名称 \"{display_name}\" 已被使用，请换一个")
    llm = LLMClient(base_url=req.base_url, api_key=req.api_key, model=req.model)
    result = await llm.verify()
    if result["ok"]:
        for i, m in enumerate(verified_models):
            if m.get("display_name") == display_name:
                verified_models[i] = {
                    "base_url": req.base_url,
                    "api_key": req.api_key,
                    "model": req.model,
                    "display_name": display_name,
                    "model_type": result["model_type"],
                }
                break
        else:
            verified_models.append({
                "base_url": req.base_url,
                "api_key": req.api_key,
                "model": req.model,
                "display_name": display_name,
                "model_type": result["model_type"],
            })
        LLM_BASE_URL = req.base_url
        LLM_API_KEY = req.api_key
        LLM_MODEL = req.model
        _save_models_config()
        logger.info("模型验证通过并已切换: %s (%s)", req.model, result["model_type"])
    return result


@router.get("/api/models")
async def list_verified_models():
    """获取已验证模型列表"""
    safe_list = []
    for m in verified_models:
        safe_list.append({
            "base_url": m["base_url"],
            "api_key": m["api_key"][:8] + "..." if len(m["api_key"]) > 8 else ("***" if m["api_key"] else ""),
            "model": m["model"],
            "display_name": m.get("display_name", ""),
            "model_type": m["model_type"],
        })
    return safe_list


@router.post("/api/select-model")
async def select_model(idx: int):
    """从已验证模型中选择一个作为当前模型"""
    global LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
    if idx < 0 or idx >= len(verified_models):
        raise HTTPException(400, "无效的模型索引")
    m = verified_models[idx]
    LLM_BASE_URL = m["base_url"]
    LLM_API_KEY = m["api_key"]
    LLM_MODEL = m["model"]
    _save_models_config()
    return {"status": "ok", "model": LLM_MODEL, "display_name": m.get("display_name", ""), "model_type": m["model_type"]}


@router.delete("/api/delete-model")
async def delete_model(idx: int):
    """删除已验证模型"""
    global LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
    if idx < 0 or idx >= len(verified_models):
        raise HTTPException(400, "无效的模型索引")
    removed = verified_models.pop(idx)
    # 如果删除的是当前使用的模型，切换到列表中第一个（若有）
    if removed["model"] == LLM_MODEL and removed["base_url"] == LLM_BASE_URL:
        if verified_models:
            m = verified_models[0]
            LLM_BASE_URL = m["base_url"]
            LLM_API_KEY = m["api_key"]
            LLM_MODEL = m["model"]
        else:
            LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
            LLM_API_KEY = os.getenv("LLM_API_KEY", "sk-your-key-here")
            LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o")
    _save_models_config()
    return {"status": "ok", "current_model": LLM_MODEL}


# ── 会话管理 ──────────────────────────────────────────────────

@router.post("/api/session")
async def create_session():
    """创建新会话"""
    sid = uuid.uuid4().hex[:12]
    sessions[sid] = _new_session()
    return {"session_id": sid}


@router.get("/api/session/{session_id}")
async def get_session(session_id: str):
    """获取会话状态"""
    if session_id not in sessions:
        raise HTTPException(404, "会话不存在")
    s = sessions[session_id]
    return {
        "session_id": session_id,
        "has_outline": s["outline"] is not None,
        "outline": s["outline"],
        "chapters_content": s["chapters_content"],
        "generating": s["generating"],
        "current_chapter": s["current_chapter"],
    }


# ── 文件上传解析 ──────────────────────────────────────────────────

@router.post("/api/upload-file")
async def upload_file(file: UploadFile = File(...)):
    """上传文件并解析文本内容"""
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()

    allowed_exts = {".pdf", ".doc", ".docx", ".txt", ".md"}
    if ext not in allowed_exts:
        raise HTTPException(400, f"不支持的文件格式: {ext}，支持: {', '.join(allowed_exts)}")

    try:
        content_bytes = await file.read()
        text = parse_file(content_bytes, ext, filename)
    except Exception as e:
        logger.exception("文件解析失败: %s", filename)
        raise HTTPException(400, f"文件解析失败: {e}")

    return {
        "filename": filename,
        "text": text,
        "length": len(text),
    }


# ── 文档生成 ──────────────────────────────────────────────────

@router.post("/api/generate-outline")
async def generate_outline(req: OutlineRequest):
    """生成文档大纲"""
    if req.session_id not in sessions:
        raise HTTPException(404, "会话不存在")

    llm = _get_llm_client()
    gen = DocGenerator(llm)
    try:
        outline = await gen.generate_outline(
            topic=req.topic,
            doc_type=req.doc_type,
            audience=req.audience,
            requirements=req.requirements,
            depth=req.depth,
        )
    except Exception as e:
        logger.exception("大纲生成失败")
        raise HTTPException(500, f"大纲生成失败: {e}")

    sessions[req.session_id]["outline"] = outline
    sessions[req.session_id]["chapters_content"] = {}
    sessions[req.session_id]["topic"] = req.topic
    sessions[req.session_id]["doc_type"] = req.doc_type
    sessions[req.session_id]["audience"] = req.audience
    sessions[req.session_id]["requirements"] = req.requirements

    actual = DocGenerator._get_actual_depth(outline.get("chapters", []))
    if actual > req.depth:
        logger.error("!!! 大纲深度校验失败：实际深度=%d，要求深度=%d，强制再次截断 !!!", actual, req.depth)
        outline["chapters"] = DocGenerator._enforce_max_depth(outline["chapters"], req.depth)
        DocGenerator._renumber_chapters(outline["chapters"])
    return outline


@router.post("/api/update-outline")
async def update_outline(session_id: str, outline: dict):
    """更新大纲（用户编辑后保存）"""
    if session_id not in sessions:
        raise HTTPException(404, "会话不存在")
    DocGenerator._validate_outline(outline)
    sessions[session_id]["outline"] = outline
    return {"status": "ok"}


@router.post("/api/prepare-generation")
async def prepare_generation(session_id: str):
    """确认大纲后，生成全局上下文摘要和大纲树，为后续章节生成做准备"""
    if session_id not in sessions:
        raise HTTPException(404, "会话不存在")

    s = sessions[session_id]
    outline = s["outline"]
    if not outline:
        raise HTTPException(400, "请先生成大纲")

    outline_tree = DocGenerator.build_outline_tree(outline)
    s["outline_tree"] = outline_tree

    llm = _get_llm_client()
    gen = DocGenerator(llm)
    try:
        global_context = await gen.generate_global_context(
            topic=s.get("topic", outline.get("title", "")),
            doc_type=s.get("doc_type", "技术文档"),
            audience=s.get("audience", "技术人员"),
            requirements=s.get("requirements", ""),
            outline_toc=outline_tree,
        )
    except Exception as e:
        logger.exception("全局上下文生成失败")
        raise HTTPException(500, f"全局上下文生成失败: {e}")

    s["global_context"] = global_context
    logger.info("全局上下文生成完成，字数=%d", len(global_context))

    return {
        "status": "ok",
        "global_context": global_context,
        "outline_tree": outline_tree,
    }


@router.websocket("/ws/generate-chapter")
async def ws_generate_chapter(ws: WebSocket):
    """WebSocket接口：流式生成单章内容"""
    await ws.accept()
    session_id = None
    try:
        data = await ws.receive_json()
        session_id = data["session_id"]
        chapter_id = data["chapter_id"]
        min_words = data.get("min_words", 800)
        pre_delay = data.get("pre_delay", 0)  # 生成前延迟（秒），用于多章节间间隔

        if session_id not in sessions:
            await ws.send_json({"type": "error", "message": "会话不存在"})
            await ws.close()
            return

        s = sessions[session_id]
        outline = s["outline"]
        if not outline:
            await ws.send_json({"type": "error", "message": "请先生成大纲"})
            await ws.close()
            return

        flat = DocGenerator.flatten_chapters(outline)
        chapter_info = None
        for ch in flat:
            if ch["id"] == chapter_id:
                chapter_info = ch
                break

        if not chapter_info:
            await ws.send_json({"type": "error", "message": f"未找到章节 {chapter_id}"})
            await ws.close()
            return

        global_context = s.get("global_context", "")
        if not global_context:
            global_context = f"文档主题：{outline.get('title', '')}"

        outline_toc = s.get("outline_tree", "")
        if not outline_toc:
            outline_toc = DocGenerator.build_outline_tree(outline)

        outline_toc_marked = DocGenerator.build_outline_toc(outline, chapter_id)

        prev_chapter_summary = DocGenerator.build_prev_chapter_summary(
            s["chapters_content"], flat, chapter_id
        )

        s["generating"] = True
        s["current_chapter"] = chapter_id
        llm = _get_llm_client()
        gen = DocGenerator(llm)

        # 多章节间延迟：让 LLM 服务端释放资源
        if pre_delay > 0:
            logger.info("章节 %s 生成前延迟 %.1f 秒", chapter_id, pre_delay)
            await ws.send_json({"type": "delay", "seconds": pre_delay})
            await asyncio.sleep(pre_delay)

        full_content = []
        async for token in gen.stream_chapter(
            doc_title=outline["title"],
            chapter_id=chapter_info["id"],
            chapter_title=chapter_info["title"],
            chapter_description=chapter_info["description"],
            global_context=global_context,
            outline_toc=outline_toc_marked,
            prev_chapter_summary=prev_chapter_summary,
            min_words=min_words,
        ):
            full_content.append(token)
            await ws.send_json({"type": "token", "content": token})

        content = "".join(full_content)
        s["chapters_content"][chapter_id] = content
        s["generating"] = False
        s["current_chapter"] = None

        await ws.send_json({"type": "done", "chapter_id": chapter_id, "length": len(content)})
        await ws.close()

    except WebSocketDisconnect:
        logger.info("WebSocket断开")
        if session_id and session_id in sessions:
            sessions[session_id]["generating"] = False
            sessions[session_id]["current_chapter"] = None
    except Exception as e:
        logger.exception("章节生成异常")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
        if session_id and session_id in sessions:
            sessions[session_id]["generating"] = False
            sessions[session_id]["current_chapter"] = None


@router.get("/api/export-docx/{session_id}")
async def export_docx(session_id: str, mode: str = "", chapters: str = "", filename: str = ""):
    """导出文档为DOCX"""
    if session_id not in sessions:
        raise HTTPException(404, "会话不存在")

    s = sessions[session_id]
    if not s["outline"]:
        raise HTTPException(400, "没有可导出的文档")

    outline = s["outline"]
    chapters_content = s["chapters_content"]

    if mode == "full":
        try:
            doc_bytes = export_to_docx(outline, chapters_content)
        except Exception as e:
            logger.exception("导出DOCX失败")
            raise HTTPException(500, f"导出失败: {e}")
    elif mode == "partial" or chapters:
        chapter_ids = [cid.strip() for cid in chapters.split(",") if cid.strip()]
        if not chapter_ids:
            raise HTTPException(400, "未指定要导出的目录")

        top_chapters = outline.get("chapters", [])
        selected_top = [ch for ch in top_chapters if ch.get("id") in chapter_ids]
        if not selected_top:
            raise HTTPException(400, "未找到指定的一级目录")

        sub_outline = {"title": outline.get("title", "文档"), "chapters": selected_top}
        flat_ids = set()
        def collect_ids(ch_list):
            for ch in ch_list:
                flat_ids.add(ch["id"])
                collect_ids(ch.get("children", []))
        collect_ids(selected_top)
        sub_content = {cid: chapters_content.get(cid, "") for cid in flat_ids}

        try:
            doc_bytes = export_to_docx(sub_outline, sub_content)
        except Exception as e:
            logger.exception("导出DOCX失败")
            raise HTTPException(500, f"导出失败: {e}")
    else:
        try:
            doc_bytes = export_to_docx(outline, chapters_content)
        except Exception as e:
            logger.exception("导出DOCX失败")
            raise HTTPException(500, f"导出失败: {e}")

    fname = filename or outline.get("title", "文档")
    fname = "".join(c for c in fname if c.isalnum() or c in "._- ")
    fname_utf8 = quote(fname + ".docx")

    return StreamingResponse(
        io.BytesIO(doc_bytes),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename=\"document.docx\"; filename*=UTF-8''{fname_utf8}",
        },
    )


# ── 注册路由 ──────────────────────────────────────────────────
app.include_router(router, prefix=ROOT_PATH)

# ── 静态文件（放在 include_router 之后，确保 API 路由优先匹配） ──
app.mount(ROOT_PATH, StaticFiles(directory="static", html=True), name="static")


# ── 入口 ──────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=5003, reload=True)
