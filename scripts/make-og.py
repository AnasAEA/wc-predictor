#!/usr/bin/env python3
"""Generate the 1200x630 social share card -> assets/og.png.
Rendered at 2x with the site's real Archivo display font, then downscaled (LANCZOS) for crisp type.
Palette + centre-circle mark mirror the site's dark theme."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 2                                  # supersample: render 2x, downscale = sharp text + geometry
W, H = 1200 * S, 630 * S
AB = "assets/fonts/archivo-700.woff"   # the site's display weight (woff loads in Pillow's FreeType)
AR = "assets/fonts/archivo-400.woff"
fb = lambda s: ImageFont.truetype(AB, int(s * S))
fr = lambda s: ImageFont.truetype(AR, int(s * S))
def T(v): return int(v * S)

GOLD = (232, 185, 49)

# vertical gradient: dark ink -> deep pitch green (the site's dark --paper into a pitch tint)
def vgrad(top, bot):
    g = Image.new("RGB", (1, H)); p = g.load()
    for y in range(H):
        t = y / H
        p[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    return g.resize((W, H))

def glow(img, color, cx, cy, r, alpha, blur):
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(ov).ellipse([T(cx) - T(r), T(cy) - T(r), T(cx) + T(r), T(cy) + T(r)], fill=color + (alpha,))
    ov = ov.filter(ImageFilter.GaussianBlur(T(blur)))
    img.paste(ov, (0, 0), ov)

def tracked(d, xy, text, font, fill, track):   # letter-spaced caps for a refined eyebrow / stat line
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + T(track)

# the site's logo: halfway line + centre circle + kick-off spot, off-canvas top-right
def centre_mark(img, color, alpha, cx, cy, R):
    m = Image.new("RGBA", (W, H), (0, 0, 0, 0)); md = ImageDraw.Draw(m)
    a = lambda f: int(alpha * f)
    md.ellipse([T(cx) - T(R + 115), T(cy) - T(R + 115), T(cx) + T(R + 115), T(cy) + T(R + 115)], outline=color + (a(0.16),), width=T(2))
    md.line([(T(cx) - T(R + 95), T(cy)), (T(cx) + T(R + 155), T(cy))], fill=color + (a(0.55),), width=T(9))
    md.ellipse([T(cx) - T(R), T(cy) - T(R), T(cx) + T(R), T(cy) + T(R)], outline=color + (a(0.85),), width=T(9))
    md.ellipse([T(cx) - T(14), T(cy) - T(14), T(cx) + T(14), T(cy) + T(14)], fill=color + (a(1.0),))
    img.paste(m, (0, 0), m)

img = vgrad((14, 24, 34), (8, 38, 30))
glow(img, (11, 163, 96), 70, 60, 360, 150, 110)     # green top-left
glow(img, GOLD, 1135, 600, 430, 130, 120)           # gold bottom-right
glow(img, (45, 212, 191), 1015, 60, 240, 80, 100)   # teal top-right
centre_mark(img, (255, 255, 255), 255, 1035, 150, 205)   # faint white halo under the mark
centre_mark(img, GOLD, 190, 1035, 150, 205)

d = ImageDraw.Draw(img)
x = T(84)
tracked(d, (x, T(96)), "JUNE 11 – JULY 19, 2026", fb(27), GOLD, 2.2)
d.text((x, T(140)), "FIFA World Cup", font=fb(80), fill=(233, 238, 242))
d.text((x, T(220)), "2026", font=fb(156), fill=(38, 222, 140), stroke_width=T(1.4), stroke_fill=(38, 222, 140))
tag = fr(30)
d.text((x, T(426)), "Live scores, lineups & stats, a win probability and a", font=tag, fill=(179, 192, 203))
d.text((x, T(466)), "predicted score for every match. Yours to follow & predict.", font=tag, fill=(179, 192, 203))
d.rectangle([x, T(538), x + T(300), T(541)], fill=GOLD)
tracked(d, (x, T(554)), "104 MATCHES    ·    48 TEAMS    ·    IN YOUR TIMEZONE", fb(23), (132, 150, 165), 1.4)

img = img.resize((1200, 630), Image.LANCZOS)
img.save("assets/og.png")
print("wrote assets/og.png", img.size)
