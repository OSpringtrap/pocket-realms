import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';

/**
 * Self-signed certificate, generated on first run and reused (so phones only
 * accept the warning once). Regenerated if a new LAN IP appears.
 */
export function ensureCert(dir: string, ips: string[]): { key: string; cert: string } {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { ips: string[]; expires: number };
    if (ips.every((ip) => meta.ips.includes(ip)) && meta.expires > Date.now() + 86400_000 && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') };
    }
  } catch {
    /* generate below */
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: 'pocket-realms.local' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const days = 825;
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Pocket Realms' }, { name: 'organizationName', value: 'Pocket Realms (local)' }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, JSON.stringify({ ips, expires: Date.now() + days * 86400_000 }));
  return { key: pems.private, cert: pems.cert };
}
