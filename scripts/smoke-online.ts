/**
 * Smoke test for online play against a server started with --online (or PUBLIC_URL): the public
 * address is in every screen's state, a watch screen (no host key) follows the game but cannot
 * control it, and the real host still can.
 *   HOST_KEY=testkey ROOM_CODE=TEST PORT=9443 HTTP_PORT=9080 PUBLIC_URL=https://example.test bun dist/server/index.js --no-open &
 *   bun scripts/smoke-online.ts
 */
import { PROTOCOL_VERSION } from '../shared/src/index.js';
import { Client, assert, sleep } from './lib/wsclient.js';

const watch = new Client('watch');
const host = new Client('host');
await watch.open();
await host.open();
watch.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'host' });
host.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'host', key: process.env.HOST_KEY ?? 'testkey' });
await sleep(400);
const pub = (c: Client) => (c.view as unknown as { publicUrl?: string; scene: { kind: string } } | undefined);
assert(pub(watch)?.publicUrl?.startsWith('https://'), `watch screen sees the public address (got ${pub(watch)?.publicUrl})`);
assert(pub(host)?.publicUrl === pub(watch)?.publicUrl, 'host and watch screen agree on the address');

watch.send({ t: 'host', command: { cmd: 'newCampaign', settings: {} } });
await sleep(300);
assert(watch.errors.some((e) => /main screen/i.test(e)), `watch screen cannot run host commands (errors: ${watch.errors.join(' | ')})`);
assert(pub(watch)?.scene.kind === 'title', 'the game did not start from the watch screen');

host.send({ t: 'host', command: { cmd: 'newCampaign', settings: {} } });
await sleep(600);
assert(pub(host)?.scene.kind === 'lobby', `host starts a campaign (scene ${pub(host)?.scene.kind})`);
assert(pub(watch)?.scene.kind === 'lobby', 'watch screen follows into the lobby');

const phone = new Client('Remote');
await phone.open();
phone.send({ t: 'join', v: PROTOCOL_VERSION, code: process.env.ROOM_CODE ?? 'TEST', name: 'Remote' });
await sleep(400);
assert(!!phone.playerId, 'remote phone joins');
assert((pub(watch) as unknown as { players: unknown[] }).players.length === 1, 'watch screen sees the new player');

// leave the room as we found it, so other smoke tests can follow on the same server
host.send({ t: 'host', command: { cmd: 'kick', playerId: phone.playerId } });
host.send({ t: 'host', command: { cmd: 'title' } });
await sleep(300);
console.log('✅ online smoke test passed');
process.exit(0);
