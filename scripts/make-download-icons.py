#!/usr/bin/env python3
# /download 운영체제 그림을 생성한다. 실행: python -I scripts/make-download-icons.py (Pillow).
from math import sin, pi
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

OUT = Path(__file__).resolve().parents[1] / 'web' / 'icons' / 'download'
SCALE = 4
SIZE = 64 * SCALE


def coords(*points):
    return tuple(round(point * SCALE) for point in points)


def windows(draw):
    for x, y in ((17, 17), (33, 17), (17, 33), (33, 33)):
        draw.rounded_rectangle(coords(x, y, x + 14, y + 14), radius=2 * SCALE, fill=255)


def mac(draw):
    draw.rounded_rectangle(coords(15, 17, 49, 40), radius=5 * SCALE, outline=255, width=3 * SCALE)
    draw.line(coords(32, 40, 32, 47), fill=255, width=3 * SCALE)
    draw.rounded_rectangle(coords(23, 46, 41, 49), radius=1.5 * SCALE, fill=255)


def android(draw):
    draw.line(coords(19, 19, 24, 27), fill=255, width=2 * SCALE)
    draw.line(coords(45, 19, 40, 27), fill=255, width=2 * SCALE)
    draw.pieslice(coords(15, 24, 49, 57), 180, 360, fill=255)
    draw.rounded_rectangle(coords(15, 38, 49, 43), radius=2 * SCALE, fill=255)
    for x in (25, 39):
        draw.ellipse(coords(x - 1.5, 33, x + 1.5, 36), fill=0)


def gradient(top, bottom):
    return ImageOps.colorize(Image.linear_gradient('L').resize((SIZE, SIZE)), top, bottom).convert('RGBA')


def frame(draw_glyph, lift):
    tile = gradient('#FBF6FF', '#EEDFFA')
    tile_mask = Image.new('L', tile.size)
    ImageDraw.Draw(tile_mask).rounded_rectangle(coords(1, 1, 63, 63), radius=15 * SCALE, fill=255)
    tile.putalpha(tile_mask)

    glyph = Image.new('L', tile.size)
    draw_glyph(ImageDraw.Draw(glyph))
    moved = Image.new('L', tile.size)
    moved.paste(glyph, (0, -round(lift * SCALE)))

    shadow = Image.new('RGBA', tile.size, '#8A40D1')
    shadow_mask = Image.new('L', tile.size)
    shadow_mask.paste(moved, (0, 2 * SCALE))
    shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(2.5 * SCALE)).point(lambda value: value // 3))
    tile.alpha_composite(shadow)

    foreground = gradient('#9562F6', '#5420BA')
    foreground.putalpha(moved)
    tile.alpha_composite(foreground)
    return tile.resize((128, 128), Image.Resampling.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for draw_glyph in (windows, mac, android):
        name = draw_glyph.__name__
        # 제자리에서 시작해 한 번 살짝 떠올랐다가 돌아온다.
        frames = [frame(draw_glyph, 3 * sin(pi * step / 22) ** 2) for step in range(23)]
        frames[0].save(OUT / f'{name}.png', optimize=True)
        frames[0].save(
            OUT / f'{name}.webp', save_all=True, append_images=frames[1:],
            duration=[150] + [55] * 21 + [250], loop=1, quality=82, method=4,
        )


if __name__ == '__main__':
    main()
