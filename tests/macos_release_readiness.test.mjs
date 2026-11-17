import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMacRelease, REQUIRED_NATIVE_CHECKS } from '../scripts/macos-release-readiness.mjs';
const pkg = { arch: 'universal', frontend: 'full-web-product', coworkPlugin: true, sha256: 'a'.repeat(64), wasmSha256: 'b'.repeat(64) };
// Synthetic data tests the gate's decisions; it is not native release evidence.
const native = arch => ({ platform: 'darwin', arch, macos: '12.1', packagedApp: true, archiveSha256: pkg.sha256,
  wasmSha256: pkg.wasmSha256, pass: true, appProcessExited: true, codesign: true, gatekeeper: true,
  checks: REQUIRED_NATIVE_CHECKS.map(name => ({ name, status: 'pass' })) });
const manual = arch => ({ ...native(arch), tester: 'gate-unit-test', testedAt: 'test-only', checks: Object.fromEntries(
  ['nativeKoreanIme', 'finderLaunch', 'longSession'].map(name => [name, { status: 'pass', notes: 'synthetic unit test' }])) });
test('no Mac, Windows, modern macOS, one CPU, different hashes, and dev app cannot pass the 12.1 gate', () => {
  const valid = [native('x64'), native('arm64')];
  const reviews = [manual('x64'), manual('arm64')];
  assert.equal(assessMacRelease(pkg, valid, reviews).ready, true);
  for (const runs of [[], valid.slice(0, 1), valid.map(r => ({ ...r, platform: 'win32' })),
    valid.map(r => ({ ...r, macos: '15.0' })), valid.map(r => ({ ...r, archiveSha256: 'c'.repeat(64) })),
    valid.map(r => ({ ...r, wasmSha256: 'c'.repeat(64) })), valid.map(r => ({ ...r, packagedApp: false }))]) {
    assert.equal(assessMacRelease(pkg, runs, reviews).ready, false);
  }
});
test('missing native/manual checks and rejected Gatekeeper remain unverified', () => {
  const runs = [native('x64'), native('arm64')], reviews = [manual('x64'), manual('arm64')];
  assert.equal(assessMacRelease(pkg, runs, []).ready, false);
  for (const change of [{ gatekeeper: false }, { codesign: false }, { pass: false }, { checks: [] }]) {
    assert.equal(assessMacRelease(pkg, [runs[0], { ...runs[1], ...change }], reviews).ready, false);
  }
});
