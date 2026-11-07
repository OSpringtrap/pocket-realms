"""The reference voices: voice/voices/<name>.wav plus <name>.txt (what the clip says).

Each voice was designed once from a text description (Qwen3-TTS VoiceDesign, see
tools/design_voices.py) and is cloned for every line by the Base model, so a voice stays the same
from line to line (solo-dm's "design once, then clone"). Only the Base model is needed to play.
"""

import math
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent.parent / "voices"
CODEC_HZ = 12.5
CHARS_PER_S = 15.0


def available() -> dict[str, tuple[Path, str]]:
    out = {}
    for wav in sorted(VOICE_DIR.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if txt.exists():
            out[wav.stem] = (wav, txt.read_text(encoding="utf-8").strip())
    return out


def max_codec_tokens(text: str) -> int:
    """At most twice the expected duration plus 1.5 s: text that is not words can otherwise babble
    for many seconds (measured in solo-dm)."""
    return math.ceil(CODEC_HZ * (2 * len(text) / CHARS_PER_S + 1.5))
