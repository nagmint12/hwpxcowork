import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { auditMacBinaries, machoTargets } from '../scripts/macos-binary-audit.mjs';
import { mergeMacApps } from '../scripts/macos-universal.mjs';

function thin(cpu, minimum = 0x0c0000) {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4);
  b.writeUInt32LE(1, 16); b.writeUInt32LE(24, 20);
  b.writeUInt32LE(0x32, 32); b.writeUInt32LE(24, 36);
  b.writeUInt32LE(1, 40); b.writeUInt32LE(minimum, 44);
  return b;
}
// Independent fixture using the published Mach-O fat_header/fat_arch format.
function fat(x64, arm64) {
  const b = Buffer.alloc(128 + arm64.length);
  b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(2, 4);
  for (const [index, cpu, offset, slice] of [[0, 0x1000007, 64, x64], [1, 0x100000c, 128, arm64]]) {
    const at = 8 + index * 20;
    b.writeUInt32BE(cpu, at); b.writeUInt32BE(offset, at + 8);
    b.writeUInt32BE(slice.length, at + 12); b.writeUInt32BE(6, at + 16);
    slice.copy(b, offset);
  }
  return b;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-universal-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('Universal gate requires both actual CPU slices in every nested binary', t => {
  const root = fixture(t);
  const both = fat(thin(0x1000007), thin(0x100000c, 0x0c0100));
  fs.writeFileSync(path.join(root, 'app'), both);
  assert.deepEqual(machoTargets(both), [{ arch: 'x64', minimumMacos: '12.0.0' }, { arch: 'arm64', minimumMacos: '12.1.0' }]);
  assert.equal(auditMacBinaries(root, { arch: 'universal' }).binaries.length, 1);
  fs.writeFileSync(path.join(root, 'helper'), thin(0x1000007));
  assert.throws(() => auditMacBinaries(root, { arch: 'universal' }), /Missing target architecture/);
  fs.writeFileSync(path.join(root, 'helper'), fat(thin(0x1000007), thin(0x100000c, 0x0d0000)));
  assert.throws(() => auditMacBinaries(root, { arch: 'universal' }), /requires 13\.0\.0/);
});

test('merge rejects divergent shared WASM or missing files before producing an app', t => {
  const root = fixture(t), x64App = path.join(root, 'intel.app'), arm64App = path.join(root, 'silicon.app'), outApp = path.join(root, 'universal.app');
  for (const [app, cpu] of [[x64App, 0x1000007], [arm64App, 0x100000c]]) {
    fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'executable'), thin(cpu));
    fs.writeFileSync(path.join(app, 'rhwp.wasm'), 'common-wasm');
  }
  fs.writeFileSync(path.join(arm64App, 'rhwp.wasm'), 'different-wasm');
  const options = { x64App, arm64App, outApp, signer: 'must-not-run' };
  assert.throws(() => mergeMacApps(options), /Different shared app resource/);
  assert.equal(fs.existsSync(outApp), false);
  assert.equal(fs.readFileSync(path.join(x64App, 'rhwp.wasm'), 'utf8'), 'common-wasm');
  fs.writeFileSync(path.join(arm64App, 'rhwp.wasm'), 'common-wasm');
  fs.writeFileSync(path.join(x64App, 'missing.js'), 'code');
  assert.throws(() => mergeMacApps(options), /Unmatched app resource/);
  assert.equal(fs.existsSync(outApp), false);
  assert.throws(() => mergeMacApps({ ...options, outApp: x64App }), /separate/);
  fs.mkdirSync(outApp);
  assert.throws(() => mergeMacApps(options), /already exists/);
});
