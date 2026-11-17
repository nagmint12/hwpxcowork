#!/usr/bin/env node
// Building a universal binary or passing on Windows is not Mac 12.1 validation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_NATIVE_CHECKS = [
  'native-launch-and-private-library', 'cowork-build-included', 'folder-document-and-plugin-open',
  'continuous-input-and-chromium-composition', 'local-font-permission-picker-and-loading',
  'autosave-to-linked-hwpx-copy', 'memo-api-and-cowork-ui', 'reload-restores-saved-document',
  'app-close-stops-own-server',
];
export function assessMacRelease(pkg, runs = [], manual = []) {
  const missing = [];
  if (pkg.arch !== 'universal' || pkg.frontend !== 'full-web-product' || pkg.coworkPlugin !== true) missing.push('full cowork universal package');
  if (!/^[a-f0-9]{64}$/.test(pkg.sha256 || '') || !/^[a-f0-9]{64}$/.test(pkg.wasmSha256 || '')) missing.push('package and WASM hashes');
  for (const arch of ['x64', 'arm64']) {
    const key = `macOS 12.1 ${arch}`;
    const run = runs.find(r => r.platform === 'darwin' && r.arch === arch && /^12\.1(?:\.|$)/.test(r.macos || '')
      && r.packagedApp === true && r.archiveSha256 === pkg.sha256 && r.wasmSha256 === pkg.wasmSha256);
    if (!run) { missing.push(`${key}: native run of this package`); continue; }
    for (const name of REQUIRED_NATIVE_CHECKS) if (!run.checks?.some(c => c.name === name && c.status === 'pass')) missing.push(`${key}: ${name}`);
    if (run.pass !== true || run.appProcessExited !== true) missing.push(`${key}: completed native run`);
    if (run.codesign !== true) missing.push(`${key}: codesign verification`);
    if (run.gatekeeper !== true) missing.push(`${key}: Gatekeeper assessment`);
    const review = manual.find(r => r.platform === 'darwin' && r.arch === arch && r.macos === run.macos
      && r.archiveSha256 === pkg.sha256 && r.wasmSha256 === pkg.wasmSha256 && r.tester && r.testedAt);
    // A real tester supplies notes; Chromium composition never satisfies OS IME.
    for (const name of ['nativeKoreanIme', 'finderLaunch', 'longSession']) {
      const check = review?.checks?.[name];
      if (check?.status !== 'pass' || !check.notes?.trim()) missing.push(`${key}: ${name} actual-machine evidence`);
    }
  }
  return { schema: 1, checkedAt: new Date().toISOString(), product: pkg.product, version: pkg.version,
    archiveSha256: pkg.sha256, wasmSha256: pkg.wasmSha256, ready: missing.length === 0,
    scope: 'macOS 12.1 Intel and Apple Silicon; specified checks only', missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!arg('--package') || !arg('--out')) throw Error('Use --package macos-apps.json --out readiness.json [--native files separated by comma] [--manual files separated by comma]');
  const metadata = read(arg('--package'));
  const pkg = metadata.packages?.find(p => p.arch === 'universal') || metadata;
  const files = flag => (arg(flag) || '').split(',').filter(Boolean).map(read);
  const result = assessMacRelease(pkg, files('--native'), files('--manual'));
  fs.writeFileSync(arg('--out'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(result.ready ? 'PASS: specified native Mac release checks' : 'UNVERIFIED: ' + result.missing.join('; '));
  if (!result.ready) process.exitCode = 2;
}
