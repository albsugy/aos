// Build the single-file compiled bundle that installs ship.
// Output: dist/aos.mjs (deps inlined, minified) + dist/ui.html (console UI).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'cli.js')],
  outfile: path.join(dist, 'aos.mjs'),
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    // Shebang, plus a CJS require shim: bundled CJS deps (yaml) require()
    // node builtins, which ESM output doesn't provide by itself.
    js: '#!/usr/bin/env node\nimport { createRequire as __aosCreateRequire } from "node:module";\nconst require = __aosCreateRequire(import.meta.url);',
  },
  define: { 'process.env.AOS_BUNDLED': '"1"' },
  // Preserve any dependency license banners (emitted to dist/aos.mjs.LEGAL.txt
  // when present) instead of stripping them. The bundled `yaml` ships no inline
  // banner, so its ISC notice is reproduced in THIRD-PARTY-LICENSES.md — the
  // canonical attribution for everything inlined into the bundle.
  legalComments: 'external',
});

// The console reads ui.html as a sibling file at runtime.
fs.copyFileSync(path.join(root, 'src', 'console', 'ui.html'), path.join(dist, 'ui.html'));
fs.chmodSync(path.join(dist, 'aos.mjs'), 0o755);

const size = (fs.statSync(path.join(dist, 'aos.mjs')).size / 1024).toFixed(0);
const legal = fs.existsSync(path.join(dist, 'aos.mjs.LEGAL.txt')) ? ' + dist/aos.mjs.LEGAL.txt' : '';
console.log(`✔ dist/aos.mjs (${size} KB) + dist/ui.html${legal}`);
