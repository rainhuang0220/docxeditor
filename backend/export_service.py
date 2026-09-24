import html as html_lib
import os
import re
import io
import base64
import docx
from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn


def export_docx(html_content: str, filename: str = "document.docx") -> str:
    """Convert HTML content to a DOCX file with proper formatting."""
    doc = Document()

    _setup_document_styles(doc)

    blocks = _parse_html_sequential(html_content)
    _assign_list_numbering(doc, blocks)

    for block in blocks:
        _add_block(doc, block)

    output_dir = os.path.join(os.path.expanduser("~"), "Documents", "DocxEditor")
    os.makedirs(output_dir, exist_ok=True)
    safe_name = os.path.basename(filename.replace("\\", "/")).replace("\x00", "").strip()
    if not safe_name or safe_name in {".", ".."}:
        safe_name = "document.docx"
    filepath = os.path.join(output_dir, safe_name)
    doc.save(filepath)
    return filepath


def export_docx_to_bytes(html_content: str, page_settings: dict | None = None) -> bytes:
    """Export to bytes for download endpoint (in-memory, no temp file)."""
    doc = Document()

    _setup_document_styles(doc)

    # Apply page settings if provided
    if page_settings:
        _apply_page_settings(doc, page_settings)

    blocks = _parse_html_sequential(html_content)
    _assign_list_numbering(doc, blocks)
    for block in blocks:
        _add_block(doc, block)

    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def _set_style_fonts(rpr, ascii_font: str, ea_font: str):
    """Point a style's rPr at explicit fonts, dropping theme font references
    (theme attrs would otherwise win over the explicit ones)."""
    from docx.oxml import OxmlElement

    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = OxmlElement('w:rFonts')
        rpr.insert(0, rfonts)
    rfonts.set(qn('w:ascii'), ascii_font)
    rfonts.set(qn('w:hAnsi'), ascii_font)
    rfonts.set(qn('w:eastAsia'), ea_font)
    for attr in ('w:asciiTheme', 'w:hAnsiTheme', 'w:eastAsiaTheme', 'w:cstheme'):
        rfonts.attrib.pop(qn(attr), None)


def _set_style_color_black(rpr):
    """Force a style's text color to black, removing theme color attributes
    (w:themeColor takes precedence over w:val if left in place)."""
    from docx.oxml import OxmlElement

    color = rpr.find(qn('w:color'))
    if color is None:
        color = OxmlElement('w:color')
        rpr.append(color)
    color.set(qn('w:val'), '000000')
    for attr in ('w:themeColor', 'w:themeShade', 'w:themeTint'):
        color.attrib.pop(qn(attr), None)


def _setup_document_styles(doc):
    """Redefine the template's built-in styles so the exported file matches
    what the editor renders.

    python-docx's default template uses Word's look, not ours:
    - Heading 1/2 are blue (accent1 theme color) -> force black.
    - Heading styles carry keepNext/keepLines, which makes WPS/Word draw a
      small (non-printing) dot before every heading -> remove them.
    - Body defaults to Calibri/single spacing -> Times New Roman, 1.5 lines,
      6pt after, matching the .ProseMirror CSS.
    """
    normal = doc.styles['Normal']
    normal.font.name = 'Times New Roman'
    normal.font.size = Pt(12)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.space_after = Pt(6)
    _set_style_fonts(normal.element.get_or_add_rPr(), 'Times New Roman', '宋体')

    # Sizes mirror the editor CSS: h1 2em / h2 1.5em / h3 1.25em of 12pt
    for name, size in (('Heading 1', 24), ('Heading 2', 18), ('Heading 3', 15)):
        try:
            st = doc.styles[name]
        except KeyError:
            continue
        st.font.name = 'Times New Roman'
        st.font.size = Pt(size)
        st.font.bold = True
        rpr = st.element.get_or_add_rPr()
        _set_style_fonts(rpr, 'Times New Roman', '宋体')
        _set_style_color_black(rpr)
        ppr = st.element.find(qn('w:pPr'))
        if ppr is not None:
            for tag in ('w:keepNext', 'w:keepLines'):
                el = ppr.find(qn(tag))
                if el is not None:
                    ppr.remove(el)
        pf = st.paragraph_format
        pf.space_before = Pt(12)
        pf.space_after = Pt(4)
        pf.line_spacing = 1.5


def _parse_dimension(value: str) -> float | None:
    """Parse a CSS dimension string (e.g. '25.4mm', '1in') to Cm."""
    if not value:
        return None
    value = value.strip()
    if value.endswith('mm'):
        return float(value[:-2]) / 10
    elif value.endswith('cm'):
        return float(value[:-2])
    elif value.endswith('in'):
        return float(value[:-2]) * 2.54
    elif value.endswith('pt'):
        return float(value[:-2]) / 72 * 2.54
    return None


def _apply_page_settings(doc, settings: dict):
    """Apply one section's page size and margins. Twips win over CSS strings."""
    from docx.shared import Twips

    section = doc.sections[0]
    if settings.get("widthTwip") and settings.get("heightTwip"):
        section.page_width = Twips(int(settings["widthTwip"]))
        section.page_height = Twips(int(settings["heightTwip"]))
        section.top_margin = Twips(int(settings.get("marginTopTwip", 1440)))
        section.bottom_margin = Twips(int(settings.get("marginBottomTwip", 1440)))
        section.left_margin = Twips(int(settings.get("marginLeftTwip", 1440)))
        section.right_margin = Twips(int(settings.get("marginRightTwip", 1440)))
        if int(settings["widthTwip"]) > int(settings["heightTwip"]):
            section.orientation = 1
        return
    width = _parse_dimension(settings.get('width', ''))
    height = _parse_dimension(settings.get('minHeight', '') or settings.get('height', ''))
    if width:
        section.page_width = Cm(width)
    if height:
        section.page_height = Cm(height)

    top = _parse_dimension(settings.get('paddingTop', '') or settings.get('marginTop', ''))
    bottom = _parse_dimension(settings.get('paddingBottom', '') or settings.get('marginBottom', ''))
    left = _parse_dimension(settings.get('paddingLeft', '') or settings.get('marginLeft', ''))
    right = _parse_dimension(settings.get('paddingRight', '') or settings.get('marginRight', ''))
    if top is not None:
        section.top_margin = Cm(top)
    if bottom is not None:
        section.bottom_margin = Cm(bottom)
    if left is not None:
        section.left_margin = Cm(left)
    if right is not None:
        section.right_margin = Cm(right)


def _add_page_number_footer(doc):
    """Add automatic page numbering to the document footer."""
    from docx.oxml import OxmlElement

    section = doc.sections[0]
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # PAGE field
    run = p.add_run()
    fldChar1 = OxmlElement('w:fldChar')
    fldChar1.set(qn('w:fldCharType'), 'begin')
    run._element.append(fldChar1)

    run2 = p.add_run()
    instrText = OxmlElement('w:instrText')
    instrText.set(qn('xml:space'), 'preserve')
    instrText.text = ' PAGE '
    run2._element.append(instrText)

    run3 = p.add_run()
    fldChar2 = OxmlElement('w:fldChar')
    fldChar2.set(qn('w:fldCharType'), 'end')
    run3._element.append(fldChar2)


def _extract_tag_content(html: str, tag: str, start: int) -> tuple[str, int] | None:
    """Extract content between opening tag (already consumed) and matching close tag.
    Returns (content, position_after_close_tag) or None."""
    depth = 1
    i = start
    open_pattern = re.compile(rf'<{tag}[\s>/]')
    close_tag = f'</{tag}>'
    while i < len(html) and depth > 0:
        # Check for close tag
        if html[i:i+len(close_tag)] == close_tag:
            depth -= 1
            if depth == 0:
                return (html[start:i], i + len(close_tag))
            i += len(close_tag)
        # Check for nested open tag
        elif open_pattern.match(html[i:]):
            depth += 1
            i += 1
        else:
            i += 1
    return None


def _parse_html_sequential(html: str) -> list:
    """Parse HTML into sequential blocks preserving document order."""
    blocks = []
    html = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', html, flags=re.DOTALL)

    # Match block-level opening tags in order, with depth-aware content extraction.
    # Longer tag names must precede shorter prefixes ('pre' before 'p',
    # 'blockquote' before 'p'), otherwise '<pre>' is parsed as tag 'p' with
    # bogus attribute 're'.
    block_tags = r'h[1-6]|blockquote|pre|table|div|img|ul|ol|hr|p'
    tag_pattern = re.compile(rf'<({block_tags})([^>]*)(/?)>', re.DOTALL)

    pos = 0
    while pos < len(html):
        m = tag_pattern.search(html, pos)
        if not m:
            break
        tag = m.group(1)
        attrs = m.group(2)
        self_closing = m.group(3) == '/'

        # Handle self-closing tags (img, br, hr)
        if self_closing or tag == "img" or tag == "hr":
            if tag == "img":
                src_match = re.search(r'src="([^"]*)"', attrs)
                if src_match:
                    blocks.append({"tag": "img", "src": src_match.group(1), "text": "", "runs": []})
            elif tag == "hr":
                blocks.append({"tag": "hr", "text": "", "runs": []})
            pos = m.end()
            continue

        # Find matching close tag with depth tracking
        content_start = m.end()
        content = _extract_tag_content(html, tag, content_start)
        if content is None:
            pos = m.end()
            continue
        content_text, end_pos = content
        pos = end_pos

        # Handle page break divs
        if tag == "div" and 'data-page-break' in attrs:
            blocks.append({"tag": "page_break", "text": "", "runs": []})
            continue

        block = {
            "tag": tag,
            "attrs": attrs,
            "runs": _parse_runs(content_text) if tag not in ("ul", "ol", "table") else [],
            "text": re.sub(r'<[^>]+>', '', content_text).strip(),
            "raw_content": content_text,
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
        size_match = re.search(r'font-size:\s*(\d+(?:\.\d+)?)pt', attrs)
        if size_match:
            block["font_size"] = float(size_match.group(1))

        blocks.append(block)

    # Handle list items within ul/ol
    expanded = []
    groups = [0]
    for block in blocks:
        if block["tag"] in ("ul", "ol"):
            groups[0] += 1
            _expand_list(
                block["tag"],
                block.get("raw_content", ""),
                expanded,
                0,
                _list_start(block.get("attrs", "")),
                _ol_type(block.get("attrs", "")),
                groups[0],
                groups,
            )
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


def _strip_nested_lists(html: str) -> str:
    """Remove nested <ul>...</ul> and <ol>...</ol> blocks using depth-aware parsing."""
    result = []
    pos = 0
    while pos < len(html):
        m = re.search(r'<(ul|ol)[\s>]', html[pos:])
        if not m:
            result.append(html[pos:])
            break
        # Add everything before the list tag
        result.append(html[pos:pos + m.start()])
        # Find the matching close tag
        tag = m.group(1)
        tag_start = pos + m.start()
        # Find the end of the opening tag
        open_end = html.find('>', tag_start)
        if open_end == -1:
            break
        content_result = _extract_tag_content(html, tag, open_end + 1)
        if content_result:
            _, end_pos = content_result
            pos = end_pos
        else:
            # Can't parse, skip this character
            result.append(html[tag_start])
            pos = tag_start + 1
    return "".join(result)


def _expand_list(list_type: str, html: str, expanded: list, level: int = 0, start: int = 1, ol_type: str | None = None, group: int = 0, groups: list | None = None):
    """Recursively expand list HTML into flat list items with indent level."""
    # Match top-level <li> elements (non-greedy, handling nested lists)
    pos = 0
    while pos < len(html):
        li_start = html.find('<li', pos)
        if li_start == -1:
            break
        # Find the opening > of <li>
        tag_end = html.find('>', li_start)
        if tag_end == -1:
            break
        # Find matching </li> accounting for nested <li> tags
        li_content_start = tag_end + 1
        depth = 1
        i = li_content_start
        while i < len(html) and depth > 0:
            if html[i:i+3] == '<li':
                depth += 1
                i += 3
            elif html[i:i+5] == '</li>':
                depth -= 1
                if depth == 0:
                    break
                i += 5
            else:
                i += 1
        li_content = html[li_content_start:i]
        pos = i + 5  # skip past </li>

        # Extract text content (strip nested lists from content)
        # Use depth-aware extraction to remove nested <ul>/<ol> blocks
        item_text_html = _strip_nested_lists(li_content)
        align_match = re.search(r'text-align:\s*(left|center|right|justify)', item_text_html)
        item_text_html = re.sub(r'</?p[^>]*>', '', item_text_html)
        text = re.sub(r'<[^>]+>', '', item_text_html)
        runs = _parse_runs(item_text_html)
        if text.strip() or runs:
            expanded.append({
                "tag": "li",
                "list_type": list_type,
                "level": level,
                "text": text.strip(),
                "runs": runs,
                "group": group,
                "start": start,
                "ol_type": ol_type,
                "align": align_match.group(1) if align_match else None,
            })

        nested_pos = 0
        box = groups if groups is not None else [group]
        while nested_pos < len(li_content):
            nested_start = re.search(r'<(ul|ol)([^>]*)>', li_content[nested_pos:])
            if not nested_start:
                break
            nested_tag = nested_start.group(1)
            nested_attrs = nested_start.group(2)
            content_begin = nested_pos + nested_start.end()
            nested_content_result = _extract_tag_content(li_content, nested_tag, content_begin)
            if nested_content_result:
                nested_inner, nested_end = nested_content_result
                if nested_tag == list_type:
                    nested_group = group
                else:
                    box[0] += 1
                    nested_group = box[0]
                _expand_list(
                    nested_tag,
                    nested_inner,
                    expanded,
                    level + 1,
                    _list_start(nested_attrs),
                    _ol_type(nested_attrs) if nested_tag == "ol" else None,
                    nested_group,
                    box,
                )
                nested_pos = nested_end
            else:
                break


def _parse_runs(html: str) -> list:
    """Parse inline elements into runs with formatting."""
    runs = []

    # Split on inline formatting tags (including img)
    segments = re.split(r'(<(?:strong|b|em|i|u|s|del|mark|span|a|br|sup|sub|img)[^>]*>|</(?:strong|b|em|i|u|s|del|mark|span|a|sup|sub)>)', html)

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
    link_href = None

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
            href_match = re.search(r'href="([^"]*)"', seg)
            if href_match:
                link_href = href_match.group(1)
        elif seg == '</a>':
            link_href = None
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
                sm = re.search(r'font-size:\s*(\d+(?:\.\d+)?)pt', style)
                if sm:
                    font_size = float(sm.group(1))
                cm = re.search(r'color:\s*(#[0-9a-fA-F]{6})', style)
                if cm:
                    color = cm.group(1)
        elif seg == '</span>':
            font_family = None
            font_size = None
            color = None
        elif seg == '<br>' or seg == '<br/>':
            runs.append({"text": "\n"})
        elif seg.startswith('<img'):
            src_match = re.search(r'src="([^"]*)"', seg)
            if src_match:
                runs.append({"image_src": src_match.group(1)})
        elif not seg.startswith('<'):
            text = html_lib.unescape(seg)
            if text == '':
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
            if link_href:
                run["link"] = link_href
            runs.append(run)

    if not runs:
        text = html_lib.unescape(re.sub(r'<[^>]+>', '', html))
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
        p = doc.add_paragraph()
        _add_runs_to_paragraph(p, block.get("runs") or [])
        if block.get("num_id"):
            _set_num_pr(p, int(block["num_id"]), int(block.get("level") or 0))
    elif tag == "blockquote":
        p = doc.add_paragraph(style='Quote')
        _add_runs_to_paragraph(p, block.get("runs", [{"text": block["text"]}]))
    elif tag == "table":
        _add_table_from_html(doc, block)
    elif tag == "img":
        _add_image_from_data_url(doc, block.get("src", ""))
    elif tag == "hr":
        # Horizontal rule as a thin bordered paragraph
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(6)
        from docx.oxml import OxmlElement
        pPr = p._element.get_or_add_pPr()
        pBdr = OxmlElement('w:pBdr')
        bottom = OxmlElement('w:bottom')
        bottom.set(qn('w:val'), 'single')
        bottom.set(qn('w:sz'), '6')
        bottom.set(qn('w:space'), '1')
        bottom.set(qn('w:color'), 'auto')
        pBdr.append(bottom)
        pPr.append(pBdr)
        return
    elif tag == "pre":
        # Code block: monospace font with shading
        code_text = re.sub(r'<[^>]+>', '', block.get("raw_content", block["text"]))
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(6)
        run = p.add_run(code_text)
        run.font.name = 'Courier New'
        run.font.size = Pt(10)
        # Add shading to simulate code block background
        from docx.oxml import OxmlElement
        rPr = run._element.get_or_add_rPr()
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear')
        shd.set(qn('w:fill'), 'F5F5F5')
        rPr.append(shd)
        return
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
        # Handle inline images
        if run_data.get("image_src"):
            src = run_data["image_src"]
            if src.startswith("data:"):
                match = re.match(r'data:image/[^;]+;base64,(.+)', src)
                if match:
                    try:
                        image_data = base64.b64decode(match.group(1), validate=True)
                    except Exception:
                        continue
                    if len(image_data) > 2 * 1024 * 1024:
                        continue
                    image_stream = io.BytesIO(image_data)
                    run = paragraph.add_run()
                    run.add_picture(image_stream)
            continue

        text = run_data.get("text", "")
        if text == "\n" and len(run_data) == 1:
            paragraph.add_run().add_break()
            continue
        if not text:
            continue

        # Handle hyperlinks
        if run_data.get("link"):
            _add_hyperlink(paragraph, text, run_data["link"], run_data)
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
    """Parse a table as nested HTML and write spans plus cell blocks."""
    from html.parser import HTMLParser

    class _Cells(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.rows = []
            self._row = None
            self._cell = None
            self._parts: list[str] = []

        def handle_starttag(self, tag, attrs):
            attr = {key.lower(): value for key, value in attrs}
            if tag == "tr" and self._cell is None:
                self._row = []
                return
            if tag in {"td", "th"} and self._row is not None and self._cell is None:
                self._cell = {
                    "header": tag == "th",
                    "colspan": _span_attr(attr.get("colspan")),
                    "rowspan": _span_attr(attr.get("rowspan")),
                    "bg": _background_attr(attr),
                }
                self._parts = []
                return
            if self._cell is not None:
                self._parts.append(self.get_starttag_text() or "")

        def handle_endtag(self, tag):
            if tag in {"td", "th"} and self._cell is not None:
                self._cell["html"] = "".join(self._parts)
                self._row.append(self._cell)
                self._cell = None
                return
            if tag == "tr" and self._row is not None and self._cell is None:
                if self._row:
                    self.rows.append(self._row)
                self._row = None
                return
            if self._cell is not None:
                self._parts.append(f"</{tag}>")

        def handle_data(self, data):
            if self._cell is not None:
                self._parts.append(data)

    parser = _Cells()
    parser.feed(block.get("raw_content", ""))
    rows = parser.rows
    if not rows:
        return
    cols = 0
    for row in rows:
        cols = max(cols, sum(cell["colspan"] for cell in row))
    if cols < 1:
        return
    table = doc.add_table(rows=len(rows), cols=cols)
    table.style = "Table Grid"
    covered = [[False for _ in range(cols)] for _ in rows]
    for r, row in enumerate(rows):
        c = 0
        header = any(cell["header"] for cell in row)
        if header:
            _mark_header_row(table.rows[r])
        for cell in row:
            while c < cols and covered[r][c]:
                c += 1
            if c >= cols:
                break
            rs = min(cell["rowspan"], len(rows) - r)
            cs = min(cell["colspan"], cols - c)
            for i in range(rs):
                for j in range(cs):
                    covered[r + i][c + j] = True
            origin = table.cell(r, c)
            if rs > 1 or cs > 1:
                origin.merge(table.cell(r + rs - 1, c + cs - 1))
            _fill_cell(doc, origin, cell.get("html") or "")
            if cell.get("bg"):
                _shade_cell(origin, cell["bg"])
            c += cs


def _add_image_from_data_url(doc: Document, src: str):
    """Add an image from a base64 data URL to the document."""
    if not src.startswith("data:"):
        return
    # Parse data URL: data:<mime>;base64,<data>
    match = re.match(r'data:image/[^;]+;base64,(.+)', src)
    if not match:
        return
    image_data = base64.b64decode(match.group(1))
    image_stream = io.BytesIO(image_data)
    # Add image with a max width of 5 inches to fit page
    p = doc.add_paragraph()
    run = p.add_run()
    run.add_picture(image_stream)


def _allowed_hyperlink(url: str) -> str | None:
    cleaned = html_lib.unescape(url).strip()
    lower = cleaned.lower()
    if lower.startswith(("https://", "http://", "mailto:")) and not any(ch in cleaned for ch in '<>"'):
        return cleaned
    return None


def _add_hyperlink(paragraph, text: str, url: str, run_data: dict):
    """Add a hyperlink to a paragraph using python-docx low-level XML."""
    from docx.oxml import OxmlElement

    safe = _allowed_hyperlink(url)
    if not safe:
        paragraph.add_run(text)
        return
    url = safe

    # Create the relationship
    part = paragraph.part
    r_id = part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)

    # Create the w:hyperlink element
    hyperlink = OxmlElement('w:hyperlink')
    hyperlink.set(qn('r:id'), r_id)

    # Create the run inside the hyperlink
    new_run = OxmlElement('w:r')
    rPr = OxmlElement('w:rPr')

    # Style as a hyperlink (blue + underline)
    color_el = OxmlElement('w:color')
    color_el.set(qn('w:val'), '0563C1')
    rPr.append(color_el)
    u_el = OxmlElement('w:u')
    u_el.set(qn('w:val'), 'single')
    rPr.append(u_el)

    # Apply additional formatting from run_data
    if run_data.get("bold"):
        rPr.append(OxmlElement('w:b'))
    if run_data.get("italic"):
        rPr.append(OxmlElement('w:i'))

    new_run.append(rPr)

    # Add the text
    t = OxmlElement('w:t')
    t.text = text
    t.set(qn('xml:space'), 'preserve')
    new_run.append(t)

    hyperlink.append(new_run)
    paragraph._element.append(hyperlink)


def _list_start(attrs: str) -> int:
    match = re.search(r'\bstart="(\d+)"', attrs or "")
    return int(match.group(1)) if match else 1


def _ol_type(attrs: str) -> str | None:
    match = re.search(r'\btype="([aAiI1])"', attrs or "")
    if not match or match.group(1) == "1":
        return None
    return match.group(1)


def _span_attr(value: str | None) -> int:
    try:
        parsed = int(value or "1")
    except ValueError:
        return 1
    return parsed if parsed > 0 else 1


def _background_attr(attrs: dict) -> str | None:
    raw = attrs.get("data-background-color") or ""
    if not raw:
        style = attrs.get("style") or ""
        match = re.search(r'background-color:\s*#?([0-9A-Fa-f]{6})', style)
        raw = match.group(1) if match else ""
    raw = raw.lstrip("#")
    return raw.upper() if re.fullmatch(r"[0-9A-Fa-f]{6}", raw) else None


def _mark_header_row(row) -> None:
    from docx.oxml import OxmlElement

    tr_pr = row._tr.get_or_add_trPr()
    tr_pr.append(OxmlElement("w:tblHeader"))


def _shade_cell(cell, color: str) -> None:
    from docx.oxml import OxmlElement

    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), color.upper())
    shading.set(qn("w:val"), "clear")
    cell._tc.get_or_add_tcPr().append(shading)


def _fill_cell(doc: Document, cell, html: str) -> None:
    blocks = _parse_html_sequential(html) if html.strip() else []
    if not blocks:
        cell.paragraphs[0].clear()
        return
    _assign_list_numbering(doc, blocks)
    first = True
    for block in blocks:
        if block["tag"] == "table":
            before = len(doc.tables)
            _add_table_from_html(doc, block)
            if len(doc.tables) > before:
                moved = doc.tables[-1]._tbl
                parent = moved.getparent()
                if parent is not None:
                    parent.remove(moved)
                cell._tc.append(moved)
            continue
        paragraph = cell.paragraphs[0] if first else cell.add_paragraph()
        if first:
            paragraph.clear()
            first = False
        if block["tag"] == "img":
            _add_image_from_data_url_run(paragraph, block.get("src", ""))
        elif block["tag"] == "page_break":
            paragraph.add_run().add_break(docx.enum.text.WD_BREAK.PAGE)
        else:
            _add_runs_to_paragraph(paragraph, block.get("runs") or [])
            if block["tag"] == "li" and block.get("num_id"):
                _set_num_pr(paragraph, int(block["num_id"]), int(block.get("level") or 0))
        if block.get("align"):
            paragraph.alignment = {
                "center": WD_ALIGN_PARAGRAPH.CENTER,
                "right": WD_ALIGN_PARAGRAPH.RIGHT,
                "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
                "left": WD_ALIGN_PARAGRAPH.LEFT,
            }.get(block["align"], WD_ALIGN_PARAGRAPH.LEFT)


def _add_image_from_data_url_run(paragraph, src: str) -> None:
    if not src.startswith("data:"):
        return
    match = re.match(r'data:image/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)', src)
    if not match:
        return
    try:
        image_data = base64.b64decode(match.group(1), validate=True)
    except Exception:
        return
    if len(image_data) > 2 * 1024 * 1024:
        return
    paragraph.add_run().add_picture(io.BytesIO(image_data))


def _set_num_pr(paragraph, num_id: int, level: int) -> None:
    from docx.oxml import OxmlElement

    p_pr = paragraph._p.get_or_add_pPr()
    for old in p_pr.findall(qn("w:numPr")):
        p_pr.remove(old)
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), str(level))
    nid = OxmlElement("w:numId")
    nid.set(qn("w:val"), str(num_id))
    num_pr.append(ilvl)
    num_pr.append(nid)
    p_pr.append(num_pr)


def _assign_list_numbering(doc: Document, blocks: list) -> None:
    groups: dict[int, list] = {}
    for block in blocks:
        if block.get("tag") == "li" and block.get("group"):
            groups.setdefault(block["group"], []).append(block)
    if not groups:
        return
    numbering = doc.part.numbering_part._element
    for items in groups.values():
        kind = "bullet" if items[0].get("list_type") == "ul" else (items[0].get("ol_type") or "decimal")
        starts: dict[int, int] = {}
        for item in items:
            starts.setdefault(int(item.get("level") or 0), int(item.get("start") or 1))
        num_id = _add_numbering_definition(numbering, kind, starts)
        for item in items:
            item["num_id"] = num_id


def _add_numbering_definition(numbering, kind: str, starts: dict[int, int]) -> int:
    from docx.oxml import OxmlElement

    formats = {
        "bullet": ("bullet", "•"),
        "decimal": ("decimal", "%1."),
        "a": ("lowerLetter", "%1."),
        "A": ("upperLetter", "%1."),
        "i": ("lowerRoman", "%1."),
        "I": ("upperRoman", "%1."),
    }
    fmt, _text = formats.get(kind, ("decimal", "%1."))
    abstract_ids = [int(el.get(qn("w:abstractNumId"))) for el in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(el.get(qn("w:numId"))) for el in numbering.findall(qn("w:num"))]
    abstract_id = max(abstract_ids or [0]) + 1
    num_id = max(num_ids or [0]) + 1
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "hybridMultilevel")
    abstract.append(multi)
    for level in range(9):
        lvl = OxmlElement("w:lvl")
        lvl.set(qn("w:ilvl"), str(level))
        start = OxmlElement("w:start")
        start.set(qn("w:val"), str(starts.get(level, 1)))
        num_fmt = OxmlElement("w:numFmt")
        num_fmt.set(qn("w:val"), fmt)
        lvl_text = OxmlElement("w:lvlText")
        lvl_text.set(qn("w:val"), "•" if fmt == "bullet" else f"%{level + 1}.")
        lvl.extend([start, num_fmt, lvl_text])
        abstract.append(lvl)
    first_num = numbering.find(qn("w:num"))
    if first_num is not None:
        first_num.addprevious(abstract)
    else:
        numbering.append(abstract)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), str(abstract_id))
    num.append(ref)
    numbering.append(num)
    return num_id
