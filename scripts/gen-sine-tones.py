#!/usr/bin/env python3
"""gen-sine-tones.py

Generate a built-in Library template of pure sine tones for the Studio.

Output: public/library/clips/sine-tones/<slug>.wav
Spec   : 1.0 s, 16000 Hz, stereo (L=R), 16-bit PCM, ~0.45 full-scale,
         uniform amplitude (no fade — constant level for the whole 1 s).

Frequencies are the 1/3-octave-style set visible in the requested image
(20-200 Hz). Re-run after editing FREQS, then `npm run gen:library`
to refresh public/library/index.json.
"""

import math
import os
import struct
import wave

SR = 16000          # sample rate (Hz) — matches device playback
DUR = 1.0           # seconds
AMP = 0.45          # peak amplitude (fraction of full scale)

# (frequency Hz, filename slug). Slugs avoid '.' so the generated
# event_id stays "sine-tones.<slug>" (a single dot, per contracts).
FREQS = [
    (20.0,  "20hz"),
    (31.5,  "31_5hz"),
    (40.0,  "40hz"),
    (50.0,  "50hz"),
    (63.0,  "63hz"),
    (80.0,  "80hz"),
    (100.0, "100hz"),
    (125.0, "125hz"),
    (160.0, "160hz"),
    (200.0, "200hz"),
]

OUT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "public", "library", "clips", "sine-tones"
)


def gen_samples(freq):
    n = int(SR * DUR)
    peak = int(AMP * 32767)
    out = []
    for i in range(n):
        s = math.sin(2.0 * math.pi * freq * (i / SR))
        out.append(int(round(s * peak)))  # uniform amplitude, no fade
    return out


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(2)      # stereo (L=R)
        w.setsampwidth(2)      # 16-bit PCM
        w.setframerate(SR)
        frames = bytearray()
        for v in samples:
            b = struct.pack("<h", v)
            frames += b  # L
            frames += b  # R
        w.writeframes(bytes(frames))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for freq, slug in FREQS:
        path = os.path.join(OUT_DIR, f"{slug}.wav")
        write_wav(path, gen_samples(freq))
        print(f"  wrote {slug}.wav ({freq} Hz)")
    print(f"Done: {len(FREQS)} tones -> {os.path.relpath(OUT_DIR)}")


if __name__ == "__main__":
    main()
