"""Draws the app icon and splash screens for the Android app (the same picture as www/icon.svg):
a page with lines of text and one red pen stroke across it, on the app's dark background.
Run it after changing the icon (in Thonny: just press Run). Needs Pillow:  pip install pillow
"""

from pathlib import Path

from PIL import Image, ImageDraw

# ---- settings ----
RES = Path(__file__).resolve().parent.parent / "android" / "app" / "src" / "main" / "res"
BG = "#15130f"
PAGE = "#ede6d8"
LINES = "#b7ad9c"
INK = "#c8452c"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def draw_mark(d, s, ox=0, oy=0, k=1.0):
    """The page and stroke, on a 64-unit grid scaled by s, offset by ox/oy, shrunk by k around the middle."""
    def P(x, y):
        return (ox + (32 + (x - 32) * k) * s, oy + (32 + (y - 32) * k) * s)
    d.rounded_rectangle([P(16, 11), P(46, 51)], radius=2 * s * k, fill=PAGE)
    for x0, x1, y in [(21, 41, 21), (21, 41, 27), (21, 35, 33)]:
        d.line([P(x0, y), P(x1, y)], fill=LINES, width=max(1, round(2.4 * s * k)))
    pts = [P(19 + t * 30, 44 - 20 * (t ** 0.8) - 3 * t * (1 - t)) for t in [i / 24 for i in range(25)]]
    d.line(pts, fill=INK, width=max(2, round(4 * s * k)), joint="curve")
    r = 2 * s * k
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=INK)


def legacy_icon(px, round_icon):
    big = px * 4   # draw large, then shrink, for smooth edges
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_icon:
        d.ellipse([0, 0, big - 1, big - 1], fill=BG)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.2, fill=BG)
    draw_mark(d, big / 64, k=0.86 if round_icon else 1.0)
    return img.resize((px, px), Image.LANCZOS)


def foreground(px):
    # adaptive icons: 108dp canvas, the middle 66dp is always visible
    big = px * 4
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(img), big / 64, k=0.62)
    return img.resize((px, px), Image.LANCZOS)


def splash(w, h):
    img = Image.new("RGB", (w, h), BG)
    s = min(w, h) / 64 * 0.28
    draw_mark(ImageDraw.Draw(img), s, ox=w / 2 - 32 * s, oy=h / 2 - 32 * s)
    return img


if __name__ == "__main__":
    for name, k in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(parents=True, exist_ok=True)
        legacy_icon(round(48 * k), False).save(folder / "ic_launcher.png")
        legacy_icon(round(48 * k), True).save(folder / "ic_launcher_round.png")
        foreground(round(108 * k)).save(folder / "ic_launcher_foreground.png")
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">' + BG + "</color>\n</resources>\n")
    # replace Capacitor's splash pictures (same sizes)
    for f in RES.glob("drawable*/splash.png"):
        with Image.open(f) as old:
            size = old.size
        splash(*size).save(f)
    print("Icons and splash screens written under", RES)
