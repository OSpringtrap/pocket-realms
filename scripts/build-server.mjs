// Bundle the server (and the shared rules/content) into dist/server/index.js
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(root, 'server/src/index.ts')],
  outfile: path.join(root, 'dist/server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  packages: 'external',
  alias: { '@pr/shared': path.join(root, 'shared/src/index.ts') },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('server bundled → dist/server/index.js');
