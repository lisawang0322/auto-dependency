#!/usr/bin/env python3
"""Build the slide-deck form of the INGEST-142 plan of record, plus its PDF export.

    .venv/bin/python fixtures/build_pptx.py

Writes:
  fixtures/ingest-142/docs/Ingestion-service-POR-v3.pptx   (python-pptx)
  fixtures/ingest-142/docs/Ingestion-service-POR-v3.pdf    (reportlab, "1 slide with notes" layout)

PLACEHOLDER SAMPLE DATA (PRD R12): same plan content as Ingestion-service-POR-v3.md, spread the way a
real deck spreads it: a timeline table (slide 4), dependencies as bullets (slide 6), the approval only in
the speaker notes (slide 7), the SRE readiness item on slide 8, and one image-only slide (slide 3).
The PDF is the "1 slide with notes" export: a plain export drops speaker notes, and with them the approval.
Nothing here describes a real company, team or person.
"""
import io
import os
import struct
import zlib

from pptx import Presentation
from pptx.util import Inches, Pt

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "ingest-142", "docs")
PPTX = os.path.join(DOCS, "Ingestion-service-POR-v3.pptx")
PDF = os.path.join(DOCS, "Ingestion-service-POR-v3.pdf")

# ---------- content (slide order matters: plan items are numbered in reading order) ----------

TITLE = "Ingestion service launch — Plan of record (v3)"
SUBTITLE = "Epic: INGEST-142 · Launch date: 2026-11-20 · Fix version 1.0"

OVERVIEW = [
    "The ingestion service replaces the batch importer with a streaming path onto the shared data platform.",
    "This is a new service with production database access, backend only.",
    "Four teams are involved: the Ingestion team (service team), Data Platform (shared platform), Security (approver) and SRE (capacity and on-call).",
    "Go/no-go is the Friday before launch.",
]

TIMELINE = [
    ["Date", "Milestone", "Owner"],
    ["Oct 20", "Kickoff", "—"],
    ["Nov 13", "Go/no-go", "—"],
    ["Nov 18", "Ingestion service live in production", "Ingestion team"],
    ["Nov 20", "Launch", "—"],
]

ASSUMPTIONS = [
    "Peak load at launch is 2× the batch importer's peak.",
    "No customer-facing UI changes ship with this release.",
]

DEPENDENCIES = [
    "Data Platform will have the cluster quota raised for ingestion load by Nov 12.",
]

APPROVALS_TABLE = [
    ["Review", "Status"],
    ["AppSec review", "In progress"],
    ["Secrets rotation approval", "Done"],
]
APPROVALS_NOTES = [
    "Security will have the security review approved by Nov 14.",
]

READINESS = [
    "SRE capacity and on-call will be in place the week before launch.",
]

RISKS = [
    "Peak load estimate is unverified until the load test runs.",
    "Cut-over timing depends on the capacity confirmation.",
]

NEXT_STEPS = [
    "Go/no-go review on Friday Nov 13.",
    "Launch on Nov 20.",
]

SLIDES = [
    {"title": TITLE, "subtitle": SUBTITLE},                       # 1
    {"title": "Overview", "bullets": OVERVIEW},                   # 2
    {"title": None, "image": True},                               # 3 image only
    {"title": "Timeline", "table": TIMELINE},                     # 4
    {"title": "Assumptions", "bullets": ASSUMPTIONS},             # 5
    {"title": "Dependencies", "bullets": DEPENDENCIES},           # 6
    {"title": "Approvals", "table": APPROVALS_TABLE, "notes": APPROVALS_NOTES},  # 7
    {"title": "Readiness", "bullets": READINESS},                 # 8
    {"title": "Risks", "bullets": RISKS},                         # 9
    {"title": "Next steps", "bullets": NEXT_STEPS},               # 10
]


# ---------- a small architecture picture (no text: it must not be extractable) ----------

def architecture_png(path):
    """Boxes and arrows as a PNG, drawn without any text, using Pillow (a python-pptx dependency)."""
    from PIL import Image, ImageDraw
    w, h = 1200, 560
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    boxes = [(60, 200, 300, 360), (450, 200, 750, 360), (900, 200, 1140, 360)]
    colors = ["#C9D6F5", "#B9E0C4", "#F5D9A8"]
    for (x0, y0, x1, y1), c in zip(boxes, colors):
        d.rectangle([x0, y0, x1, y1], fill=c, outline="#2E3440", width=3)
    for (ax, ay, bx, by) in [(300, 280, 450, 280), (750, 280, 900, 280)]:
        d.line([ax, ay, bx, by], fill="#2E3440", width=4)
        d.polygon([(bx, by), (bx - 18, by - 10), (bx - 18, by + 10)], fill="#2E3440")
    # a "database" cylinder under the middle box
    d.ellipse([540, 420, 660, 450], outline="#2E3440", width=3)
    d.rectangle([540, 435, 660, 500], outline="#2E3440", width=3, fill="white")
    d.ellipse([540, 485, 660, 515], outline="#2E3440", width=3)
    d.line([541, 435, 541, 500], fill="white", width=3)
    img.save(path)


# ---------- pptx ----------

def build_pptx(image_path):
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    L_TITLE, L_TITLE_ONLY, L_BLANK = prs.slide_layouts[0], prs.slide_layouts[5], prs.slide_layouts[6]

    def add_bullets(slide, lines, top=Inches(1.6)):
        box = slide.shapes.add_textbox(Inches(0.8), top, Inches(11.7), Inches(5))
        tf = box.text_frame
        tf.word_wrap = True
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = "• " + line
            p.font.size = Pt(20)

    def add_table(slide, rows, top=Inches(1.6)):
        shape = slide.shapes.add_table(len(rows), len(rows[0]), Inches(0.8), top, Inches(11.7), Inches(0.5) * len(rows))
        for r, row in enumerate(rows):
            for c, cell in enumerate(row):
                shape.table.cell(r, c).text = cell
                for p in shape.table.cell(r, c).text_frame.paragraphs:
                    p.font.size = Pt(18)

    for spec in SLIDES:
        if spec.get("image"):
            slide = prs.slides.add_slide(L_BLANK)
            slide.shapes.add_picture(image_path, Inches(1.5), Inches(1.0), width=Inches(10.3))
            continue
        if "subtitle" in spec:
            slide = prs.slides.add_slide(L_TITLE)
            slide.shapes.title.text = spec["title"]
            slide.placeholders[1].text = spec["subtitle"]
            continue
        slide = prs.slides.add_slide(L_TITLE_ONLY)
        slide.shapes.title.text = spec["title"]
        if "bullets" in spec:
            add_bullets(slide, spec["bullets"])
        if "table" in spec:
            add_table(slide, spec["table"])
        if "notes" in spec:
            slide.notes_slide.notes_text_frame.text = "\n".join(spec["notes"])
    prs.save(PPTX)


# ---------- pdf export ("1 slide with notes") ----------

def build_pdf(image_path):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, Table, TableStyle
    from reportlab.pdfgen import canvas

    PAGE = (13.333 * inch, 7.5 * inch)
    c = canvas.Canvas(PDF, pagesize=PAGE)
    c.setTitle(TITLE)
    body = ParagraphStyle("body", fontName="Helvetica", fontSize=16, leading=22)
    notes_style = ParagraphStyle("notes", fontName="Helvetica", fontSize=11, leading=14)
    W, H = PAGE

    def draw_title(text, size=28):
        c.setFont("Helvetica-Bold", size)
        c.drawString(0.8 * inch, H - 1.1 * inch, text)

    def draw_paragraphs(lines, style, top, bullet=True, width=W - 1.6 * inch):
        y = top
        for line in lines:
            p = Paragraph(("• " if bullet else "") + line, style)
            _, ph = p.wrap(width, 5 * inch)
            y -= ph
            p.drawOn(c, 0.8 * inch, y)
            y -= 6
        return y

    def draw_table(rows, top):
        t = Table(rows, colWidths=[2.0 * inch, 6.5 * inch, 3.0 * inch] if len(rows[0]) == 3 else [5.0 * inch, 3.0 * inch])
        t.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 14),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 14),
            ("GRID", (0, 0), (-1, -1), 0.75, colors.black),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF0F4")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 8),
        ]))
        _, th = t.wrap(W, H)
        t.drawOn(c, 0.8 * inch, top - th)

    for spec in SLIDES:
        if spec.get("image"):
            c.drawImage(image_path, 1.5 * inch, 1.0 * inch, width=10.3 * inch, height=10.3 * inch * 560 / 1200)
            c.showPage()
            continue
        if "subtitle" in spec:
            draw_title(spec["title"], 34)
            c.setFont("Helvetica", 18)
            c.drawString(0.8 * inch, H - 1.8 * inch, spec["subtitle"])
            c.showPage()
            continue
        draw_title(spec["title"])
        top = H - 1.6 * inch
        if "bullets" in spec:
            draw_paragraphs(spec["bullets"], body, top)
        if "table" in spec:
            draw_table(spec["table"], top)
        if "notes" in spec:
            c.setStrokeColor(colors.grey)
            c.line(0.8 * inch, 1.5 * inch, W - 0.8 * inch, 1.5 * inch)
            c.setFont("Helvetica-Bold", 11)
            c.drawString(0.8 * inch, 1.3 * inch, "Speaker notes")
            draw_paragraphs(spec["notes"], notes_style, 1.2 * inch, bullet=False)
        c.showPage()
    c.save()


def main():
    os.makedirs(DOCS, exist_ok=True)
    image_path = os.path.join(HERE, "ingest-142", "docs", "architecture.png")
    architecture_png(image_path)
    build_pptx(image_path)
    build_pdf(image_path)
    os.remove(image_path)
    print(f"wrote {PPTX}\nwrote {PDF}")


if __name__ == "__main__":
    main()
