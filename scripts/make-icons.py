#!/usr/bin/env python3
"""Generate PWA / home-screen icons -> assets/icon-{512,192,180}.png + a favicon (icon-32.png).
The mark: the football pitch's centre circle — centre circle + halfway line + kick-off spot — in trophy gold,
centred on a deep green-ink ground. Abstract, premium, no clip-art; pure geometry so it stays razor-sharp at
any size. Content sits inside the maskable safe circle. Supersampled 2x for smooth edges."""
from PIL import Image, ImageDraw

GOLD = (232, 185, 49)
CTR, EDG = (18, 70, 58), (6, 20, 26)      # floodlit centre -> deep ink edges (radial vignette, premium depth)

def ground(S):
    s = 112                               # compute small, upscale smooth
    base = Image.new("RGB", (s, s))
    cx, cy = s * 0.5, s * 0.42            # light source slightly above centre
    maxd = (max(cx, s - cx) ** 2 + max(cy, s - cy) ** 2) ** 0.5
    for y in range(s):
        for x in range(s):
            d = min(1.0, (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / maxd)
            base.putpixel((x, y), tuple(int(CTR[j] + (EDG[j] - CTR[j]) * d) for j in range(3)))
    return base.resize((S, S), Image.LANCZOS)

def pitch_mark(d, S, cy, r, lw, line_half):
    cap = lw / 2
    # halfway line with rounded caps
    d.line([(S / 2 - line_half, cy), (S / 2 + line_half, cy)], fill=GOLD, width=lw)
    for ex in (S / 2 - line_half, S / 2 + line_half):
        d.ellipse([ex - cap, cy - cap, ex + cap, cy + cap], fill=GOLD)
    d.ellipse([S / 2 - r, cy - r, S / 2 + r, cy + r], outline=GOLD, width=lw)      # centre circle
    sp = lw * 1.2
    d.ellipse([S / 2 - sp, cy - sp, S / 2 + sp, cy + sp], fill=GOLD)               # kick-off spot

def make(size, favicon=False):
    S = 1024
    img = ground(S); d = ImageDraw.Draw(img)
    if favicon:
        pitch_mark(d, S, S * 0.50, r=S * 0.27, lw=round(S * 0.052), line_half=S * 0.40)
    else:
        pitch_mark(d, S, S * 0.50, r=S * 0.215, lw=round(S * 0.028), line_half=S * 0.42)   # edge-to-edge halfway line
    return img.resize((size, size), Image.LANCZOS)

for s in (512, 192, 180):
    make(s).save(f"assets/icon-{s}.png"); print("wrote", f"assets/icon-{s}.png")
make(32, favicon=True).save("assets/icon-32.png"); print("wrote assets/icon-32.png (favicon)")
