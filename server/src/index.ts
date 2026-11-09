import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { content } from '@pr/shared';
import { ensureCert } from './cert.js';
import { realClock } from './clock.js';
import { Game } from './game/Game.js';
import { installHandlers, toTitle } from './game/director.js';
import { lanIps, openBrowser } from './net.js';
import { Room, clientAddress, makeRoomCode } from './room.js';
import { Tunnel, waitUntilReachable } from './tunnel.js';
import { SpeechQueue } from './voice/speech.js';
import { TtsWorker } from './voice/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from dist/server/index.js and server/src/index.ts
const ROOT = path.resolve(here, '..', '..');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT ?? 8443);
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const NO_OPEN = args.has('--no-open') || process.env.NO_OPEN === '1';
/** your own tunnel / reverse proxy address (Tailscale Funnel, a named Cloudflare tunnel...) */
const PUBLIC_URL = /^https:\/\/[^\s/?#]+$/.test(process.env.PUBLIC_URL?.replace(/\/+$/, '') ?? '') ? process.env.PUBLIC_URL!.replace(/\/+$/, '') : undefined;
/** start a Cloudflare quick tunnel (needs cloudflared) */
const ONLINE = !PUBLIC_URL && (args.has('--online') || process.env.ONLINE === '1');

function main() {
  // Fail loudly on bad content before anything else
  try {
    const c = content();
    console.log(`📚 Content OK: ${c.abilityList.length} spells & abilities, ${c.monsterList.length} monsters, ${c.itemList.length} items, ${c.events.length} event cards.`);
  } catch (e) {
    console.error('❌ Content validation failed:\n', (e as Error).message);
    process.exit(1);
  }

  const ips = lanIps();
  const ip = ips[0] ?? '127.0.0.1';
  const { key, cert } = ensureCert(path.join(ROOT, '.certs'), ips);
  const code = process.env.ROOM_CODE && /^[A-Z]{4}$/.test(process.env.ROOM_CODE) ? process.env.ROOM_CODE : makeRoomCode();
  const hostKey = process.env.HOST_KEY && /^[a-z0-9]{6,64}$/i.test(process.env.HOST_KEY) ? process.env.HOST_KEY : randomBytes(8).toString('hex');
  const lanUrl = `https://${ip}:${PORT}`;
  const hostUrl = `https://localhost:${PORT}/host/?key=${hostKey}`;
  if (process.env.PUBLIC_URL && !PUBLIC_URL) console.warn(`⚠️  Ignoring PUBLIC_URL=${process.env.PUBLIC_URL}: expected something like https://my-game.example.com`);

  const game = new Game({ clock: realClock, code, lanUrl, publicUrl: PUBLIC_URL, savesDir: path.join(ROOT, 'saves'), log: (m) => console.log(m) });
  /** phones join through the internet address when there is one (it works on the LAN too) */
  const joinUrl = () => `${game.opts.publicUrl ?? lanUrl}/?room=${code}`;
  installHandlers(game);
  toTitle(game);
  const room = new Room(game, code, hostKey);

  // Optional voices: narrator and characters, spoken on the main screen and on watch screens.
  const tts = new TtsWorker(ROOT);
  const speech = new SpeechQueue(tts, { hosts: () => room.screenCount(), json: (m) => room.sendScreens(m as never), binary: (b) => room.sendScreens(b) });
  tts.onStatus = () => game.dirty();
  room.onSpeechPlayed = (sid) => speech.played(sid);
  game.voice = speech;
  tts.start();

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'accelerometer=(self), gyroscope=(self), magnetometer=(self), microphone=(self), screen-wake-lock=(self)');
    next();
  });
  const hostDir = path.join(ROOT, 'dist', 'client-host');
  const phoneDir = path.join(ROOT, 'dist', 'client-phone');
  if (!fs.existsSync(hostDir) || !fs.existsSync(phoneDir)) console.warn('⚠️  Built clients not found — run `bun run build` (`bun start` does this for you).');
  /**
   * The QR and /api/info contain the room code, and online anyone with the tunnel address can reach
   * them, so they need the host key or the code itself (counted by the same wrong-guess lockout).
   */
  const mayKnowCode = (req: express.Request): boolean => {
    if (req.query.key === hostKey) return true;
    return room.checkCode(clientAddress(req.socket.remoteAddress, req.headers), req.query.room) === null;
  };
  app.get('/api/qr.svg', async (req, res) => {
    if (!mayKnowCode(req)) return void res.status(403).type('text/plain').send('room code or host key required');
    const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, color: { dark: '#2b1d0e', light: '#00000000' } });
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-cache').send(svg);
  });
  app.get('/api/info', (req, res) => (mayKnowCode(req) ? res.json({ code, joinUrl: joinUrl(), lanUrl, publicUrl: game.opts.publicUrl ?? null }) : res.status(403).json({ error: 'room code or host key required' })));
  app.get('/healthz', (_req, res) => res.send('ok'));
  app.use('/host', express.static(hostDir, { index: 'index.html', maxAge: '1h' }));
  app.use('/', express.static(phoneDir, { index: 'index.html', maxAge: '1h' }));
  app.get('/host/*', (_req, res) => res.sendFile(path.join(hostDir, 'index.html')));

  const server = https.createServer({ key, cert }, app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('connection', (ws, req) => room.attach(ws, clientAddress(req.socket.remoteAddress, req.headers)));

  // Plain HTTP on another port just redirects to HTTPS (easier to type on a phone)
  const redirect = http.createServer((req, res) => {
    const hostHeader = (req.headers.host ?? `${ip}:${HTTP_PORT}`).replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${hostHeader}:${PORT}${req.url ?? '/'}` });
    res.end();
  });
  redirect.on('error', (e) => console.warn(`(HTTP redirect on port ${HTTP_PORT} unavailable: ${(e as Error).message})`));

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`❌ Port ${PORT} is in use. Close the other program or run with PORT=9443 bun start`);
    else console.error('❌ Server error:', e);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    redirect.listen(HTTP_PORT, '0.0.0.0');
    const line = '─'.repeat(64);
    console.log(`\n${line}\n  🏰  POCKET REALMS is running!\n${line}`);
    console.log(`  📺 Main screen:  ${hostUrl}`);
    console.log(`  📱 Phones join:  https://${ip}:${PORT}   (room code: ${code})`);
    console.log(`                   or http://${ip}:${HTTP_PORT} (redirects)`);
    if (ips.length > 1) console.log(`     other addresses: ${ips.slice(1).join(', ')}`);
    console.log(`\n  First time on each device: your browser warns about the self-signed`);
    console.log(`  certificate. Tap "Advanced" → "Proceed" (Chrome) or "Show Details" →`);
    if (game.opts.publicUrl || ONLINE) console.log(`  "visit this website" (Safari). Online players get no warning.`);
    else console.log(`  "visit this website" (Safari). Everything stays on your local network.`);
    console.log(`${line}\n`);
    if (game.opts.publicUrl) printOnline(game.opts.publicUrl);
    else if (ONLINE) {
      console.log('🌍 Opening the online tunnel (cloudflared)...');
      tunnel?.start();
    }
    if (!NO_OPEN) openBrowser(hostUrl);
  });

  /** what to send a remote player: their phone link and a watch-only main screen */
  function printOnline(url: string, verified = true) {
    const line = '─'.repeat(64);
    console.log(`${line}\n  🌍  ONLINE: send these to players who are not in the room\n${line}`);
    console.log(`  📱 Phone:        ${url}/?room=${code}`);
    console.log(`  📺 Watch screen: ${url}/host/?room=${code}      (follows the game, no controls)`);
    if (!verified) console.log(`\n  (It has not answered from here yet. If a link won't open, wait a minute and retry.)`);
    console.log(`\n  Keep the host link above to yourself: it controls the game.`);
    console.log(`${line}\n`);
  }

  const tunnel = ONLINE ? new Tunnel(PORT) : undefined;
  if (tunnel) {
    tunnel.onUrl = (url) => {
      console.log(`🌍 Tunnel created; waiting until ${url.replace('https://', '')} answers from the internet...`);
      void waitUntilReachable(url, { stillCurrent: () => tunnel.url === url }).then((ok) => {
        if (tunnel.url !== url) return; // restarted meanwhile; the new address reports itself
        game.setPublicUrl(url);
        printOnline(url, ok);
      });
    };
    tunnel.onLog = (m) => {
      if (!tunnel.url) game.setPublicUrl(undefined);
      console.log(m);
    };
  }

  const shutdown = () => {
    console.log('\nSaving and shutting down...');
    try {
      if (game.state.phase === 'playing') game.save();
    } catch {
      /* ignore */
    }
    room.close();
    tts.stop();
    tunnel?.stop();
    process.exit(0);
  };
  process.on('exit', () => {
    tts.stop();
    tunnel?.stop();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
}

main();
