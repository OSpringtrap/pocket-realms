/**
 * End-to-end smoke test over real WebSockets: a host and 6 phones join,
 * create heroes, drop and rejoin with their tokens, then auto-play for a while.
 *   HOST_KEY=testkey ROOM_CODE=TEST PORT=9443 bun dist/server/index.js --no-open &
 *   bun scripts/smoke-clients.ts
 */
import { PROTOCOL_VERSION } from '../shared/src/index.js';
import { Client, assert, sleep } from './lib/wsclient.js';

const KEY = process.env.HOST_KEY ?? 'testkey';
const CODE = process.env.ROOM_CODE ?? 'TEST';
const PLAY_MS = Number(process.env.PLAY_MS ?? 20000);
const CLASSES = ['wizard', 'rogue', 'paladin', 'cleric', 'bard', 'barbarian', 'warrior'];
const QUIRK: Record<string, string> = { elf: 'elf_light_sleeper', dwarf: 'dwarf_ale_powered', human: 'human_farmhand', orc: 'orc_battle_scars', dragonborn: 'db_honor_bound' };
const SPECIES = ['elf', 'dwarf', 'human', 'orc', 'dragonborn', 'human'];

async function main() {
  const host = new Client('host');
  await host.open();
  host.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'host', key: KEY });
  await sleep(200);
  host.send({ t: 'host', key: KEY, command: { cmd: 'newCampaign', settings: { length: 'oneshot', difficulty: 'normal', turnTimer: 0 } } });
  await sleep(300);
  assert(host.view?.scene.kind === 'lobby', 'host sees lobby after newCampaign');

  const phones: Client[] = [];
  for (let i = 0; i < 6; i++) {
    const c = new Client(`Phone${i}`);
    await c.open();
    c.send({ t: 'join', v: PROTOCOL_VERSION, code: CODE, name: `Hero${i}` });
    phones.push(c);
  }
  await sleep(500);
  assert(phones.every((p) => p.token && p.playerId), '6 phones joined and received tokens');
  const extra = new Client('Phone7');
  await extra.open();
  extra.send({ t: 'join', v: PROTOCOL_VERSION, code: CODE, name: 'TooMany' });
  await sleep(300);
  assert(extra.errors.some((e) => /full/i.test(e)), '7th phone is refused (party full)');
  extra.close();
  const bad = new Client('BadCode');
  await bad.open();
  bad.send({ t: 'join', v: PROTOCOL_VERSION, code: 'ZZZZ', name: 'x' });
  await sleep(200);
  assert(bad.errors.some((e) => /code/i.test(e)), 'wrong room code rejected');
  // garbage input must not crash the server
  bad.ws.send('not json');
  bad.send({ t: 'answer', id: 'nope', value: { evil: true } });
  bad.send({ t: 'host', command: { cmd: 'title' } });
  bad.send({ t: 'character:create', draft: { name: '<script>', species: 'elf', cls: 'wizard', quirks: ['elf_bird_fear'] } });
  await sleep(200);
  bad.close();

  phones.forEach((p, i) => {
    const species = SPECIES[i]!;
    p.send({ t: 'character:create', draft: { name: `Hero${i}`, species, cls: CLASSES[i % CLASSES.length], quirks: [QUIRK[species]], personality: 'Brave', ancestry: 'red', extraSkill: 'stealth' } });
  });
  await sleep(500);
  assert(Object.keys(host.view!.chars).length === 6, 'host sees 6 created heroes');

  // drop & rejoin three phones
  const dropped = phones.slice(0, 3);
  const ids = dropped.map((d) => d.playerId);
  dropped.forEach((d) => d.close());
  await sleep(400);
  assert(host.view!.players.filter((p) => !p.connected).length === 3, 'host shows 3 phones disconnected');
  for (const d of dropped) {
    await d.open();
    d.send({ t: 'resume', v: PROTOCOL_VERSION, token: d.token });
  }
  await sleep(400);
  assert(dropped.every((d, i) => d.playerId === ids[i]), 'rejoined phones keep their player id');
  assert(host.view!.players.every((p) => p.connected), 'all 6 phones connected again');
  assert(dropped.every((d) => d.view?.chars[d.playerId!]?.name), 'rejoined phones see their own hero');

  phones[0]!.send({ t: 'intent', intent: { kind: 'physicalDice', on: false } });
  phones[1]!.send({ t: 'intent', intent: { kind: 'ping', q: 0, r: 0 } });
  await sleep(200);
  assert(phones[0]!.errors.length === 0 && phones[1]!.errors.length === 0, 'valid intents produce no errors');
  phones.forEach((p) => p.send({ t: 'ready', ready: true }));
  await sleep(300);
  host.send({ t: 'host', key: KEY, command: { cmd: 'start' } });
  phones.forEach((p) => (p.auto = true));
  phones.forEach((p) => p.autoplay());
  await sleep(1500);
  assert(host.view?.world, 'world generated after start');
  // mid-game drop: one phone sleeps for a bit, then comes back
  const t0 = Date.now();
  let dropDone = false;
  const scenes = new Set<string>();
  while (Date.now() - t0 < PLAY_MS) {
    await sleep(500);
    scenes.add(host.view!.scene.kind);
    if (!dropDone && Date.now() - t0 > PLAY_MS / 3) {
      dropDone = true;
      const p = phones[4]!;
      p.close();
      await sleep(1500);
      await p.open();
      p.send({ t: 'resume', v: PROTOCOL_VERSION, token: p.token });
    }
    if (host.view!.scene.kind === 'ending') break;
  }
  console.log('  scenes seen:', [...scenes].join(', '), '| turn', host.view!.world?.turn, '| doom', host.view!.world?.doom);
  const errs = phones.flatMap((p) => p.errors).filter((e) => !/expired|Not waiting|not your|Only the leader/i.test(e));
  if (errs.length) console.log('  phone errors:', [...new Set(errs)].slice(0, 6));
  assert(phones.every((p) => p.errors.every((e) => !/seq gap/.test(e))), 'no patch sequence gaps');
  assert(host.errors.length === 0, `host received no errors (${host.errors.join('; ')})`);
  assert(scenes.size >= 2, 'game progressed through several scenes');
  phones.forEach((p) => p.close());
  host.close();
  console.log('SMOKE OK');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
