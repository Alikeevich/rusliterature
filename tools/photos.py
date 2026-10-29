"""Обрезает фотографии героев и авторов под сайт.

Исходники кладутся в photos/<person>.<jpg|png|webp>, где person - значение
поля person из data/characters.js (или из AUTHOR_PERSON).
Скрипт находит лицо, делает портрет 4:5 для карточки и квадрат для аватарки,
сохраняет их в img/people/ и обновляет data/photos.js.

Запуск: python3 tools/photos.py   (нужны pillow и opencv-python-headless)
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "photos"
OUT = ROOT / "img" / "people"
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".jfif"}

CARD_SIZE = (600, 750)
SQUARE_SIZE = 320


def find_face(img):
    gray = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    gray = cv2.equalizeHist(gray)
    min_side = max(24, min(gray.shape) // 12)
    faces = []
    for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + name)
        found = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side))
        faces.extend(found)
        if len(faces):
            break
    if not len(faces):
        return None
    return max(faces, key=lambda f: f[2] * f[3])


def crop_box(img_w, img_h, ratio, face, face_share, face_y):
    """Прямоугольник с соотношением ratio (w/h), где лицо занимает face_share высоты."""
    if face is None:
        h = min(img_h, img_w / ratio)
        w = h * ratio
        x = (img_w - w) / 2
        y = min((img_h - h) * 0.15, img_h - h)  # чуть выше центра
        return x, y, w, h

    fx, fy, fw, fh = face
    h = min(fh / face_share, img_h, img_w / ratio)
    w = h * ratio
    cx, cy = fx + fw / 2, fy + fh / 2
    x = min(max(cx - w / 2, 0), img_w - w)
    y = min(max(cy - h * face_y, 0), img_h - h)
    return x, y, w, h


def process(path):
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    face = find_face(img)
    person = path.stem.lower()
    OUT.mkdir(parents=True, exist_ok=True)

    x, y, w, h = crop_box(img.width, img.height, CARD_SIZE[0] / CARD_SIZE[1], face, 0.30, 0.36)
    card = img.crop((round(x), round(y), round(x + w), round(y + h))).resize(CARD_SIZE, Image.LANCZOS)
    card.save(OUT / f"{person}.webp", "WEBP", quality=82, method=6)

    x, y, w, h = crop_box(img.width, img.height, 1.0, face, 0.48, 0.45)
    sq = img.crop((round(x), round(y), round(x + w), round(y + h))).resize((SQUARE_SIZE, SQUARE_SIZE), Image.LANCZOS)
    sq.save(OUT / f"{person}-sq.webp", "WEBP", quality=82, method=6)

    note = "лицо найдено" if face is not None else "лицо НЕ найдено, обрезано по центру"
    print(f"{path.name}: {img.width}x{img.height}, {note}")


def main():
    files = sorted(p for p in SRC.glob("*") if p.suffix.lower() in EXTS) if SRC.exists() else []
    for path in files:
        process(path)

    people = sorted(p.stem for p in OUT.glob("*.webp") if not p.stem.endswith("-sq")) if OUT.exists() else []
    (ROOT / "data" / "photos.js").write_text(
        "// Список фотографий, которые есть в img/people. Обновляется скриптом tools/photos.py.\n"
        f"export const PHOTOS = {json.dumps(people, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"Готово: {len(files)} обработано, всего фото на сайте: {len(people)}")


if __name__ == "__main__":
    sys.exit(main())
