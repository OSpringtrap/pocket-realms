# Voice worker

Optional text-to-speech for Pocket Realms. The game server (Node) starts it when `voice/.venv`
exists; install with `npm run voice:setup` from the repository root.

```
pr_voice/        python -m pr_voice [--backend auto|mlx|torch|fake] [--port 8766] [--model ID] [--device cuda:1]
  server.py      WebSocket server; one model thread runs jobs in order, cancel at chunk boundaries
  tts_mlx.py     Apple Silicon: Qwen3-TTS Base 6-bit over mlx-audio, streamed in 0.32 s chunks
  tts_torch.py   NVIDIA (CUDA), AMD (ROCm) or CPU: Qwen3-TTS Base over qwen-tts
  fast_qwen.py   GPU hot loop for tts_torch: static KV cache, one HIP/CUDA graph per 80 ms frame,
                 streamed decode. VOICE_GRAPHS=0 skips the graph; VOICE_FAST=0 uses qwen-tts' generate()
  tts_fake.py    beeps, no models (tests)
  protocol.py    JSON control messages + binary AUD0 audio frames (same framing as solo-dm)
voices/          <name>.wav + <name>.txt per voice: the clip and exactly what it says
tools/design_voices.py   (Apple Silicon) design a voice from a text description
```

## Adding a voice

1. Add a description and an in-character line (8–12 s when spoken) to `VOICES` in
   `tools/design_voices.py`, then run `voice/.venv/bin/python voice/tools/design_voices.py <name>`.
   Listen to `voices/<name>.wav`; rerun with `--force` until you like it. On a PC, any clean 5–15 s
   recording of the voice with an exact transcript in `<name>.txt` works too.
2. Add the name to `VOICE_IDS` in `shared/src/content/schemas.ts`.
3. Use it in `shared/content/npcs.json` (`voices`, one per name) or `shared/content/barks.json` (`voice`).
