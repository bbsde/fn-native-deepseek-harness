# Generates the app icons: rounded-square gradient tile with a terminal
# chevron-and-underscore glyph (readable at 64px). Writes ICON.PNG / ICON_256.PNG
# at the fpk root and icon_64.png / icon_256.png under app/ui/images/.
import os

from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fpk")

# DeepSeek-ish blue gradient endpoints.
TOP = (35, 81, 217)
BOTTOM = (78, 167, 255)


def rounded_gradient(size, radius_ratio):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        for x in range(size):
            gradient.putpixel((x, y), color)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    image.paste(gradient, (0, 0), mask)
    return image


def draw_glyph(image):
    size = image.width
    draw = ImageDraw.Draw(image)
    stroke = max(2, round(size * 0.085))
    # Chevron ">": two lines meeting at mid-left, kept inside the safe area.
    left = size * 0.28
    mid_y = size * 0.46
    top = size * 0.28
    bottom = size * 0.64
    tip = size * 0.52
    draw.line([(left, top), (tip, mid_y)], fill=(255, 255, 255, 255), width=stroke)
    draw.line([(left, bottom), (tip, mid_y)], fill=(255, 255, 255, 255), width=stroke)
    # Underscore "_".
    draw.line(
        [(size * 0.56, bottom), (size * 0.74, bottom)],
        fill=(255, 255, 255, 255),
        width=stroke,
    )
    for cx, cy in [(left, top), (left, bottom), (tip, mid_y)]:
        r = stroke / 2
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    return image


targets = [
    (os.path.join(ROOT, "ICON.PNG"), 64),
    (os.path.join(ROOT, "ICON_256.PNG"), 256),
    (os.path.join(ROOT, "app", "ui", "images", "icon_64.png"), 64),
    (os.path.join(ROOT, "app", "ui", "images", "icon_256.png"), 256),
]
for path, size in targets:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    draw_glyph(rounded_gradient(size, 0.22)).save(path)
    print(f"wrote {os.path.relpath(path, ROOT)} ({size}x{size})")
