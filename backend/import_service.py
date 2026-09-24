"""DOCX → editor HTML.

The HTML is limited to what the TipTap schema can store. Images are blocks.
One page box is returned for the first section. Headers, footers, and later
sections are reported as warnings and are not written into the HTML.
"""

from __future__ import annotations

import base64
import io
import re
import zipfile
from dataclasses import dataclass, field

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

MAX_DOCX_BYTES = 20 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_MEMBER_BYTES = 8 * 1024 * 1024
MAX_ZIP_MEMBERS = 128
MAX_IMAGE_BYTES = 2 * 1024 * 1024
_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_OL_TYPE = {
    "decimal": None,
    "decimalZero": None,
    "lowerLetter": "a",
    "upperLetter": "A",
    "lowerRoman": "i",
    "upperRoman": "I",
}


class DocxImportError(Exception):
    """The upload is not a document this importer will open."""


@dataclass
class ImportResult:
    html: str
    page_settings: dict | None
    warnings: list[str] = field(default_factory=list)


@dataclass
class _Ctx:
    warnings: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)


def import_docx(content: bytes) -> ImportResult:
    """Convert DOCX bytes to editor HTML plus the first section's page box."""
    _reject_hostile_package(content)
    try:
        doc = Document(io.BytesIO(content))
    except Exception as exc:
        raise DocxImportError("The document could not be opened.") from exc
    ctx = _Ctx()
    page_settings = _page_settings(doc, ctx)
    html_parts: list[str] = []
    list_buffer: list[tuple] = []

    def flush() -> None:
        nonlocal list_buffer
        if list_buffer:
            html_parts.append(_build_nested_list(list_buffer))
            list_buffer = []

    for element in doc.element.body:
        tag = _local(element)
        if tag == "tbl":
            flush()
            html_parts.append(_table_to_html(Table(element, doc), ctx))
        elif tag == "p":
            para = Paragraph(element, doc)
            info = _get_list_info(para, ctx)
            if info:
                if list_buffer and list_buffer[0][3] != info[2]:
                    flush()
                blocks = _paragraph_blocks(para, ctx, as_list=True)
                kind, level, num_id, start, ol_type = info
                list_buffer.append((kind, level, "".join(blocks), num_id, start, ol_type))
            else:
                flush()
                html_parts.extend(_paragraph_blocks(para, ctx, as_list=False))
    flush()
    html = "\n".join(part for part in html_parts if part)
    return ImportResult(html=html, page_settings=page_settings, warnings=ctx.warnings)


def _reject_hostile_package(content: bytes) -> None:
    if not content or len(content) > MAX_DOCX_BYTES or not content.startswith(b"PK"):
        raise DocxImportError("The document could not be opened.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise DocxImportError("The document could not be opened.") from exc
    infos = archive.infolist()
    if len(infos) > MAX_ZIP_MEMBERS:
        raise DocxImportError("The document could not be opened.")
    total = 0
    for info in infos:
        total += info.file_size
        if info.file_size > MAX_MEMBER_BYTES or total > MAX_UNCOMPRESSED_BYTES:
            raise DocxImportError("The document could not be opened.")
        if info.compress_size and info.file_size / info.compress_size > 100:
            raise DocxImportError("The document could not be opened.")


def _local(element) -> str:
    tag = element.tag
    return tag.split("}")[-1] if "}" in tag else tag


def _escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _flag(rpr, name: str) -> bool:
    if rpr is None:
        return False
    el = rpr.find(qn(f"w:{name}"))
    if el is None:
        return False
    val = (el.get(qn("w:val")) or "").lower()
    return val not in {"0", "false", "off", "none"}


def _safe_href(url: str | None, ctx: _Ctx) -> str | None:
    if not url:
        return None
    cleaned = url.strip()
    lower = cleaned.lower()
    if lower.startswith(("https://", "http://", "mailto:")) and '"' not in cleaned and "<" not in cleaned:
        return cleaned
    ctx.warn("A hyperlink was removed because its address is not http, https, or mailto.")
    return None


def _safe_font(name: str | None) -> str | None:
    if not name:
        return None
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 80:
        return None
    if any(ch in cleaned for ch in '<>"\';{}\\'):
        return None
    return cleaned


def _safe_hex(value: str | None) -> str | None:
    if not value or not re.fullmatch(r"[0-9A-Fa-f]{6}", value):
        return None
    return value.upper()


def _page_settings(doc, ctx: _Ctx) -> dict | None:
    sects = list(doc.element.body.iter(qn("w:sectPr")))
    if not sects:
        return None
    boxes = [_read_sect(sect) for sect in sects]
    present = [box for box in boxes if box is not None]
    if len(present) > 1 and any(box != present[0] for box in present[1:]):
        ctx.warn("Only the first section's page size and margins are kept.")
    for sect in sects:
        if sect.find(qn("w:headerReference")) is not None or sect.find(qn("w:footerReference")) is not None:
            ctx.warn("Headers and footers are not imported.")
            break
    return present[0] if present else None


def _read_sect(sect) -> dict | None:
    pg_sz = sect.find(qn("w:pgSz"))
    if pg_sz is None:
        return None
    width = _int_attr(pg_sz, "w:w")
    height = _int_attr(pg_sz, "w:h")
    if width is None or height is None:
        return None
    pg_mar = sect.find(qn("w:pgMar"))

    def margin(name: str) -> int:
        value = _int_attr(pg_mar, name) if pg_mar is not None else None
        return 1440 if value is None else value

    return {
        "widthTwip": width,
        "heightTwip": height,
        "marginTopTwip": margin("w:top"),
        "marginRightTwip": margin("w:right"),
        "marginBottomTwip": margin("w:bottom"),
        "marginLeftTwip": margin("w:left"),
    }


def _int_attr(element, name: str) -> int | None:
    if element is None:
        return None
    raw = element.get(qn(name))
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _paragraph_blocks(para: Paragraph, ctx: _Ctx, *, as_list: bool) -> list[str]:
    segments = _inline_segments(para._element, para.part, ctx)
    if not segments:
        return [] if as_list else ["<p></p>"]
    blocks: list[str] = []
    text_buf: list[str] = []

    def flush_text() -> None:
        if not text_buf:
            return
        inner = "".join(text_buf)
        text_buf.clear()
        if as_list:
            blocks.append(f"<p{_align_attr(para)}>{inner}</p>")
        else:
            blocks.append(_wrap_block(para, inner, ctx))

    for kind, html in segments:
        if kind == "text":
            text_buf.append(html)
        else:
            flush_text()
            blocks.append(html if kind == "img" else '<div data-page-break></div>')
    flush_text()
    if as_list and blocks and not blocks[0].startswith("<p"):
        blocks.insert(0, "<p></p>")
    return blocks


def _wrap_block(para: Paragraph, inner: str, ctx: _Ctx) -> str:
    style_name = (para.style.name or "").lower()
    if style_name.startswith("heading 1") or style_name == "title":
        tag = "h1"
    elif style_name.startswith("heading 2"):
        tag = "h2"
    elif style_name.startswith("heading 3"):
        tag = "h3"
    elif style_name.startswith("heading"):
        ctx.warn("Headings below H3 are kept as H3.")
        tag = "h3"
    elif "quote" in style_name:
        return f"<blockquote><p{_align_attr(para)}>{inner}</p></blockquote>"
    else:
        tag = "p"
    return f"<{tag}{_align_attr(para)}>{inner}</{tag}>"


def _align_attr(para: Paragraph) -> str:
    if para.alignment == WD_ALIGN_PARAGRAPH.CENTER:
        value = "center"
    elif para.alignment == WD_ALIGN_PARAGRAPH.RIGHT:
        value = "right"
    elif para.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY:
        value = "justify"
    elif para.alignment == WD_ALIGN_PARAGRAPH.LEFT:
        value = "left"
    else:
        return ""
    return f' style="text-align: {value}"'


def _inline_segments(parent, part, ctx: _Ctx) -> list[tuple[str, str]]:
    segments: list[tuple[str, str]] = []
    for child in parent:
        tag = _local(child)
        if tag == "hyperlink":
            segments.extend(_hyperlink_segments(child, part, ctx))
        elif tag == "r":
            segments.extend(_run_segments(child, part, ctx))
        elif tag in {"ins", "smartTag", "sdt"}:
            segments.extend(_inline_segments(child, part, ctx))
    return segments


def _hyperlink_segments(element, part, ctx: _Ctx) -> list[tuple[str, str]]:
    inner: list[tuple[str, str]] = []
    for child in element:
        if _local(child) == "r":
            inner.extend(_run_segments(child, part, ctx))
    href = _safe_href(_get_hyperlink_url(element, part), ctx)
    segments: list[tuple[str, str]] = []
    buf: list[str] = []

    def flush() -> None:
        if not buf:
            return
        html = "".join(buf)
        buf.clear()
        if href:
            segments.append(("text", f'<a href="{_escape_html(href)}">{html}</a>'))
        else:
            segments.append(("text", html))

    for kind, html in inner:
        if kind == "text":
            buf.append(html)
        else:
            flush()
            if kind == "img":
                ctx.warn("An image inside a hyperlink is kept, but the link is not.")
            segments.append((kind, html))
    flush()
    return segments


def _run_segments(run, part, ctx: _Ctx) -> list[tuple[str, str]]:
    rpr = run.find(qn("w:rPr"))
    segments: list[tuple[str, str]] = []
    for child in run:
        tag = _local(child)
        if tag in {"drawing", "pict"}:
            image = _image_html(child, part, ctx)
            if image:
                segments.append(("img", image))
        elif tag == "t" and child.text:
            segments.append(("text", _format_text(child.text, rpr)))
        elif tag == "br":
            if child.get(qn("w:type")) == "page":
                segments.append(("break", ""))
            else:
                segments.append(("text", "<br>"))
        elif tag == "tab":
            ctx.warn("Tabs are imported as spaces.")
            segments.append(("text", _format_text(" ", rpr)))
    return segments


def _format_text(text: str, rpr) -> str:
    html = _escape_html(text)
    if _flag(rpr, "b"):
        html = f"<strong>{html}</strong>"
    if _flag(rpr, "i"):
        html = f"<em>{html}</em>"
    if _flag(rpr, "u"):
        html = f"<u>{html}</u>"
    if _flag(rpr, "strike"):
        html = f"<s>{html}</s>"
    vert = rpr.find(qn("w:vertAlign")) if rpr is not None else None
    vert_val = vert.get(qn("w:val")) if vert is not None else None
    if vert_val == "superscript":
        html = f"<sup>{html}</sup>"
    elif vert_val == "subscript":
        html = f"<sub>{html}</sub>"
    styles: list[str] = []
    if rpr is not None:
        fonts = rpr.find(qn("w:rFonts"))
        if fonts is not None:
            family = _safe_font(fonts.get(qn("w:ascii")) or fonts.get(qn("w:hAnsi")) or fonts.get(qn("w:eastAsia")))
            if family:
                styles.append(f"font-family: {_escape_html(family)}")
        size = rpr.find(qn("w:sz"))
        half = _int_attr(size, "w:val") if size is not None else None
        if half:
            styles.append(f"font-size: {half / 2:g}pt")
        color = rpr.find(qn("w:color"))
        hex_color = _safe_hex(color.get(qn("w:val")) if color is not None else None)
        if hex_color:
            styles.append(f"color: #{hex_color}")
    if styles:
        html = f'<span style="{"; ".join(styles)}">{html}</span>'
    if rpr is not None and rpr.find(qn("w:highlight")) is not None:
        html = f"<mark>{html}</mark>"
    return html


def _image_magic(blob: bytes, content_type: str) -> bool:
    if content_type == "image/png":
        return blob.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return blob.startswith(b"\xff\xd8\xff")
    if content_type == "image/gif":
        return blob.startswith((b"GIF87a", b"GIF89a"))
    if content_type == "image/webp":
        return blob.startswith(b"RIFF") and blob[8:12] == b"WEBP"
    return False


def _image_html(element, part, ctx: _Ctx) -> str | None:
    blips = element.findall(f'.//{qn("a:blip")}')
    if not blips:
        blips = element.findall(f'.//{qn("v:imagedata")}')
    for blip in blips:
        embed_id = blip.get(qn("r:embed")) or blip.get(qn("r:id"))
        if not embed_id:
            continue
        try:
            image_part = part.related_parts[embed_id]
            blob = image_part.blob
            content_type = (image_part.content_type or "").split(";")[0].lower()
        except (KeyError, AttributeError):
            continue
        if content_type not in _IMAGE_TYPES or len(blob) > MAX_IMAGE_BYTES or not _image_magic(blob, content_type):
            ctx.warn("An image was skipped because its type or size is not supported.")
            continue
        encoded = base64.b64encode(blob).decode("ascii")
        return f'<img src="data:{content_type};base64,{encoded}" />'
    return None


def _get_hyperlink_url(element, part) -> str | None:
    rel_id = element.get(qn("r:id"))
    if not rel_id:
        return None
    try:
        return part.rels[rel_id].target_ref
    except (KeyError, AttributeError):
        return None


def _get_list_info(para: Paragraph, ctx: _Ctx) -> tuple[str, int, str, int, str | None] | None:
    """Return (kind, level, num_id, start, ol_type). numPr wins over a list style name."""
    p_pr = para._element.find(qn("w:pPr"))
    num_pr = p_pr.find(qn("w:numPr")) if p_pr is not None else None
    if num_pr is not None:
        num_id_el = num_pr.find(qn("w:numId"))
        num_id = num_id_el.get(qn("w:val")) if num_id_el is not None else None
        if num_id and num_id != "0":
            level = _int_attr(num_pr.find(qn("w:ilvl")), "w:val") or 0
            kind, ol_type, start = _numbering_format(para, num_id, level, ctx)
            if kind is None:
                return None
            return (kind, level, num_id, start, ol_type)
    style_name = (para.style.name or "").lower()
    if "list bullet" in style_name:
        return ("ul", _style_level(style_name, "list bullet"), f"style:{style_name}", 1, None)
    if "list number" in style_name:
        return ("ol", _style_level(style_name, "list number"), f"style:{style_name}", 1, None)
    return None


def _style_level(style_name: str, prefix: str) -> int:
    suffix = style_name.replace(prefix, "").strip()
    if suffix.isdigit():
        return max(0, int(suffix) - 1)
    return 0


def _numbering_format(para: Paragraph, num_id: str, level: int, ctx: _Ctx) -> tuple[str | None, str | None, int]:
    try:
        numbering = para.part.numbering_part._element
    except AttributeError:
        return "ul", None, 1
    abstract_id = None
    start_override = None
    for num_el in numbering.findall(qn("w:num")):
        if num_el.get(qn("w:numId")) != num_id:
            continue
        abstract_el = num_el.find(qn("w:abstractNumId"))
        abstract_id = abstract_el.get(qn("w:val")) if abstract_el is not None else None
        for override in num_el.findall(qn("w:lvlOverride")):
            if override.get(qn("w:ilvl")) == str(level):
                start_el = override.find(qn("w:startOverride"))
                if start_el is not None:
                    start_override = _int_attr(start_el, "w:val")
        break
    fmt = "bullet"
    start = 1
    if abstract_id is not None:
        for abstract in numbering.findall(qn("w:abstractNum")):
            if abstract.get(qn("w:abstractNumId")) != abstract_id:
                continue
            levels = {node.get(qn("w:ilvl")): node for node in abstract.findall(qn("w:lvl"))}
            exact = levels.get(str(level))
            lvl = exact if exact is not None else levels.get("0")
            if lvl is not None:
                fmt_el = lvl.find(qn("w:numFmt"))
                fmt = fmt_el.get(qn("w:val")) if fmt_el is not None else "bullet"
                if exact is not None:
                    start_el = lvl.find(qn("w:start"))
                    if start_el is not None and _int_attr(start_el, "w:val"):
                        start = _int_attr(start_el, "w:val") or 1
            break
    if start_override:
        start = start_override
    if fmt == "bullet":
        return "ul", None, 1
    if fmt == "none":
        return None, None, 1
    ol_type = _OL_TYPE.get(fmt)
    if fmt not in _OL_TYPE:
        ctx.warn("A numbering format other than decimal, letter, or roman is kept as a decimal list.")
        ol_type = None
    return "ol", ol_type, start


def _build_nested_list(items: list[tuple]) -> str:
    if not items:
        return ""
    if all(item[1] == 0 for item in items):
        return _list_tag(items[0]) + "".join(f"<li>{item[2]}</li>" for item in items) + _list_close(items[0])
    result: list[str] = []
    _build_list_recursive(items, 0, 0, result)
    return "".join(result)


def _list_tag(item: tuple) -> str:
    kind, _level, _html, _num, start, ol_type = item
    if kind == "ul":
        return "<ul>"
    attrs = []
    if start and start != 1:
        attrs.append(f'start="{int(start)}"')
    if ol_type in {"a", "A", "i", "I"}:
        attrs.append(f'type="{ol_type}"')
    return "<ol" + ((" " + " ".join(attrs)) if attrs else "") + ">"


def _list_close(item: tuple) -> str:
    return "</ul>" if item[0] == "ul" else "</ol>"


def _build_list_recursive(items: list[tuple], start: int, base_level: int, output: list[str]) -> None:
    if start >= len(items):
        return
    output.append(_list_tag(items[start]))
    index = start
    while index < len(items):
        item = items[index]
        level = item[1]
        if level < base_level:
            break
        if level > base_level:
            output.append(f"<li>{item[2]}</li>")
            index += 1
            continue
        nested = index + 1 < len(items) and items[index + 1][1] > base_level
        if nested:
            output.append(f"<li>{item[2]}")
            _build_list_recursive(items, index + 1, items[index + 1][1], output)
            while index + 1 < len(items) and items[index + 1][1] > base_level:
                index += 1
            output.append("</li>")
        else:
            output.append(f"<li>{item[2]}</li>")
        index += 1
    output.append(_list_close(items[start]))


def _table_to_html(table: Table, ctx: _Ctx) -> str:
    logical: list[list[dict]] = []
    open_rows: dict[int, dict] = {}
    for tr in table._tbl.findall(qn("w:tr")):
        header = _row_is_header(tr)
        row_cells: list[dict] = []
        column = 0
        for tc in tr.findall(qn("w:tc")):
            colspan, merge = _tc_span(tc)
            if merge == "continue":
                origin = open_rows.get(column)
                if origin is not None:
                    origin["rowspan"] += 1
                column += colspan
                continue
            cell = {
                "html": _cell_html(tc, table, ctx),
                "colspan": colspan,
                "rowspan": 1,
                "header": header,
                "bg": _cell_fill(tc),
            }
            if merge == "restart":
                open_rows[column] = cell
            else:
                open_rows.pop(column, None)
            row_cells.append(cell)
            column += colspan
        logical.append(row_cells)
    rows = [f"<tr>{''.join(_render_cell(cell) for cell in row)}</tr>" for row in logical]
    return "<table>" + "".join(rows) + "</table>"


def _row_is_header(tr) -> bool:
    tr_pr = tr.find(qn("w:trPr"))
    return tr_pr is not None and tr_pr.find(qn("w:tblHeader")) is not None


def _tc_span(tc) -> tuple[int, str | None]:
    tc_pr = tc.find(qn("w:tcPr"))
    colspan = 1
    merge = None
    if tc_pr is None:
        return colspan, merge
    grid = tc_pr.find(qn("w:gridSpan"))
    if grid is not None and _int_attr(grid, "w:val"):
        colspan = _int_attr(grid, "w:val") or 1
    vmerge = tc_pr.find(qn("w:vMerge"))
    if vmerge is not None:
        val = vmerge.get(qn("w:val"))
        merge = "restart" if val == "restart" else "continue"
    return colspan, merge


def _cell_fill(tc) -> str | None:
    tc_pr = tc.find(qn("w:tcPr"))
    if tc_pr is None:
        return None
    shade = tc_pr.find(qn("w:shd"))
    if shade is None:
        return None
    return _safe_hex(shade.get(qn("w:fill")))


def _cell_html(tc, table: Table, ctx: _Ctx) -> str:
    parts: list[str] = []
    list_buffer: list[tuple] = []

    def flush() -> None:
        nonlocal list_buffer
        if list_buffer:
            parts.append(_build_nested_list(list_buffer))
            list_buffer = []

    for child in tc:
        tag = _local(child)
        if tag == "p":
            para = Paragraph(child, table)
            info = _get_list_info(para, ctx)
            if info:
                if list_buffer and list_buffer[0][3] != info[2]:
                    flush()
                kind, level, num_id, start, ol_type = info
                list_buffer.append((kind, level, "".join(_paragraph_blocks(para, ctx, as_list=True)), num_id, start, ol_type))
            else:
                flush()
                parts.extend(_paragraph_blocks(para, ctx, as_list=False))
        elif tag == "tbl":
            flush()
            parts.append(_table_to_html(Table(child, table._parent), ctx))
    flush()
    return "".join(parts) or "<p></p>"


def _render_cell(cell: dict) -> str:
    tag = "th" if cell["header"] else "td"
    attrs = [f'colspan="{cell["colspan"]}"', f'rowspan="{cell["rowspan"]}"']
    if cell["bg"]:
        attrs.append(f'style="background-color: #{cell["bg"]}" data-background-color="#{cell["bg"]}"')
    return f"<{tag} {' '.join(attrs)}>{cell['html']}</{tag}>"
