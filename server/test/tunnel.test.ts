import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instantClock } from '../src/clock.js';
import { Game } from '../src/game/Game.js';
import { Tunnel, parseTunnelUrl, waitUntilReachable } from '../src/tunnel.js';

// what cloudflared 2024–2026 prints on stderr for a quick tunnel
const BANNER = `2026-11-09T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-09T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-09T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-09T10:00:01Z INF |  https://brave-otter-lantern-quest.trycloudflare.com                                       |
2026-11-09T10:00:01Z INF +--------------------------------------------------------------------------------------------+`;

const dirs: string[] = [];
const tunnels: Tunnel[] = [];
afterEach(() => {
  for (const t of tunnels.splice(0)) t.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** a stand-in cloudflared: prints the banner in two pieces (as pipes do), then waits */
function fakeCloudflared(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tunnel-'));
  dirs.push(dir);
  const bin = path.join(dir, 'cloudflared');
  const [a, b] = [BANNER.slice(0, 300), BANNER.slice(300)];
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\nprintf '%s' '${a}' >&2\nsleep 0.05\nprintf '%s\\n' '${b}' >&2\nexec sleep 30\n`, { mode: 0o755 });
  return bin;
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
};

describe('online tunnel', () => {
  it('finds the quick tunnel address in cloudflared output', () => {
    expect(parseTunnelUrl(BANNER)).toBe('https://brave-otter-lantern-quest.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel')).toBeUndefined();
    expect(parseTunnelUrl('INF Registered tunnel connection connIndex=0')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('starts cloudflared against the local HTTPS port and reports the address', async () => {
    const bin = fakeCloudflared();
    const t = new Tunnel(9443, bin);
    tunnels.push(t);
    const urls: string[] = [];
    t.onUrl = (u) => urls.push(u);
    t.onLog = () => {};
    t.start();
    await waitFor(() => urls.length > 0);
    expect(urls).toEqual(['https://brave-otter-lantern-quest.trycloudflare.com']);
    const args = fs.readFileSync(path.join(path.dirname(bin), 'args'), 'utf8');
    expect(args).toContain('--url https://127.0.0.1:9443');
    expect(args).toContain('--no-tls-verify');
  });

  it('says how to install cloudflared when it is missing', async () => {
    const t = new Tunnel(9443, '/nonexistent/cloudflared');
    tunnels.push(t);
    const logs: string[] = [];
    t.onLog = (m) => logs.push(m);
    t.start();
    await waitFor(() => logs.length > 0);
    expect(logs[0]).toContain('cloudflared');
    expect(logs[0]).toContain('Local play still works');
  });

  it('waits until the new address answers before calling it ready', async () => {
    let calls = 0;
    const fake = async (u: string) => {
      calls++;
      expect(u).toBe('https://x.trycloudflare.com/healthz');
      if (calls < 3) throw new Error('getaddrinfo ENOTFOUND'); // DNS not there yet
      return new Response('ok');
    };
    expect(await waitUntilReachable('https://x.trycloudflare.com', { fetch: fake, firstDelayMs: 0, intervalMs: 1 })).toBe(true);
    expect(calls).toBe(3);
    // Cloudflare's "tunnel error" page is a 530, not our server
    const errPage = async () => new Response('<html>Cloudflare Tunnel error 1033 ... cookies ...</html>', { status: 530 });
    expect(await waitUntilReachable('https://x.trycloudflare.com', { fetch: errPage, firstDelayMs: 0, intervalMs: 1, timeoutMs: 30 })).toBe(false);
    // the tunnel restarted with another address: stop waiting for this one
    expect(await waitUntilReachable('https://x.trycloudflare.com', { fetch: errPage, firstDelayMs: 0, stillCurrent: () => false })).toBe(false);
  });

  it('puts the online address in the public view once it arrives', () => {
    const g = new Game({ clock: instantClock(), code: 'TEST', lanUrl: 'https://192.168.1.2:8443', instantBots: true });
    let changes = 0;
    g.onChange = () => changes++;
    expect(g.publicView().publicUrl).toBeUndefined();
    g.setPublicUrl('https://brave-otter-lantern-quest.trycloudflare.com');
    expect(g.publicView().publicUrl).toBe('https://brave-otter-lantern-quest.trycloudflare.com');
    expect(g.publicView().lanUrl).toBe('https://192.168.1.2:8443');
    g.setPublicUrl('https://brave-otter-lantern-quest.trycloudflare.com');
    expect(changes).toBe(1);
  });
});
