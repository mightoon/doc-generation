"""文档导出 - 将生成的内容导出为DOCX"""
import io
import re
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE


def export_to_docx(outline: dict, chapters_content: dict) -> bytes:
    """将大纲+章节内容导出为DOCX文件，返回字节流"""
    doc = Document()

    _setup_styles(doc)

    # 封面标题
    title_para = doc.add_paragraph()
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_para.space_before = Pt(72)
    run = title_para.add_run(outline.get("title", "未命名文档"))
    run.font.size = Pt(28)
    run.font.bold = True
    run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)

    doc.add_page_break()

    # 目录页（简易文本目录）
    toc_heading = doc.add_heading("目  录", level=1)
    toc_heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    flat = _flatten_outline(outline)
    for ch in flat:
        indent_level = ch["id"].count(".")
        prefix = "    " * indent_level
        p = doc.add_paragraph(f"{prefix}{ch['id']}  {ch['title']}")
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.space_before = Pt(2)
        for run in p.runs:
            run.font.size = Pt(11 - indent_level)

    doc.add_page_break()

    # 正文章节
    for ch in flat:
        content = chapters_content.get(ch["id"], "")
        _add_chapter(doc, ch, content)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.getvalue()


def _setup_styles(doc: Document):
    """设置文档样式"""
    style = doc.styles["Normal"]
    style.font.name = "宋体"
    style.font.size = Pt(12)
    style.paragraph_format.line_spacing = 1.5
    style.paragraph_format.space_after = Pt(6)

    for i in range(1, 5):
        hs = doc.styles[f"Heading {i}"]
        hs.font.name = "黑体"
        hs.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
        sizes = {1: 22, 2: 16, 3: 14, 4: 12}
        hs.font.size = Pt(sizes.get(i, 12))


def _flatten_outline(outline: dict) -> list[dict]:
    """展平大纲为有序列表"""
    result = []
    def walk(chapters: list):
        for ch in chapters:
            result.append({"id": ch["id"], "title": ch["title"]})
            walk(ch.get("children", []))
    walk(outline.get("chapters", []))
    return result


def _add_chapter(doc: Document, ch: dict, content: str):
    """添加一个章节到文档，将Markdown转为DOCX"""
    level = min(ch["id"].count(".") + 1, 4)
    doc.add_heading(f"{ch['id']}  {ch['title']}", level=level)

    if not content.strip():
        doc.add_paragraph("（本章内容待补充）")
        return

    # 简单Markdown → DOCX 转换
    lines = content.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()

        # 空行
        if not line:
            i += 1
            continue

        # Markdown 标题
        heading_match = re.match(r"^(#{2,4})\s+(.+)$", line)
        if heading_match:
            h_level = min(len(heading_match.group(1)), 4)
            doc.add_heading(heading_match.group(2), level=h_level)
            i += 1
            continue

        # 表格行（简单跳过，后续可增强）
        if line.startswith("|") and "|" in line[1:]:
            # 收集连续表格行
            table_lines = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                stripped = lines[i].strip()
                if not re.match(r"^\|[\s\-:|]+\|$", stripped):
                    table_lines.append(stripped)
                i += 1
            if table_lines:
                _add_table(doc, table_lines)
            continue

        # 无序列表
        if re.match(r"^[\-\*]\s+", line):
            text = re.sub(r"^[\-\*]\s+", "", line)
            p = doc.add_paragraph(text, style="List Bullet")
            i += 1
            continue

        # 有序列表
        num_match = re.match(r"^(\d+)[.、]\s+(.+)$", line)
        if num_match:
            text = num_match.group(2)
            p = doc.add_paragraph(text, style="List Number")
            i += 1
            continue

        # 普通段落
        para_text = line
        # 合并连续的普通行
        while i + 1 < len(lines):
            next_line = lines[i + 1].rstrip()
            if not next_line or next_line.startswith("#") or next_line.startswith("|") or re.match(r"^[\-\*]\s+", next_line) or re.match(r"^\d+[.、]\s+", next_line):
                break
            i += 1
            para_text += " " + next_line

        # 处理粗体标记
        p = doc.add_paragraph()
        _add_rich_text(p, para_text)
        i += 1


def _add_table(doc: Document, table_lines: list[str]):
    """简单表格渲染"""
    rows_data = []
    for line in table_lines:
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows_data.append(cells)

    if not rows_data:
        return

    ncols = max(len(r) for r in rows_data)
    # 补齐列数
    for r in rows_data:
        while len(r) < ncols:
            r.append("")

    table = doc.add_table(rows=len(rows_data), cols=ncols, style="Table Grid")
    for ri, row_data in enumerate(rows_data):
        for ci, cell_text in enumerate(row_data):
            cell = table.rows[ri].cells[ci]
            cell.text = cell_text
            for p in cell.paragraphs:
                for run in p.runs:
                    run.font.size = Pt(10)


def _add_rich_text(para, text: str):
    """处理粗体等简单格式"""
    # 按粗体标记 **...** 分割
    parts = re.split(r"(\*\*[^*]+\*\*)", text)
    for part in parts:
        bold_match = re.match(r"^\*\*(.+)\*\*$", part)
        if bold_match:
            run = para.add_run(bold_match.group(1))
            run.bold = True
        elif part:
            para.add_run(part)
