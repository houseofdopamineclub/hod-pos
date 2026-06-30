from PIL import Image, ImageDraw, ImageFont

W = 576  # 80mm thermal @ 203dpi
BASE = 24
pad = 24

f_norm = ImageFont.load_default(size=BASE)
f_norm_b = ImageFont.load_default(size=BASE)
f_hdr = ImageFont.load_default(size=BASE + 6)


def text_strip(txt, font, bold=False, tracking=0):
    """Render text to its own RGBA strip with optional letter spacing.

    2026-06-30 (Khushi) — the big KOT lines printed too compact / letters
    touching. `tracking` = extra pixels added after every glyph (mirrors the
    real printer's ESC SP n char-spacing) so the preview shows the same airy,
    easy-to-read letters the floor printer now produces.
    """
    sw = 1 if bold else 0
    asc, desc = font.getmetrics()
    h = asc + desc + 4
    total = int(sum(font.getlength(ch) for ch in txt) + tracking * max(len(txt) - 1, 0)) + 4
    strip = Image.new("RGBA", (max(total, 1), h), (255, 255, 255, 0))
    ds = ImageDraw.Draw(strip)
    x = 2
    for ch in txt:
        ds.text((x, 2), ch, font=font, fill=(0, 0, 0, 255),
                stroke_width=sw, stroke_fill=(0, 0, 0, 255))
        x += font.getlength(ch) + tracking
    return strip


lines = []  # (kind, text)  kind: hdr, norm, div, note(2x), item(5x), gap

lines = [
    ("hdr", "HOUSE OF DOPAMINE"),
    ("norm", "KITCHEN ORDER TICKET (KOT)"),
    ("norm", "Table: C4   Round 2   9:42 PM"),
    ("div", ""),
    ("note", "** NOTE: MAKE IT SPICY **"),
    ("div", ""),
    ("item", "1 x SOUP"),
    ("item", "1 x COCKTAIL"),
    ("div", ""),
    ("norm", "Staff: Ravi   Token: 14"),
]

# build strips & measure total height
rendered = []
for kind, txt in lines:
    if kind == "div":
        rendered.append(("div", None))
        continue
    if kind == "hdr":
        s = text_strip(txt, f_hdr, bold=True, tracking=2)
    elif kind == "note":
        base = text_strip(txt, f_norm, bold=True, tracking=4)
        s = base.resize((base.width, base.height * 2), Image.NEAREST)
    elif kind == "item":
        base = text_strip(txt, f_norm, bold=True, tracking=6)
        s = base.resize((base.width, base.height * 5), Image.NEAREST)
    else:
        s = text_strip(txt, f_norm, bold=False, tracking=1)
    rendered.append((kind, s))

gap = 14
total_h = pad * 2
for kind, s in rendered:
    total_h += (2 if kind == "div" else s.height) + gap

img = Image.new("RGB", (W, total_h), (255, 255, 255))
draw = ImageDraw.Draw(img)
y = pad
for kind, s in rendered:
    if kind == "div":
        draw.line([(pad, y + 1), (W - pad, y + 1)], fill=(0, 0, 0), width=1)
        y += 2 + gap
        continue
    if kind == "hdr":
        x = (W - s.width) // 2
    else:
        x = pad
    img.paste(s, (x, y), s)
    y += s.height + gap

img.save("exports/kot-font-preview.png")
print("saved", img.size)
