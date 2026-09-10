"""Render the Glossa icon set as transparent RGBA PNGs.

The tile is a rounded square with the brand gradient and the glyphs "文" and "A": the two scripts
read as "translation" at every size. Everything outside the tile has alpha 0 so the icon composites
onto any toolbar or README background.

Usage: python tools/icons.py
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "extension" / "icons"
SIZES = (16, 32, 48, 128, 256, 512)
MASTER = 1024

ACCENT_TOP = (124, 108, 242)
ACCENT_BOTTOM = (84, 70, 200)
INK = (255, 255, 255)

FONTS = os.environ.get("WINDIR", r"C:\Windows") + r"\Fonts"
LATIN_FONT = Path(FONTS) / "segoeuib.ttf"
CJK_FONT_CANDIDATES = [Path(FONTS) / "YuGothB.ttc", Path(FONTS) / "msyhbd.ttc", Path(FONTS) / "msyh.ttc", Path(FONTS) / "simhei.ttf"]


def load_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def cjk_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in CJK_FONT_CANDIDATES:
        if candidate.exists():
            return load_font(candidate, size)
    raise SystemExit("No CJK-capable font found; install a Japanese or Chinese UI font")


def gradient_tile(size: int, radius: int) -> Image.Image:
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size))
    px = gradient.load()
    for y in range(size):
        t = y / (size - 1)
        r = round(ACCENT_TOP[0] * (1 - t) + ACCENT_BOTTOM[0] * t)
        g = round(ACCENT_TOP[1] * (1 - t) + ACCENT_BOTTOM[1] * t)
        b = round(ACCENT_TOP[2] * (1 - t) + ACCENT_BOTTOM[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    tile.paste(gradient, (0, 0), mask)
    return tile


def draw_glyphs(tile: Image.Image) -> None:
    size = tile.size[0]
    draw = ImageDraw.Draw(tile)
    cjk = cjk_font(int(size * 0.46))
    latin = load_font(LATIN_FONT, int(size * 0.50))
    # 文 upper-left, A lower-right, with a thin diagonal rule between them.
    draw.text((size * 0.14, size * 0.10), "文", font=cjk, fill=INK)
    draw.text((size * 0.50, size * 0.40), "A", font=latin, fill=INK)
    rule_width = max(4, size // 64)
    draw.line((size * 0.40, size * 0.80, size * 0.62, size * 0.22), fill=(255, 255, 255, 150), width=rule_width)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = gradient_tile(MASTER, radius=int(MASTER * 0.22))
    draw_glyphs(master)
    master.save(OUT / "icon-1024.png")
    for size in SIZES:
        resized = master.resize((size, size), Image.LANCZOS)
        resized.save(OUT / f"icon-{size}.png")
    for size in (*SIZES, MASTER):
        with Image.open(OUT / f"icon-{size}.png") as check:
            if check.mode != "RGBA":
                raise SystemExit(f"icon-{size}.png is {check.mode}, expected RGBA")
            if check.getpixel((0, 0))[3] != 0:
                raise SystemExit(f"icon-{size}.png corner is not transparent")
    print(f"icons: wrote {len(SIZES) + 1} RGBA PNGs to {OUT}")


if __name__ == "__main__":
    main()
