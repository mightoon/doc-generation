"""文件解析器 - 支持 PDF, DOCX, DOC, TXT, MD 格式"""
import io
import logging

logger = logging.getLogger(__name__)


def parse_file(content_bytes: bytes, ext: str, filename: str = "") -> str:
    """
    根据文件扩展名解析文件内容，返回纯文本。
    - .pdf:  使用 pdfplumber
    - .docx: 使用 python-docx
    - .doc:  尝试用 python-docx 解析（旧格式可能失败）
    - .txt/.md: 直接解码
    """
    if ext == ".pdf":
        return _parse_pdf(content_bytes)
    elif ext == ".docx":
        return _parse_docx(content_bytes)
    elif ext == ".doc":
        # .doc 是旧格式，python-docx 不能直接解析
        # 尝试用 docx 解析，如果失败则提示
        try:
            return _parse_docx(content_bytes)
        except Exception:
            return f"[提示] .doc 旧格式文件 '{filename}' 无法直接解析，建议转换为 .docx 格式后重新上传。"
    elif ext in (".txt", ".md"):
        return _parse_text(content_bytes)
    else:
        raise ValueError(f"不支持的文件格式: {ext}")


def _parse_pdf(content_bytes: bytes) -> str:
    """解析PDF文件"""
    import pdfplumber

    text_parts = []
    with pdfplumber.open(io.BytesIO(content_bytes)) as pdf:
        for i, page in enumerate(pdf.pages):
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)

    full_text = "\n\n".join(text_parts)
    if not full_text.strip():
        logger.warning("PDF文件可能为扫描件，未能提取到文本内容")
    return full_text


def _parse_docx(content_bytes: bytes) -> str:
    """解析DOCX文件"""
    from docx import Document

    doc = Document(io.BytesIO(content_bytes))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def _parse_text(content_bytes: bytes) -> str:
    """解析TXT/MD文件，自动检测编码"""
    # 尝试常见编码
    for encoding in ("utf-8", "gbk", "gb2312", "gb18030", "latin-1"):
        try:
            return content_bytes.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    # 最后兜底
    return content_bytes.decode("utf-8", errors="replace")
