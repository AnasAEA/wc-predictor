#!/usr/bin/env python3
"""Synthesize a gentle, seamless-looping 8s ambient anthem -> /tmp/anthem.wav.
Pure stdlib (no numpy). Encoded to assets/anthem.mp3 separately via lame/ffmpeg."""
import math, wave, struct

SR = 44100
BARS = [2.0, 2.0, 2.0, 2.0]          # 4 chords x 2s = 8s loop
TOTAL = sum(BARS)
N = int(SR * TOTAL)
buf = [0.0] * N

# I-V-vi-IV in D major: D, A, Bm, G  (triad + low root for warmth)
CHORDS = [
    [146.83, 293.66, 369.99, 440.00],   # D  (D3, D4, F#4, A4)
    [110.00, 220.00, 277.18, 329.63],   # A  (A2, A3, C#4, E4)
    [123.47, 246.94, 293.66, 369.99],   # Bm (B2, B3, D4, F#4)
    [ 98.00, 196.00, 246.94, 293.66],   # G  (G2, G3, B3, D4)
]
MELODY = [587.33, 659.25, 739.99, 587.33]  # D5, E5, F#5, D5 — soft bell on each chord

def smooth(x):  # 0..1 raised-cosine
    return 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, x)))

def add(idx, v):
    buf[idx % N] += v

t0 = 0.0
for ci, ch in enumerate(CHORDS):
    W = BARS[ci] + 0.6          # 0.6s overlap into the next bar -> crossfade (wraps at the seam)
    atk, rel = 0.45, 0.7
    base = int(t0 * SR)
    for n in range(int(W * SR)):
        t = n / SR
        env = smooth(t / atk) * (smooth((W - t) / rel) if t > W - rel else 1.0)
        if env <= 0:
            continue
        tabs = t0 + t
        s = 0.0
        for k, f in enumerate(ch):
            amp = 0.55 if k == 0 else 0.42   # root a touch louder
            w = 2 * math.pi * f * tabs
            s += amp * (math.sin(w) + 0.32 * math.sin(2 * w) + 0.12 * math.sin(3 * w))
        add(base + n, env * s * 0.12)
    # soft bell melody at the start of the bar
    mf = MELODY[ci]
    for n in range(int(1.4 * SR)):
        t = n / SR
        e = math.exp(-t / 0.5)
        tabs = t0 + 0.12 + t
        w = 2 * math.pi * mf * tabs
        add(base + int(0.12 * SR) + n, e * (math.sin(w) + 0.45 * math.sin(2 * w)) * 0.10)
    t0 += BARS[ci]

peak = max(1e-6, max(abs(v) for v in buf))
g = 0.72 / peak
with wave.open("/tmp/anthem.wav", "w") as wf:
    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
    wf.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v * g)) * 32767)) for v in buf))
print("wrote /tmp/anthem.wav", round(TOTAL, 1), "s")
