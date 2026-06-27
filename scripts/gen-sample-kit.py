#!/usr/bin/env python3
"""gen-sample-kit.py

Generate WAV files for the built-in sample-kit (mono 16 kHz PCM16 sine tones).

Spec (contracts/specs/sample-kit.md):
  - Sample rate : 16000 Hz
  - Channels    : 1 (mono) — install-clips for device flashing
  - Bit depth   : 16-bit PCM (pcm_s16le)
  - Duration    : 1.0 s
  - Amplitude   : 0.45 × full-scale  (peak = round(0.45 * 32767) = 14745)
  - No fade     : uniform amplitude throughout
  - Wave        : sample[i] = round(peak * sin(2π * f * i / 16000))

Output: public/sample-kit/install-clips/{sine_50hz,sine_100hz,sine_200hz}.wav
"""

import math
import os
import struct
import wave

SR = 16000          # sample rate (Hz) — matches device playback rate
DUR = 1.0           # seconds
AMP = 0.45          # peak amplitude (fraction of full scale)

FREQS = [
    (50.0,  "sine_50hz"),
    (100.0, "sine_100hz"),
    (200.0, "sine_200hz"),
]

OUT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "public", "sample-kit", "install-clips"
)


def gen_samples(freq: float) -> list[int]:
    n = int(SR * DUR)
    peak = round(AMP * 32767)
    return [round(math.sin(2.0 * math.pi * freq * (i / SR)) * peak) for i in range(n)]


def write_wav(path: str, samples: list[int]) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)       # mono
        w.setsampwidth(2)       # 16-bit PCM
        w.setframerate(SR)
        frames = bytearray()
        for v in samples:
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for freq, slug in FREQS:
        path = os.path.join(OUT_DIR, f"{slug}.wav")
        write_wav(path, gen_samples(freq))
        print(f"  wrote {slug}.wav ({freq} Hz, mono, {SR} Hz, PCM16)")
    print(f"Done: {len(FREQS)} tones -> {os.path.relpath(OUT_DIR)}")


if __name__ == "__main__":
    main()
