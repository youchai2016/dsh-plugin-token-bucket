// Rebuild only bridge artifacts. No app/profile access. Tooling is development-only.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = new URL('../', import.meta.url);
// Resolve only this checkout's pinned development dependencies.
const requireTooling = createRequire(new URL('package.json', root));
const { build } = requireTooling('esbuild');
const zodDirectory = path.dirname(requireTooling.resolve('zod/package.json'));
if (requireTooling('zod/package.json').version !== '4.4.3' || requireTooling('esbuild/package.json').version !== '0.25.12') {
  throw new Error('Bridge rebuild requires zod@4.4.3 and esbuild@0.25.12');
}
const zodLicense = await fs.readFile(path.join(zodDirectory, 'LICENSE'), 'utf8');
const shared = {
  bundle: true, format: 'esm', target: 'es2022',
  // Keep generated source comments relative even when invoked from another cwd.
  absWorkingDir: fileURLToPath(root), minify: false, legalComments: 'inline',
};

await build({
  entryPoints: [fileURLToPath(new URL('./bridge-contract-source.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('lib/remote.js', root)),
  platform: 'neutral',
  ...shared,
  banner: { js: '// Generated from tools/bridge-contract-source.mjs; includes Zod, not DSH implementation code.\n/* Zod 4.4.3 license:\n' + zodLicense + '\n*/' },
});

// The Host half is bundled too, so it never depends on sibling ESM resolution.
await build({
  entryPoints: [fileURLToPath(new URL('src/host-bridge.js', root))],
  outfile: fileURLToPath(new URL('lib/index.js', root)),
  platform: 'node',
  ...shared,
  banner: { js: '// Generated from src/host-bridge.js. Uses the Host credential service and one read-only balance request.' },
});

// Remove an obsolete helper from earlier layouts during incremental rebuilds.
await fs.rm(new URL('lib/version.js', root), { force: true });
console.log('Built strict browser contract and bundled Host entry.');
