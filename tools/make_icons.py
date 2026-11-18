#!/usr/bin/env python3
"""Genera le icone PWA, iOS e favicon di GT-Graphic dal logo ufficiale.

Sorgente: assets/brand/LOGO_GRAPHIC.png
Uso: python3 tools/make_icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "brand" / "LOGO_GRAPHIC.png"
OUT = ROOT / "assets" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

logo = Image.open(SRC).convert("RGB")
BG = logo.getpixel((4, 4))

# Ritaglio del solo simbolo (diamante + GT), senza il wordmark GRAPHIC.
MARK_BOX = (190, 190, 1065, 1015)
# Ritaglio del lockup completo con margini ridotti: più leggibile a 180-192 px.
ICON_BOX = (107, 130, 1147, 1170)


def full(size):
    return logo.crop(ICON_BOX).resize((size, size), Image.LANCZOS)


def maskable(size):
    """Logo all'80% su tela quadrata: rispetta la safe zone delle icone adattive."""
    canvas = Image.new("RGB", (size, size), BG)
    inner = int(round(size * 0.80))
    canvas.paste(full(inner), ((size - inner) // 2, (size - inner) // 2))
    return canvas


mark_src = logo.crop(MARK_BOX)
mark_canvas = Image.new("RGB", (1050, 1050), BG)
mark_canvas.paste(
    mark_src,
    ((1050 - mark_src.width) // 2, (1050 - mark_src.height) // 2),
)
mark = mark_canvas.resize((256, 256), Image.LANCZOS)

full(1024).save(OUT / "icon-1024.png", optimize=True)
full(512).save(OUT / "icon-512.png", optimize=True)
full(192).save(OUT / "icon-192.png", optimize=True)
full(180).save(OUT / "apple-touch-icon.png", optimize=True)
maskable(512).save(OUT / "icon-maskable-512.png", optimize=True)
mark.save(OUT / "logo-mark.png", optimize=True)
mark.resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)
mark.resize((16, 16), Image.LANCZOS).save(OUT / "favicon-16.png", optimize=True)
mark.resize((64, 64), Image.LANCZOS).save(
    OUT / "favicon.ico",
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
)

print("Icone generate in", OUT)
for p in sorted(OUT.glob("*")):
    print(f"  {p.name:26s} {p.stat().st_size/1024:7.1f} KB")
