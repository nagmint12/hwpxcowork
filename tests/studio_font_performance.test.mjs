import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import { coworkBuildPlugins, patchesForStudio } from '../studio/build/patches.mjs';
import { STANDALONE_EDITOR_PATCHES } from '../studio/build/standalone-editor-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = path.join(root, 'vendor/rhwp/rhwp-studio');
const patches = patchesForStudio(studio, process.env.STUDIO_TEST_PROFILE === 'standalone' ? STANDALONE_EDITOR_PATCHES : undefined);
let directory;
let sequence = 0;
const bundles = {};

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-font-perf-'));
  const { build } = await import(pathToFileURL(path.join(studio, 'node_modules/vite/dist/node/index.js')).href);
  for (const patched of [false, true]) {
    const entry = '\0cowork-font-performance.ts';
    const [patcher] = coworkBuildPlugins({ studioSrc: studio, patches });
    const source = ['src/core/font-rule-runtime.ts', 'src/core/font-loader.ts']
      .map(file => `export * from ${JSON.stringify(path.join(studio, file).replaceAll('\\', '/'))};`).join('\n');
    const result = await build({
      configFile: false, root: studio, publicDir: false, logLevel: 'silent',
      plugins: [{
        name: 'cowork-font-perf-test', enforce: 'pre',
        resolveId(id) { if (id === entry) return entry; },
        // [hwpx-cowork] 2026-11-10 fontfix: 패치본은 실제 빌드처럼 바꿔 끼운 모듈(fork 글꼴 로더) 위에 패치를 얹는다.
        load(id) { if (id === entry) return source; if (patched) return patcher.load.call(this, id); },
        transform(code, id) { if (patched) return patcher.transform(code, id); },
      }],
      build: { write: false, emptyOutDir: false, minify: false, target: 'esnext',
        rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'es', codeSplitting: false } } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output ?? []);
    const chunk = outputs.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk);
    bundles[String(patched)] = path.join(directory, `${patched ? 'patched' : 'original'}.mjs`);
    await fs.writeFile(bundles[String(patched)], chunk.code);
  }
});

after(async () => {
  if (!directory) return;
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('hwpx-font-perf-'));
  await fs.rm(directory, { recursive: true, force: true });
});

async function api(patched = true) {
  return import(`${pathToFileURL(bundles[String(patched)]).href}?case=${++sequence}`);
}

test('indexed catalog preserves all font supply statuses and ordered diagnostic rule IDs', async () => {
  const original = await api(false);
  const patched = await api();
  const names = [...new Set(original.FONT_RULE_WEBFONT_ENTRIES.map(entry => entry.name))];
  names.push('ABSENT font', '', '  NOTO   Sans KR ', '나눔고딕', 'Noto\u0000 Sans KR');
  for (const name of names) {
    assert.deepEqual(patched.getWebFontSupplySnapshotWithRules(name), original.getWebFontSupplySnapshotWithRules(name), name);
    assert.deepEqual(patched.getProjectedWebFontRuleIds(name), original.getProjectedWebFontRuleIds(name), name);
    assert.equal(patched.normalizeProjectedFontFamily(name), original.normalizeProjectedFontFamily(name), name);
  }
});

test('repeated font snapshots no longer normalize the whole catalog for every text run', async t => {
  const original = await api(false);
  const patched = await api();
  const originalLower = String.prototype.toLocaleLowerCase;
  let calls = 0;
  t.mock.method(String.prototype, 'toLocaleLowerCase', function (...args) {
    calls++;
    return Reflect.apply(originalLower, this, args);
  });
  original.getWebFontSupplySnapshotWithRules('Noto Sans KR');
  calls = 0;
  for (let n = 0; n < 100; n++) original.getWebFontSupplySnapshotWithRules('Noto Sans KR');
  const beforeCalls = calls;
  patched.getWebFontSupplySnapshotWithRules('Noto Sans KR');
  calls = 0;
  for (let n = 0; n < 100; n++) patched.getWebFontSupplySnapshotWithRules('Noto Sans KR');
  assert.ok(beforeCalls > 1000, `original reproduces full catalog normalization: ${beforeCalls}`);
  assert.equal(calls, 0, 'warm repeated snapshots perform no locale normalization');
});

test('loaded/registered status stays live across failure, retry, and canonical alias queries', async t => {
  const patched = await api();
  const failed = new Set(['나눔고딕']);
  const styles = [];
  const document = {
    head: { appendChild(element) { styles.push(element); } },
    createElement() { return { id: '', textContent: '' }; },
    getElementById(id) { return styles.find(style => style.id === id) ?? null; },
    fonts: { check: () => false, add() {} },
  };
  // [hwpx-cowork] 2026-11-10: 0.9.0 은 번들 웹폰트를 fetch 로 받은 바이트로 FontFace 를 만든다 — 파일 공급은 늘 성공시키고
  // 실패는 전처럼 FontFace.load 에서만 낸다.
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) });
  t.mock.method(URL, 'createObjectURL', () => 'blob:font-fixture');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  for (const [name, value] of Object.entries({ document, fetch, FontFace: class {
    constructor(family) { this.family = family; }
    async load() { if (failed.has(this.family)) throw new Error('font fixture failure'); return this; }
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  for (const name of ['log', 'debug', 'warn']) t.mock.method(console, name, () => {});
  assert.equal(patched.getWebFontSupplySnapshot('나눔고딕').status, 'catalogued');
  await patched.loadWebFonts(['나눔고딕'], undefined, { disableExternalWebFonts: true });
  assert.equal(patched.getWebFontSupplySnapshot('나눔고딕').status, 'registered');
  assert.equal(patched.getWebFontSupplySnapshot('  나눔고딕  ').status, 'registered');
  failed.clear();
  await patched.loadWebFonts(['나눔고딕'], undefined, { disableExternalWebFonts: true });
  assert.equal(patched.getWebFontSupplySnapshot('나눔고딕').status, 'loaded');
  assert.equal(patched.getWebFontSupplySnapshot('나눔고딕').status, 'loaded');
});

test('caller mutation cannot corrupt indexed rule IDs and normalization eviction preserves results', async () => {
  const patched = await api();
  const expected = patched.getProjectedWebFontRuleIds('Noto Sans KR');
  assert.ok(expected.length > 0);
  patched.getProjectedWebFontRuleIds('Noto Sans KR').splice(0, 1000, 'changed');
  assert.deepEqual(patched.getProjectedWebFontRuleIds('Noto Sans KR'), expected);
  for (let n = 0; n < 4200; n++) {
    assert.equal(patched.getWebFontSupplySnapshot(`unavailable-${n}`).status, 'absent');
  }
  const unusual = `  Noto\u0000   Sans KR  `;
  assert.equal(patched.normalizeProjectedFontFamily(unusual), 'noto sans kr');
  assert.equal(patched.normalizeProjectedFontFamily('A'.repeat(1024)), 'a'.repeat(1024));
  assert.deepEqual(patched.getProjectedWebFontRuleIds('Noto Sans KR'), expected);
});
