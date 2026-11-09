# 🏰 Pocket Realms

A Jackbox-style, local-multiplayer fantasy RPG built on a simplified D&D 5e ("5e-lite").
One shared **main screen** (TV or laptop) shows the world. **1–6 players** join from their phones'
browsers with a 4-letter room code: the phone is your character sheet, your inventory, your wand,
your sword and your dice. No app install and no internet needed. Everything runs on the host machine.

- Procedural hex overworld with fog of war, day/night, weather, and a **Doom Clock**
- 87 event cards, NPC social scenes, quests, shops, shrines, camps, dungeons and bosses
- 108 spells and abilities across 7 classes, most driven by phone **minigames** (draw runes, swing,
  shout, tilt, shake, hum, blow, scan the room, rhythm taps…), each with a touch-only fallback
- Dice you hold in your phone: tilt, shake and twist it and they slide, rattle and tumble inside; flick
  them toward the TV and they fly out of the phone and onto the main screen from that side. Or roll
  **real dice** and type them in
- Jackbox-style writing and voting rounds that weave your answers into the world
- Adaptive difficulty for 1–6 heroes, a bot simulator, autosave and continue

## Quick start

Requirements: **[Bun](https://bun.sh) 1.2+** on the host computer (macOS, Linux or Windows); `curl -fsSL https://bun.sh/install | bash` installs it.

```bash
bun install
bun start
```

`bun start` builds everything, starts the server, prints the address and opens the main screen in
your browser. The terminal shows something like:

```
📺 Main screen:  https://localhost:8443/host/?key=…
📱 Phones join:  https://192.168.1.23:8443   (room code: QWRT)
```

1. On the main screen, click once (enables sound), pick a length and difficulty, and press **Begin a new adventure**.
2. Each player scans the QR code (or types the address) on their phone, enters the room code and their name.
3. Everyone creates a hero on their phone. When all are ready, the host presses **Start the adventure!**

### The certificate warning (one time per device)

Phone sensors (motion, compass, microphone) and screen wake lock require HTTPS, so the server uses a
**self-signed certificate** generated on first run (stored in `.certs/`). Browsers warn about it once:

- **Chrome / Android:** tap **Advanced** → **Proceed to … (unsafe)**
- **Safari / iOS:** tap **Show Details** → **visit this website** → **Visit Website**
- **Firefox:** **Advanced** → **Accept the Risk and Continue**

It's your own computer on your own network; nothing leaves your Wi-Fi. The certificate is reused, so
you only accept it again if the host's IP address changes.

Tip: typing `http://<ip>:8080` on a phone redirects to the HTTPS address.

### Network troubleshooting

- **Same Wi-Fi:** phones must be on the same network as the host (not mobile data, not a guest network).
- **Firewall:** allow Bun on private networks when your OS asks. On Windows: *Windows Security →
  Firewall → Allow an app*. On macOS: *System Settings → Network → Firewall → Options*. On Linux,
  open TCP ports **8443** and **8080** (e.g. `sudo ufw allow 8443/tcp`).
- **Router client isolation / AP isolation:** many guest and some home networks block devices from
  talking to each other. If phones can't connect, disable "AP/client isolation" in the router, or
  use a phone hotspot that the host computer also joins.
- **Wrong IP printed:** if the host has several network adapters (VPN, Docker, VMs), the terminal
  lists other addresses — try those. You can also set a port: `PORT=9443 HTTP_PORT=9080 bun start`.
- **iPhone sensors:** iOS asks for motion permission the first time you tap a sensor game. If you
  decline, every minigame falls back to touch.

### Playing online (friends in another house)

**Step-by-step guide for the host and the players: [PLAYING-ONLINE.md](PLAYING-ONLINE.md).**

The game still runs on your computer; a free Cloudflare quick tunnel gives it a public `https://`
address, so remote players need nothing installed and get no certificate warning. Install
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
once (`sudo pacman -S cloudflared`, `brew install cloudflared`, …), then:

```bash
bun run online        # = bun start, plus the tunnel (or: ONLINE=1 bun start)
```

The terminal says the tunnel was created, then waits until the new address answers from the internet
(a fresh address takes up to about a minute to reach everyone). Then it prints two links for remote players:

```
📱 Phone:        https://some-random-words.trycloudflare.com/?room=QWRT
📺 Watch screen: https://some-random-words.trycloudflare.com/host/?room=QWRT
```

- **Phone link:** the remote player opens it on their phone and joins as usual. Players in the room
  can keep using the local address; the QR code on the main screen switches to the online one,
  which works everywhere.
- **Watch screen:** open it on the remote player's computer or TV and click once to turn on sound.
  It needs the room code (the link includes it; otherwise it asks), like a phone does.
  It shows the same main screen (map, combat, dice, narration, sounds and voices) but has no
  controls. Only your host link (with `?key=`) runs the game, so don't share that one. Your own
  screen sets the pace of the voices; a muted watch screen doesn't speed anything up.
- The address is new every time the tunnel starts. If it drops, the server restarts it and prints
  the new links.
- Strangers can't guess their way in: after 8 wrong room codes from one address, that address has to
  wait 5 minutes.
- Using your own tunnel or domain instead (Tailscale Funnel, a named Cloudflare tunnel, a reverse
  proxy)? Point it at `https://127.0.0.1:8443` (self-signed, so turn off certificate checks
  for the origin) and start with `PUBLIC_URL=https://your.address bun start`, so the QR code and the
  links show that address.

## How to play

**Overworld.** Each turn a rotating **leader** picks where the party goes (on their phone or by
tapping the TV map). Movement is limited by terrain. Arriving somewhere triggers a scene: a town,
dungeon, shrine, camp, an event card, or a fight. Each turn the **Doom Clock** ticks; at 1/3 and 2/3
the antagonist's power spreads. If it fills up, the antagonist comes for you, empowered.

**Goal.** Collect the antagonist's seal-keys from dungeons (one in one-shot mode, three in a
campaign), then storm their fortress. Win, and the ending depends on how much Doom you allowed and
which factions you befriended.

**Events.** The party votes on what to do (ties are broken by a dice roll). A volunteer — or the best
fit — attempts the check, sometimes with a minigame first. Outcomes have critical, success, partial,
failure and fumble versions.

**Combat.** Everyone rolls initiative on their phone. On your turn, your phone shows your actions,
abilities, spells and items. Many abilities start a minigame: a great result grants advantage, a
wider crit range, extra damage dice or a refund. Enemies telegraph big attacks — the targeted
players get a "BRACE!" challenge on their phones. At 0 HP you make dramatic death saves; fallen
heroes can return from the Veil or pass the torch to a new hero.

**Dice.** When it's your roll, your phone becomes a box with the dice inside: tilt it and they slide,
shake it and they rattle off the walls, twist it and they swing round. Flick the phone toward the TV
(or swipe) and they fly out through that edge of the phone and in through the matching edge of the main
screen, roll to a stop, and the total shows for a moment in the log under the board. The values are
still generated by the server (fair). Turn on **physical dice** in
*Journal → Settings* on your phone and the game asks you to roll your real d4–d20 or d% and enter the
result (validated against the die).

**Between scenes.** Write rumors, name the kingdom's mascot, give each other epithets, act out
campfire moments (the group votes to award Inspiration), shop, and manage your bag and the party
stash on your phone. Some players get secret goals or whispered temptations…

## Voices (optional)

The main screen can speak: a **narrator** reads the story, and NPCs and monsters say their lines in
their own voices (a goblin cackles, a ghost rasps, the innkeeper grumbles). The lines are written in
the game's content files; the voices are spoken by **Qwen3-TTS**, running on the host computer.
Nothing goes online during play. Without the voice install the game plays exactly as before, silently.

Install once (needs Python 3.10–3.13, 3.12 recommended, and about 4–6 GB of disk for the model and
libraries):

```bash
bun run voice:setup
bun start            # starts the voice worker by itself
```

The setup picks a backend for the computer:

| Machine | Backend | Notes |
|---|---|---|
| Mac with Apple Silicon | MLX (Metal) | 1.7B model, first audio in about 0.3 s |
| NVIDIA GPU (Windows or Linux) | PyTorch + CUDA 12.8 | 1.7B model, streamed; each 80 ms audio frame replays as one CUDA graph |
| AMD GPU on Linux | PyTorch + ROCm 6.4 | 1.7B model, streamed; each frame replays as one HIP graph; needs the `amdgpu` driver with ROCm support |
| AMD GPU on Windows, or no GPU | PyTorch on CPU | 0.6B model; about 2× slower than real time, so lines start a few seconds late |

On Windows with an AMD card, PyTorch has no official ROCm build, so the setup falls back to the CPU.
If AMD publishes ROCm PyTorch wheels for your card, point the setup at them:
`TORCH_INDEX_URL=<index url> bun run voice:setup` (PowerShell: `$env:TORCH_INDEX_URL="<index url>"; bun run voice:setup`).

Other switches: `VOICE=0 bun start` plays without voices; `VOICE_BACKEND=mlx|torch|fake` forces a
backend (`fake` speaks beeps, for testing without models); **Voices** in ⚙️ Settings turns them off for
a session and shows whether the voice worker is ready. The voices themselves are the clips in
`voice/voices/` (see [voice/README.md](voice/README.md)).

## Modes and settings (main screen ⚙️)

- **Length:** One-shot (~30–45 min, 1 key) or Campaign (2–4 h, 3 keys, bigger map, home-base upgrades)
- **Difficulty:** Story / Normal / Heroic, plus an **adaptive director** toggle
- Text speed, text size, volume, ambient music, **voices**, **color-blind-safe palette**, reduce motion, turn timer
- **Seed:** the same seed reproduces the same world

The campaign **autosaves** to `saves/*.json` at the end of every scene. On the title screen choose
**Continue campaign**; phones automatically rejoin as the same heroes (or pick their hero from a list).

## Testing without phones

- Add `?debug=1` to the phone URL (`https://localhost:8443/?debug=1`) to get a sensor simulator panel
  (🧪 button): sliders for acceleration, tilt, compass, mic volume and pitch, plus swing/shake buttons.
- Open several phone tabs in a desktop browser to play multiple heroes.
- On the main screen lobby, **🤖 Add bot** adds a computer-controlled hero.

## Development

```bash
bun run dev          # server with auto-restart (run `bun run build` once first for the clients)
bun test             # unit tests (rules, RNG, dice, diffs, content validation, generation)
bun run typecheck
bun run sim          # balance simulator: full bot runs for 1–6 players
bun run sim -- --runs 30 --difficulty heroic --length campaign
bun run ci           # typecheck + tests + simulator with balance gates (fails if out of range)
```

End-to-end smoke tests against a running server:

```bash
bun run build
HOST_KEY=testkey ROOM_CODE=TEST PORT=9443 HTTP_PORT=9080 bun dist/server/index.js --no-open &
bun scripts/smoke-clients.ts            # 6 phones join, drop, rejoin, auto-play
bun scripts/smoke-continue.ts start     # then restart the server and:
bun scripts/smoke-continue.ts resume
bun scripts/smoke-voice.ts              # with voices installed: narrator + monster lines, audio flows
bun scripts/smoke-online.ts             # start the server with PUBLIC_URL=https://example.test (or --online):
                                        # the address reaches every screen; a watch screen can't run the game
```

### Project layout

```
shared/          types, protocol, rules engine, content schemas, generators, browser helpers
  content/*.json data: spells, classes, species, quirks, monsters, items, affixes, events, NPCs…
  src/rules/     pure-ish deterministic engine (state + action + RNG → new state + events)
  src/gen/       world, encounter generation
  src/browser/   dice renderer, hex map, audio synth, WebSocket client (used by both clients)
server/          Express + ws over HTTPS; Game (state, prompts, saves) and scene scripts
client-host/     main screen (Vite + vanilla TS)
client-phone/    phone controller (Vite + vanilla TS), sensors and minigames
scripts/         build, simulator, smoke tests, voice setup
voice/           optional TTS worker (Python): MLX, PyTorch (CUDA/ROCm/CPU) or fake backends
  voices/        reference clips, one per voice (designed once, cloned for every line)
server/src/voice worker launcher and the speech queue (server side of the voices)
```

All content is validated with zod when the server starts; a broken JSON file stops the server with
the file name and the failing path.

See [DECISIONS.md](DECISIONS.md) for design decisions, simplifications and known issues.

## Credits

Monster art comes from [game-icons.net](https://game-icons.net) (CC BY 3.0); fonts are Young Serif and Merriweather (SIL OFL). See [CREDITS.md](CREDITS.md). To change a monster's icon, edit the map in `scripts/gen-monster-icons.mjs` and run `bun scripts/gen-monster-icons.mjs`.
