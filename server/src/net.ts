import { spawn } from 'node:child_process';
import os from 'node:os';

/** LAN IPv4 addresses, best candidates first (192.168.x, 10.x, 172.16-31.x). */
export function lanIps(): string[] {
  const out: { ip: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (a.address.startsWith('192.168.')) score = 3;
      else if (a.address.startsWith('10.')) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score = 1;
      if (/^(docker|br-|veth|virbr|vmnet|tailscale|zt|lxc|tun)/i.test(name)) score -= 5;
      out.push({ ip: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.ip);
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`  (Could not open a browser automatically — open ${url} yourself.)`));
    child.unref();
  } catch {
    console.log(`  (Could not open a browser automatically — open ${url} yourself.)`);
  }
}
