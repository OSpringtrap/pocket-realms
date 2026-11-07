# Design decisions & notes

Where the brief was ambiguous I picked the option that keeps the table moving and the code robust.
Each entry: **decision** — why.

## Environment & architecture

- **Node 24 LTS was installed user-locally** (`~/.local/opt/node`, symlinked into `~/.local/bin`) because the
  machine had no Node. The project itself only needs Node ≥ 20.
- **One room per server process.** The host machine runs one game; a 4-letter room code guards joining.
  A random **host key** in the main-screen URL is required for host commands; other browsers opening `/host/`
  become read-only spectators.
- **HTTPS on 8443 + HTTP redirect on 8080.** Sensors/Wake Lock need a secure context; the redirect makes the
  address easier to type on a phone. The self-signed certificate includes every LAN IP and is regenerated only
  when a new IP appears, so devices accept the warning once.
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
  minigame (shake/steady). Great = advantage on the save / disadvantage on the attack, good = +2. Counter abilities
  (Counterspell, Shield Bash, Cutting Words, Disarm) or stunning the monster cancel the wind-up.

## Phones, dice and sensors

- **Fair dice:** for digital rolls the phone only sends "I threw it"; the server rolls. Physical mode accepts the
  typed values after validating them against each die. Timeouts and disconnects auto-roll.
- **3D dice are drawn on a 2D canvas** (convex polyhedra with back-face culling, numbers mapped onto faces) instead of
  three.js: smaller, no dependency, and the ink-on-parchment style fits the theme. The tumble settles on the
  server's values. d% is shown as a tens die plus a units die.
- **Rune drawing is scored on the server** with a $1 unistroke recognizer over the raw points (10 rune shapes,
  either stroke direction). Other minigames report a 0..1 score that the server clamps; a cheating phone could claim
  perfect scores, but minigames only ever give a bounded bonus. Accepted risk for a living-room game.
- **Every sensor game has a touch fallback** (timing bar, tap-mash, drag-to-aim, finger-steady, slider pitch match,
  drag dial). Fallback is used automatically if a sensor is missing or permission is denied, or on request.
- **iOS:** motion permission is requested inside the Join tap and again inside the minigame Start tap; there is no
  vibration on iOS, so a gold screen-edge flash is used instead.
- **"Listen with the mic for hidden sounds"** was implemented as the *quiet* (stay silent) and *listen* (react to a
  faint sound/shimmer) minigames; a true "hear the TV's sound through the phone mic" game proved too dependent on
  room acoustics. **Pressure plates** are cooperative: every player holds their plate during a shared timed window
  and the result uses the *lowest* score.
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
