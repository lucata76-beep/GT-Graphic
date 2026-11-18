#!/usr/bin/env python3
"""Genera le icone PWA di GT-Graphic (PNG 512/192/180)."""
from PIL import Image, ImageDraw
import math
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (13, 20, 28)
BORDER = (36, 50, 68)
GRID = (23, 34, 46)
CYAN = (34, 211, 238)
YELLOW = (251, 191, 36)
MAGENTA = (232, 121, 249)
ORANGE = (255, 107, 74)
WHITE = (230, 237, 243)


def dashed(draw, p0, p1, fill, width, dash=18, gap=12):
    x0, y0 = p0
    x1, y1 = p1
    total = math.hypot(x1 - x0, y1 - y0)
    if total == 0:
        return
    ux, uy = (x1 - x0) / total, (y1 - y0) / total
    t = 0.0
    while t < total:
        a = t
        b = min(t + dash, total)
        draw.line([(x0 + ux * a, y0 + uy * a), (x0 + ux * b, y0 + uy * b)], fill=fill, width=width)
        t += dash + gap


def draw_icon(size, maskable=False):
    scale = size / 512.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        d.rectangle([0, 0, size, size], fill=BG)
        content = 0.72
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(92 * scale), fill=BG, outline=BORDER, width=max(1, int(3 * scale)))
        content = 0.86

    # Griglia tecnica
    step = int(64 * scale)
    for x in range(step, size, step):
        d.line([(x, 0), (x, size)], fill=GRID, width=max(1, int(1 * scale)))
    for y in range(step, size, step):
        d.line([(0, y), (size, y)], fill=GRID, width=max(1, int(1 * scale)))

    # Centro e fattore di scala del contenuto
    cx = cy = size / 2.0
    s = scale * content

    def P(x, y):
        return (cx + (x - 256) * s, cy + (y - 256) * s)

    # Contorno pezzo (raccordo)
    box = [P(118, 156)[0], P(118, 156)[1], P(394, 348)[0], P(394, 348)[1]]
    d.rounded_rectangle(box, radius=int(46 * s), outline=CYAN, width=max(2, int(12 * s)))

    # Tasca circolare
    r = 54 * s
    ccx, ccy = P(256, 252)
    d.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], outline=YELLOW, width=max(2, int(10 * s)))

    # Arco interno (G03)
    ar = 78 * s
    d.arc([ccx - ar, ccy - ar, ccx + ar, ccy + ar], start=200, end=340, fill=MAGENTA, width=max(2, int(9 * s)))

    # Rapido tratteggiato + punto
    dashed(d, P(78, 420), P(150, 348), ORANGE, max(2, int(8 * s)), dash=18 * s, gap=13 * s)
    dot = 9 * s
    ox, oy = P(150, 348)
    d.ellipse([ox - dot, oy - dot, ox + dot, oy + dot], fill=ORANGE)

    # Origine pezzo
    ox, oy = P(118, 348)
    ln = 16 * s
    d.line([(ox - ln, oy), (ox + ln, oy)], fill=WHITE, width=max(2, int(5 * s)))
    d.line([(ox, oy - ln), (ox, oy + ln)], fill=WHITE, width=max(2, int(5 * s)))
    rr = 6 * s
    d.ellipse([ox - rr, oy - rr, ox + rr, oy + rr], outline=WHITE, width=max(1, int(3 * s)))

    return img


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)


base = draw_icon(512)
save(base, "icon-512.png", 512)
save(base, "icon-192.png", 192)
save(base, "apple-touch-icon.png", 180)

mask = draw_icon(512, maskable=True)
save(mask, "icon-maskable-512.png", 512)

print("Icone generate in", OUT)
