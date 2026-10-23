"""Makes the small test library in tests/fixtures/library/ (comics, a PDF, an EPUB).
Run it from anywhere (in Thonny: just press Run). It overwrites the old fixtures.
Needs Pillow and reportlab:  pip install pillow reportlab
"""

import io
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

# ---- settings ----
LIBRARY = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "library"
COMIC_PAGES = 11          # page names run page1 ... page11, so "page10" must sort after "page9"
PAGE_SIZE = (600, 900)    # comic page in pixels (width, height)
COLORS = ["#c8452c", "#1565c0", "#2e7d32", "#d9a441", "#6a1b9a", "#00838f"]


def font(size):
    for name in ["DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def page_png(n, label, size=PAGE_SIZE):
    """One comic page: a colored panel with a big page number, so tests can check which page is showing."""
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    w, h = size
    d.rectangle([30, 30, w - 30, h - 30], outline="black", width=6)
    d.rectangle([60, 60, w - 60, h // 2], fill=COLORS[n % len(COLORS)])
    d.text((w // 2, h * 0.68), str(n), fill="black", font=font(160), anchor="mm")
    d.text((w // 2, h * 0.88), label, fill="black", font=font(28), anchor="mm")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_cbz(path, pages, label):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        # written out of order on purpose: the reader must sort by name, naturally
        for n in reversed(range(1, pages + 1)):
            z.writestr(f"{label}/page{n}.png", page_png(n, label), compress_type=zipfile.ZIP_STORED if n % 2 else zipfile.ZIP_DEFLATED)
        z.writestr("ComicInfo.xml", "<ComicInfo><Title>" + label + "</Title></ComicInfo>")
        z.writestr("__MACOSX/._page1.png", b"junk")


def make_pdf(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=letter)
    for n in range(1, 4):
        if n == 3:
            c.setPageSize(landscape(letter))
        w, h = c._pagesize
        c.setFont("Helvetica-Bold", 40)
        c.drawString(72, h - 110, f"Field Guide, page {n}")
        c.setFont("Helvetica", 14)
        for line in range(18):
            c.drawString(72, h - 170 - line * 22, "The quick brown fox jumps over the lazy dog. " * 2)
        c.showPage()
    c.save()


def make_epub(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    cover = io.BytesIO()
    Image.new("RGB", (400, 600), "#6a1b9a").save(cover, "JPEG")
    files = {
        "META-INF/container.xml": '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        "OEBPS/content.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">novel</dc:identifier><dc:title>Novel</dc:title></metadata><manifest><item id="c" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
        "OEBPS/ch1.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Chapter one.</p></body></html>',
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name, text in files.items():
            z.writestr(name, text, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/images/cover.jpg", cover.getvalue())


if __name__ == "__main__":
    make_cbz(LIBRARY / "Comics" / "Saga Vol 1.cbz", COMIC_PAGES, "Saga")
    make_cbz(LIBRARY / "Comics" / "Minis" / "Tiny Tales.cbz", 2, "Tiny")
    make_pdf(LIBRARY / "Books" / "Field Guide.pdf")
    make_epub(LIBRARY / "Books" / "Novel.epub")
    (LIBRARY / "notes.txt").write_text("not a book")
    (LIBRARY / ".hidden.pdf").write_bytes(b"%PDF-1.4 hidden")
    print("Made the test library in", LIBRARY)
