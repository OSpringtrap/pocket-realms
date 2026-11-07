/**
 * Voice smoke test over real WebSockets: a host screen plays a bot game with voices on and checks
 * that narration and character lines arrive as speech with audio, and that the game keeps moving.
 *   HOST_KEY=testkey ROOM_CODE=TEST PORT=9443 node dist/server/index.js --no-open &
 *   npx tsx scripts/smoke-voice.ts
 */
import { PROTOCOL_VERSION, type S2C } from '../shared/src/index.js';
import { Client, assert, sleep } from './lib/wsclient.js';

const KEY = process.env.HOST_KEY ?? 'testkey';
const PLAY_MS = Number(process.env.PLAY_MS ?? 90000);

class Host extends Client {
  speeches: { sid: number; job: number; who: string; voice: string }[] = [];
  samples = new Map<number, number>(); // job -> samples received
  ended = 0;
  firstAudioMs: number[] = [];
  private sentAt = new Map<number, number>();
  override onMsg(m: S2C) {
    super.onMsg(m);
    if (m.t === 'speech') {
      this.speeches.push(m);
      this.sentAt.set(m.job, Date.now());
    } else if (m.t === 'speechEnd') {
      this.ended++;
      // Pretend to play it: report once its audio would have finished.
      const s = this.speeches.find((x) => x.sid === m.sid);
      const secs = s ? (this.samples.get(s.job) ?? 0) / 24000 : 0;
      setTimeout(() => this.send({ t: 'speech:played', sid: m.sid }), secs * 1000);
    }
  }
  override onBinary(buf: Buffer) {
    const job = buf.readUInt32LE(4);
    if (!this.samples.has(job)) this.firstAudioMs.push(Date.now() - (this.sentAt.get(job) ?? Date.now()));
    this.samples.set(job, (this.samples.get(job) ?? 0) + buf.readUInt32LE(16));
  }
}

async function main() {
  const host = new Host('host');
  await host.open();
  host.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'host', key: KEY });
  await sleep(300);
  for (let i = 0; i < 120 && host.view?.voice?.state !== 'ready'; i++) await sleep(1000);
  assert(host.view?.voice?.state === 'ready', `voice worker ready (${JSON.stringify(host.view?.voice)})`);
  host.send({ t: 'host', key: KEY, command: { cmd: 'newCampaign', settings: { length: 'oneshot', difficulty: 'normal', turnTimer: 0, voice: true } } });
  await sleep(400);
  for (let i = 0; i < 3; i++) host.send({ t: 'host', key: KEY, command: { cmd: 'addBot' } });
  await sleep(600);
  host.send({ t: 'host', key: KEY, command: { cmd: 'start' } });
  const t0 = Date.now();
  let lastNarr = '';
  let stalls = 0; // longest run of 5 s samples with nothing new
  let run = 0;
  while (Date.now() - t0 < PLAY_MS && host.view?.scene.kind !== 'ending') {
    await sleep(5000);
    // progress = new narration, or new combat log lines during a fight
    const sc = host.view?.scene;
    const cb = sc?.kind === 'combat' ? (sc.combat as { round: number; current?: string; monsters: { hp: number }[] }) : undefined;
    const id = JSON.stringify([host.view?.narration.at(-1)?.id, sc?.kind, cb?.round, cb?.current, cb?.monsters.reduce((a, m) => a + m.hp, 0)]);
    run = id === lastNarr ? run + 1 : 0;
    stalls = Math.max(stalls, run);
    lastNarr = id;
  }
  const who = new Map<string, number>();
  for (const s of host.speeches) who.set(`${s.who} (${s.voice})`, (who.get(`${s.who} (${s.voice})`) ?? 0) + 1);
  const audioS = [...host.samples.values()].reduce((a, b) => a + b, 0) / 24000;
  const ttfa = [...host.firstAudioMs].sort((a, b) => a - b);
  console.log(`speeches ${host.speeches.length}, ended ${host.ended}, audio ${audioS.toFixed(1)}s, first audio median ${ttfa[ttfa.length >> 1]}ms`);
  console.log('speakers:', [...who.entries()].map(([k, v]) => `${k}×${v}`).join(', '));
  console.log('scene:', host.view?.scene.kind, '| last lines:', host.view?.narration.slice(-4).map((l) => (l.who ? `${l.who}: ${l.text}` : l.text)).join(' / '));
  assert(host.speeches.some((s) => s.voice === 'narrator'), 'the narrator spoke');
  assert(audioS > 5, 'audio frames arrived');
  assert(host.ended >= host.speeches.length - 2, 'every sentence finished synthesis');
  assert(stalls < 4, `the game kept moving (longest quiet stretch ${stalls * 5}s)`);
  assert(host.errors.length === 0, `no errors (${host.errors.join('; ')})`);
  console.log('✅ voice smoke passed');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
