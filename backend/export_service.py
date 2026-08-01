import os
import re
import tempfile
import docx
from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn


def export_docx(html_content: str, filename: str = "document.docx") -> str:
    """Convert HTML content to a DOCX file with proper formatting."""
    doc = Document()

    # Set default font
    style = doc.styles['Normal']
    font = style.font
    font.name = 'Times New Roman'
    font.size = Pt(12)

    # Parse and add content
    blocks = _parse_html_sequential(html_content)

    for block in blocks:
        _add_block(doc, block)

    output_dir = os.path.join(os.path.expanduser("~"), "Documents", "DocxEditor")
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    doc.save(filepath)
    return filepath


def export_docx_to_bytes(html_content: str) -> bytes:
    """Export to bytes for download endpoint."""
    filepath = export_docx(html_content, f"_temp_{os.getpid()}.docx")
    with open(filepath, 'rb') as f:
        data = f.read()
    os.unlink(filepath)
    return data


def _parse_html_sequential(html: str) -> list:
    """Parse HTML into sequential blocks preserving document order."""
    blocks = []
    html = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', html, flags=re.DOTALL)

    # Match block-level elements in order
    pattern = r'<(h[1-6]|p|ul|ol|table|blockquote|div)([^>]*)>(.*?)</\1>'
    for match in re.finditer(pattern, html, re.DOTALL):
        tag = match.group(1)
        attrs = match.group(2)
        content = match.group(3)

        # Handle page break divs
        if tag == "div" and 'data-page-break' in attrs:
            blocks.append({"tag": "page_break", "text": "", "runs": []})
            continue

        block = {
            "tag": tag,
            "attrs": attrs,
            "runs": _parse_runs(content),
            "text": re.sub(r'<[^>]+>', '', content).strip(),
            "raw_content": content,
        }

        # Parse alignment from style
        align_match = re.search(r'text-align:\s*(left|center|right|justify)', attrs)
        if align_match:
            block["align"] = align_match.group(1)

        # Parse font family from style
        font_match = re.search(r'font-family:\s*([^;"]+)', attrs)
        if font_match:
            block["font_family"] = font_match.group(1).strip().strip("'\"")

        # Parse font size from style
        size_match = re.search(r'font-size:\s*(\d+)pt', attrs)
        if size_match:
            block["font_size"] = int(size_match.group(1))

        blocks.append(block)

    # Handle list items within ul/ol
    expanded = []
    for block in blocks:
        if block["tag"] in ("ul", "ol"):
            items = re.findall(r'<li[^>]*>(.*?)</li>', block.get("raw_content", ""), re.DOTALL)
            if not items:
                items = [block["text"]]
            for item in items:
                text = re.sub(r'<[^>]+>', '', item).strip()
                if text:
                    expanded.append({
                        "tag": "li",
                        "list_type": block["tag"],
                        "text": text,
                        "runs": [{"text": text}],
                    })
        else:
            expanded.append(block)

    if not expanded:
        text = re.sub(r'<[^>]+>', '', html).strip()
        if text:
            for line in text.split('\n'):
                line = line.strip()
                if line:
                    expanded.append({"tag": "p", "text": line, "runs": [{"text": line}]})

    return expanded


def _parse_runs(html: str) -> list:
    """Parse inline elements into runs with formatting."""
    runs = []

    # Split on inline formatting tags
    segments = re.split(r'(<(?:strong|b|em|i|u|s|del|mark|span|a|br|sup|sub)[^>]*>|</(?:strong|b|em|i|u|s|del|mark|span|a|sup|sub)>)', html)

    bold = False
    italic = False
    underline = False
    strikethrough = False
    highlight = None
    font_family = None
    font_size = None
    color = None
    superscript = False
    subscript = False

    for seg in segments:
        if not seg:
            continue
        if seg in ('<strong>', '<b>'):
            bold = True
        elif seg in ('</strong>', '</b>'):
            bold = False
        elif seg in ('<em>', '<i>'):
            italic = True
        elif seg in ('</em>', '</i>'):
            italic = False
        elif seg == '<u>':
            underline = True
        elif seg == '</u>':
            underline = False
        elif seg in ('<s>', '<del>'):
            strikethrough = True
        elif seg in ('</s>', '</del>'):
            strikethrough = False
        elif seg.startswith('<mark'):
            highlight = "#ffff00"
            style_match = re.search(r'data-color="([^"]*)"', seg)
            if style_match:
                highlight = style_match.group(1)
        elif seg == '</mark>':
            highlight = None
        elif seg.startswith('<a'):
            # Links - just continue, text will be captured
            pass
        elif seg == '</a>':
            pass
        elif seg == '<sup>':
            superscript = True
        elif seg == '</sup>':
            superscript = False
        elif seg == '<sub>':
            subscript = True
        elif seg == '</sub>':
            subscript = False
        elif seg.startswith('<span'):
            style_match = re.search(r'style="([^"]*)"', seg)
            if style_match:
                style = style_match.group(1)
                fm = re.search(r'font-family:\s*([^;"]+)', style)
                if fm:
                    font_family = fm.group(1).strip().strip("'\"")
                sm = re.search(r'font-size:\s*(\d+)pt', style)
                if sm:
                    font_size = int(sm.group(1))
                cm = re.search(r'color:\s*(#[0-9a-fA-F]{6})', style)
                if cm:
                    color = cm.group(1)
        elif seg == '</span>':
            font_family = None
            font_size = None
            color = None
        elif seg == '<br>' or seg == '<br/>':
            runs.append({"text": "\n"})
        elif not seg.startswith('<'):
            text = seg
            if not text.strip():
                continue
            run = {"text": text}
            if bold:
                run["bold"] = True
            if italic:
                run["italic"] = True
            if underline:
                run["underline"] = True
            if strikethrough:
                run["strikethrough"] = True
            if highlight:
                run["highlight"] = highlight
            if font_family:
                run["font_family"] = font_family
            if font_size:
                run["font_size"] = font_size
            if color:
                run["color"] = color
            if superscript:
                run["superscript"] = True
            if subscript:
                run["subscript"] = True
            runs.append(run)

    if not runs:
        text = re.sub(r'<[^>]+>', '', html).strip()
        if text:
            runs.append({"text": text})

    return runs


def _add_block(doc: Document, block: dict):
    """Add a block to the document."""
    tag = block["tag"]

    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        level = int(tag[1])
        p = doc.add_heading(level=level)
        p.clear()
        _add_runs_to_paragraph(p, block.get("runs", [{"text": block["text"]}]))
    elif tag == "page_break":
        p = doc.add_paragraph()
        run = p.add_run()
        run.add_break(docx.enum.text.WD_BREAK.PAGE)
        return
    elif tag == "li":
        style = 'List Bullet' if block.get("list_type") == "ul" else 'List Number'
        p = doc.add_paragraph(style=style)
        _add_runs_to_paragraph(p, block.get("runs", [{"text": block["text"]}]))
    elif tag == "blockquote":
        p = doc.add_paragraph(style='Quote')
        _add_runs_to_paragraph(p, block.get("runs", [{"text": block["text"]}]))
    elif tag == "table":
        _add_table_from_html(doc, block)
    else:
        p = doc.add_paragraph()
        _add_runs_to_paragraph(p, block.get("runs", [{"text": block["text"]}]))

        # Apply paragraph-level formatting
        if block.get("font_family"):
            for run in p.runs:
                run.font.name = block["font_family"]
        if block.get("font_size"):
            for run in p.runs:
                run.font.size = Pt(block["font_size"])

    # Apply alignment
    if tag != "table" and block.get("align"):
        align_map = {
            "center": WD_ALIGN_PARAGRAPH.CENTER,
            "right": WD_ALIGN_PARAGRAPH.RIGHT,
            "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
            "left": WD_ALIGN_PARAGRAPH.LEFT,
        }
        p.alignment = align_map.get(block["align"], WD_ALIGN_PARAGRAPH.LEFT)


def _add_runs_to_paragraph(paragraph, runs: list):
    """Add formatted runs to a paragraph."""
    for run_data in runs:
        text = run_data.get("text", "")
        if not text:
            continue
        run = paragraph.add_run(text)
        if run_data.get("bold"):
            run.bold = True
        if run_data.get("italic"):
            run.italic = True
        if run_data.get("underline"):
            run.underline = True
        if run_data.get("strikethrough"):
            run.font.strike = True
        if run_data.get("font_family"):
            run.font.name = run_data["font_family"]
        if run_data.get("font_size"):
            run.font.size = Pt(run_data["font_size"])
        if run_data.get("color"):
            hex_color = run_data["color"].lstrip("#")
            run.font.color.rgb = RGBColor(
                int(hex_color[0:2], 16),
                int(hex_color[2:4], 16),
                int(hex_color[4:6], 16),
            )
        if run_data.get("highlight"):
            # python-docx highlight uses WD_COLOR_INDEX enum
            # Map common colors to highlight indices
            from docx.enum.text import WD_COLOR_INDEX
            run.font.highlight_color = WD_COLOR_INDEX.YELLOW
        if run_data.get("superscript"):
            run.font.superscript = True
        if run_data.get("subscript"):
            run.font.subscript = True


def _add_table_from_html(doc: Document, block: dict):
    """Parse and add an HTML table to the document."""
    html = block.get("raw_content", block.get("text", ""))
    rows_data = []
    for tr_match in re.finditer(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL):
        cells = re.findall(r'<(?:td|th)[^>]*>(.*?)</(?:td|th)>', tr_match.group(1), re.DOTALL)
        cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
        if cells:
            rows_data.append(cells)

    if not rows_data:
        return

    max_cols = max(len(row) for row in rows_data)
    table = doc.add_table(rows=len(rows_data), cols=max_cols)
    table.style = 'Table Grid'

    for i, row in enumerate(rows_data):
        for j, cell_text in enumerate(row):
            if j < max_cols:
                table.cell(i, j).text = cell_text
