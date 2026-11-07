"""WebSocket front end over one model thread.

Every model call (load included) runs on a single thread: MLX streams are bound to the thread that
created them (solo-dm, API_NOTES), and one thread also means never two voices at once. Jobs run in
the order they arrive; a cancel takes effect at the next chunk boundary.
"""

import asyncio
import json
import queue
import threading
import time
import traceback

from .protocol import pack_audio
from .voices import available


class ModelThread:
    def __init__(self, tts):
        self.tts = tts
        self.jobs: queue.Queue = queue.Queue()
        self.cancelled: set[int] = set()
        self.ready = threading.Event()
        self.load_error: str | None = None
        threading.Thread(target=self._run, name="model", daemon=True).start()

    def _run(self):
        try:
            t0 = time.perf_counter()
            self.tts.load()
            print(f"loaded {self.tts.model_id} on {self.tts.device} in {time.perf_counter() - t0:.1f}s", flush=True)
            self.tts.warm()
        except Exception as e:
            traceback.print_exc()
            self.load_error = f"{type(e).__name__}: {e}"
        self.ready.set()
        while True:
            job, text, voice, emit = self.jobs.get()
            if job in self.cancelled:
                self.cancelled.discard(job)
                emit({"type": "cancelled", "job": job})
                continue
            t0 = time.perf_counter()
            ttfa, n, seq = None, 0, 0
            try:
                if self.load_error:
                    raise RuntimeError(self.load_error)
                for chunk in self.tts.synth(text, voice):
                    if job in self.cancelled:
                        break
                    if ttfa is None:
                        ttfa = time.perf_counter() - t0
                    n += chunk.shape[0]
                    emit(pack_audio(job, seq, self.tts.sample_rate, chunk))
                    seq += 1
                if job in self.cancelled:
                    self.cancelled.discard(job)
                    emit({"type": "cancelled", "job": job})
                else:
                    emit({"type": "done", "job": job, "samples": n, "sample_rate": self.tts.sample_rate,
                          "synth_s": round(time.perf_counter() - t0, 3), "ttfa_s": round(ttfa or 0, 3)})
            except Exception as e:
                traceback.print_exc()
                emit({"type": "error", "job": job, "message": f"{type(e).__name__}: {e}"})


async def serve(tts, host: str, port: int):
    import websockets

    model = ModelThread(tts)

    async def handler(ws):
        loop = asyncio.get_running_loop()
        out: asyncio.Queue = asyncio.Queue()
        mine: set[int] = set()

        def emit(payload):
            loop.call_soon_threadsafe(out.put_nowait, payload)

        async def sender():
            while True:
                p = await out.get()
                if isinstance(p, dict) and p.get("type") in ("done", "cancelled", "error"):
                    mine.discard(p.get("job"))
                try:
                    await ws.send(p if isinstance(p, bytes) else json.dumps(p))
                except websockets.ConnectionClosed:
                    return

        await asyncio.to_thread(model.ready.wait)
        await ws.send(json.dumps({"type": "ready", "backend": tts.backend, "device": tts.device,
                                  "model": tts.model_id, "voices": list(available()),
                                  "sample_rate": tts.sample_rate, "error": model.load_error}))
        task = asyncio.create_task(sender())
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                m = json.loads(raw)
                t = m.get("type")
                if t == "tts":
                    job = int(m["job"])
                    mine.add(job)
                    model.cancelled.discard(job)
                    model.jobs.put((job, str(m.get("text", ""))[:400], str(m.get("voice", "narrator")), emit))
                elif t == "cancel":
                    model.cancelled.update(mine if m.get("all") else {int(j) for j in m.get("jobs", [])})
        except websockets.ConnectionClosed:
            pass  # the game server went away; its jobs are cancelled below
        finally:
            model.cancelled.update(mine)  # a dropped connection stops its jobs
            task.cancel()

    async with websockets.serve(handler, host, port, max_size=1 << 20):
        print(f"pocket-realms voice worker on ws://{host}:{port} ({tts.backend})", flush=True)
        await asyncio.Future()
