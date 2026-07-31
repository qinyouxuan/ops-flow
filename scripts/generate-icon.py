# SPDX-License-Identifier: MPL-2.0

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
PNG_PATH = BUILD_DIR / "icon-1024.png"
ICO_PATH = BUILD_DIR / "icon.ico"
CANVAS_SIZE = 1024


def interpolate(start, end, ratio):
    return tuple(round(a + (b - a) * ratio) for a, b in zip(start, end))


def draw_cube(draw, center_x, center_y, width, height, outline, accent):
    half_width = width // 2
    top = (center_x, center_y - height // 2)
    left = (center_x - half_width, center_y - height // 6)
    middle = (center_x, center_y + height // 7)
    right = (center_x + half_width, center_y - height // 6)
    lower_left = (center_x - half_width, center_y + height // 3)
    bottom = (center_x, center_y + (height * 2) // 3)
    lower_right = (center_x + half_width, center_y + height // 3)

    draw.polygon([top, left, middle, right], fill=(103, 232, 249, 34))
    draw.polygon([left, lower_left, bottom, middle], fill=(236, 254, 255, 22))
    draw.polygon([middle, bottom, lower_right, right], fill=(14, 165, 233, 30))

    outer = [top, left, lower_left, bottom, lower_right, right, top]
    draw.line(outer, fill=outline, width=48, joint="curve")
    draw.line([left, middle, right], fill=outline, width=48, joint="curve")
    draw.line([top, middle, bottom], fill=accent, width=42, joint="curve")


def create_icon():
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    mask = Image.new("L", canvas.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((48, 48, 976, 976), radius=216, fill=255)

    gradient = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    top_color = (8, 77, 112, 255)
    bottom_color = (13, 148, 136, 255)
    for y in range(CANVAS_SIZE):
        gradient_draw.line(
            (0, y, CANVAS_SIZE, y),
            fill=interpolate(top_color, bottom_color, y / (CANVAS_SIZE - 1)),
        )
    canvas.alpha_composite(Image.composite(gradient, Image.new("RGBA", canvas.size), mask))

    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((85, -250, 939, 520), fill=(125, 211, 252, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    glow.putalpha(Image.composite(glow.getchannel("A"), Image.new("L", canvas.size), mask))
    canvas.alpha_composite(glow)

    icon_draw = ImageDraw.Draw(canvas, "RGBA")
    icon_draw.rounded_rectangle(
        (58, 58, 966, 966),
        radius=206,
        outline=(165, 243, 252, 95),
        width=10,
    )

    outline = (236, 254, 255, 255)
    accent = (103, 232, 249, 255)
    draw_cube(icon_draw, 512, 275, 270, 250, outline, accent)
    draw_cube(icon_draw, 350, 570, 270, 250, outline, accent)
    draw_cube(icon_draw, 674, 570, 270, 250, outline, accent)

    canvas.save(PNG_PATH, "PNG", optimize=True)
    canvas.save(
        ICO_PATH,
        "ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    create_icon()
