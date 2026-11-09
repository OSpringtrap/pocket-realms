import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Online play through a Cloudflare "quick tunnel": `cloudflared` opens an outbound connection to
 * Cloudflare and prints a random https://<words>.trycloudflare.com address that forwards to this
 * server. No account, no port forwarding, and a real certificate (so remote phones get no warning
 * and keep their sensors). The tunnel talks to our self-signed HTTPS port, hence --no-tls-verify.
 *
 * A quick tunnel gets a new address every time it starts, so if cloudflared dies and is restarted,
 * remote players need the new link (onUrl fires again).
 */

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 5000;
const STABLE_MS = 60_000;

export function parseTunnelUrl(text: string): string | undefined {
  // cloudflared also logs https://api.trycloudflare.com while it registers; that is not ours
  for (const m of text.matchAll(new RegExp(URL_RE, 'g'))) if (!m[0].startsWith('https://api.')) return m[0];
  return undefined;
}

/**
 * A brand-new quick-tunnel name takes from a few seconds to about a minute to resolve, so a link
 * sent the moment cloudflared prints it can fail ("site can't be reached"). Poll /healthz through
 * the tunnel until it answers, so the links are only shown once they work. The first try waits a
 * little: asking too early can make a DNS resolver cache "no such name" for a while.
 */
export async function waitUntilReachable(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; firstDelayMs?: number; fetch?: (u: string, init?: RequestInit) => Promise<Response>; stillCurrent?: () => boolean } = {},
): Promise<boolean> {
  const { timeoutMs = 90_000, intervalMs = 2000, firstDelayMs = 3000, stillCurrent = () => true } = opts;
  const get = opts.fetch ?? fetch;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  await sleep(firstDelayMs);
  while (stillCurrent() && Date.now() < deadline) {
    try {
      const res = await get(`${url}/healthz`, { signal: AbortSignal.timeout(4000) });
      if (res.ok && (await res.text()).trim() === 'ok') return true;
    } catch {
      /* not resolvable / not routed yet */
    }
    await sleep(intervalMs);
  }
  return false;
}

export class Tunnel {
  url?: string;
  onUrl?: (url: string) => void;
  /** a message for the terminal (install hint, crash, restart) */
  onLog: (msg: string) => void = (m) => console.log(m);
  private child?: ChildProcess;
  private stopped = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private port: number,
    private bin = process.env.CLOUDFLARED || 'cloudflared',
  ) {}

  start() {
    if (this.stopped) return;
    // 127.0.0.1, not localhost: the server listens on IPv4 only and localhost may resolve to ::1
    const args = ['tunnel', '--no-autoupdate', '--no-tls-verify', '--url', `https://127.0.0.1:${this.port}`];
    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return this.missing(e as NodeJS.ErrnoException);
    }
    this.child = child;
    const startedAt = Date.now();
    let buf = '';
    const scan = (chunk: Buffer) => {
      if (this.child !== child) return;
      buf = (buf + chunk.toString()).slice(-4096);
      const url = parseTunnelUrl(buf);
      if (url && url !== this.url) {
        this.url = url;
        buf = '';
        this.onUrl?.(url);
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e: NodeJS.ErrnoException) => this.missing(e));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopped) return;
      this.url = undefined;
      // a tunnel that ran for a while earned a fresh set of restarts; one that keeps crashing did not
      if (Date.now() - startedAt > STABLE_MS) this.restarts = 0;
      if (++this.restarts > MAX_RESTARTS) return this.onLog(`🌍 The online tunnel keeps stopping (exit ${code ?? signal}); giving up. Local play still works.`);
      this.onLog(`🌍 The online tunnel stopped (exit ${code ?? signal}); restarting in ${RESTART_DELAY_MS / 1000} s. Remote players will need the new link.`);
      this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    });
  }

  private missing(e: NodeJS.ErrnoException) {
    this.child = undefined;
    this.stopped = true;
    if (e.code === 'ENOENT') {
      this.onLog(
        [
          `🌍 Online play needs cloudflared, which was not found (${this.bin}). Install it, then run again:`,
          '     Arch/CachyOS:  sudo pacman -S cloudflared',
          '     macOS:         brew install cloudflared',
          '     Debian/Ubuntu, Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
          '   Local play still works.',
        ].join('\n'),
      );
    } else this.onLog(`🌍 Could not start cloudflared: ${e.message}. Local play still works.`);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = undefined;
  }
}
