#!/usr/bin/env python3
"""Read a slide deck (.pptx with python-pptx, or a PDF export with pdfplumber) into JSON, slide by slide.

    python3 read_deck.py <file.pptx|file.pdf>

Output (stdout), one object:
{
  "kind": "pptx" | "pdf",
  "slides": [
    { "n": 1, "title": "…", "texts": ["…"], "rows": [["cell", …], …], "notes": ["…"] },
    …
  ],
  "warnings": ["slide 3 has no extractable text"],
  "landscape": true            # PDF only: pages wider than tall (a deck), else a document
}

Rules:
- Slide order is kept; every piece of text carries its slide number.
- .pptx: every text frame, table cells as rows, grouped shapes recursively, speaker notes.
- .pdf: one page is one slide; tables come from pdfplumber's table finder; a "Speaker notes" block
  at the bottom of a page (the "1 slide with notes" export layout) becomes that slide's notes.
- A slide with no text at all gives the warning "slide N has no extractable text".
No OCR. Nothing here is interpreted; the TypeScript Stage A turns slides into plan items.
"""
import json
import re
import sys


def _clean(s):
    return re.sub(r"[ \t ]+", " ", (s or "").replace("\r", "")).strip()


# ---------- pptx ----------

def _shape_texts(shape, texts, rows):
    """Collect text frames and table rows from a shape, recursing into groups."""
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        for s in shape.shapes:
            _shape_texts(s, texts, rows)
        return
    if getattr(shape, "has_table", False) and shape.has_table:
        for r in shape.table.rows:
            cells = [_clean(c.text) for c in r.cells]
            if any(cells):
                rows.append(cells)
        return
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            t = _clean("".join(run.text for run in p.runs) or p.text)
            if t:
                texts.append(t)


def read_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    slides, warnings = [], []
    for n, slide in enumerate(prs.slides, start=1):
        texts, rows, notes = [], [], []
        title = ""
        title_shape = slide.shapes.title
        if title_shape is not None and title_shape.has_text_frame:
            title = _clean(title_shape.text_frame.text)
        for shape in slide.shapes:
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            _shape_texts(shape, texts, rows)
        if slide.has_notes_slide:
            nf = slide.notes_slide.notes_text_frame
            if nf is not None:
                for p in nf.paragraphs:
                    t = _clean("".join(run.text for run in p.runs) or p.text)
                    if t:
                        notes.append(t)
        if not title and not texts and not rows and not notes:
            warnings.append(f"slide {n} has no extractable text")
        slides.append({"n": n, "title": title, "texts": texts, "rows": rows, "notes": notes})
    return {"kind": "pptx", "slides": slides, "warnings": warnings}


# ---------- pdf ----------

NOTES_RE = re.compile(r"^\s*(speaker\s+)?notes\s*:?\s*$", re.I)


def _line_size(line):
    sizes = [round(ch.get("size", 0)) for ch in line.get("chars", []) if ch.get("text", "").strip()]
    return max(set(sizes), key=sizes.count) if sizes else 0


BULLET_RE = re.compile(r"^(?:\(cid:\d+\)|[\u2022\u25aa\u25cf\u2013\-\*]|\d+[.)])\s*")


def read_pdf(path):
    import pdfplumber
    slides, warnings = [], []
    landscape_pages = 0
    with pdfplumber.open(path) as pdf:
        for n, page in enumerate(pdf.pages, start=1):
            if page.width > page.height:
                landscape_pages += 1
            rows, table_cells = [], set()
            for table in page.extract_tables() or []:
                for r in table:
                    cells = [_clean(c) for c in r]
                    if any(cells):
                        rows.append(cells)
                        table_cells.update(c for c in cells if c)

            def is_table_line(text):
                rest = text
                for c in sorted(table_cells, key=len, reverse=True):
                    rest = rest.replace(c, "")
                return bool(table_cells) and not _clean(rest)

            # Lines top to bottom with their dominant font size. The largest size on the page is the title.
            raw = [(_clean(l["text"]), _line_size(l)) for l in page.extract_text_lines()]
            raw = [(t, sz) for t, sz in raw if t and not is_table_line(t)]
            title_size = max((sz for _, sz in raw), default=0)
            lines = []  # (text, size, is_notes)
            in_notes = False
            for text, sz in raw:
                if NOTES_RE.match(text):
                    in_notes = True
                    continue
                bullet = BULLET_RE.match(text)
                if bullet:
                    text = "\u2022 " + text[bullet.end():]
                # A wrapped line continues the previous one: same size, same block, no bullet marker,
                # and the previous line did not end a sentence.
                if lines and not bullet and lines[-1][1] == sz and lines[-1][2] == in_notes \
                        and sz != title_size and not re.search(r"[.!?:]$", lines[-1][0]):
                    lines[-1] = (lines[-1][0] + " " + text, sz, in_notes)
                else:
                    lines.append((text, sz, in_notes))
            title = ""
            texts, notes = [], []
            for text, sz, is_notes in lines:
                if is_notes:
                    notes.append(text)
                elif not title and sz == title_size and not texts:
                    title = text
                else:
                    texts.append(text)
            if not title and not texts and not rows and not notes:
                warnings.append(f"slide {n} has no extractable text")
            slides.append({"n": n, "title": title, "texts": texts, "rows": rows, "notes": notes})
    return {"kind": "pdf", "slides": slides, "warnings": warnings, "landscape": landscape_pages > len(slides) / 2}


def main():
    if len(sys.argv) != 2:
        print("usage: read_deck.py <file.pptx|file.pdf>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    low = path.lower()
    if low.endswith(".pptx"):
        out = read_pptx(path)
    elif low.endswith(".pdf"):
        out = read_pdf(path)
    else:
        print(f"unsupported file type: {path}", file=sys.stderr)
        sys.exit(2)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
