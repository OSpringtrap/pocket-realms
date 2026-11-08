"""NVIDIA (CUDA), AMD (ROCm) or CPU: Qwen3-TTS Base over the official qwen-tts package (PyTorch).

PyTorch's ROCm build exposes AMD GPUs through torch.cuda, so one code path serves both vendors.
qwen-tts returns whole utterances rather than a stream; the game speaks one sentence at a time,
so a sentence is one chunk. On CPU the smaller 0.6B Base is used because 1.7B is far slower than
real time there.
"""

import time

from .protocol import to_mono_float32
from .voices import available, max_codec_tokens

GPU_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
CPU_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"


def pick_device():
    import torch
    if torch.cuda.is_available():  # NVIDIA CUDA or AMD ROCm
        return "cuda:0", torch.bfloat16
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", torch.float32
    return "cpu", torch.float32


class TorchTts:
    backend = "torch"

    def __init__(self, model: str | None = None, device: str | None = None):
        import torch
        dev, dtype = pick_device()
        self.device = device or dev
        self.dtype = dtype if self.device.startswith("cuda") else torch.float32
        if self.device.startswith("cuda") and getattr(torch.version, "hip", None):
            # On ROCm the codec decoder's convolutions go through MIOpen, which falls back to an
            # untuned GEMM path there (measured on an RX 9070 / gfx1201: 42 s to decode 5 s of
            # audio, versus 0.06 s with MIOpen off). PyTorch's native kernels are far faster.
            torch.backends.cudnn.enabled = False
        self.model_id = model or (GPU_MODEL if self.device.startswith("cuda") else CPU_MODEL)
        self.model = None
        self.sample_rate = 24000
        self._prompts: dict[str, object] = {}

    def load(self) -> None:
        from pathlib import Path

        from huggingface_hub import snapshot_download
        from qwen_tts import Qwen3TTSModel
        # qwen-tts queries the Hub even for a cached model, which fails offline; load the cached
        # snapshot by path instead (`npm run voice:setup` downloaded it).
        path = self.model_id if Path(self.model_id).is_dir() else snapshot_download(self.model_id, local_files_only=True)
        self.model = Qwen3TTSModel.from_pretrained(path, device_map=self.device, dtype=self.dtype,
                                                   attn_implementation="sdpa")

    def _prompt(self, voice: str):
        if voice not in self._prompts:
            voices = available()
            if voice not in voices:
                raise ValueError(f"unknown voice {voice!r}")
            wav, text = voices[voice]
            self._prompts[voice] = self.model.create_voice_clone_prompt(ref_audio=str(wav), ref_text=text,
                                                                        x_vector_only_mode=False)
        return self._prompts[voice]

    def synth(self, text: str, voice: str):
        import torch
        with torch.inference_mode():
            wavs, sr = self.model.generate_voice_clone(text=text, language="English",
                                                       voice_clone_prompt=self._prompt(voice),
                                                       max_new_tokens=max_codec_tokens(text))
        self.sample_rate = int(sr)
        yield to_mono_float32(wavs[0])

    def warm(self) -> None:
        t0 = time.perf_counter()
        for name in available():
            self._prompt(name)  # clone prompts once, up front
        for _ in self.synth("Ready.", "narrator"):
            pass
        print(f"warm-up {time.perf_counter() - t0:.2f}s", flush=True)
