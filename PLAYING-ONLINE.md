# Playing online: a step-by-step guide

This guide is for a game where some players are **in another house**. One person (the **host**)
runs the game on their computer. Everyone else only needs a phone, plus a computer or TV for the
main screen if they want to see the map and the fights. They install nothing.

```
   HOST'S HOUSE                                      REMOTE PLAYER'S HOUSE
 ┌──────────────────────────┐                      ┌──────────────────────────┐
 │ 💻 computer runs the game│                      │ 📺 watch screen (browser)│
 │ 📺 main screen (controls)│ ◀── internet ──────▶ │ 📱 phone (their hero)    │
 │ 📱 host's phone          │   (Cloudflare link)  │                          │
 └──────────────────────────┘                      └──────────────────────────┘
```

- **Main screen:** the big shared screen with the map, combat, dice and narration. The host's copy
  has the controls (start, skip, settings).
- **Watch screen:** the same main screen opened on a remote player's computer. It follows the game,
  with sound and voices, but has no controls.
- **Phone:** each player's character sheet, dice and minigames. Everyone plays on their own phone.

---

## For the host

### Once: setup

1. Install [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
2. In the game folder: `bun install`
3. Install **cloudflared**, which makes the online link (free, no account):
   - Arch / CachyOS: `sudo pacman -S cloudflared`
   - macOS: `brew install cloudflared`
   - Others: [Cloudflare's download page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
4. Optional: voices for the narrator and characters: `bun run voice:setup` (see the README).

### Every session

1. **Start the game online:**

   ```bash
   bun run online
   ```

   Your main screen opens in the browser. Click it once to turn on sound.

2. **Wait for the links (about a minute).** First the terminal says
   `🌍 Tunnel created; waiting until … answers from the internet...`. Then it prints:

   ```
   🌍  ONLINE: send these to players who are not in the room
   📱 Phone:        https://some-random-words.trycloudflare.com/?room=QWRT
   📺 Watch screen: https://some-random-words.trycloudflare.com/host/
   ```

   The links only appear once they work, so waiting here is normal.

3. **Send both links to the remote player** (in a chat, for example).
   - Do **not** send the `📺 Main screen: https://localhost:…/host/?key=…` link. That one controls
     the game, and it wouldn't work on another computer anyway.
   - The links are **new every session**. Old ones stop working when you close the game.

4. **Start an adventure** on your main screen: pick a length and difficulty and press
   **Begin a new adventure**, or **Continue** a saved campaign.

5. **Join on your own phone**: scan the QR code on the main screen. On the online address it works
   on any network.

6. When every hero shows as ready, press **Start the adventure!**

### During the game

- You're the only one who can press **⏩ Skip**, change **⚙️ Settings**, or quit to the title screen.
- On the map, the leader picks where to go, and you can tap the map to move things along.
- If someone drops out, the game waits 60 seconds for them. After that their hero defends on its
  turns and their rolls are made for them, until they're back.

### Ending a session

- Press **Ctrl+C** in the terminal. The game saves on the way out, and campaigns also autosave
  at the end of every scene.
- Next time, run `bun run online` again, press **Continue** on your save, and send the **new**
  links.

---

## For the remote player

You need a phone with internet (Wi-Fi or mobile data). A computer or TV with a browser is
optional, for the main screen.

### Joining

1. **Open the 📱 Phone link on your phone.** The room code is already filled in.
2. Type your name and tap **🎲 Join the adventure**.
3. **Create your hero** on the phone: your folk, your calling (class), 1–2 quirks, a name, a roll
   for fate, and a portrait you draw with your finger (or skip). Then tap **⚔️ I'm ready!**
   - **Continuing a saved campaign?** The phone asks **"Which hero are you?"**. Tap your hero
     from last time.
4. On iPhone, allow **motion access** when asked. Some minigames use tilting and shaking. If you
   say no, every minigame has a touch version instead.

### The watch screen (recommended)

1. Open the **📺 Watch screen** link on a computer or TV browser.
2. **Click anywhere once.** Browsers keep sound off until you do.
3. Press **F11** (or the browser's fullscreen option) for the full view.
4. "👁 Watching" in the top bar means this screen follows the game; the host controls it.

### During the game

- Your turn, rolls and choices pop up **on your phone**, which jumps back to its action tab and
  buzzes (on iPhone, which can't buzz, the screen edge flashes gold instead).
- Everything everyone sees (the map, the fight, the dice landing, the story) is on the
  **watch screen**.
- If your phone's screen locks or you lose connection, just open the link again. You'll be right
  back in.

---

## Talking to each other

The game has no voice chat, so use a call (Discord, FaceTime, WhatsApp…) to talk during play.

- **Remote player: use headphones** if you have a watch screen with sound. Otherwise the
  narrator coming out of your speakers is picked up by the call and echoes back to the host.
- Don't open a watch screen in the **same room** as the host's main screen; the voices would echo.

---

## Troubleshooting

| What you see | What it means / what to do |
| --- | --- |
| "Safari can't open the page because your iPhone is not connected to the internet" | The phone has no internet right now. Check Wi-Fi/mobile data. On iPhone: *Settings → Cellular* and make sure **Safari** is allowed to use mobile data. |
| "Safari can't find the server" / "This site can't be reached" | The link is new and isn't known everywhere yet (wait a minute and retry), **or** it's from an older session. Ask the host for today's link. |
| A Cloudflare page saying "Tunnel error" | The host's game isn't running (closed, or the computer went to sleep). Host: start it again and send the new links. |
| "Wrong room code" | Use the room code shown on the main screen (4 letters). The phone link fills it in for you. |
| "Too many wrong room codes. Try again in 5 min." | 8 wrong codes in a row locks that connection out for 5 minutes, to keep strangers out. Wait, then use the phone link so the code is filled in. |
| Watch screen shows everything but there's no sound | Click the watch screen once. Check the tab isn't muted. Voices need the host to have them installed (`bun run voice:setup`). |
| The host terminal says the tunnel stopped and is restarting | The internet link dropped. A new pair of links is printed a moment later; everyone opens the new ones. |
| A certificate warning on the phone | You opened the local address (numbers like `192.168…`), not the online link. That works too on the host's Wi-Fi; just tap *Advanced → Proceed* once. Remote players should use the online link. |

For the technical side (your own domain, `PUBLIC_URL`, how the tunnel works), see the
**Playing online** section in the [README](README.md) and [DECISIONS.md](DECISIONS.md).
