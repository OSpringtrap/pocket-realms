/**
 * Save/continue test. Phase "start": new campaign with 2 phones, play until the
 * first autosave, write tokens to a file. Phase "resume" (after a server restart):
 * host continues the save, phones resume with their tokens and keep playing.
 */
import fs from 'node:fs';
import { PROTOCOL_VERSION } from '../shared/src/index.js';
import { Client, assert, sleep } from './lib/wsclient.js';

const KEY = 'testkey';
const FILE = process.env.TOKENS_FILE ?? '/tmp/pr-tokens.json';
const phase = process.argv[2];

async function host() {
  const h = new Client('host');
  await h.open();
  h.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'host', key: KEY });
  await sleep(300);
  return h;
}

if (phase === 'start') {
  const h = await host();
  h.send({ t: 'host', key: KEY, command: { cmd: 'newCampaign', settings: { turnTimer: 0 }, seed: 'SAVE-TEST' } });
  await sleep(300);
  const phones: Client[] = [];
  for (const [i, sp] of ['elf', 'orc'].entries()) {
    const p = new Client(`P${i}`);
    await p.open();
    p.send({ t: 'join', v: PROTOCOL_VERSION, code: 'TEST', name: `Saver${i}` });
    await sleep(200);
    p.send({ t: 'character:create', draft: { name: `Keeper${i}`, species: sp, cls: i ? 'warrior' : 'cleric', quirks: [i ? 'orc_battle_scars' : 'elf_light_sleeper'], personality: 'x' } });
    phones.push(p);
  }
  await sleep(400);
  h.send({ t: 'host', key: KEY, command: { cmd: 'start' } });
  phones.forEach((p) => ((p.auto = true), p.autoplay()));
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 150000 && (h.view?.world?.turn ?? 1) < 2) {
    await sleep(500);
    const now = `${h.view?.scene.kind} | ${h.view?.narration.at(-1)?.text.slice(0, 70)} | waiting: ${h.view?.waiting.map((w) => w.label).join(',')}`;
    if (now !== last) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${now}`);
    last = now;
  }
  assert((h.view?.world?.turn ?? 0) >= 2, 'reached turn 2 (an autosave happened)');
  fs.writeFileSync(FILE, JSON.stringify({ tokens: phones.map((p) => p.token), ids: phones.map((p) => p.playerId), seed: h.view?.campaign?.seed, turn: h.view?.world?.turn }));
  console.log('PHASE START OK');
  process.exit(0);
} else {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { tokens: string[]; ids: string[]; seed: string; turn: number };
  const h = await host();
  assert(h.view?.scene.kind === 'title', 'fresh server shows title');
  const saves = (h.view!.scene as { saves: { id: string; name: string }[] }).saves;
  assert(saves.length >= 1, `title lists saves (${saves.map((s) => s.name).join(', ')})`);
  h.send({ t: 'host', key: KEY, command: { cmd: 'continue', saveId: saves[0]!.id } });
  await sleep(400);
  assert(h.view?.campaign?.seed === saved.seed, 'continued the right campaign');
  const phones: Client[] = [];
  // phone 0 comes back with its stored token
  const p0 = new Client('P0');
  await p0.open();
  p0.send({ t: 'resume', v: PROTOCOL_VERSION, token: saved.tokens[0] });
  await sleep(300);
  assert(p0.playerId === saved.ids[0] && p0.view?.chars[p0.playerId!], 'phone 0 resumed as its old hero');
  phones.push(p0);
  // phone 1 is a different device: joins fresh and claims the hero from the list
  const p1 = new Client('P1-new-device');
  await p1.open();
  p1.send({ t: 'join', v: PROTOCOL_VERSION, code: 'TEST', name: 'NewDevice' });
  await sleep(300);
  const claimable = p1.view?.me.creation?.claimable ?? [];
  assert(claimable.some((c) => c.id === saved.ids[1]), 'new device sees the unclaimed hero');
  p1.send({ t: 'claim', charId: saved.ids[1] });
  await sleep(300);
  assert(p1.playerId === saved.ids[1] && p1.view?.chars[p1.playerId!], 'new device claimed the old hero');
  phones.push(p1);
  await sleep(300);
  assert(h.view!.players.every((p) => p.ready), 'resumed heroes are ready');
  h.send({ t: 'host', key: KEY, command: { cmd: 'start' } });
  phones.forEach((p) => ((p.auto = true), p.autoplay()));
  await sleep(4000);
  assert(h.view?.scene.kind !== 'lobby' && (h.view?.world?.turn ?? 0) >= saved.turn, `play resumed at turn ${h.view?.world?.turn}`);
  // a brand new friend arrives mid-game
  const late = new Client('Late');
  await late.open();
  late.send({ t: 'join', v: PROTOCOL_VERSION, code: 'TEST', name: 'Latecomer' });
  await sleep(300);
  late.send({ t: 'character:create', draft: { name: 'Tardy', species: 'human', cls: 'bard', quirks: ['human_rhymes'], personality: 'Late again' } });
  await sleep(400);
  assert(late.view?.chars[late.playerId!]?.name === 'Tardy', 'mid-game joiner created a hero and joined the party');
  console.log('PHASE RESUME OK');
  process.exit(0);
}
