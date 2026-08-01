import io
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.table import Table
from docx.text.paragraph import Paragraph


def import_docx(content: bytes) -> str:
    """Convert DOCX file bytes to HTML for the editor."""
    doc = Document(io.BytesIO(content))
    html_parts = []
    current_list_type = None  # 'ul' or 'ol'
    list_items = []

    def _flush_list():
        nonlocal current_list_type, list_items
        if list_items:
            html_parts.append(f"<{current_list_type}>{''.join(list_items)}</{current_list_type}>")
            list_items = []
            current_list_type = None

    # Iterate body elements in document order (paragraphs and tables interleaved)
    for element in doc.element.body:
        tag_name = element.tag.split('}')[-1] if '}' in element.tag else element.tag
        if tag_name == 'tbl':
            _flush_list()
            table = Table(element, doc)
            html_parts.append(_table_to_html(table))
        elif tag_name == 'p':
            para = Paragraph(element, doc)
            list_type = _get_list_type(para)
            if list_type:
                if list_type != current_list_type:
                    _flush_list()
                    current_list_type = list_type
                list_items.append(f"<li>{_get_runs_html(para)}</li>")
            else:
                _flush_list()
                html_parts.append(_paragraph_to_html(para))

    _flush_list()
    return "\n".join(html_parts)


def _get_list_type(para: Paragraph) -> str | None:
    """Return 'ul' or 'ol' if paragraph is a list item, else None."""
    style_name = (para.style.name or "").lower()
    if "list bullet" in style_name:
        return "ul"
    elif "list number" in style_name:
        return "ol"
    return None


def _get_runs_html(para: Paragraph) -> str:
    """Get the formatted inline HTML for a paragraph's runs."""
    runs_html = []
    for run in para.runs:
        text = _escape_html(run.text)
        if not text:
            continue
        if run.bold:
            text = f"<strong>{text}</strong>"
        if run.italic:
            text = f"<em>{text}</em>"
        if run.underline:
            text = f"<u>{text}</u>"
        if run.font.strike:
            text = f"<s>{text}</s>"
        if run.font.superscript:
            text = f"<sup>{text}</sup>"
        if run.font.subscript:
            text = f"<sub>{text}</sub>"

        run_styles = []
        if run.font.name:
            run_styles.append(f"font-family: {run.font.name}")
        if run.font.size:
            run_styles.append(f"font-size: {run.font.size.pt}pt")
        if run.font.color and run.font.color.rgb:
            run_styles.append(f"color: #{run.font.color.rgb}")

        if run_styles:
            text = f'<span style="{"; ".join(run_styles)}">{text}</span>'

        if run.font.highlight_color:
            text = f"<mark>{text}</mark>"

        runs_html.append(text)

    return "".join(runs_html) if runs_html else _escape_html(para.text)


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
            cells_html.append(f"<{tag}>{text}</{tag}>")
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
