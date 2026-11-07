"""Apple Silicon: Qwen3-TTS Base over mlx-audio, streamed in 0.32 s chunks (as in solo-dm)."""

import gc
import time

import numpy as np

from .protocol import to_mono_float32
from .voices import available, max_codec_tokens

CLONE_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit"
STREAMING_INTERVAL = 0.32


class MlxTts:
    backend = "mlx"

    def __init__(self, model: str | None = None):
        self.model_id = model or CLONE_MODEL
        self.device = "metal"
        self.model = None
        self.sample_rate = 24000
        self._refs: dict[str, tuple] = {}

    def load(self) -> None:
        import mlx.core as mx
        from mlx_audio.tts.utils import load_model
        gc.collect()
        mx.clear_cache()
        self.model = load_model(self.model_id)
        self.sample_rate = self.model.sample_rate

    def _ref(self, voice: str):
        import mlx.core as mx
        import soundfile as sf
        if voice not in self._refs:
            voices = available()
            if voice not in voices:
                raise ValueError(f"unknown voice {voice!r}")
            wav, text = voices[voice]
            audio, _ = sf.read(str(wav), dtype="float32")
            self._refs[voice] = (mx.array(to_mono_float32(audio)), text)
        return self._refs[voice]

    def synth(self, text: str, voice: str):
        """Yields mono float32 chunks."""
        ref_audio, ref_text = self._ref(voice)
        for r in self.model.generate(text=text, ref_audio=ref_audio, ref_text=ref_text, lang_code="english",
                                     max_tokens=max_codec_tokens(text), stream=True,
                                     streaming_interval=STREAMING_INTERVAL):
            yield to_mono_float32(np.asarray(r.audio))

    def warm(self) -> None:
        t0 = time.perf_counter()
        for _ in self.synth("Ready.", "narrator"):
            pass
        print(f"warm-up {time.perf_counter() - t0:.2f}s", flush=True)
