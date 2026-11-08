# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pocket Realms: a local-multiplayer fantasy RPG ("5e-lite"). One shared main screen (`client-host`) plus 1–6 phones (`client-phone`) connected to a Node server over HTTPS/WebSocket. README.md covers gameplay, networking and voice setup; DECISIONS.md records design decisions and known issues (check it before changing rules or sync behaviour).

## Commands

```bash
bun install
bun start                 # build everything, run server (dist/server/index.js), open main screen
bun run dev               # bun --watch of the server only; run `bun run build` once first so the clients exist
bun run build:host | build:phone | build:server   # individual builds (Vite x2, `bun build`)
bun run typecheck         # tsc --noEmit over all workspaces
bun test                  # bun test (shared/test, server/test)
bun test shared/test/rules.test.ts -t "name"   # single file / test
bun run sim               # bot balance simulator (--runs N --difficulty heroic --length campaign)
bun run ci                # typecheck + tests + sim:ci (balance gates)
```

Smoke tests run against a live server (`HOST_KEY=testkey ROOM_CODE=TEST PORT=9443 HTTP_PORT=9080 bun dist/server/index.js --no-open &`, then `bun scripts/smoke-clients.ts`; also `smoke-continue.ts`, `smoke-voice.ts`). Env switches: `PORT`, `HTTP_PORT`, `ROOM_CODE`, `HOST_KEY`, `NO_OPEN=1`, `VOICE=0`, `VOICE_BACKEND=mlx|torch|fake`. Phone URL `?debug=1` shows a sensor simulator.

## Architecture

Bun workspaces (runtime, package manager and test runner; no Node needed): `shared`, `server`, `client-host`, `client-phone`. `@pr/shared` is consumed as TypeScript source everywhere (tsconfig path alias, which Bun and Vite both read); there is no build step for it.

- **shared/**: everything both sides need. `types.ts` / `protocol.ts` (state + WS messages), `rules/` (deterministic engine: checks, combat, items, stats, bots), `gen/` (seeded world, encounter and name generators), `rng.ts` (mulberry32; one uint32 saved with the campaign; world gen uses a derived independent stream), `diff.ts` (state patches), `browser/` (canvas dice, hex map, WebAudio synth, WS client, DOM helper shared by both clients). Game data lives in `shared/content/*.json` and is validated with zod (`src/content/schemas.ts`) at server start, so a bad JSON file stops boot; add new voice ids to `VOICE_IDS` there.
- **Rules engine with injected I/O**: combat/actions take a `CombatIO` (roll/minigame/emit). The server implements it with phone prompts; tests and `scripts/sim.ts` implement it with the seeded RNG, so the same `runCombat` runs in real play and in the simulator. Engine functions mutate the state passed in.
- **server/**: authoritative. `Game.ts` holds state, the generic **Prompt** system (every question to a phone is a prompt with deadline and fallback; pending prompts are part of a phone's view, which is what makes reconnect and bots work), and saves (`saves/*.json`, autosave per scene). `game/scenes/*` are async scripts (`await g.choose(...)`, `g.rollDice(...)`); a reset bumps an epoch and rejects all pending awaits. `director.ts` wires handlers and pacing/adaptive difficulty. `room.ts` is the WS layer: full state once, then `state:patch` diffs with sequence numbers (a gap forces reconnect); transient effects go as `fx` messages. One room per process; a host key in the host URL gates host commands. `voice/` launches and queues the optional Python TTS worker.
- **client-host / client-phone**: Vite + vanilla TS, no framework. Keyed `Slot`s rebuild a region only when its data hash changes (so inputs, drawing pads and running minigames survive unrelated updates). Phone sensors/minigames are in `client-phone/src/sensors.ts` and `minigames.ts`; every minigame needs a touch-only fallback and only modifies the d20 roll (never replaces it). Dice values are always rolled server-side except in physical-dice mode.
- **voice/**: optional Python worker (Qwen3-TTS; MLX / torch CUDA-ROCm / CPU / fake backends) started by the server when `voice/.venv` exists (`bun run voice:setup`). Voices are `voice/voices/<name>.wav` + exact transcript `.txt`.
- Self-signed certs are generated into `.certs/` (HTTPS required for phone sensors); `dist/` is build output.
