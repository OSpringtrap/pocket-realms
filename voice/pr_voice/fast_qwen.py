"""A lean Qwen3-TTS generation loop for PyTorch GPUs, built for AMD (ROCm) but used on CUDA too.

qwen-tts 0.1.1 generates through Hugging Face `generate()` twice over: once for the talker (one
token per 80 ms audio frame) and again, *inside every talker step*, for the 15 residual codes of
that frame. Each of those inner calls rebuilds logits processors, a DynamicCache and causal masks,
and every layer launches a dozen small kernels. At batch size 1 the GPU is idle most of the time,
waiting on Python and on kernel launches, and launches are noticeably dearer on ROCm than on CUDA.
That is why an RX 9070 XT could lose to an M5 (mlx-audio runs a hand-written loop).

This module keeps qwen-tts for loading, tokenising and building the prompt, and replaces the hot
loop:
  * the talker and code predictor run on a small static-KV decoder over the same weights;
  * one whole audio frame (15 code-predictor steps + one talker step + sampling) is captured once
    as a HIP/CUDA graph and replayed, so a frame costs one launch and one 17-integer read-back;
  * audio is decoded in chunks as frames arrive (the first after 0.32 s of audio, as on MLX),
    using only the last 25 reference frames as decoder context instead of the whole reference clip.

Sampling matches qwen-tts' defaults: repetition penalty on the first codebook, the 1024 reserved
codes suppressed, no end-of-speech before two frames, temperature + top-k on both models.
VOICE_GRAPHS=0 keeps the lean loop but skips graph capture; VOICE_FAST=0 (in tts_torch) uses
qwen-tts' own generate() unchanged.
"""

import os

import torch
import torch.nn.functional as F

CONTEXT_FRAMES = 25  # decoder left context, as qwen-tts' chunked_decode and mlx-audio use
CHUNK_FRAMES = (4, 8, 12)  # first chunk after 0.32 s of audio, then larger ones
MAX_LEN = 2048  # talker positions: prompt (reference text + codes + text) + generated frames


class PromptTooLong(ValueError):
    pass


class _Captured(Exception):
    def __init__(self, kwargs):
        super().__init__("captured")
        self.kwargs = kwargs


def _rms(x, w, eps):
    dt = x.dtype
    x32 = x.float()
    x32 = x32 * torch.rsqrt(x32.pow(2).mean(-1, keepdim=True) + eps)
    return w * x32.to(dt)


def _rotate_half(x):
    h = x.shape[-1] // 2
    return torch.cat((-x[..., h:], x[..., :h]), dim=-1)


def _sample(logits, temperature: float, top_k: int):
    """Top-k + temperature sampling via the Gumbel-max trick (graph-safe: only rand, no multinomial)."""
    v, idx = torch.topk(logits, top_k)
    u = torch.rand_like(v).clamp_(min=1e-20, max=1.0 - 1e-7)
    g = v / temperature - torch.log(-torch.log(u))
    return idx.gather(0, torch.argmax(g, dim=0, keepdim=True))


class _Decoder:
    """A Qwen3 decoder stack (the talker's or the code predictor's), run over the Hugging Face module's
    own weights with a preallocated KV cache. Text-only positions make the talker's M-RoPE identical to
    plain RoPE, so one implementation serves both."""

    def __init__(self, model, max_len: int, device, dtype):
        self.layers = list(model.layers)
        a0 = self.layers[0].self_attn
        self.hd = a0.head_dim
        self.nh = a0.config.num_attention_heads
        self.nkv = a0.config.num_key_value_heads
        self.groups = self.nh // self.nkv
        self.scale = a0.scaling
        self.eps = model.norm.variance_epsilon
        self.norm_w = model.norm.weight
        self.max_len = max_len
        n = len(self.layers)
        self.k = torch.zeros(n, self.nkv, max_len, self.hd, device=device, dtype=dtype)
        self.v = torch.zeros_like(self.k)
        rot = model.rotary_emb
        inv = rot.inv_freq.float().to(device)
        pos = torch.arange(max_len, device=device, dtype=torch.float32)
        emb = torch.outer(pos, inv)
        emb = torch.cat((emb, emb), dim=-1)
        self.cos = (emb.cos() * rot.attention_scaling).to(dtype)
        self.sin = (emb.sin() * rot.attention_scaling).to(dtype)
        self.arange = torch.arange(max_len, device=device)

    def _qkv(self, layer, h, T):
        at = layer.self_attn
        q = _rms(at.q_proj(h).view(T, self.nh, self.hd), at.q_norm.weight, at.q_norm.variance_epsilon)
        k = _rms(at.k_proj(h).view(T, self.nkv, self.hd), at.k_norm.weight, at.k_norm.variance_epsilon)
        v = at.v_proj(h).view(T, self.nkv, self.hd)
        return q, k, v

    def prefill(self, x):
        """x (1, T, H) at positions 0..T-1; returns the normed hidden state of the last position."""
        T = x.shape[1]
        cos, sin = self.cos[:T, None, :], self.sin[:T, None, :]
        x = x[0]
        for i, layer in enumerate(self.layers):
            h = _rms(x, layer.input_layernorm.weight, layer.input_layernorm.variance_epsilon)
            q, k, v = self._qkv(layer, h, T)
            q = q * cos + _rotate_half(q) * sin
            k = k * cos + _rotate_half(k) * sin
            self.k[i, :, :T] = k.transpose(0, 1)
            self.v[i, :, :T] = v.transpose(0, 1)
            kk = k.transpose(0, 1).repeat_interleave(self.groups, dim=0)
            vv = v.transpose(0, 1).repeat_interleave(self.groups, dim=0)
            o = F.scaled_dot_product_attention(q.transpose(0, 1)[None], kk[None], vv[None], is_causal=True,
                                               scale=self.scale)
            x = x + layer.self_attn.o_proj(o[0].transpose(0, 1).reshape(T, self.nh * self.hd))
            h = _rms(x, layer.post_attention_layernorm.weight, layer.post_attention_layernorm.variance_epsilon)
            x = x + layer.mlp(h)
        return _rms(x[-1:], self.norm_w, self.eps).view(1, 1, -1)

    def step(self, x, pos: int | None = None, pos_t=None):
        """One token x (1, 1, H). `pos` (a Python int) slices the cache statically; `pos_t` (a 1-element
        device tensor) masks it instead, so the step can be replayed from a graph at any position."""
        if pos is not None:
            cos, sin = self.cos[pos:pos + 1], self.sin[pos:pos + 1]
            mask, L = None, pos + 1
        else:
            cos, sin = self.cos.index_select(0, pos_t), self.sin.index_select(0, pos_t)
            mask = torch.where(self.arange <= pos_t, 0.0, float("-inf"))
            L = self.max_len
        x = x.view(1, -1)
        for i, layer in enumerate(self.layers):
            h = _rms(x, layer.input_layernorm.weight, layer.input_layernorm.variance_epsilon)
            q, k, v = self._qkv(layer, h, 1)
            q = q * cos + _rotate_half(q) * sin
            k = k * cos + _rotate_half(k) * sin
            if pos is not None:
                self.k[i, :, pos] = k[0]
                self.v[i, :, pos] = v[0]
            else:
                self.k[i].index_copy_(1, pos_t, k.transpose(0, 1))
                self.v[i].index_copy_(1, pos_t, v.transpose(0, 1))
            K, V = self.k[i, :, :L], self.v[i, :, :L]
            # GQA without copying the cache: the query heads of each KV head act as its "rows".
            s = torch.matmul(q.view(self.nkv, self.groups, self.hd), K.transpose(1, 2)).float() * self.scale
            if mask is not None:
                s = s + mask
            o = torch.matmul(s.softmax(-1).to(V.dtype), V)
            x = x + layer.self_attn.o_proj(o.reshape(1, self.nh * self.hd))
            h = _rms(x, layer.post_attention_layernorm.weight, layer.post_attention_layernorm.variance_epsilon)
            x = x + layer.mlp(h)
        return _rms(x, self.norm_w, self.eps).view(1, 1, -1)


class FastQwen:
    def __init__(self, wrapper, use_graphs: bool | None = None):
        self.w = wrapper  # qwen_tts.Qwen3TTSModel
        m = wrapper.model
        self.talker = m.talker
        cfg = m.config.talker_config
        self.device = self.talker.device
        self.dtype = self.talker.codec_head.weight.dtype
        self.groups = cfg.num_code_groups
        self.eos = cfg.codec_eos_token_id
        self.vocab = cfg.vocab_size
        g = {**{"temperature": 0.9, "top_k": 50, "repetition_penalty": 1.05, "subtalker_temperature": 0.9,
                "subtalker_top_k": 50}, **(getattr(wrapper, "generate_defaults", None) or {})}
        self.temp, self.top_k, self.rep = float(g["temperature"]), int(g["top_k"]), float(g["repetition_penalty"])
        self.sub_temp, self.sub_top_k = float(g["subtalker_temperature"]), int(g["subtalker_top_k"])

        st = m.speech_tokenizer.model
        self.codec = st.decoder
        self.upsample = int(st.decode_upsample_rate)

        dev, dt = self.device, self.dtype
        cp = self.talker.code_predictor
        self.t_dec = _Decoder(self.talker.model, MAX_LEN, dev, dt)
        self.c_dec = _Decoder(cp.model, self.groups + 1, dev, dt)
        self.t_emb = self.talker.model.codec_embedding
        self.c_emb = list(cp.model.codec_embedding)
        self.c_heads = list(cp.lm_head)
        self.c_proj = cp.small_to_mtp_projection
        self.H = self.t_emb.weight.shape[1]

        # Graph inputs/outputs: fixed tensors the graph reads and writes in place.
        self.hidden = torch.zeros(1, 1, self.H, device=dev, dtype=dt)  # talker's last hidden state
        self.code0 = torch.zeros(1, device=dev, dtype=torch.long)  # first codebook of the frame to build
        self.pos = torch.zeros(1, device=dev, dtype=torch.long)  # talker position of the frame's input
        self.tstep = torch.zeros(1, device=dev, dtype=torch.long)  # frame index (trailing-text index)
        self.trail = torch.zeros(MAX_LEN, self.H, device=dev, dtype=dt)
        self.seen = torch.zeros(self.vocab, device=dev, dtype=torch.bool)
        self.out = torch.zeros(self.groups + 1, device=dev, dtype=torch.long)  # frame codes + next code0
        self.suppress = torch.zeros(self.vocab, device=dev, dtype=torch.float32)
        self.suppress[self.vocab - 1024:] = float("-inf")
        self.suppress[self.eos] = 0.0
        self.is_eos = torch.zeros(self.vocab, device=dev, dtype=torch.bool)
        self.is_eos[self.eos] = True
        self._yes = torch.ones(1, device=dev, dtype=torch.bool)
        self._no = torch.zeros(1, device=dev, dtype=torch.bool)

        if use_graphs is None:
            use_graphs = os.environ.get("VOICE_GRAPHS", "1") != "0"
        self.graph = None
        self._want_graph = use_graphs and dev.type == "cuda"

    # ---- one frame ------------------------------------------------------------------------------

    def _talker_logits(self, h, allow_eos):
        logits = self.talker.codec_head(h).float().view(-1)
        logits = torch.where(self.seen, torch.where(logits < 0, logits * self.rep, logits / self.rep), logits)
        logits = logits + self.suppress
        return torch.where(self.is_eos & ~allow_eos, float("-inf"), logits)

    def _frame(self, step: int | None = None, pos: int | None = None):
        """Builds one frame from code0 and samples the next code0. With `step`/`pos` given (no graph) the
        talker attends only to the filled part of its cache; the graph version masks the whole cache."""
        c0 = self.code0
        e0 = self.t_emb(c0).view(1, 1, self.H)
        self.c_dec.step(self.c_proj(self.hidden), pos=0)
        h = self.c_dec.step(self.c_proj(e0), pos=1)
        acc = e0
        codes = [c0]
        for i in range(self.groups - 1):
            ci = _sample(self.c_heads[i](h).float().view(-1), self.sub_temp, self.sub_top_k)
            codes.append(ci)
            ei = self.c_emb[i](ci).view(1, 1, self.H)
            acc = acc + ei
            if i < self.groups - 2:
                h = self.c_dec.step(self.c_proj(ei), pos=i + 2)
        if step is None:
            x = acc + self.trail.index_select(0, self.tstep).view(1, 1, self.H)
            h = self.t_dec.step(x, pos_t=self.pos)
            allow_eos = self.tstep >= 1
        else:
            h = self.t_dec.step(acc + self.trail[step].view(1, 1, self.H), pos=pos)
            allow_eos = self._yes if step >= 1 else self._no
        self.hidden.copy_(h)
        self.seen.index_fill_(0, c0, True)
        nxt = _sample(self._talker_logits(h, allow_eos), self.temp, self.top_k)
        self.out.copy_(torch.cat(codes + [nxt]))
        self.code0.copy_(nxt)
        self.pos.add_(1)
        self.tstep.add_(1)

    def _capture(self):
        s = torch.cuda.Stream()
        s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(3):
                self._frame()
        torch.cuda.current_stream().wait_stream(s)
        g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g):
            self._frame()
        torch.cuda.synchronize()
        self.graph = g

    def warm(self):
        """Capture the frame graph (falls back to plain kernels if the driver refuses)."""
        if not self._want_graph or self.graph is not None:
            return
        try:
            with torch.inference_mode():
                self._capture()
            print("voice: frame graph captured", flush=True)
        except Exception as e:  # noqa: BLE001 - any capture failure just means "run eagerly"
            self.graph = None
            self._want_graph = False
            torch.cuda.synchronize()
            print(f"voice: graph capture unavailable ({type(e).__name__}: {e}); running without graphs", flush=True)

    # ---- one utterance --------------------------------------------------------------------------

    def _prompt(self, text, prompt_item):
        """Let qwen-tts build the talker prompt, then stop it before its own generate() runs."""
        talker = self.talker

        def capture(**kwargs):
            raise _Captured(kwargs)

        talker.generate = capture
        try:
            self.w.generate_voice_clone(text=text, language="English", voice_clone_prompt=[prompt_item])
        except _Captured as c:
            return c.kwargs
        finally:
            del talker.generate
        raise RuntimeError("qwen-tts did not reach the talker")

    def frames(self, text, prompt_item, max_frames: int):
        """Yields each frame's 16 codes (a list of ints) until end of speech."""
        kw = self._prompt(text, prompt_item)
        embeds = kw["inputs_embeds"].to(self.dtype)
        L = embeds.shape[1]
        if L + max_frames + 2 > MAX_LEN:
            raise PromptTooLong(f"prompt too long for the fast path ({L} + {max_frames} > {MAX_LEN})")
        trailing = kw["trailing_text_hidden"][0].to(self.dtype)
        n = trailing.shape[0]
        self.trail[:n].copy_(trailing)
        self.trail[n:].copy_(kw["tts_pad_embed"].view(1, -1).to(self.dtype).expand(MAX_LEN - n, -1))

        h = self.t_dec.prefill(embeds)
        self.hidden.copy_(h)
        self.seen.zero_()
        first = _sample(self._talker_logits(h, self._no), self.temp, self.top_k)
        self.code0.copy_(first)
        self.pos.fill_(L)
        self.tstep.zero_()
        for t in range(max_frames):
            if self.graph is not None:
                self.graph.replay()
            else:
                self._frame(t, L + t)
            out = self.out.tolist()
            yield out[:self.groups]
            if out[self.groups] == self.eos:
                return

    def _decode(self, codes, start, end):
        ctx = min(CONTEXT_FRAMES, start)
        chunk = codes[start - ctx:end].transpose(0, 1).unsqueeze(0)  # (1, Q, T)
        wav = self.codec(chunk).view(-1)
        return wav[ctx * self.upsample:(ctx + end - start) * self.upsample].float()

    def synth(self, text, prompt_item, max_frames: int):
        """Yields mono float32 numpy chunks as the frames arrive."""
        ref = prompt_item.ref_code
        ref = ref.to(self.device).long() if ref is not None else torch.zeros(0, self.groups, dtype=torch.long,
                                                                             device=self.device)
        R = ref.shape[0]
        codes = torch.zeros(R + max_frames, self.groups, dtype=torch.long, device=self.device)
        codes[:R] = ref
        n, done, k = 0, 0, 0
        pending = []
        for f in self.frames(text, prompt_item, max_frames):
            pending.append(f)
            want = CHUNK_FRAMES[min(k, len(CHUNK_FRAMES) - 1)]
            if len(pending) >= want:
                codes[R + n:R + n + len(pending)] = torch.tensor(pending, device=self.device)
                n += len(pending)
                pending = []
                yield self._decode(codes, R + done, R + n).cpu().numpy()
                done, k = n, k + 1
        if pending:
            codes[R + n:R + n + len(pending)] = torch.tensor(pending, device=self.device)
            n += len(pending)
        if n > done:
            yield self._decode(codes, R + done, R + n).cpu().numpy()
