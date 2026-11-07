"""No models: a short tone per word, so the whole pipeline can be tested anywhere (CI included)."""

import time

import numpy as np

from .voices import available


class FakeTts:
    backend = "fake"
    device = "cpu"
    model_id = "fake"
    sample_rate = 24000

    def load(self) -> None:
        pass

    def warm(self) -> None:
        pass

    def synth(self, text: str, voice: str):
        if voice not in available():
            raise ValueError(f"unknown voice {voice!r}")
        pitch = 180 + (sum(map(ord, voice)) % 8) * 30
        for _word in text.split()[:40]:
            t = np.arange(int(self.sample_rate * 0.18)) / self.sample_rate
            time.sleep(0.03)
            yield (0.08 * np.sin(2 * np.pi * pitch * t) * np.hanning(t.size)).astype(np.float32)
