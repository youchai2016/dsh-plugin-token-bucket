import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('package is a self-contained DSH bundle with only its own inserted row', () => {
  assert.equal(manifest.name, 'dsh-plugin-token-bucket');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  for (const target of Object.values(manifest.exports)) assert.equal(fs.existsSync(path.join(root, target)), true);
  assert.equal((read('cordis.patch.yml').match(/- id:/g) || []).length, 1);
  assert.match(read('cordis.patch.yml'), /id: token-bucket\s*\n\s*name: dsh-plugin-token-bucket/);
  assert.equal(manifest.dependencies, undefined);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
    assert.equal(manifest.scripts[hook], undefined);
  }
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.scripts.build, 'node tools/bridge-build.mjs && node tools/build.mjs');
  assert.ok(manifest.files.includes('lib'));
  assert.ok(manifest.files.includes('cordis.patch.yml'));
});

test('the host half is one bundled, read-only, silent entry', async () => {
  const host = await import('../lib/index.js');
  assert.equal(host.name, 'tokenBucket');
  assert.deepEqual(host.inject, ['credentials']);
  assert.equal(typeof host.apply, 'function');
  const bundle = read('lib/index.js');
  assert.match(bundle, /api\.deepseek\.com\/user\/balance/, 'the one documented endpoint');
  assert.doesNotMatch(bundle, /from ['"](?:node:)?(?:fs|child_process|net|http|https)['"]|createServer|writeFile/);
  assert.doesNotMatch(bundle, /console\.(log|info|warn|error)/, 'the host must never log, least of all a credential');
  assert.doesNotMatch(bundle, /sk-[A-Za-z0-9]{8}/, 'no credential may be embedded or echoed');
  assert.equal((bundle.match(/fetchImpl\(/g) || []).length, 1, 'exactly one outbound request path');
});

test('the browser half registers one factory and never talks to the balance service itself', () => {
  const registrations = [];
  vm.runInNewContext(read('lib/client.js'), { window: { __ModuleLoader__: { load: item => registrations.push(item) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, manifest.name);
  const requested = [];
  const plugin = registrations[0].factory(id => {
    requested.push(id);
    return { createElement() {}, useRef() {}, useEffect() {}, Component: class {}, Fragment: {} };
  });
  assert.deepEqual(requested, ['react'], 'no second runtime, no icon dependency');
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'connection', 'locale', 'remote']);
  for (const service of ['remote', 'connection', 'locale']) {
    assert.ok(manifest.dsh.client.inject.length > 0 && service.length > 0);
  }
  const slots = [];
  plugin.apply({
    slots: {
      inject(name, fn) { assert.equal(name, 'shell.overlay'); fn(); },
      register(options, component) { slots.push(options); assert.equal(typeof component, 'function'); return () => {}; },
    },
  });
  // Copy out of the vm realm: a foreign prototype is not a behavioral difference.
  assert.deepEqual(slots.map(options => ({ ...options })), [{ name: 'shell.overlay', id: 'token-bucket', order: 91 }]);
  const bundle = read('lib/client.js');
  assert.doesNotMatch(bundle, /api\.deepseek\.com|fetch\(|XMLHttpRequest/, 'only the Host may read a balance');
  assert.doesNotMatch(bundle, /diagnostic|telemetry|clipboard/);
  assert.ok(bundle.includes('BucketBridgeContract'));
  assert.ok(bundle.includes('bucket.css') === false);
  assert.ok(bundle.includes('--bonus-share'), 'the widget styles ship inside the bundle');
});

test('the generated contract is strict, stream shaped and free of secrets', () => {
  assert.match(read('tools/bridge-contract-source.mjs'), /'dsh-plugin-token-bucket#tokenBucket\/watch'/);
  const remote = read('lib/remote.js');
  assert.ok(remote.includes('dsh-plugin-token-bucket#tokenBucket/watch'));
  assert.match(remote, /mode:\s*['"]stream['"]/);
  assert.match(remote, /Zod 4\.4\.3 license/);
  assert.doesNotMatch(remote, /sk-[A-Za-z0-9]{8}/);
});

test('the offline preview is self-contained, versioned and offline', () => {
  const preview = read('preview/index.html');
  assert.doesNotMatch(preview, /<script[^>]+src=/);
  assert.equal(preview.includes('__PACKAGE_VERSION__'), false);
  assert.ok(preview.includes(manifest.version));
  assert.doesNotMatch(preview.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ''), /https?:\/\//);
  assert.ok(manifest.files.includes('README.md'));
});

test('the host reflection describes the mounted stream exactly', async () => {
  // Without this reflection the Host refuses the descriptor the browser half mounts,
  // even when every other file is present and correct.
  assert.equal(manifest.exports['./typert'], './lib/typert.host.js');
  assert.equal(fs.existsSync(path.join(root, 'lib/typert.host.js')), true);
  const typert = (await import('../lib/typert.host.js')).TYPERT;
  const contract = await import('../lib/remote.js');
  assert.equal(typert.package, manifest.name);
  assert.equal(typert.face, 'host');
  assert.equal(typert.invocations.length, 1);
  assert.equal(typert.invocations[0], contract.BUCKET_WATCH_DESCRIPTOR);
  assert.deepEqual(typert.schemas.map(schema => schema.name),
    [contract.BUCKET_WATCH_DESCRIPTOR.result.typeSymbol.split('#')[1]]);
  assert.equal(typert.schemas[0].create().safeParse({ nonsense: true }).success, false);
  const service = typert.model.services[0];
  assert.equal(service.key, 'tokenBucket');
  assert.deepEqual(service.members.map(member => member.name), ['watch']);
  assert.ok(service.description.length > 0);
});
