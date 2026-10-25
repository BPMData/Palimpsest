"""Makes the small test library in tests/fixtures/library/ (comics, a PDF, EPUBs, and files it can't open).
Run it from anywhere (in Thonny: just press Run). It overwrites the old fixtures.
Needs Pillow, reportlab and py7zr:  pip install pillow reportlab py7zr
"""

import io
import struct
import zipfile
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas
import py7zr

# ---- settings ----
LIBRARY = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "library"
COMIC_PAGES = 11          # page names run page1 ... page11, so "page10" must sort after "page9"
PAGE_SIZE = (600, 900)    # comic page in pixels (width, height)
EPUB_COMIC_PAGES = 4      # pages in the comic EPUB (plus a text credits page with no picture)
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


CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'


def make_comic_epub(path, pages, label):
    """A fixed-layout comic EPUB like Humble Bundle's: each page is a small XHTML file holding one picture.
    Odd pages wrap the picture in SVG, even pages use a plain <img>; both kinds are common."""
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest, spine, files = [], [], {}
    for n in range(1, pages + 1):
        manifest.append(f'<item id="img{n}" href="images/p{n:03}.png" media-type="image/png"{" properties=\"cover-image\"" if n == 1 else ""}/>')
        manifest.append(f'<item id="p{n}" href="xhtml/p{n:03}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="p{n}"/>')
        w, h = PAGE_SIZE
        pic = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}"><image width="{w}" height="{h}" xlink:href="../images/p{n:03}.png"/></svg>'
               if n % 2 else f'<img src="../images/p{n:03}.png" alt="Page {n}"/>')
        files[f"OEBPS/xhtml/p{n:03}.xhtml"] = f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{n}</title><meta name="viewport" content="width={w}, height={h}"/></head><body>{pic}</body></html>'
    manifest.append('<item id="credits" href="xhtml/credits.xhtml" media-type="application/xhtml+xml"/>')
    spine.append('<itemref idref="credits"/>')
    files["OEBPS/xhtml/credits.xhtml"] = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Thanks for reading.</p></body></html>'
    files["OEBPS/content.opf"] = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
        f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">{label}</dc:identifier><dc:title>{label}</dc:title>'
        '<meta property="rendition:layout">pre-paginated</meta></metadata>'
        f'<manifest>{"".join(manifest)}</manifest><spine>{"".join(spine)}</spine></package>')
    files["META-INF/container.xml"] = CONTAINER
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name, text in files.items():
            z.writestr(name, text, compress_type=zipfile.ZIP_DEFLATED)
        for n in range(1, pages + 1):
            z.writestr(f"OEBPS/images/p{n:03}.png", page_png(n, label))


def make_rar(path, pages, label):
    """A real RAR (version 4) comic. RAR is a closed format and there's no free tool that writes it, so this
    writes the simplest kind by hand: pictures stored as they are, not squeezed. Enough to test the reading."""
    path.parent.mkdir(parents=True, exist_ok=True)

    def block(head_type, flags, body, extra=b""):
        size = 7 + len(body)
        rest = struct.pack("<BHH", head_type, flags, size) + body
        return struct.pack("<H", zlib.crc32(rest) & 0xFFFF) + rest + extra

    out = bytearray(b"Rar!\x1a\x07\x00")                     # the RAR 4 marker
    out += block(0x73, 0, struct.pack("<HI", 0, 0))              # archive header
    for n in reversed(range(1, pages + 1)):                       # out of order on purpose, like the CBZ
        data, name = page_png(n, label), f"{label}/page{n}.png".encode()
        body = struct.pack("<IIBIIBBHI", len(data), len(data), 2, zlib.crc32(data), 0x5A210000, 20, 0x30, len(name), 0x20) + name
        out += block(0x74, 0x8000, body, data)                    # 0x8000: data follows; 0x30: stored
    out += bytes.fromhex("C43D7B00400700")                        # end of archive
    path.write_bytes(bytes(out))


def make_7z(path, pages, label, password=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with py7zr.SevenZipFile(path, "w", password=password) as z:
        for n in range(1, pages + 1):
            z.writestr(page_png(n, label), f"{label}/page{n}.png")


def make_picture_folder(folder, pages, label):
    """Loose pages in a folder, plus one small file that isn't a picture (it should still read as a comic)."""
    folder.mkdir(parents=True, exist_ok=True)
    for n in range(1, pages + 1):
        (folder / f"{label} {n:02}.png").write_bytes(page_png(n, label))
    (folder / "info.nfo").write_text("scanned by nobody")


def make_locked_epub(path):
    """A copy-protected EPUB as Adobe's DRM makes them: rights.xml, and its pages listed in encryption.xml.
    The 'encrypted' files are just random bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    junk = bytes((i * 73 + 41) % 256 for i in range(4000))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("META-INF/rights.xml", '<adept:rights xmlns:adept="http://ns.adobe.com/adept"/>')
        z.writestr("META-INF/encryption.xml", '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>')
        z.writestr("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">locked</dc:identifier><dc:title>Locked</dc:title></metadata><manifest><item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>')
        z.writestr("OEBPS/ch1.xhtml", junk)
        z.writestr("OEBPS/cover.jpg", junk)


if __name__ == "__main__":
    make_cbz(LIBRARY / "Comics" / "Saga Vol 1.cbz", COMIC_PAGES, "Saga")
    make_cbz(LIBRARY / "Comics" / "Minis" / "Tiny Tales.cbz", 2, "Tiny")
    make_pdf(LIBRARY / "Books" / "Field Guide.pdf")
    make_epub(LIBRARY / "Books" / "Novel.epub")
    make_comic_epub(LIBRARY / "Comics" / "Humble Comic.epub", EPUB_COMIC_PAGES, "Humble")
    make_locked_epub(LIBRARY / "Books" / "Locked.epub")
    make_rar(LIBRARY / "Comics" / "Old Comic.cbr", 3, "Rar")
    make_7z(LIBRARY / "Comics" / "Seven.cb7", 3, "Seven")
    make_cbz(LIBRARY / "Comics" / "Zip In Disguise.cbr", 2, "Disguise")   # a zip with a .cbr name, which is common
    make_picture_folder(LIBRARY / "Comics" / "Loose Pages", 3, "Loose")
    make_rar(LIBRARY / "Comics" / "Minis" / "Tiny Tales.cbr", 2, "Tiny")   # the CBZ beside it counts as its saved copy
    # files that should fail politely
    make_7z(LIBRARY / "Trouble" / "Secret.cb7", 2, "Secret", password="hunter2")
    (LIBRARY / "Trouble" / "Broken.cbr").write_bytes(bytes(range(256)) * 8)
    (LIBRARY / "Trouble" / "Some Book.mobi").write_bytes(b"BOOKMOBI pretend Kindle book")
    (LIBRARY / "notes.txt").write_text("not a book")
    (LIBRARY / "Thumbs.db").write_bytes(b"junk the computer made")
    (LIBRARY / ".hidden.pdf").write_bytes(b"%PDF-1.4 hidden")
    print("Made the test library in", LIBRARY)
