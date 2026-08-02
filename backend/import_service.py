import io
import base64
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def import_docx(content: bytes) -> str:
    """Convert DOCX file bytes to HTML for the editor."""
    doc = Document(io.BytesIO(content))
    html_parts = []
    # Collect list items as (type, level, html) tuples
    list_buffer: list[tuple[str, int, str]] = []

    def _flush_list():
        nonlocal list_buffer
        if not list_buffer:
            return
        html_parts.append(_build_nested_list(list_buffer))
        list_buffer = []

    # Iterate body elements in document order (paragraphs and tables interleaved)
    for element in doc.element.body:
        tag_name = element.tag.split('}')[-1] if '}' in element.tag else element.tag
        if tag_name == 'tbl':
            _flush_list()
            table = Table(element, doc)
            html_parts.append(_table_to_html(table))
        elif tag_name == 'p':
            para = Paragraph(element, doc)
            list_info = _get_list_info(para)
            if list_info:
                list_type, level = list_info
                # Flush if the base-level list type changes (e.g. ul -> ol)
                if list_buffer and level == 0 and list_buffer[0][0] != list_type:
                    _flush_list()
                list_buffer.append((list_type, level, _get_runs_html(para)))
            else:
                _flush_list()
                html_parts.append(_paragraph_to_html(para))

    _flush_list()
    return "\n".join(html_parts)


def _build_nested_list(items: list[tuple[str, int, str]]) -> str:
    """Build nested HTML list from (type, level, content) tuples."""
    if not items:
        return ""

    # Simple case: all same level
    if all(lvl == 0 for _, lvl, _ in items):
        list_type = items[0][0]
        inner = "".join(f"<li><p>{content}</p></li>" for _, _, content in items)
        return f"<{list_type}>{inner}</{list_type}>"

    # Nested case: build recursive structure
    result = []
    _build_list_recursive(items, 0, 0, result)
    return "".join(result)


def _build_list_recursive(items: list[tuple[str, int, str]], start: int, base_level: int, output: list[str]):
    """Recursively build nested list HTML."""
    if start >= len(items):
        return

    list_type = items[start][0]
    output.append(f"<{list_type}>")
    i = start
    while i < len(items):
        item_type, item_level, content = items[i]
        if item_level < base_level:
            break
        if item_level == base_level:
            # Check if next items are nested under this one
            nested_start = i + 1
            if nested_start < len(items) and items[nested_start][1] > base_level:
                output.append(f"<li><p>{content}</p>")
                _build_list_recursive(items, nested_start, items[nested_start][1], output)
                # Skip past nested items
                while i + 1 < len(items) and items[i + 1][1] > base_level:
                    i += 1
                output.append("</li>")
            else:
                output.append(f"<li><p>{content}</p></li>")
            i += 1
        else:
            # Item at deeper level without a parent at base_level — treat as base
            output.append(f"<li><p>{content}</p></li>")
            i += 1
    output.append(f"</{list_type}>")


def _get_list_info(para: Paragraph) -> tuple[str, int] | None:
    """Return (list_type, indent_level) if paragraph is a list item, else None."""
    style_name = (para.style.name or "").lower()

    # Style-based detection with level from style name suffix
    if "list bullet" in style_name:
        level = _extract_style_level(style_name, "list bullet")
        return ("ul", level)
    elif "list number" in style_name:
        level = _extract_style_level(style_name, "list number")
        return ("ol", level)

    # Check for w:numPr in paragraph properties (how Word natively creates lists)
    pPr = para._element.find(qn("w:pPr"))
    if pPr is not None:
        numPr = pPr.find(qn("w:numPr"))
        if numPr is not None:
            numId_el = numPr.find(qn("w:numId"))
            # numId 0 means "no numbering" (used to remove list formatting)
            if numId_el is not None and numId_el.get(qn("w:val")) != "0":
                ilvl_el = numPr.find(qn("w:ilvl"))
                level = int(ilvl_el.get(qn("w:val"))) if ilvl_el is not None else 0
                list_type = _resolve_numpr_list_type(para, numPr)
                return (list_type, level)
    return None


def _extract_style_level(style_name: str, prefix: str) -> int:
    """Extract indent level from style name like 'List Bullet 2' -> 1 (0-indexed)."""
    suffix = style_name.replace(prefix, "").strip()
    if suffix.isdigit():
        return max(0, int(suffix) - 1)
    return 0


def _resolve_numpr_list_type(para: Paragraph, numPr) -> str:
    """Determine bullet vs numbered from the numbering definitions."""
    try:
        numId_el = numPr.find(qn("w:numId"))
        numId = int(numId_el.get(qn("w:val")))
        ilvl_el = numPr.find(qn("w:ilvl"))
        ilvl = int(ilvl_el.get(qn("w:val"))) if ilvl_el is not None else 0

        # Access the numbering part from the document
        numbering_part = para.part.numbering_part
        if numbering_part is None:
            return "ul"

        numbering_elem = numbering_part._element
        # Find the w:num element matching numId
        for num_el in numbering_elem.findall(qn("w:num")):
            if num_el.get(qn("w:numId")) == str(numId):
                abstract_num_id_el = num_el.find(qn("w:abstractNumId"))
                if abstract_num_id_el is None:
                    return "ul"
                abstract_num_id = abstract_num_id_el.get(qn("w:val"))

                # Find the abstract numbering definition
                for abstract_el in numbering_elem.findall(qn("w:abstractNum")):
                    if abstract_el.get(qn("w:abstractNumId")) == abstract_num_id:
                        # Find the level definition
                        for lvl_el in abstract_el.findall(qn("w:lvl")):
                            if lvl_el.get(qn("w:ilvl")) == str(ilvl):
                                numFmt_el = lvl_el.find(qn("w:numFmt"))
                                if numFmt_el is not None:
                                    fmt = numFmt_el.get(qn("w:val"))
                                    if fmt == "bullet":
                                        return "ul"
                                    else:
                                        return "ol"
                        # Level not found, check first level as fallback
                        first_lvl = abstract_el.find(qn("w:lvl"))
                        if first_lvl is not None:
                            numFmt_el = first_lvl.find(qn("w:numFmt"))
                            if numFmt_el is not None:
                                fmt = numFmt_el.get(qn("w:val"))
                                if fmt == "bullet":
                                    return "ul"
                                else:
                                    return "ol"
                break
    except (AttributeError, ValueError, TypeError):
        pass
    # Default to bullet list if we can't determine the type
    return "ul"


def _get_runs_html(para: Paragraph) -> str:
    """Get the formatted inline HTML for a paragraph's runs, including images and hyperlinks.
    Single-pass through XML children to preserve correct ordering."""
    runs_html = []

    for child in para._element:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        # Handle hyperlinks (w:hyperlink wraps one or more w:r elements)
        if tag == 'hyperlink':
            href = _get_hyperlink_url(child, para.part)
            link_text = _get_hyperlink_text(child)
            if link_text:
                if href:
                    runs_html.append(f'<a href="{_escape_html(href)}">{_escape_html(link_text)}</a>')
                else:
                    runs_html.append(_escape_html(link_text))
            continue

        if tag != 'r':
            continue

        # Check for image first
        img_html = _extract_image_from_run(child, para.part)
        if img_html:
            runs_html.append(img_html)
            continue

        # Process as text run
        text_parts = []
        for t_elem in child.findall(f'.//{qn("w:t")}'):
            if t_elem.text:
                text_parts.append(t_elem.text)
        text = _escape_html("".join(text_parts))
        if not text:
            continue

        # Check formatting properties
        rpr = child.find(qn("w:rPr"))
        bold = rpr is not None and rpr.find(qn("w:b")) is not None
        italic = rpr is not None and rpr.find(qn("w:i")) is not None
        underline = rpr is not None and rpr.find(qn("w:u")) is not None
        strike = rpr is not None and rpr.find(qn("w:strike")) is not None
        sup = rpr is not None and rpr.find(qn("w:vertAlign")) is not None and rpr.find(qn("w:vertAlign")).get(qn("w:val")) == "superscript"
        sub = rpr is not None and rpr.find(qn("w:vertAlign")) is not None and rpr.find(qn("w:vertAlign")).get(qn("w:val")) == "subscript"

        if bold:
            text = f"<strong>{text}</strong>"
        if italic:
            text = f"<em>{text}</em>"
        if underline:
            text = f"<u>{text}</u>"
        if strike:
            text = f"<s>{text}</s>"
        if sup:
            text = f"<sup>{text}</sup>"
        if sub:
            text = f"<sub>{text}</sub>"

        # Inline styles
        run_styles = []
        if rpr is not None:
            rfont = rpr.find(qn("w:rFonts"))
            if rfont is not None:
                fname = rfont.get(qn("w:ascii")) or rfont.get(qn("w:hAnsi"))
                if fname:
                    run_styles.append(f"font-family: {fname}")
            sz = rpr.find(qn("w:sz"))
            if sz is not None:
                # w:sz is in half-points
                half_pt = sz.get(qn("w:val"))
                if half_pt:
                    run_styles.append(f"font-size: {int(half_pt) / 2}pt")
            color_el = rpr.find(qn("w:color"))
            if color_el is not None:
                color_val = color_el.get(qn("w:val"))
                if color_val and color_val != "auto":
                    run_styles.append(f"color: #{color_val}")

        if run_styles:
            text = f'<span style="{"; ".join(run_styles)}">{text}</span>'

        # Highlight
        if rpr is not None and rpr.find(qn("w:highlight")) is not None:
            text = f"<mark>{text}</mark>"

        runs_html.append(text)

    return "".join(runs_html) if runs_html else _escape_html(para.text)


def _extract_image_from_run(run_element, part) -> str | None:
    """Extract an image from a run element and return an <img> tag with base64 src."""
    # Look for drawing elements (w:drawing) or inline pictures (w:pict)
    drawings = run_element.findall(f'.//{qn("w:drawing")}')
    if not drawings:
        # Also check for old-style w:pict (VML)
        return None

    for drawing in drawings:
        # Find the blip element which references the image
        blips = drawing.findall(f'.//{qn("a:blip")}')
        for blip in blips:
            embed_id = blip.get(qn("r:embed"))
            if not embed_id:
                continue
            try:
                image_part = part.related_parts[embed_id]
                image_bytes = image_part.blob
                content_type = image_part.content_type
                b64 = base64.b64encode(image_bytes).decode('ascii')
                data_url = f"data:{content_type};base64,{b64}"
                return f'<img src="{data_url}" />'
            except (KeyError, AttributeError):
                continue
    return None


def _get_hyperlink_url(hyperlink_element, part) -> str | None:
    """Get the URL from a w:hyperlink element."""
    r_id = hyperlink_element.get(qn("r:id"))
    if not r_id:
        return None
    try:
        return part.rels[r_id].target_ref
    except (KeyError, AttributeError):
        return None


def _get_hyperlink_text(hyperlink_element) -> str:
    """Get the combined text content of a w:hyperlink element."""
    text_parts = []
    for t_elem in hyperlink_element.findall(f'.//{qn("w:t")}'):
        if t_elem.text:
            text_parts.append(t_elem.text)
    return "".join(text_parts)


def _paragraph_to_html(para: Paragraph) -> str:
    """Convert a single paragraph to HTML."""
    if not para.text.strip() and not para.runs:
        return "<p><br></p>"

    # Determine tag based on style
    style_name = (para.style.name or "").lower()
    if style_name.startswith("heading 1") or style_name == "title":
        tag = "h1"
    elif style_name.startswith("heading 2"):
        tag = "h2"
    elif style_name.startswith("heading 3"):
        tag = "h3"
    elif style_name.startswith("heading 4"):
        tag = "h3"  # Map h4+ to h3 (editor supports 1-3)
    elif style_name.startswith("heading 5") or style_name.startswith("heading 6"):
        tag = "h3"
    elif "quote" in style_name:
        # Wrap in blockquote
        content_html = _get_runs_html(para)
        return f"<blockquote><p>{content_html}</p></blockquote>"
    else:
        tag = "p"

    # Build inline styles
    inline_styles = []
    if para.alignment == WD_ALIGN_PARAGRAPH.CENTER:
        inline_styles.append("text-align: center")
    elif para.alignment == WD_ALIGN_PARAGRAPH.RIGHT:
        inline_styles.append("text-align: right")
    elif para.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY:
        inline_styles.append("text-align: justify")

    style_attr = f' style="{"; ".join(inline_styles)}"' if inline_styles else ""

    content_html = _get_runs_html(para)
    return f"<{tag}{style_attr}>{content_html}</{tag}>"


def _table_to_html(table) -> str:
    """Convert a docx table to HTML."""
    rows_html = []
    for i, row in enumerate(table.rows):
        cells_html = []
        tag = "th" if i == 0 else "td"
        for cell in row.cells:
            text = _escape_html(cell.text)
            # Check for cell shading (background color)
            tc_pr = cell._tc.tcPr
            bg_color = None
            if tc_pr is not None:
                shd = tc_pr.find(qn("w:shd"))
                if shd is not None:
                    fill = shd.get(qn("w:fill"))
                    if fill and fill.lower() != "auto" and fill != "FFFFFF":
                        bg_color = fill
            attrs = ""
            if bg_color:
                attrs = f' style="background-color: #{bg_color}" data-background-color="#{bg_color}"'
            cells_html.append(f"<{tag}{attrs}>{text}</{tag}>")
        rows_html.append(f"<tr>{''.join(cells_html)}</tr>")
    return f"<table>{''.join(rows_html)}</table>"


def _escape_html(text: str) -> str:
    """Escape HTML special characters."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
