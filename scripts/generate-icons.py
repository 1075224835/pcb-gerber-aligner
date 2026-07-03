from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"
PUBLIC_DIR = ROOT / "public"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((48, 48, size - 48, size - 48), radius=radius, fill=255)
    return mask


def draw_glow(draw: ImageDraw.ImageDraw, xy, color, width):
    for extra, alpha in ((42, 28), (24, 48), (12, 78)):
        glow = (*color[:3], alpha)
        draw.line(xy, fill=glow, width=width + extra, joint="curve")
    draw.line(xy, fill=color, width=width, joint="curve")


def make_base_icon() -> Image.Image:
    size = 1024
    mask = rounded_mask(size, 220)
    background = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            teal = int(26 + 34 * (1 - y / size) + 20 * (x / size))
            blue = int(34 + 28 * (y / size))
            pixels[x, y] = (13, teal, blue, 255)
    background.alpha_composite(gradient)
    background.putalpha(mask)

    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    glow_draw.ellipse((600, 82, 860, 342), fill=(20, 184, 166, 72))
    glow_draw.ellipse((560, 510, 1020, 970), fill=(56, 189, 248, 42))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(36))
    glow_layer.putalpha(Image.composite(glow_layer.getchannel("A"), Image.new("L", (size, size), 0), mask))
    background.alpha_composite(glow_layer)

    draw = ImageDraw.Draw(background)

    for value in range(146, 900, 126):
        draw.line((value, 96, value, 928), fill=(148, 163, 184, 42), width=4)
        draw.line((96, value, 928, value), fill=(148, 163, 184, 32), width=4)

    board = [(248, 266), (696, 196), (812, 650), (360, 736)]
    draw.polygon(board, fill=(17, 94, 89, 222))
    draw.line(board + [board[0]], fill=(94, 234, 212, 255), width=44, joint="curve")

    draw_glow(
        draw,
        [(302, 358), (430, 354), (508, 448), (690, 430)],
        (94, 234, 212, 255),
        30,
    )
    draw_glow(
        draw,
        [(344, 612), (496, 558), (590, 642), (744, 604)],
        (52, 211, 153, 255),
        34,
    )
    draw_glow(
        draw,
        [(452, 266), (486, 390), (560, 420), (606, 542)],
        (56, 189, 248, 255),
        26,
    )

    for x, y, radius in (
        (318, 354, 38),
        (430, 354, 30),
        (690, 430, 34),
        (496, 558, 32),
        (744, 604, 34),
        (606, 542, 30),
    ):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(15, 23, 42, 255))
        draw.ellipse(
            (x - radius + 9, y - radius + 9, x + radius - 9, y + radius - 9),
            outline=(250, 204, 21, 255),
            width=12,
        )

    draw.line((144, 744, 880, 744), fill=(56, 189, 248, 235), width=28)
    draw.line((192, 814, 756, 814), fill=(56, 189, 248, 135), width=18)
    draw.line((420, 140, 782, 864), fill=(248, 250, 252, 68), width=18)

    cx, cy = 592, 484
    draw.ellipse((cx - 86, cy - 86, cx + 86, cy + 86), outline=(250, 204, 21, 255), width=26)
    draw.line((cx - 134, cy, cx - 48, cy), fill=(250, 204, 21, 255), width=18)
    draw.line((cx + 48, cy, cx + 134, cy), fill=(250, 204, 21, 255), width=18)
    draw.line((cx, cy - 134, cx, cy - 48), fill=(250, 204, 21, 255), width=18)
    draw.line((cx, cy + 48, cx, cy + 134), fill=(250, 204, 21, 255), width=18)

    draw.rounded_rectangle((48, 48, size - 48, size - 48), radius=220, outline=(94, 234, 212, 180), width=18)
    return background


def write_pngs(base: Image.Image) -> None:
    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, size in sizes.items():
        icon = base.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(ICON_DIR / name)


def write_ico(base: Image.Image) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(ICON_DIR / "icon.ico", sizes=sizes)


def write_icns(base: Image.Image) -> None:
    base.save(ICON_DIR / "icon.icns", format="ICNS")


def write_favicon() -> None:
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
      <stop stop-color="#164E63"/>
      <stop offset="1" stop-color="#0F172A"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#bg)" stroke="#5EEAD4" stroke-width="2"/>
  <path d="M17 22 42 17 49 41 23 47Z" fill="#115E59" stroke="#5EEAD4" stroke-width="4" stroke-linejoin="round"/>
  <path d="M20 28h10l7 8h11M24 42l13-5 8 6" fill="none" stroke="#5EEAD4" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10 48h44M15 53h34" stroke="#38BDF8" stroke-width="3" stroke-linecap="round"/>
  <circle cx="38" cy="32" r="7" fill="none" stroke="#FACC15" stroke-width="3"/>
  <path d="M38 21v6M38 37v6M27 32h6M43 32h6" stroke="#FACC15" stroke-width="2.6" stroke-linecap="round"/>
</svg>
"""
    (PUBLIC_DIR / "favicon.svg").write_text(svg, encoding="utf-8")


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    base = make_base_icon()
    write_pngs(base)
    write_ico(base)
    write_icns(base)
    write_favicon()


if __name__ == "__main__":
    main()
