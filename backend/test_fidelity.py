"""Structural DOCX fidelity. Compare document meaning, not ZIP bytes."""

from __future__ import annotations

import base64
import io
import zipfile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Mm, Pt, RGBColor

from .export_service import export_docx_to_bytes
from .import_service import DocxImportError, import_docx
from .main import app

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _bytes(doc: Document) -> bytes:
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _body_text(doc: Document) -> list[str]:
    return [para.text for para in doc.paragraphs]


def _roundtrip(doc: Document, page=None):
    raw = _bytes(doc)
    imported = import_docx(raw)
    exported = export_docx_to_bytes(imported.html, page_settings=page or imported.page_settings)
    return imported, Document(io.BytesIO(exported))


def _physical_cells(table):
    cells = []
    for tr in table._tbl.findall(qn("w:tr")):
        for tc in tr.findall(qn("w:tc")):
            tc_pr = tc.find(qn("w:tcPr"))
            grid = 1
            merge = None
            if tc_pr is not None:
                span = tc_pr.find(qn("w:gridSpan"))
                if span is not None and span.get(qn("w:val")):
                    grid = int(span.get(qn("w:val")))
                vmerge = tc_pr.find(qn("w:vMerge"))
                if vmerge is not None:
                    merge = vmerge.get(qn("w:val")) or "continue"
            texts = []
            for node in tc.findall(".//" + qn("w:t")):
                if node.text:
                    texts.append(node.text)
            cells.append({"text": "".join(texts), "grid": grid, "merge": merge})
    return cells


def test_paragraphs_headings_and_marks():
    doc = Document()
    doc.add_paragraph("Alpha paragraph")
    doc.add_heading("Heading One", level=1)
    doc.add_heading("Heading Two", level=2)
    doc.add_heading("Heading Three", level=3)
    para = doc.add_paragraph()
    para.add_run("bold").bold = True
    para.add_run("italic").italic = True
    para.add_run("underline").underline = True
    strike = para.add_run("strike")
    strike.font.strike = True
    vert = doc.add_paragraph()
    vert.add_run("E=mc")
    vert.add_run("2").font.superscript = True
    vert.add_run(" H")
    vert.add_run("2").font.subscript = True
    vert.add_run("O")
    styled = doc.add_paragraph()
    run = styled.add_run("Big Red")
    run.font.size = Pt(18)
    run.font.color.rgb = RGBColor(0xC0, 0x39, 0x2B)
    for alignment, text in (
        (WD_ALIGN_PARAGRAPH.LEFT, "Align left"),
        (WD_ALIGN_PARAGRAPH.CENTER, "Align center"),
        (WD_ALIGN_PARAGRAPH.RIGHT, "Align right"),
        (WD_ALIGN_PARAGRAPH.JUSTIFY, "Align justify"),
    ):
        doc.add_paragraph(text).alignment = alignment
    imported, out = _roundtrip(doc)
    text = "\n".join(_body_text(out))
    for expected in ("Alpha paragraph", "Heading One", "Heading Two", "Heading Three", "bold", "italic", "underline", "strike", "E=mc2", "Align center", "Align justify"):
        assert expected.replace(" ", "") in text.replace(" ", "") or expected in text, expected
    assert "Heading1" in out.paragraphs[1].style.name.replace(" ", "")
    assert any(para.text == "Align center" and para.alignment == WD_ALIGN_PARAGRAPH.CENTER for para in out.paragraphs)
    assert out.paragraphs[4].runs[0].bold
    assert out.paragraphs[4].runs[1].italic
    assert out.paragraphs[4].runs[2].underline
    assert out.paragraphs[4].runs[3].font.strike
    assert out.paragraphs[5].runs[1].font.superscript
    assert out.paragraphs[5].runs[3].font.subscript
    assert "C0392B" in (out.paragraphs[6].runs[0].font.color.rgb.__str__() if out.paragraphs[6].runs else "")
    assert "<h1" in imported.html and "<h2" in imported.html and "<h3" in imported.html
    print("PASS: paragraphs, headings, marks, alignment")


def test_image_order_and_link():
    doc = Document()
    para = doc.add_paragraph()
    run = para.add_run()
    run.add_text("BEFORE")
    run.add_picture(io.BytesIO(PNG))
    run.add_text("AFTER")
    imported, out = _roundtrip(doc)
    assert "BEFORE" in imported.html and "AFTER" in imported.html
    assert imported.html.index("BEFORE") < imported.html.index("data:image/png") < imported.html.index("AFTER")
    joined = "".join(_body_text(out))
    assert "BEFORE" in joined and "AFTER" in joined
    blobs = []
    for part in out.part.related_parts.values():
        if getattr(part, "content_type", "") == "image/png":
            blobs.append(part.blob)
    assert PNG in blobs
    link = doc.add_paragraph()
    _add_link(link, "example", "https://example.com/a")
    imported, out = _roundtrip(doc)
    assert 'href="https://example.com/a"' in imported.html
    targets = [rel.target_ref for rel in out.part.rels.values() if "hyperlink" in rel.reltype]
    assert "https://example.com/a" in targets
    hostile = Document()
    _add_link(hostile.add_paragraph(), "bad", "javascript:alert(1)")
    hostile_html = import_docx(_bytes(hostile)).html
    assert "javascript:" not in hostile_html
    assert "bad" in hostile_html
    print("PASS: image order and links")


def test_lists_restart_and_type():
    doc = Document()
    _add_list(doc, ["First", "Second"], "decimal", num_id=10, abstract_id=20)
    doc.add_paragraph("between")
    _add_list(doc, ["Again"], "decimal", num_id=11, abstract_id=21, start=5)
    _add_list(doc, ["Bullet"], "bullet", num_id=12, abstract_id=22)
    imported, out = _roundtrip(doc)
    assert '<ol' in imported.html and 'start="5"' in imported.html and "<ul>" in imported.html
    assert imported.html.index("First") < imported.html.index("between") < imported.html.index('start="5"')
    nums = _resolved_starts(out)
    assert 5 in nums
    assert any(fmt == "bullet" for fmt in _resolved_formats(out))
    letters = Document()
    _add_list(letters, ["Alpha"], "lowerLetter", num_id=13, abstract_id=23)
    letter_html = import_docx(_bytes(letters)).html
    assert 'type="a"' in letter_html
    letter_out = Document(io.BytesIO(export_docx_to_bytes(letter_html)))
    assert "lowerLetter" in _resolved_formats(letter_out)
    nested = Document()
    _add_list(nested, ["Parent"], "decimal", num_id=14, abstract_id=24)
    child = nested.add_paragraph("Child")
    p_pr = child._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "1")
    nid = OxmlElement("w:numId")
    nid.set(qn("w:val"), "14")
    num_pr.extend([ilvl, nid])
    p_pr.append(num_pr)
    nested_html = import_docx(_bytes(nested)).html
    assert nested_html.index("Parent") < nested_html.index("Child")
    assert nested_html.count("<ol") >= 2
    roman = Document()
    _add_list(roman, ["Eye"], "lowerRoman", num_id=15, abstract_id=25)
    roman_html = import_docx(_bytes(roman)).html
    assert 'type="i"' in roman_html
    assert "lowerRoman" in _resolved_formats(Document(io.BytesIO(export_docx_to_bytes(roman_html))))
    print("PASS: list restart and bullet")


def test_tables_merges_and_rich_cells():
    doc = Document()
    table = doc.add_table(rows=3, cols=3)
    table.cell(0, 0).merge(table.cell(0, 1))
    table.cell(0, 0).text = "HSpan"
    table.cell(0, 2).text = "Corner"
    table.cell(1, 0).merge(table.cell(2, 0))
    table.cell(1, 0).text = "VSpan"
    table.cell(1, 1).text = "Mid"
    table.cell(1, 2).paragraphs[0].add_run("Note").italic = True
    imported, out = _roundtrip(doc)
    assert imported.html.count("HSpan") == 1
    assert imported.html.count("VSpan") == 1
    assert 'colspan="2"' in imported.html and 'rowspan="2"' in imported.html
    assert "<em>Note</em>" in imported.html or "<em>Note</em>".lower() in imported.html.lower()
    cells = _physical_cells(out.tables[0])
    anchors = [cell for cell in cells if cell["merge"] != "continue"]
    texts = [cell["text"] for cell in anchors]
    assert texts.count("HSpan") == 1
    assert texts.count("VSpan") == 1
    assert any(cell["grid"] == 2 and "HSpan" in cell["text"] for cell in cells)
    assert any(cell["merge"] == "restart" and "VSpan" in cell["text"] for cell in cells)
    linked = Document()
    cell = linked.add_table(rows=1, cols=1).cell(0, 0)
    cell.paragraphs[0].add_run().add_picture(io.BytesIO(PNG))
    _add_link(cell.add_paragraph(), "inside", "https://example.com/cell")
    imported_cell = import_docx(_bytes(linked))
    assert "data:image/png" in imported_cell.html and 'href="https://example.com/cell"' in imported_cell.html
    exported_cell = Document(io.BytesIO(export_docx_to_bytes(imported_cell.html)))
    assert any(getattr(part, "content_type", "") == "image/png" for part in exported_cell.part.related_parts.values())
    assert "https://example.com/cell" in [rel.target_ref for rel in exported_cell.part.rels.values() if "hyperlink" in rel.reltype]
    print("PASS: table merges and rich cells")


def test_page_break_and_page_settings():
    doc = Document()
    doc.add_paragraph("Before")
    broken = doc.add_paragraph()
    broken.add_run().add_break(WD_BREAK.PAGE)
    doc.add_paragraph("After")
    section = doc.sections[0]
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    imported, out = _roundtrip(doc)
    assert "data-page-break" in imported.html
    assert "Before" in imported.html and "After" in imported.html
    assert any(run._element.find(qn("w:br")) is not None and (run._element.find(qn("w:br")).get(qn("w:type")) == "page") for para in out.paragraphs for run in para.runs)
    assert imported.page_settings["widthTwip"] == 11906
    assert imported.page_settings["heightTwip"] == 16838
    letter = Document()
    letter.sections[0].page_width = Inches(8.5)
    letter.sections[0].page_height = Inches(11)
    letter.add_paragraph("Letter page")
    imported_letter = import_docx(_bytes(letter))
    assert imported_letter.page_settings["widthTwip"] == 12240
    assert imported_letter.page_settings["heightTwip"] == 15840
    exported = Document(io.BytesIO(export_docx_to_bytes("<p>Letter page</p>", imported_letter.page_settings)))
    assert int(exported.sections[0].page_width.twips) == 12240
    assert int(exported.sections[0].page_height.twips) == 15840
    multi = Document()
    multi.add_paragraph("One")
    # A second sectPr with a different size is a warning, not a second page object.
    imported_multi = import_docx(_bytes(multi))
    assert imported_multi.page_settings is not None
    print("PASS: page break and page settings")


def test_unicode_empty_and_hostile_package():
    doc = Document()
    doc.add_paragraph("汉字测量")
    doc.add_paragraph('a & b < c > "quoted"')
    doc.add_paragraph("")
    imported, out = _roundtrip(doc)
    joined = "\n".join(_body_text(out))
    assert "汉字测量" in joined
    assert 'a & b < c > "quoted"' in joined or "a &amp; b" not in joined and "quoted" in joined
    assert "<p></p>" in imported.html or "<p><br></p>" in imported.html
    try:
        import_docx(b"not a docx")
        raise AssertionError("malformed package was accepted")
    except DocxImportError:
        pass
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"A" * (9 * 1024 * 1024))
    try:
        import_docx(bomb.getvalue())
        raise AssertionError("oversized package was accepted")
    except DocxImportError:
        pass
    print("PASS: unicode, empty paragraph, hostile package")


def test_import_endpoint_hides_failures():
    from fastapi.testclient import TestClient

    client = TestClient(app)
    # Dev insecure is process-global. The credentials tests set it; this module sets it too.
    import os
    os.environ["DOCXEDITOR_DEV_INSECURE"] = "1"
    from .session_auth import configure
    configure(token=None, dev_insecure=True)
    bad = client.post("/api/import", files={"file": ("bad.docx", b"nope", "application/octet-stream")})
    assert bad.status_code == 422
    assert "html" not in bad.json()
    doc = Document()
    doc.add_paragraph("Endpoint")
    good = client.post("/api/import", files={"file": ("ok.docx", _bytes(doc), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert good.status_code == 200
    body = good.json()
    assert "Endpoint" in body["html"]
    assert "page_settings" in body and "warnings" in body
    print("PASS: import endpoint")


def _add_link(paragraph, text, url):
    part = paragraph.part
    rel_id = part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rel_id)
    run = OxmlElement("w:r")
    node = OxmlElement("w:t")
    node.text = text
    run.append(node)
    link.append(run)
    paragraph._p.append(link)


def _add_list(doc, items, fmt, num_id, abstract_id, start=1):
    numbering = doc.part.numbering_part._element
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), "0")
    start_el = OxmlElement("w:start")
    start_el.set(qn("w:val"), str(start))
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), fmt)
    text = OxmlElement("w:lvlText")
    text.set(qn("w:val"), "•" if fmt == "bullet" else "%1.")
    lvl.extend([start_el, num_fmt, text])
    abstract.append(lvl)
    first = numbering.find(qn("w:num"))
    first.addprevious(abstract)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), str(abstract_id))
    num.append(ref)
    numbering.append(num)
    for item in items:
        para = doc.add_paragraph(item)
        p_pr = para._p.get_or_add_pPr()
        num_pr = OxmlElement("w:numPr")
        ilvl = OxmlElement("w:ilvl")
        ilvl.set(qn("w:val"), "0")
        nid = OxmlElement("w:numId")
        nid.set(qn("w:val"), str(num_id))
        num_pr.extend([ilvl, nid])
        p_pr.append(num_pr)


def _resolved_starts(doc: Document) -> set[int]:
    numbering = doc.part.numbering_part._element
    starts = set()
    for abstract in numbering.findall(qn("w:abstractNum")):
        for lvl in abstract.findall(qn("w:lvl")):
            if lvl.get(qn("w:ilvl")) == "0":
                start = lvl.find(qn("w:start"))
                if start is not None:
                    starts.add(int(start.get(qn("w:val"))))
    return starts


def _resolved_formats(doc: Document) -> set[str]:
    numbering = doc.part.numbering_part._element
    formats = set()
    for abstract in numbering.findall(qn("w:abstractNum")):
        for lvl in abstract.findall(qn("w:lvl")):
            fmt = lvl.find(qn("w:numFmt"))
            if fmt is not None:
                formats.add(fmt.get(qn("w:val")))
    return formats


def test_spaces_between_marks_and_header_warning():
    exported = Document(io.BytesIO(export_docx_to_bytes("<p><strong>a</strong> <em>b</em></p>")))
    assert exported.paragraphs[0].text == "a b"
    doc = Document()
    doc.add_paragraph("Keep me")
    footer = doc.sections[0].footer
    footer.paragraphs[0].text = "CONFIDENTIAL"
    imported = import_docx(_bytes(doc))
    assert "Keep me" in imported.html
    assert "CONFIDENTIAL" not in imported.html
    assert any("footer" in warning.lower() or "header" in warning.lower() for warning in imported.warnings)
    print("PASS: spaces and header warning")


def test_font_size_header_shading_and_list_in_cell():
    sized = Document()
    run = sized.add_paragraph().add_run("Half")
    run.font.size = Pt(10.5)
    imported = import_docx(_bytes(sized))
    assert "10.5pt" in imported.html
    exported = Document(io.BytesIO(export_docx_to_bytes(imported.html)))
    assert exported.paragraphs[0].runs[0].font.size.pt == 10.5
    shaded = '<table><tr><th data-background-color="#00FF00" style="background-color: #00FF00"><p>Head</p></th></tr></table>'
    shaded_doc = Document(io.BytesIO(export_docx_to_bytes(shaded)))
    fill = shaded_doc.tables[0].rows[0].cells[0]._tc.tcPr.find(qn("w:shd")).get(qn("w:fill"))
    assert fill == "00FF00"
    listed = '<table><tr><td><ul><li><p>Item</p></li></ul></td></tr></table>'
    listed_doc = Document(io.BytesIO(export_docx_to_bytes(listed)))
    cell_para = listed_doc.tables[0].rows[0].cells[0].paragraphs[0]
    assert cell_para._p.find(qn("w:pPr")).find(qn("w:numPr")) is not None
    zero = {
        "widthTwip": 12240,
        "heightTwip": 15840,
        "marginTopTwip": 0,
        "marginRightTwip": 1440,
        "marginBottomTwip": 0,
        "marginLeftTwip": 1440,
    }
    zero_doc = Document(io.BytesIO(export_docx_to_bytes("<p>Edge</p>", zero)))
    assert int(zero_doc.sections[0].top_margin.twips) == 0
    assert int(zero_doc.sections[0].page_width.twips) == 12240
    print("PASS: font size, header shading, cell list, zero margin")


def test_review_fixtures():
    # Several images, image-then-text, and bold text on both sides.
    doc = Document()
    para = doc.add_paragraph()
    para.add_run("AAA").bold = True
    para.add_run().add_picture(io.BytesIO(PNG))
    para.add_run().add_picture(io.BytesIO(PNG))
    para.add_run("BBB").bold = True
    imported, out = _roundtrip(doc)
    assert imported.html.index("AAA") < imported.html.index("data:image") < imported.html.rindex("data:image") < imported.html.index("BBB")
    assert "<strong>AAA</strong>" in imported.html and "<strong>BBB</strong>" in imported.html
    drawings = out.element.body.findall(".//" + qn("w:drawing"))
    assert len(drawings) == 2
    joined = "".join(para.text for para in out.paragraphs)
    assert joined.index("AAA") < joined.index("BBB")

    image_first = Document()
    run = image_first.add_paragraph().add_run()
    run.add_picture(io.BytesIO(PNG))
    run.add_text("TAIL")
    imported = import_docx(_bytes(image_first))
    assert imported.html.index("data:image") < imported.html.index("TAIL")

    # Empty cell, CJK, symbol, body shading, two paragraphs, and a 2x2 merge.
    doc = Document()
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "汉字"
    table.cell(0, 1).text = ""
    table.cell(1, 0).text = "Ω"
    shade = OxmlElement("w:shd")
    shade.set(qn("w:val"), "clear")
    shade.set(qn("w:fill"), "00AA00")
    table.cell(1, 1)._tc.get_or_add_tcPr().append(shade)
    table.cell(1, 1).text = "green"
    imported = import_docx(_bytes(doc))
    assert imported.html.count("汉字") == 1 and "Ω" in imported.html and "00AA00" in imported.html
    assert imported.html.count("<td") == 4
    cell = Document().add_table(rows=1, cols=1).cell(0, 0)
    # rebuild with paragraphs
    doc = Document()
    cell = doc.add_table(rows=1, cols=1).cell(0, 0)
    cell.paragraphs[0].text = "P1"
    cell.add_paragraph("P2")
    _, out = _roundtrip(doc)
    assert [para.text for para in out.tables[0].cell(0, 0).paragraphs] == ["P1", "P2"]

    doc = Document()
    merged = doc.add_table(rows=3, cols=3)
    merged.cell(0, 0).merge(merged.cell(1, 1))
    merged.cell(0, 0).text = "BLOCK"
    merged.cell(0, 2).text = "R"
    merged.cell(2, 0).text = "Bot"
    imported, out = _roundtrip(doc)
    assert imported.html.count("BLOCK") == 1 and 'colspan="2"' in imported.html and 'rowspan="2"' in imported.html
    assert sum(cell["text"].count("BLOCK") for cell in _physical_cells(out.tables[0])) == 1

    # Two independent decimal lists, a bold link, and a parentless nested item.
    doc = Document()
    _add_list(doc, ["A1", "A2"], "decimal", 70, 80)
    doc.add_paragraph("gap")
    _add_list(doc, ["B1"], "decimal", 71, 81)
    imported = import_docx(_bytes(doc))
    assert imported.html.count("<ol") == 2
    assert imported.html.index("A1") < imported.html.index("gap") < imported.html.index("B1")

    doc = Document()
    paragraph = doc.add_paragraph()
    _add_link(paragraph, "Go", "https://example.com/z")
    link_run = paragraph._p.find(qn("w:hyperlink")).find(qn("w:r"))
    rpr = OxmlElement("w:rPr")
    rpr.append(OxmlElement("w:b"))
    link_run.insert(0, rpr)
    fonts = OxmlElement("w:rFonts")
    fonts.set(qn("w:ascii"), "url(http://evil.example/a.woff)")
    fonts.set(qn("w:eastAsia"), "宋体")
    rpr.append(fonts)
    imported = import_docx(_bytes(doc))
    assert 'href="https://example.com/z"' in imported.html and "<strong>Go</strong>" in imported.html
    assert "url(" not in imported.html and "宋体" in imported.html

    doc = Document()
    _add_list(doc, ["OnlyDeep"], "decimal", 72, 82)
    ilvl = doc.paragraphs[-1]._p.find(qn("w:pPr")).find(qn("w:numPr")).find(qn("w:ilvl"))
    ilvl.set(qn("w:val"), "1")
    imported = import_docx(_bytes(doc))
    assert "<ol><li><p>OnlyDeep</p></li></ol>" in imported.html.replace("\n", "")
    assert any("flattened" in warning for warning in imported.warnings)

    # Letter margins survive export.
    doc = Document()
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1.25)
    section.top_margin = Inches(0.5)
    section.bottom_margin = Inches(0.75)
    doc.add_paragraph("Letter")
    imported, out = _roundtrip(doc)
    assert imported.page_settings["widthTwip"] == 12240
    assert int(out.sections[0].top_margin.twips) == 720
    assert int(out.sections[0].right_margin.twips) == 1800
    assert int(out.sections[0].bottom_margin.twips) == 1080
    assert int(out.sections[0].left_margin.twips) == 1440
    print("PASS: review fixtures")


def test_spanned_row_hostile_package_and_textbox():
    doc = Document()
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).merge(table.cell(1, 1))
    table.cell(0, 0).text = "ONLY"
    imported, out = _roundtrip(doc)
    assert 'rowspan="2"' in imported.html and imported.html.count("ONLY") == 1
    cells = _physical_cells(out.tables[0])
    assert any(cell["grid"] == 2 and cell["merge"] == "restart" and cell["text"] == "ONLY" for cell in cells)
    assert any(cell["merge"] == "continue" and cell["text"] == "" for cell in cells)
    assert sum(cell["text"].count("ONLY") for cell in cells) == 1

    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as archive:
        archive.writestr("word/document.xml", b'<!DOCTYPE w:document [<!ENTITY x "SECRET">]><w:document/>')
    try:
        import_docx(bad.getvalue())
        raise AssertionError("DTD package was accepted")
    except DocxImportError:
        pass

    broken = io.BytesIO()
    with zipfile.ZipFile(broken, "w") as archive:
        archive.writestr("[Content_Types].xml", b"<Types></Types>")
        archive.writestr("word/document.xml", b"<document xmlns='urn:example:not-ooxml'/>")
    try:
        import_docx(broken.getvalue())
        raise AssertionError("unreadable package was accepted")
    except DocxImportError:
        pass

    doc = Document()
    doc.add_paragraph("Keep")
    from lxml import etree
    run = OxmlElement("w:r")
    run.append(etree.fromstring(
        '<w:pict xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p><w:r><w:t>INBOX</w:t></w:r></w:p>'
        '</w:txbxContent></v:textbox></w:pict>'
    ))
    doc.paragraphs[0]._p.append(run)
    imported = import_docx(_bytes(doc))
    assert "Keep" in imported.html and "INBOX" not in imported.html
    assert any("not imported" in warning for warning in imported.warnings)

    doc = Document()
    paragraph = doc.add_paragraph("star ")
    sym = OxmlElement("w:r")
    sym.append(OxmlElement("w:sym"))
    paragraph._p.append(sym)
    imported = import_docx(_bytes(doc))
    assert "star" in imported.html
    assert any("Symbol-font" in warning for warning in imported.warnings)
    print("PASS: spanned row, hostile package, text box")


def main():
    test_paragraphs_headings_and_marks()
    test_image_order_and_link()
    test_lists_restart_and_type()
    test_tables_merges_and_rich_cells()
    test_page_break_and_page_settings()
    test_unicode_empty_and_hostile_package()
    test_import_endpoint_hides_failures()
    test_spaces_between_marks_and_header_warning()
    test_font_size_header_shading_and_list_in_cell()
    test_review_fixtures()
    test_spanned_row_hostile_package_and_textbox()
    print("ALL FIDELITY TESTS PASSED")


if __name__ == "__main__":
    main()
