"""Genera los íconos de la app (logo «MS» de Materiales SAP (adaptado de Registro Operacional)). Requiere Pillow.

Uso: python herramientas/generar_iconos.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TEXTO = "MS"
DESTINO = Path(__file__).resolve().parent.parent / "icons"
AZUL, AZUL2, VERDE = (11, 37, 69), (19, 49, 92), (30, 142, 62)


def fuente(px: int):
    for f in ("arialbd.ttf", "C:/Windows/Fonts/arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            continue
    return ImageFont.load_default()


def dibujar(n: int, maskable: bool) -> Image.Image:
    im = Image.new("RGB", (n, n), AZUL)
    d = ImageDraw.Draw(im)
    m = int(n * (0.22 if maskable else 0.12))  # zona segura para íconos maskable
    d.rounded_rectangle([m, m, n - m, n - m], radius=int(n * 0.08), fill=AZUL2, outline=VERDE, width=max(2, n // 40))
    d.text((n / 2, n / 2 - n * 0.03), TEXTO, font=fuente(int((n - 2 * m) * 0.40)), fill="white", anchor="mm")
    alto = max(3, n // 28)
    y = n - m - int((n - 2 * m) * 0.2)
    d.rectangle([n * 0.36, y, n * 0.64, y + alto], fill=VERDE)
    return im


def guardar(im: Image.Image, nombre: str) -> None:
    im.quantize(colors=32, method=Image.Quantize.MEDIANCUT).save(DESTINO / nombre, optimize=True)


if __name__ == "__main__":
    DESTINO.mkdir(exist_ok=True)
    guardar(dibujar(192, False), "icon-192.png")
    guardar(dibujar(512, False), "icon-512.png")
    guardar(dibujar(512, True), "icon-maskable-512.png")
    guardar(dibujar(180, True), "apple-touch-icon.png")
    print("Íconos generados en", DESTINO)
