# Design decisions & notes

Where the brief was ambiguous I picked the option that keeps the table moving and the code robust.
Each entry: **decision** — why.

## Environment & architecture

- **One room per server process.** The host machine runs one game; a 4-letter room code guards joining.
  A random **host key** in the main-screen URL is required for host commands; other browsers opening `/host/`
  become read-only spectators.
- **HTTPS on 8443 + HTTP redirect on 8080.** Sensors/Wake Lock need a secure context; the redirect makes the
  address easier to type on a phone. The self-signed certificate includes every LAN IP and is regenerated only
  when a new IP appears, so devices accept the warning once.
- **Online play = the same local server behind a Cloudflare quick tunnel** (`--online`, user, 9 Nov), not a
  hosted server: the voice worker needs the host's GPU, saves stay local, and nothing in the game changes.
  `cloudflared` gets a random `*.trycloudflare.com` address with a real certificate (no account, no port
  forwarding) and forwards to the self-signed HTTPS port (`--no-tls-verify`, `127.0.0.1` because the server
  listens on IPv4 only). The address arrives after start, so it lives in `GameOptions.publicUrl` and the
  public view; QR code, lobby and top bar follow it, and a restart of the tunnel (new address) updates them.
  `PUBLIC_URL` covers any other tunnel or proxy. A remote main screen is the existing **spectator** role
  ("watch screen"): same public view and `fx` (dice, damage, sounds), no host commands.
- **Links are printed only once the tunnel answers.** A new quick-tunnel name took about a minute to resolve
  in testing, so a link sent right away failed. The server polls `/healthz` through the tunnel first.
- **Voices go to every screen; the host screen sets their pace.** Watch screens get the same speech and audio
  frames, but their `speech:played` reports count only when no host screen is connected: a muted or
  not-yet-clicked tab reports each sentence at once and would rush the game. Audio is float32 at 24 kHz
  (about 0.8 Mbit/s per watch screen while someone speaks); fine for home internet, so not compressed.
  A watch screen in the same room as the host echoes; mute that tab.
- **Wrong room codes are rate limited per address** (8 in 10 min, then 5 min locked out). A 4-letter code
  is only ~330k guesses. Tunnel traffic all arrives from `127.0.0.1`, so the address is Cloudflare's
  `CF-Connecting-IP`, trusted only on loopback connections so a LAN device can't choose its own address.
  Tokens (128-bit) and the host key (64-bit) need no limit.
- **State sync = full state once, then structural JSON diffs** (`state:patch`) per connection, with sequence
  numbers; a gap makes the client reconnect for a fresh full state. Transient things (dice results, damage
  numbers, sounds, banners, haptics) travel as `fx` messages.
- **Generic prompt system instead of many bespoke messages.** Every question the server asks a phone is a
  `Prompt` (choice, roll, minigame, text, draw, notice) stored server-side with a deadline and a fallback. This
  made reconnection trivial (pending prompts are part of the phone's view) and lets bots and the simulator answer
  the same prompts humans do.
- **Scenes are async scripts** (`await g.choose(...)`, `await g.rollDice(...)`). A reset bumps an epoch and
  rejects every pending await, so "New campaign"/"Quit to title" can interrupt anything safely.
- **Rules engine in `shared/` is deterministic, with interactive I/O injected.** Pure helpers (`resolveD20`,
  `applyDamage`, `scaleMonsterToLevel`, loot, stats…) plus an async action resolver that takes a `CombatIO`
  (roll/minigame/emit). The server implements it with phone prompts; tests and the simulator implement it with
  the seeded RNG. The *same* `runCombat` loop runs in the real game and in the simulator.
  Engine functions mutate the passed state object (structured cloning on every call would cost a lot for no gain);
  determinism is tested (same seed ⇒ identical combat log).
- **Seeded RNG:** mulberry32 whose single uint32 state is saved with the campaign, so a loaded game continues the
  same random stream. World generation uses an independent derived stream (`Rng.derive(seed, 'world')`), so the
  same seed always produces the same map regardless of how play went.
- **Server bundle with esbuild, clients with Vite**; `@pr/shared` is consumed as TypeScript source everywhere.
- **No frameworks on the clients.** A tiny `h()` DOM helper and keyed `Slot`s that only rebuild a region when its
  data hash changes (so text inputs, drawing pads and running minigames are not destroyed by unrelated updates).
- **Bun replaces Node, npm, tsx, esbuild and vitest.** `bun install` (text lockfile `bun.lock`), `bun test`
  (tests import from `bun:test`; timeout in `bunfig.toml`), `bun --watch` for dev, and the server is bundled
  with `bun build --target bun` into `dist/server/index.js`. Dependencies are bundled in, because Bun's
  workspace installs keep each package's modules under that package, where a file in `dist/` can't find them.
  Vite still builds the two clients (run with `bunx --bun`). Express, `ws`, `node:https` and the voice
  worker's child process all work unchanged on Bun (checked with the client and voice smoke tests).

## Rules ("5e-lite")

- **Hit points get a +4 "heroic buffer"** at every level. Level-1 5e characters die to one goblin crit, which is
  miserable at a party game.
- **Spell Points** replace slots: full casters get 4 at L1 → 22 at L10, paladins half. Cantrips are free and scale
  every 4 levels; other spells add dice every 2–3 levels above their unlock level. Short rest restores half the SP.
- **Action economy:** each turn = 1 action, plus at most 1 *bonus* ability taken before the action. No movement
  or positioning (theater of the mind); "melee/ranged" only affects advantage vs. prone targets.
- **Conditions (10):** poisoned, stunned, frightened, prone, blinded, charmed, burning, slowed, blessed, inspired.
  Effects like Invisibility, Shield, Rage, Sanctuary, Taunt, Smites, Spirit Guardians are **buffs**, not conditions.
  Bosses reduce stun/charm to 1 turn ("legendary resistance lite").
- **Inspiration** (from campfire moments, Jackbox wins, secret goals) is spent automatically for advantage on a
  hard skill check (when the DC is more than 12 above your bonus).
- **Death:** 0 HP = down, 3 d20 death saves rolled on the phone (nat 20 revives, nat 1 = two failures), damage while
  down = a failure (crit = two). Massive damage (overflow ≥ max HP) kills outright except on Story. Fallen heroes
  keep playing as spirits (each turn: inspire an ally or frighten an enemy). After the fight they choose
  **Return from the Veil** (half HP, "Death-Touched" title, +1 Doom) or **Pass the torch** (new hero, same level,
  inherits the gear).
- **Total party wipe:** Story = rescued every time; Normal = rescued once (lose half the gold, +2 Doom); Heroic = game over.
- **Doom Clock full** doesn't instantly end the game: the antagonist comes to you, empowered (+30% HP, +2 to hit).
  You can still win, but it's hard. Losing there ends the campaign.
- **XP** uses a custom, faster curve (L2 at 120 XP … L10 at 4,200) and awards per encounter difficulty rather than
  per monster, so a one-shot reaches about level 4–5 and a campaign about 9–10. The 5e XP budget is still used to
  *build* encounters.
- **Encounter building:** 5e per-character thresholds × group multiplier, scaled by a per-party-size factor
  (`POCKET_SCALE`) and enemy HP factor (`POCKET_HP`), enemy count caps for small parties, elites for 4+ heroes,
  extra legendary actions for 5–6, softer boss damage and no boss minions for 1–2. A solo hero always gets a
  companion (Pip the Squire). All numbers were tuned with the simulator.
- **Adaptive director** (toggle): ±0.3 multiplier on the XP budget driven by how the last fights went (HP left,
  downs, round count), plus the pacing rules: max 2 fights in a row, a safe/social beat after hard fights, and the
  last 5 event cards never repeat.
- **Minigame → bonus mapping:** score ≥ 0.8 = *great*, ≥ 0.45 = *good*. Depending on the ability: advantage (good = +2),
  bonus die (+2/+3 to hit), crit range (−1/−2), damage/potency (+1/+2 dice or +turns), or SP refund. Quirks such as
  "Calligrapher" add to specific minigame scores. The d20 is never replaced.
- **Telegraphed attacks:** many big monsters wind up for a turn; targeted players immediately get a short BRACE
  minigame: *parry* for weapon blows (no save), *shake* for DEX saves, *steady* for other saves. Great = advantage
  on the save / disadvantage on the attack, good = +2. Counter abilities (Counterspell, Shield Bash, Cutting Words,
  Disarm) or stunning the monster cancel the wind-up.
- **New minigames: lockpick, parry, balance.** Lockpick (three hidden tumblers on a dial, found by ear and by the
  pick trembling; you must *rest* on one to set it, so sweeping slowly does not work) replaces the two-finger game
  for picking locks and disarming traps, and is a dungeon puzzle option. Parry (tap as five ever-faster rings meet
  your shield; a tap long before impact is a flinch that wastes that parry, so mashing fails) is the brace for
  weapon blows and Riposte's minigame. Balance (an unstable tightrope with gusts; falling ends the walk) is used for
  rope bridges and climbs. Lockpick and balance are tilt games with drag/hold-a-side touch fallbacks.

## Phones, dice and sensors

- **Fair dice:** for digital rolls the phone only sends "I threw it"; the server rolls. Physical mode accepts the
  typed values after validating them against each die. Timeouts and disconnects auto-roll.
- **3D dice are drawn on a 2D canvas** (convex polyhedra with back-face culling, numbers mapped onto faces) instead of
  three.js: smaller, no dependency, and the ink-on-parchment style fits the theme. The tumble settles on the
  server's values. d% is shown as a tens die plus a units die.
- **Rune drawing is scored on the server as a trace of the guide**, not by shape recognition. The phone sends the
  stroke in the rune's own shape units (same transform it drew the guide with), and `scoreTrace` multiplies three
  checks: *precision* (all ink near the rune; ink far off costs points, and clearly stray ink is penalised again),
  *coverage* (the whole rune inked) and *order* (follows the path, either direction, any start on closed runes).
  The old $1 recognizer was position/size/rotation invariant and only compared shapes, so a small lopsided blob
  anywhere passed as a perfect circle; it is kept only to say what a failed stroke looked like. The phone colours
  the ink live (violet on the line, gold drifting, red off). Other minigames report a 0..1 score that the server
  clamps; a cheating phone could claim perfect scores, but minigames only ever give a bounded bonus. Accepted risk
  for a living-room game.
- **Every sensor game has a touch fallback** (timing bar, tap-mash, drag-to-aim, finger-steady, slider pitch match,
  drag dial). Fallback is used automatically if a sensor is missing or permission is denied, or on request.
- **iOS:** motion permission is requested inside the Join tap and again inside the minigame Start tap; there is no
  vibration on iOS, so a gold screen-edge flash is used instead, and minigames have synthesized sound cues (the
  hot/cold search beeps faster and higher as you get close, the lockpick's ticks get louder near a tumbler). Audio
  is unlocked in the Start tap, and the page asks iOS for a *playback* audio session during a minigame so the cues
  play even with the silent switch on. Mic games (shout, blow, quiet, hum, listen) get no timer ticks, so the
  phone does not hear itself.
- **"Listen with the mic for hidden sounds"** was implemented as the *quiet* (stay silent) and *listen* (react to a
  faint sound/shimmer) minigames; a true "hear the TV's sound through the phone mic" game proved too dependent on
  room acoustics. **Pressure plates** are cooperative: every player holds their plate during a shared timed window
  and the result uses the *lowest* score.
- **Dice box: the hold angle is level.** Absolute gravity pinned the dice to one edge (nobody holds a phone flat,
  and static friction gives way at about 11 degrees). The box learns the angle the phone is held at (re-learned
  over about 2.5 s) and only tilting away from it rolls the dice; small accelerations and rotation rates are a dead
  zone, so a steady hand does not drag or swirl them.
- **Motion sign is learned, not assumed.** iOS Safari reports `accelerationIncludingGravity` (and `acceleration`)
  with the opposite sign to the spec, which made the dice fall up. The sign is voted from the tilt angle (beta),
  which agrees on every engine, starting from a platform guess.
- **Disconnects:** a player's pending prompts get a 60 s grace period, then resolve with their fallback (combat turns
  become *Defend*; rolls auto-roll). Reconnecting restores the original deadlines.
- **Turn timer** (default 75 s, configurable 0–180 s, 0 = off): when it runs out, the character acts on autopilot
  (bot policy). Leaders choosing a path have no timer — talking it over is part of the fun; the host can tap the TV
  map or press **Skip** to move things along.

## Content

- All gameplay data lives in `shared/content/*.json` and is validated with zod at load time, including
  cross-references (abilities ↔ classes ↔ resources, summons, sets, event monsters/families, bosses).
- Monster names/families are generic fantasy (SRD-style) creatures; no product-identity monsters.
- Species abilities (Breath Weapon, Aggressive Charge) are stored as abilities tagged `species` and are never
  offered at level-up.
- **Bosses scale to the party's level** (`scaleMonsterToLevel`), so any antagonist can be the final boss of a
  one-shot at level 4 or a campaign at level 10.
- **Written answers must come back.** A vote result is kept only if the game uses it again (kingdom, party
  name, motto, place names on the map, tavern, rumor). The mascot and "local legend" rounds were removed
  because their winners were never mentioned again.
- **Titles are said aloud.** The narrator calls a hero by their latest title ("Doob the Bold", "Mira,
  Monster Slayer,") at their first mention in a line, at most once every 4 narration lines per hero
  (`Game.withEpithets`); possessives and the line announcing the title are left alone. The ending names
  every titled hero. Named monsters whose name already ends in an epithet don't also get "the Cultist".

## Secrets & social

- **Secret goals:** each human hero gets a private objective measured from their own stats (kills, crits, healing,
  aced minigames, damage). Completing it is announced on the TV and grants Inspiration, XP and a title.
- **Temptations (traitor-style):** with 3+ humans, ~18% of event votes secretly ask one player to steer the party to a
  specific option. If the party picks it: +1 Inspiration and 25 gold for them, +1 Doom for everyone.
- **Hidden loot:** when searching caches or treasure rooms, the finder sometimes sees an extra item only on their
  phone and can pocket it or share it.
- **Social scenes:** NPC attitude (−3..3) and the NPC's faction reputation adjust the DC; a written line judged
  "convincing" by the rest of the party lowers it further. Success can produce quests, map reveals and loot.
- **Campaign side quests** sometimes reward one of the antagonist's seal-keys, tying side content to the main arc.

## Voices

- **Voices are optional and live in a separate Python worker** (`voice/`), started by the server when
  `voice/.venv` exists. The game never waits on it for rules: with no worker, a crashed worker or no
  main screen connected, lines are simply not spoken. Same split as solo-dm: the Node server owns the
  game, the worker owns the model.
- **Only TTS, no language model** (user, 7 Nov). An earlier plan had a tiny LLM (Gemma E2B) write
  short lines on the fly; dropped in favour of scripted lines: NPC `greet`/`ask` plus new
  `pleased`/`displeased` reactions in `npcs.json`, and monster lines in `barks.json` (taunt, attack,
  hurt, windup, death, flee).
- **Design once, then clone** (from solo-dm): each voice was designed once from a text description
  (Qwen3-TTS VoiceDesign, `voice/tools/design_voices.py`) and the clip is committed. Play only needs
  the Base model, which clones the clip for every line, so a voice stays the same from line to line
  and players never need VoiceDesign. Each clip reads an in-character line (a clone keeps the delivery
  as well as the timbre). All 14 clips were checked with Parakeet speech-to-text against their transcripts.
- **Backends for every GPU vendor** (user: one player is on NVIDIA, another on AMD): MLX on Apple
  Silicon; PyTorch with the official `qwen-tts` package elsewhere. PyTorch's ROCm build exposes AMD
  GPUs through `torch.cuda`, so CUDA and ROCm share one code path. `bun run voice:setup` detects the
  GPU (`nvidia-smi`, `/dev/kfd`/`rocminfo`, or the Windows video controller name) and installs matching
  wheels. AMD on Windows has no official PyTorch ROCm build, so it falls back to the CPU with the 0.6B
  model unless `TORCH_INDEX_URL` points at one. The PyTorch path was tested here on CPU (Mac, 0.6B):
  all test lines transcribed correctly, but synthesis took about twice the audio's length (4.5 s for
  2 s), so on CPU lines start late and the queue keeps them twice as long before dropping them. The
  CUDA and ROCm installs have not been run on real hardware yet.
- **The PyTorch backend loads the cached snapshot by path.** qwen-tts asks the Hub for model info even
  when the model is cached, which fails with the worker's `HF_HUB_OFFLINE=1`.
- **qwen-tts returns whole utterances, mlx-audio streams 0.32 s chunks.** The speech queue sends one
  sentence at a time with two in flight, so on PyTorch the first sentence starts once it is fully
  synthesized and the next one is synthesized while it plays.
- **One global speech queue, never two voices at once** (as in solo-dm). Narration is split into
  sentences. Stale lines are dropped (narration after 14 s, character lines after 7 s), and the oldest
  narration goes first when more than 8 lines wait. A narration that has started is read to its end:
  its remaining sentences are not stale (the ending's last sentence, the party motto, used to expire
  while the first ones played). A sentence counts as heard when the main screen
  reports it played, or after its length plus 4 s if no report comes.
- **Pacing follows speech, with caps.** `beat()` waits for queued speech to finish (at most the beat
  plus 9 s), and a monster's turn waits up to 4 s for its line. With voices off nothing changes.
- **Barks are cosmetic and use `Math.random`, not the seeded RNG**, so a seed plays the same with or
  without them, and the simulator (`instantBots`) skips them. A minimum gap between barks (5 s for
  chatter, less for taunts, wind-ups and last words) keeps fights from becoming a shouting match;
  beasts, oozes, constructs and the like have no lines.
- **Bookkeeping lines are not read aloud** (`narrate(..., { quiet: true })`), and the speech text drops
  emoji, `*stage directions*` and bracketed numbers such as "(Reputation +1)".

## Simplifications / stubs

- **Camera** features were skipped (optional in the brief).
- No grid movement or ranges; "push" and similar effects become *prone*.
- Faction reputation affects shop prices, social-scene outcomes, quest rewards (reputation gains) and ending text;
  there are no faction-exclusive quest chains.
- Bots use a heuristic policy; they are good enough for balance testing and auto-play but not clever.
- Home-base upgrades exist only in Campaign mode.

## Known issues

- With very large parties, a full combat round can take a few minutes; the turn timer and legendary actions keep
  everyone involved but the 6-player experience is the slowest.
- Browsers may block the main screen's audio until the first click (the title screen asks for one).
- Simulated run lengths assume quick decisions; real tables take roughly 2–3× longer than the simulator estimate.
