"""Regenerate PWA icons: python gen_icons.py (needs Pillow; dev-only)."""
import os

from PIL import Image, ImageDraw

BLUE, WHITE = (28, 86, 214, 255), (255, 255, 255, 255)


def glyph(d, s, scale):
    """Route glyph (origin dot -> bend -> destination dot) centred in s x s."""
    c = s / 2
    u = s * scale / 100.0
    pts = [(c - 28 * u, c + 22 * u), (c - 28 * u, c - 6 * u), (c + 28 * u, c - 6 * u), (c + 28 * u, c - 22 * u)]
    d.line(pts, fill=WHITE, width=max(2, int(9 * u)), joint="curve")
    r = 13 * u
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
        r2 = r * 0.45
        d.ellipse([x - r2, y - r2, x + r2, y + r2], fill=BLUE)


def make(size, maskable, rounded):
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BLUE)
    else:
        d.rectangle([0, 0, s, s], fill=BLUE)  # full bleed (maskable / iOS)
    glyph(d, s, 0.62 if maskable else 0.9)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "icons")
    os.makedirs(out, exist_ok=True)
    make(192, False, True).save(os.path.join(out, "icon-192.png"))
    make(512, False, True).save(os.path.join(out, "icon-512.png"))
    make(192, True, False).save(os.path.join(out, "maskable-192.png"))
    make(512, True, False).save(os.path.join(out, "maskable-512.png"))
    make(180, False, False).save(os.path.join(out, "apple-touch-icon.png"))
