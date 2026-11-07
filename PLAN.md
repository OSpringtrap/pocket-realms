0. Role and goal

You are a senior full-stack game developer. Build Pocket Realms, a Jackbox-style local multiplayer fantasy RPG based on simplified D&D 5e. A shared main screen (TV or laptop) shows the world, and 1–6 players join on their own phones by typing a 4-letter room code into their mobile browser. No app install and no internet are required. Everything runs on the host machine over the local network.

Work autonomously, commit after every milestone, and don’t stop to ask questions. Where something is ambiguous, pick the most sensible option and note it in DECISIONS.md. Optimize for a fun, playable game today: finish the vertical slice (Milestones 1–5) before widening content.
1. Tech stack (fixed, don’t relitigate)

    Node 20+, TypeScript, a single repo with npm workspaces: server/, client-host/ (main screen), client-phone/, shared/ (types, rules engine, content data, seeded RNG).
    Server: Express and ws, serving both clients as static files over HTTPS with a self-signed certificate auto-generated on first run (e.g. the selfsigned package). Secure context is required for DeviceMotion, DeviceOrientation, getUserMedia and Wake Lock on phones.
    Clients: Vite and vanilla TypeScript, with Canvas/SVG/CSS for visuals. Use three.js only for the 3D dice if it stays light. No heavy frameworks.
    Startup: npm start builds, starts the server, prints the LAN IP and URL, opens the host screen in the browser, and shows a QR code and a 4-letter room code on the main screen. Phones go to https://<lan-ip>:PORT. Add a one-time “accept the certificate warning” tip on the join page and in the README.
    Authoritative server: all game state and rules resolution run on the server. Phones send intents and input results (a drawn rune, a shake intensity, a dice value) and the server validates them. Use a seeded PRNG (mulberry32 or similar) per run so runs are reproducible and testable.
    Reconnection: players get a token in localStorage. If a phone sleeps or drops, it rejoins to the same character within the session. The game pauses gracefully, or the character goes on auto-defend, for up to 60 seconds.
    Persistence: autosave the campaign to saves/*.json at every scene end. The host screen has “Continue campaign” and “New campaign”.

2. Phone flow

    Join: enter the room code and a name. Keep the screen awake with the Wake Lock API.
    Character creation: pick species (Elf, Dwarf, Human, Orc, Dragonborn) and class (Wizard, Rogue, Paladin, Cleric, Bard, Barbarian, Warrior), then 1–2 quirks from a list tied to species/class (see §6). Ability scores come from a class-based standard array with a small reroll-by-dice minigame for flavor. Players also write or choose a one-line personality, and a drawing pad lets them sketch a portrait or banner on the touchscreen.
    Ready-up: the host starts when all players are ready.
    In-game: the phone shows context-sensitive controls (sheet, inventory, spell list, action buttons) and the current minigame or dice roll. The main screen shows the map, scenes, combat and shared narration. Secrets such as private quests, hidden loot and traitor-style prompts show only on phones.

3. Rules: “5e-lite”

Keep the d20 feel and drop the bookkeeping.

    Abilities: STR, DEX, CON, INT, WIS, CHA with modifiers. Proficiency bonus scales by level. Cap at level 10, with milestone and XP leveling.
    Core resolution: d20 + modifier + proficiency vs a DC or AC. Advantage/disadvantage is supported everywhere. Natural 20 is a crit and natural 1 a fumble, with fun effects, not just numbers.
    HP, AC, initiative: standard. At 0 HP a character goes down, with a simplified death-save rule (3 d20 rolls on the phone, shown dramatically). Dead characters get a revival or a legacy path. Never leave a player sitting out for long.
    Resources: casters use Spell Points (simplified from slots) that recover on rests. Martials use class resources such as Rage, Smite, Second Wind, Sneak Attack dice, Bardic Inspiration and Channel Divinity charges. Short rests and long rests happen at camps and inns.
    Conditions (limit to about 10): poisoned, stunned, frightened, prone, blinded, charmed, burning, frozen/slowed, blessed, inspired.
    Skills (condensed to about 12): Athletics, Acrobatics, Stealth, Arcana, Nature, Religion, Insight, Perception, Persuasion, Deception, Intimidation, Performance. A few skills can be used by anyone, and the associated minigame can grant bonuses.
    Items: weapons, armor, trinkets, consumables and magic items, in rarities Common to Legendary, with procedurally generated affixes (e.g. “Flaming”, “of the Fox”). Inventory is handled on the phone, and shared loot goes to a party stash.
    Dice system: support d4, d6, d8, d10, d12, d20 and d100 (percentile). Whenever an action calls for a roll, the phone shows the right dice with a 3D tumbling animation. Players can shake the phone to throw or tap to roll. Each player has a “physical dice” toggle: when on, the phone shows “Roll your real d8 and enter the result”, with a number pad that validates the allowed range. Rolls are mirrored on the main screen with the player’s name and the outcome narrated. The server never trusts a client-side roll for fairness-sensitive events. It generates the result, except in physical-dice mode, where it accepts the entered value.

4. Sensor and input mechanics

The minigame result modifies the roll (grants advantage, adds a bonus die, widens the crit range, adds damage or reduces cost). It never replaces the d20 and never makes the player’s real-world skill the only factor.

Feature-detect every sensor and always provide a touch-only fallback. iOS needs DeviceMotionEvent.requestPermission() triggered from a user gesture. Vibration is unsupported on iOS, so use screen flash and sound instead.
Input	Used for
Touchscreen drawing	Wizard runes (draw the shape for each spell, scored by a simple $1 gesture recognizer with a tolerance setting), cleric holy symbols, rogue lock-tracing, the party banner
Microphone (volume and pitch)	Shout a battle cry (barbarian Rage), sustained hum or note-matching (bard songs), blow into the mic to fan flames or blow out candles, whisper-quiet stealth where silence is the goal
Accelerometer	Swing the phone for melee (peak force and direction), shake to roll dice, hold steady for archery or lockpicking (low variance is success), shake out of grapples
Gyroscope / orientation	Tilt to aim spells and arrows, tilt-balance on rope bridges, “turn around the room” to investigate (compass heading reveals hidden things at specific directions, signaled by haptic or audio hot/cold)
Vibration / haptics	Proximity hints when searching, heartbeat on low HP, traps ticking, the feel of a crit
Multitouch	Hold-and-release charge casting, two-finger disarm, rhythm tapping for bard performances, press-and-hold to concentrate
Camera	Optional, off by default. Skip it unless time remains

Debug mode: ?debug=1 shows simulated sensor sliders and buttons so everything is testable on a desktop without a phone.
5. Procedural generation (inspired by For The King)

Each campaign is generated from a seed:

    Overworld: a hex or node graph with biomes (forest, swamp, mountains, desert, ruins, coast) and points of interest (towns, dungeons, camps, shrines, merchants, lairs, hidden caches). Fog of war, with tiles revealed as the party explores. Movement spends a limited per-turn “move” budget.
    Time pressure: a Doom Clock/Chaos track that advances each turn and with failures, tied to a campaign antagonist and a procedurally chosen final objective, with regional events spawning as it rises. It adds urgency without making play impossible.
    Day/night and weather: these change encounter tables, visibility and available actions.
    Event cards: weighted procedural events with skill-check branches, and often a different class or species is the best fit. Give each event multiple outcomes (success, partial success, failure, and critical versions), with narration templates and a shuffle system so the same event feels different.
    Dungeons: procedural room graphs with encounter rooms, puzzle rooms (sensor-based), trap rooms, treasure and a boss. Include shortcuts, secrets and a retreat option.
    Quests: generated from templates (rescue, fetch, escort, investigate, hunt, negotiate, heist), parameterized by NPCs, regions and factions, and linked to the main campaign arc.
    Loot: a rarity-weighted loot table with affixes, set bonuses and cursed items.
    Monsters: data-driven stat blocks and monster families with variants (e.g. goblin → goblin shaman → goblin warlord). Each has behavior patterns, a weakness, and telegraphed attacks that players respond to via the phone.
    Anti-boredom rules: a “director” system ensures no more than 2 combats in a row, guarantees a safe or social beat after hard encounters, and injects surprise events. It also avoids repeating the last 5 event cards.

Adaptive difficulty (1–6 players)

    Use an XP-budget system per encounter, like 5e, scaled by party size and average level, and tuned with a global difficulty setting (Story, Normal, Heroic).
    Scale enemy count and HP by player count, not just damage. Solo play gets a companion NPC. At 5–6 players, add enemy action economy (extra actions, elites, legendary actions) so nobody is idle, and keep each combat round short.
    The director also nudges difficulty from live signals (party HP and resources, win streaks, near-deaths), staying challenging but rewarding and never impossible. Show a toggle in settings.
    Keep a simulation script that auto-plays 1–6 bot parties, outputs win rates and average encounter lengths, and fails CI if balance drifts out of range.

6. Content (data-driven JSON in shared/content/)

Create a large library. Minimum targets (more is better):

    Spells and abilities: at least 100 total. At minimum 15 per caster class, with leveled tiers (levels 1–10):
        Wizard: Magic Missile, Fire Bolt, Fireball, Shield, Misty Step, Sleep, Counterspell, Lightning Bolt, Web, Ray of Frost, Mage Armor, Burning Hands, Invisibility, Polymorph, Chain Lightning, Disintegrate, etc.
        Cleric: Cure Wounds, Guiding Bolt, Spiritual Weapon, Bless, Sanctuary, Turn Undead, Revivify, Spirit Guardians, Healing Word, Hold Person, Daylight, Banishment, etc.
        Bard: Vicious Mockery, Inspiration, Healing Word, Hypnotic Pattern, Thunderwave, Charm Person, Song of Rest, Shatter, Dissonant Whispers, Power Word Stun, etc.
        Paladin: Divine Smite, Lay on Hands, Shield of Faith, Aura of Protection, Smite variants (wrathful, thunderous, branding), Bless, etc.
        Rogue: Sneak Attack, Cunning Action, Evasion, Poison Blade, Smoke Bomb, Pickpocket, Backstab, Trick Shot, etc.
        Barbarian: Rage, Reckless Attack, Cleave, Intimidating Roar, Whirlwind, Danger Sense, etc.
        Warrior: Second Wind, Action Surge, Shield Bash, Disarm, Taunt, Riposte, Volley, etc.
        Each spell has: name, level, cost, range, target type, effect formula (dice and scaling), conditions applied, an input minigame type (rune, shout, tilt, shake, hold, rhythm, etc.), and flavor text with animation and sound cues.
    Species traits: Elf (keen senses, trance, fey ancestry), Dwarf (poison resistance, stonecunning), Human (versatile, extra skill), Orc (relentless endurance, aggressive charge), Dragonborn (breath weapon via blowing into the mic, damage resistance by ancestry color).
    Quirks: at least 6 per species and 4 per class, each with a small mechanical effect and a roleplay prompt (e.g. “Afraid of birds: disadvantage vs. flying enemies, but +2 Insight against them”, “Compulsive collector”, “Speaks only in rhymes when nervous”).
    Monsters: at least 40, across tiers (goblins, wolves, skeletons, bandits, giant spiders, ogres, wraiths, trolls, mimics, young dragons, etc.) plus 6 bosses.
    Event cards: at least 80, NPCs/factions: at least 20 archetypes with names and motivations, items: at least 150 base items plus affix generation.

Sound: synthesize sound effects with WebAudio (no assets needed), plus an optional ambient loop per biome. Use emoji, SVG and CSS for visuals. Make it look charming and consistent (a parchment and ink theme with animated dice), not a dev-tool look.
7. Beyond combat: exploration, social and growth

    Exploration: tile reveal, investigation minigames (turn around to scan, search by touch, listen with the mic for hidden sounds), traps, puzzles (sequence memory, rune matching, pressure plates requiring multiple players to act at once on their phones).
    Social scenes: NPC dialogue with choices that are role-based (Persuasion, Intimidation, Deception, Performance). Players can speak a line into the mic (volume or pitch affects a bonus), or choose or write an in-character line. Party votes on group decisions, with the tie-breaker being a dice roll.
    Jackbox-style moments: between scenes, the game prompts players privately (“Write a rumor about the tavern”, “Name the village’s mascot”, “Write what your character did last night”). Answers get shown anonymously on the main screen for voting, and the winner is woven into the world as an NPC, a place name or a recurring joke.
    World-building: the party names their kingdom, draws its banner and adds shared lore entries, and it all appears in the campaign journal.
    Camp scenes: short, optional roleplay beats between players (prompts tied to quirks) that grant Inspiration (a reroll or advantage) when done well, as voted by the group.
    Evolution: level-up screens with choices (new spell, new passive, ability score boost), player-written titles and epithets earned from deeds, an upgradable home base or town (inn, shop, shrine) that persists in the campaign, faction reputation that changes prices, quests and endings, and multiple endings depending on choices and the Doom Clock.
    Pacing: each “turn” on the overworld should take about 1–3 minutes, a combat 5–8 minutes, and a full campaign 2–4 hours, with an optional short “one-shot” mode of about 45 minutes.

8. Main-screen UX

Lobby (QR, code, player cards joining with animated avatars), the overworld map with a party token and fog of war, scene narration with typewriter text, a combat view (initiative bar, HP, status icons, floating damage, telegraphed enemy attacks), a dice-roll overlay, a journal and a settings menu (difficulty, text speed, volume, accessibility toggles). Include a color-blind-safe palette and a text-size option. Narration should be readable from a couch.
9. Protocol and architecture

    WebSocket messages are typed and versioned (a discriminated union in shared/), covering join, character:create, intent:*, input:result, roll:request/roll:result, state:patch (send diffs, not full state) and host:*.
    The server uses a scene state machine: Lobby → Creation → Overworld → (Event | Combat | Dungeon | Social | Camp | Town) → Resolution → Overworld, with the Doom Clock ticking in between.
    The rules engine in shared/ must be pure and deterministic (state + action + RNG → new state + events), and unit tested.
    Documented content schemas (zod or similar) with validation at load time, so bad JSON fails loudly.

10. Implementation plan (time-boxed to roughly 12 hours)

Milestone 1: Skeleton (about 1h): monorepo, HTTPS server, QR code and room code, phone join with reconnect tokens, lobby on the main screen. Done when: 6 simulated clients can join, drop and rejoin.

Milestone 2: Rules core and dice (about 1.5h): the shared rules engine, seeded RNG, the dice UI with all dice types, 3D animation, shake-to-roll and the physical-dice entry mode, with unit tests. Done when: tests pass and rolls display on both screens.

Milestone 3: Characters (about 1h): species, class and quirks selection, the character sheet, 6 players at once, and the phone UI.

Milestone 4: Combat vertical slice (about 2h): initiative, turn flow, 3 monster types, 3 abilities per class with at least 4 working sensor minigames (rune drawing, swing, shout, tilt), the touch fallbacks, adaptive scaling, death saves. Done when: a full 1-player and a full 6-player fight are completable and well-paced.

Milestone 5: Overworld and the loop (about 2h): procedural map generation, movement, event cards, rest, loot, a Doom Clock, save and load. Done when: one complete, winnable and losable short run (about 30 minutes) exists from lobby to ending.

— Checkpoint: playable game committed. —

Milestone 6: Content expansion (about 2h): fill out the full spell, monster, item, event and quirk libraries to the targets above, plus the validation tests.

Milestone 7: Exploration and social (about 1.5h): investigation minigames, dialogue scenes, the voting and Jackbox prompt rounds, camp scenes and the world journal.

Milestone 8: Dungeons, towns and growth (about 1.5h): procedural dungeons, bosses, shops, leveling and perks, faction reputation, the home base and endings.

Milestone 9: Polish and balance (about 1h): the bot simulation across 1–6 players, audio and animation polish, accessibility, README with setup instructions (same Wi-Fi, firewall, router client isolation), and a DECISIONS.md.

If time runs short, cut breadth, not stability: drop Milestones 8 and 9 content first, and never ship a broken vertical slice.
11. Quality bar and acceptance checklist

    npm install && npm start works on a fresh machine, with the LAN URL printed.
    Works on Chrome and Safari (iOS and Android) and degrades gracefully when a sensor is missing.
    1, 2, 4 and 6 player runs all complete, with perceptibly different difficulty tuning.
    No unhandled exceptions, and invalid client input can’t crash or cheat the server.
    Every roll can be physical or digital. Every minigame has a fallback.
    The same seed reproduces the same world. Different seeds look and play differently.
    Unit tests for rules, generation and content validation, plus the bot simulation script.
    Final summary: what works, what’s stubbed, how to run it, and known issues.

Make no mistake.
