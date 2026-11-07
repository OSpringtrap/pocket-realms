"""python -m pr_voice [--backend auto|mlx|torch|fake] [--port 8766] [--model ID]"""

import argparse
import asyncio
import os
import platform


def auto_backend() -> str:
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        try:
            import mlx_audio  # noqa: F401
            return "mlx"
        except ImportError:
            pass
    try:
        import qwen_tts  # noqa: F401
        return "torch"
    except ImportError:
        return "fake"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default=os.environ.get("VOICE_BACKEND", "auto"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("VOICE_PORT", 8766)))
    ap.add_argument("--model", default=os.environ.get("VOICE_TTS_MODEL"))
    ap.add_argument("--device", default=os.environ.get("VOICE_DEVICE"), help="torch only, e.g. cuda:1 or cpu")
    args = ap.parse_args()
    backend = auto_backend() if args.backend == "auto" else args.backend
    if backend != "fake":
        os.environ.setdefault("HF_HUB_OFFLINE", "1")  # models come from `npm run voice:setup`, never at play time
    if backend == "mlx":
        from .tts_mlx import MlxTts
        tts = MlxTts(args.model)
    elif backend == "torch":
        from .tts_torch import TorchTts
        tts = TorchTts(args.model, args.device)
    else:
        from .tts_fake import FakeTts
        tts = FakeTts()
    from .server import serve
    asyncio.run(serve(tts, args.host, args.port))


if __name__ == "__main__":
    main()
