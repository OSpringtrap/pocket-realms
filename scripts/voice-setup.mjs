#!/usr/bin/env node
// One-time install of the optional voice worker (Qwen3-TTS): `npm run voice:setup`.
// Picks a backend for this machine, creates voice/.venv, installs it and downloads the model.
//
//   Apple Silicon         -> mlx    (Metal)
//   NVIDIA GPU            -> torch  (CUDA wheels)
//   AMD GPU on Linux      -> torch  (ROCm wheels; PyTorch exposes ROCm through torch.cuda)
//   anything else         -> torch  (CPU wheels, the smaller 0.6B model; slow but works)
//
// Overrides: VOICE_BACKEND=mlx|torch|fake, TORCH_INDEX_URL=<pytorch wheel index> (for example
// AMD's Windows ROCm wheels), PYTHON=<path to python 3.10-3.13>.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICE = path.join(ROOT, 'voice');
const VENV = path.join(VOICE, '.venv');
const WIN = process.platform === 'win32';
const venvPy = path.join(VENV, WIN ? 'Scripts/python.exe' : 'bin/python');

const MODELS = {
  mlx: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit',
  gpu: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  cpu: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
};
const TORCH_INDEX = {
  cuda: 'https://download.pytorch.org/whl/cu128',
  rocm: 'https://download.pytorch.org/whl/rocm6.4',
  cpu: 'https://download.pytorch.org/whl/cpu',
};

const ok = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
};
const out = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
// pip stages multi-GB wheels (PyTorch is ~4.5 GB) in the temp dir; on Linux /tmp is often a small
// RAM-backed tmpfs, so use a directory next to the venv instead.
const TMP = path.join(VOICE, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const run = (cmd, args) => {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: TMP, TEMP: TMP, TMP } });
  if (r.status !== 0) {
    console.error(`\n❌ Failed: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
};

function findPython() {
  if (process.env.PYTHON) return [process.env.PYTHON];
  const cands = WIN ? [['py', '-3.12'], ['py', '-3.11'], ['py', '-3.13'], ['python']] : [['python3.12'], ['python3.11'], ['python3.13'], ['python3']];
  for (const c of cands) {
    const v = out(c[0], [...c.slice(1), '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])']).trim().split(' ').map(Number);
    if (v[0] === 3 && v[1] >= 10 && v[1] <= 13) return c;
  }
  console.error('❌ Python 3.10–3.13 is required (3.12 recommended). Install it, or set PYTHON=/path/to/python.');
  process.exit(1);
}

function gpu() {
  if (ok('nvidia-smi', ['-L'])) return 'nvidia';
  if (process.platform === 'linux' && (fs.existsSync('/dev/kfd') || ok('rocminfo', []))) return 'amd';
  if (WIN) {
    const names = out('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
    if (/nvidia/i.test(names)) return 'nvidia';
    if (/amd|radeon/i.test(names)) return 'amd-windows';
  }
  return 'none';
}

const appleSilicon = process.platform === 'darwin' && os.arch() === 'arm64';
const backend = process.env.VOICE_BACKEND ?? (appleSilicon ? 'mlx' : 'torch');
const card = backend === 'torch' ? gpu() : 'none';
let flavor = 'cpu';
if (card === 'nvidia') flavor = 'cuda';
else if (card === 'amd') flavor = 'rocm';
const index = process.env.TORCH_INDEX_URL ?? TORCH_INDEX[flavor];
// A custom index (for example AMD's Windows ROCm wheels) is assumed to be a GPU build.
const model = backend === 'mlx' ? MODELS.mlx : flavor !== 'cpu' || process.env.TORCH_INDEX_URL ? MODELS.gpu : MODELS.cpu;

console.log(`🎙️  Voice setup: backend=${backend}${backend === 'torch' ? ` (${flavor}, GPU: ${card})` : ''}, model=${backend === 'fake' ? 'none' : model}`);
if (card === 'amd-windows' && !process.env.TORCH_INDEX_URL)
  console.log('   AMD on Windows: PyTorch has no official ROCm wheels for Windows, so this installs the CPU build.\n   If AMD publishes ROCm PyTorch wheels for your card, rerun with TORCH_INDEX_URL=<that index>.');

if (!fs.existsSync(venvPy)) {
  const py = findPython();
  run(py[0], [...py.slice(1), '-m', 'venv', VENV]);
}
run(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
if (backend === 'torch') run(venvPy, ['-m', 'pip', 'install', 'torch', 'torchaudio', '--index-url', index]);
run(venvPy, ['-m', 'pip', 'install', '-r', path.join(VOICE, `requirements-${backend}.txt`)]);
if (backend !== 'fake') {
  run(venvPy, ['-c', `from huggingface_hub import snapshot_download; print(snapshot_download(${JSON.stringify(model)}))`]);
  if (backend === 'torch') run(venvPy, ['-c', 'import torch; print("torch", torch.__version__, "GPU:", torch.cuda.is_available() and torch.cuda.get_device_name(0))']);
}
fs.writeFileSync(path.join(VOICE, 'config.json'), JSON.stringify({ backend, model: backend === 'fake' ? undefined : model, flavor, gpu: card }, null, 2) + '\n');
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n✅ Voice ready. `npm start` now starts the voice worker by itself (set VOICE=0 to play without voices).');
