"""Wire protocol between the game server (Node) and this TTS worker. Same framing as solo-dm.

Control messages are JSON text frames with a "type" field. Audio travels in binary frames:
a fixed little-endian header followed by mono float32 PCM.

Server -> worker
  tts     {job, text, voice}      voice = a file stem in voice/voices/ (narrator, goblin, ...)
  cancel  {jobs: [int]} or {all: true}
Worker -> server
  ready   {backend, device, model, voices: [str], sample_rate}   sent once on connect
  done    {job, samples, sample_rate, synth_s, ttfa_s}
  cancelled {job}
  error   {job, message}
  <binary AUD0 frame> per audio chunk
"""

import struct

import numpy as np

AUDIO_MAGIC = b"AUD0"
FLAG_FINAL = 1
_HEADER = struct.Struct("<4sIIIII")  # magic, job, seq, sample_rate, n_samples, flags
HEADER_SIZE = _HEADER.size


def pack_audio(job: int, seq: int, sample_rate: int, samples: np.ndarray, final: bool = False) -> bytes:
    pcm = np.ascontiguousarray(samples, dtype="<f4")
    if pcm.ndim != 1:
        raise ValueError(f"audio frames must be mono, got shape {pcm.shape}")
    head = _HEADER.pack(AUDIO_MAGIC, job, seq, sample_rate, pcm.shape[0], FLAG_FINAL if final else 0)
    return head + pcm.tobytes()


def unpack_header(data: bytes) -> tuple[int, int, int, int, int]:
    magic, job, seq, sr, n, flags = _HEADER.unpack_from(data)
    if magic != AUDIO_MAGIC:
        raise ValueError(f"bad audio magic {magic!r}")
    return job, seq, sr, n, flags


def to_mono_float32(audio) -> np.ndarray:
    """1-D float32. Stereo (N, 2) or (2, N) is averaged, never flattened (flattening interleaves
    the channels and plays at half speed, an octave low)."""
    a = np.asarray(audio)
    if a.ndim == 2:
        a = a.mean(axis=1) if a.shape[1] <= 2 and a.shape[0] > a.shape[1] else a.mean(axis=0)
    elif a.ndim != 1:
        raise ValueError(f"expected 1-D or 2-D audio, got shape {a.shape}")
    a = a.astype(np.float32, copy=False)
    if not np.all(np.isfinite(a)):
        raise ValueError("audio contains NaN or inf")
    return a
