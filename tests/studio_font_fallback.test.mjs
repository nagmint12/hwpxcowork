import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { coworkBuildPlugins, patchedStudioSource } from '../studio/build/patches.mjs';

const NodeBlob = globalThis.Blob;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = path.join(root, 'vendor/rhwp/rhwp-studio');
const viteEntry = path.join(studio, 'node_modules/vite/dist/node/index.js');
// vendor Vite 8의 engines: ^20.19.0 || >=22.12.0. 오래된 Node의 전체 시험도 중단하지 않는다.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportedNode = (nodeMajor === 20 && nodeMinor >= 19)
  || nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
const builderAvailable = supportedNode && existsSync(viteEntry);
const studioTest = (name, run) => test(name, {
  skip: builderAvailable ? false : !supportedNode
    ? 'Studio font tests require the Vite-supported Node version (^20.19.0 or >=22.12.0).'
    : 'Studio build tools are absent; run npm run build:studio to install them.',
}, run);
let directory;
let bundle;
let sequence = 0;

// 실제 빌드 패치를 메모리에서 적용한다. vendor 원본이나 studio/dist를 쓰지 않는다.
before(async () => {
  if (!builderAvailable) return;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-font-test-'));
  const { build } = await import(pathToFileURL(viteEntry).href);
  // [hwpx-cowork] 2026-11-10 fontfix: 실제 번들과 같은 글(wasm-bridge 패치 적용본)에서 병합 함수를 잘라 쓴다.
  const bridge = patchedStudioSource(studio, 'src/core/wasm-bridge.ts');
  const start = bridge.indexOf('function substituteCssFontFamily(cssFont: string): string {');
  const end = bridge.indexOf('\nlet canvasFontSubstitutionInstalled', start);
  assert.ok(start >= 0 && end > start, 'actual Canvas2D font merger must remain discoverable');
  const substitution = path.join(studio, 'src/core/font-substitution.ts').replaceAll('\\', '/');
  const loader = path.join(studio, 'src/core/font-loader.ts').replaceAll('\\', '/');
  const local = path.join(studio, 'src/core/local-fonts.ts').replaceAll('\\', '/');
  const entry = '\0cowork-font-regression.ts';
  const source = `
    import * as coworkSubstitution from ${JSON.stringify(substitution)};
    import * as coworkLocalFonts from ${JSON.stringify(local)};
    // [hwpx-cowork] 2026-11-10: 0.9.0 substituteCssFontFamily 는 documentSubstituteFamilies·completeFontFamilyList·getLocalFontState 도 쓴다.
    // 원본 wasm-bridge.ts 와 같은 모듈에서 가져오고, 그 판에 없는 이름은 쓰이지 않는다.
    const { fontFamilyCandidatesForDisplay, formatCssFontFamilyList, parseCssFontFamilyList, resolveFont,
      documentSubstituteFamilies, completeFontFamilyList } = coworkSubstitution;
    const { getLocalFontState } = coworkLocalFonts;
    export * from ${JSON.stringify(substitution)};
    export * from ${JSON.stringify(loader)};
    export { loadStoredLocalFonts, detectLocalFonts, getLocalFontRecords, resolveLocalFont } from ${JSON.stringify(local)};
    export ${bridge.slice(start, end)}
  `;
  const [patcher] = coworkBuildPlugins({ studioSrc: studio });
  const result = await build({
    configFile: false, root: studio, publicDir: false, logLevel: 'silent',
    plugins: [{
      name: 'cowork-font-regression', enforce: 'pre',
      resolveId(id) { if (id === entry) return entry; },
      // 바꿔 끼운 모듈(0.9.0 글꼴 로더 → fork 로더)도 실제 빌드처럼 읽는다.
      load(id) { if (id === entry) return source; return patcher.load.call(this, id); },
      transform(code, id) { return patcher.transform(code, id); },
    }],
    build: { write: false, emptyOutDir: false, minify: false, target: 'esnext',
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'es', codeSplitting: false } } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output || []);
  const chunk = outputs.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(chunk, 'patched font module bundle must exist');
  bundle = path.join(directory, 'font-policy.mjs');
  await fs.writeFile(bundle, chunk.code);
});

after(async () => {
  if (!directory) return;
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('hwpx-font-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
});

async function fixture(t, { installed = [], failed = [], localFaces = [], snapshot, queryFonts } = {}) {
  t.mock.method(console, 'debug', () => {});
  t.mock.method(console, 'log', () => {});
  const requests = [];
  const styles = [];
  const faces = [];
  const fetchedFiles = new WeakMap();
  let stored = snapshot ? JSON.stringify(snapshot) : null;
  const replacements = {
    document: {
      head: { appendChild(element) { styles.push(element); } },
      createElement(tag) { assert.equal(tag, 'style'); return { id: '', textContent: '' }; },
      getElementById(id) { return styles.find(style => style.id === id) || null; },
      fonts: {
        check(descriptor) { return installed.some(name => descriptor === `16px "${name}"`); },
        add(face) { faces.push(face); },
      },
    },
    // [hwpx-cowork] 2026-11-10: 0.9.0 은 번들 웹폰트를 fetch 로 받은 바이트로 FontFace 를 만든다(URL FontFace 대신).
    // 받은 바이트가 어느 파일인지 기억해 두고, 요청 기록은 전처럼 url(<파일>) 로 남겨 같은 단언으로 확인한다.
    fetch: async file => ({ ok: true, status: 200, async arrayBuffer() { const bytes = new ArrayBuffer(4); fetchedFiles.set(bytes, String(file)); return bytes; } }),
    FontFace: class {
      constructor(family, rawSource, descriptors) {
        const source = typeof rawSource === 'string' ? rawSource : `url(${fetchedFiles.get(rawSource)})`;
        this.family = family; this.source = source; requests.push({ family, source, descriptors });
      }
      async load() {
        if (failed.includes(this.family) || (this.source.startsWith('local(') && !localFaces.includes(this.family))) {
          this.status = 'error';
          throw new Error('fixture font failed');
        }
        // 실제 FontFace 처럼 성공한 face 는 status='loaded'(0.9.0 registerLoadedLocalFontFace 가 확인한다).
        this.status = 'loaded';
        return this;
      }
    },
    // 0.9.0 은 @font-face CSS 도 같은 바이트의 blob URL 을 쓴다. 어느 파일의 바이트인지 blob 주소에 남긴다.
    Blob: class extends NodeBlob { constructor(parts, options) { super(parts, options); this.parts = parts; } },
    localStorage: {
      getItem(key) { return key === 'rhwp-local-fonts' ? stored : null; },
      setItem(_key, value) { stored = value; },
      removeItem() { stored = null; },
    },
    queryLocalFonts: queryFonts,
  };
  for (const [name, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  t.mock.method(URL, 'createObjectURL', blob => `blob:${fetchedFiles.get(blob?.parts?.[0]) ?? 'unknown'}`);
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const api = await import(`${pathToFileURL(bundle).href}?case=${++sequence}`);
  if (snapshot) await api.loadStoredLocalFonts();
  return { api, requests, styles, faces };
}

studioTest('offline startup preloads bundled Noto and missing/catalogued fonts use it before engine fallbacks', async t => {
  const { api, requests, styles } = await fixture(t);
  await api.loadWebFonts([], undefined, { disableExternalWebFonts: true });
  assert.ok(requests.some(item => item.family === 'Noto Sans KR' && item.source.includes('fonts/NotoSansKR-Regular.woff2')));
  assert.equal(api.getWebFontSupplySnapshot('Noto Sans KR').status, 'loaded');
  assert.ok(requests.every(item => !/https?:\/\//.test(item.source)));
  assert.ok(styles.every(item => !/https?:\/\//.test(item.textContent)));
  assert.equal(api.getWebFontSupplySnapshot('함초롬바탕').status, 'catalogued');
  for (const name of ['없는 글꼴', 'KoPub바탕체', '함초롬바탕', 'Courier Missing', 'Missing, "Quoted" Face']) {
    const decision = api.fontFamilyCandidatesForDisplayWithRules(name);
    assert.deepEqual(decision.candidates, ['Noto Sans KR', 'sans-serif']);
    assert.deepEqual(decision.ruleIds, ['cowork.noto-sans-kr-fallback']);
    const descriptor = `bold 14.5px ${api.formatCssFontFamilyList([name, 'Batang', 'Malgun Gothic', 'sans-serif'])}`;
    const merged = api.substituteCssFontFamily(descriptor);
    assert.ok(merged.startsWith('bold 14.5px '));
    assert.equal(api.parseCssFontFamilyList(merged.slice('bold 14.5px '.length))[0], 'Noto Sans KR');
  }
  assert.deepEqual(api.fontFamilyCandidatesForDisplay('serif'), ['serif']);
});

studioTest('registered but failed webfont falls back; a later successful retry preserves the requested face', async t => {
  const failed = ['나눔명조'];
  const { api } = await fixture(t, { failed });
  await api.loadWebFonts(['나눔명조'], undefined, { disableExternalWebFonts: true });
  assert.equal(api.getWebFontSupplySnapshot('나눔명조').status, 'registered');
  assert.deepEqual(api.fontFamilyCandidatesForDisplay('나눔명조'), ['Noto Serif KR', 'serif'], '쓸 수 없는 명조 글꼴은 번들 Noto Serif KR(2026-11-04)');
  failed.length = 0;
  await api.loadWebFonts(['나눔명조'], undefined, { disableExternalWebFonts: true });
  assert.equal(api.getWebFontSupplySnapshot('나눔명조').status, 'loaded');
  assert.equal(api.fontFamilyCandidatesForDisplay('나눔명조')[0], '나눔명조');
});

studioTest('exact installed and loaded fonts survive while missing originals override document substitutes', async t => {
  const name = 'Local, "Quoted" Face';
  const { api, requests } = await fixture(t, { installed: ['Arial'] });
  await api.loadWebFonts(['Arial', '나눔고딕'], undefined, { disableExternalWebFonts: true });
  assert.equal(requests.some(item => item.family === 'Arial'), false, 'webfont must not shadow an installed exact face');
  assert.equal(api.fontFamilyCandidatesForDisplay('Arial')[0], 'Arial');
  assert.equal(api.fontFamilyCandidatesForDisplay('나눔고딕')[0], '나눔고딕');
  assert.equal(api.fontFamilyCandidatesForDisplay(name, 0, 0, { confirmedLocalFonts: [name] })[0], name);
  assert.equal(api.fontFamilyCandidatesForDisplay(name, 0, 0, { includeUnconfirmedOriginal: true })[0], name);
  // 2026-11-04: 한/글 전용 이름(HFT 한양…)은 같은 글꼴의 설치 이름(HY…)이 원본이다 — 대체가 아님
  assert.equal(api.fontFamilyCandidatesForDisplay('한양중고딕', 2, 0, {
    confirmedLocalFonts: ['HY중고딕'],
  })[0], 'HY중고딕', 'a Hancom legacy face uses its installed same-face name');
  assert.equal(api.fontFamilyCandidatesForDisplay('한양견명조', 2, 0, {
    confirmedLocalFonts: ['HYMyeongJo-Extra'],
  })[0], 'HYMyeongJo-Extra', '한양견명조 = HY견명조(H2MJRE.TTF)');
  assert.deepEqual(api.fontFamilyCandidatesForDisplay('한양견명조', 2, 0, { confirmedLocalFonts: [] }), ['Noto Sans KR', 'sans-serif'],
    'no installed same face and no serif stand-in loaded → bundled sans');
  assert.deepEqual(api.fontFamilyCandidatesForDisplay('나눔고딕', 0, 0, { confirmedLocalFonts: ['HY중고딕'] })[0] === 'HY중고딕', false,
    'an unrelated installed substitute still does not replace a missing original');
  assert.deepEqual(api.parseCssFontFamilyList(api.formatCssFontFamilyList([name, 'sans-serif'])), [name, 'sans-serif']);
  const declaration = Object.freeze([Object.freeze(['없는 원본', '나눔고딕'])]);
  api.setDocumentFontSubstitutions(declaration);
  assert.deepEqual(api.fontFamilyCandidatesForDisplay('없는 원본'), ['Noto Sans KR', 'sans-serif']);
  assert.deepEqual(declaration, [['없는 원본', '나눔고딕']], 'display policy must not rewrite document declarations');
});

studioTest('Canvas2D keeps known installed face aliases ahead of system fallback (#6600)', async t => {
  const { api } = await fixture(t, { snapshot: {
    version: 3, detectedAt: '2026-10-26T00:00:00.000Z', families: ['HYGothic'],
    source: 'local-font-access', checkedFamilies: ['한양중고딕'],
    fontRecords: [{ family: 'HYGothic', fullName: 'HYGothic-Medium', postscriptName: 'HYGothic-Medium',
      style: 'Medium', aliases: ['HYGothic', 'HYGothic-Medium', '한양중고딕', 'HY중고딕'] }],
  } });
  const descriptor = '14px "한양중고딕", "HY중고딕", "HYGothic", "HYGothic-Medium", "HCR Dotum", \'Malgun Gothic\', sans-serif';
  const merged = api.parseCssFontFamilyList(api.substituteCssFontFamily(descriptor).slice('14px '.length));
  assert.equal(merged[0], 'HYGothic-Medium');
  assert.ok(merged.includes('HYGothic'));
  assert.ok(merged.indexOf('HYGothic') < merged.indexOf('Malgun Gothic'));
  const noto = merged.indexOf('Noto Sans KR');
  assert.ok(noto < 0 || merged.indexOf('HYGothic') < noto);
});

// [hwpx-cowork] 2026-11-10 fontfix: 0.9 엔진은 원본 TTF·굵은 표시 글꼴의 체인 맨 앞에 내부 별칭('__rhwp_ttf__X'·
// '__rhwp_intrinsic__X')을 넣는다. 웹에는 이 이름의 face 가 없으므로 설치된 원 글꼴 X 가 맨 앞이어야 한다(운영 전 fork 와 같게) —
// 별칭을 원 글꼴로 오인해 Noto 를 앞에 두면 문서 전체가 Noto 로 그려진다(브라우저 대조로 확인한 운영 결함).
studioTest('engine-internal TTF/intrinsic aliases keep the installed original ahead of Noto fallback', async t => {
  const { api } = await fixture(t, { installed: ['HY중고딕', '굴림체'] });
  await api.loadWebFonts(['HY중고딕', '굴림체'], undefined, { disableExternalWebFonts: true });
  for (const [name, generic] of [['HY중고딕', 'sans-serif'], ['굴림체', 'monospace']]) {
    for (const prefix of ['__rhwp_ttf__', '__rhwp_intrinsic__']) {
      const merged = api.parseCssFontFamilyList(
        api.substituteCssFontFamily(`14px '${prefix}${name}', "${name}", ${generic}`).slice('14px '.length));
      assert.equal(merged[0], name, `${prefix}${name}`);
      assert.ok(!merged.some(family => family.startsWith('__rhwp_')), `${prefix}${name}`);
    }
  }
});

studioTest('exact KoPubWorld faces and aliases load from full/PostScript local names before display', async t => {
  const names = [
    ...['KoPubWorld', 'KoPub'].flatMap(prefix => ['바탕체', '돋움체'].flatMap(family => ['Light', 'Medium', 'Bold'].map(style => `${prefix}${family} ${style}`))),
    'kopubWorld바탕체Bold', 'KoPubWorldBatangBold', 'KoPubWorld-Dotum-Medium', '나눔바른고딕',
  ];
  const { api, requests, faces } = await fixture(t, { localFaces: names });
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  for (const name of names) {
    assert.ok(faces.some(face => face.family === name));
    assert.ok(api.getDetectedOSFonts().has(name));
    assert.equal(api.fontFamilyCandidatesForDisplay(name)[0], name);
    assert.equal(api.parseCssFontFamilyList(api.substituteCssFontFamily(`24px "${name}"`).slice(5))[0], name);
    assert.ok(requests.filter(request => request.family === name).every(request => request.source.startsWith('local(')));
  }
  const bold = requests.find(request => request.family === 'KoPubWorld바탕체 Bold');
  assert.ok(bold.source.includes('local("KoPubWorldBatangBold")'));
  assert.ok(!bold.source.includes('local("KoPubWorldBatang")'), 'base family cannot verify the Bold face');
  const count = requests.length;
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  assert.equal(requests.length, count, 'successful exact local registrations are reused');
});

studioTest('pasted HY Sense and Hancom Cool Jazz use exact local faces and retain fallback when absent', async t => {
  const names = ['HY센스L', '한컴 쿨재즈 L'];
  const localFaces = [];
  const { api, requests } = await fixture(t, { localFaces });
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  for (const name of names) assert.equal(api.fontFamilyCandidatesForDisplay(name)[0], 'Noto Sans KR');
  localFaces.push(...names);
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  for (const name of names) {
    assert.equal(api.fontFamilyCandidatesForDisplay(name)[0], name);
    assert.ok(requests.some(r => r.family === name && r.source === `local("${name}")`));
  }
  const attempts = requests.filter(r => names.includes(r.family)).length;
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  assert.equal(requests.filter(r => names.includes(r.family)).length, attempts, 'successful local faces are reused');
  assert.ok(requests.every(r => !/https?:\/\//.test(r.source)), 'font files remain on the user PC');
});

studioTest('generated SFNT identities bind unlisted full names and actual style siblings', async t => {
  const names = ['한컴 윤고딕 740', 'Times New Roman'];
  const { api, requests, faces } = await fixture(t, { localFaces: names });
  await api.loadWebFonts(names, undefined, { disableExternalWebFonts: true });
  const yoon = requests.find(r => r.family === names[0]);
  assert.ok(yoon?.source.includes('HaanYoonGothic740'), 'name table 6, not the different TTF filename');
  const times = requests.filter(r => r.family === names[1]);
  assert.equal(times.length, 4);
  assert.ok(times.find(r => r.descriptors.weight === '700' && r.descriptors.style === 'normal').source.includes('TimesNewRomanPS-BoldMT'));
  assert.ok(times.find(r => r.descriptors.style === 'italic' && r.descriptors.weight === '400').source.includes('TimesNewRomanPS-ItalicMT'));
  assert.ok(faces.some(face => face.family === names[0]));
  assert.equal(api.fontFamilyCandidatesForDisplay(names[0])[0], names[0]);
});

studioTest('HFT paint targets are checked locally without claiming an HFT-only face is SFNT', async t => {
  const { api, requests } = await fixture(t, { localFaces: ['HY중고딕'] });
  await api.loadWebFonts(['한양중고딕', '필기'], undefined, { disableExternalWebFonts: true });
  assert.ok(requests.some(r => r.family === 'HY중고딕' && r.source.includes('HYGothic-Medium')));
  assert.ok(api.getDetectedOSFonts().has('HY중고딕'));
  assert.ok(!api.getDetectedOSFonts().has('필기'));
  assert.ok(!requests.some(r => r.family === '필기' && r.source.startsWith('local(')), 'no unproven Pilgi TTF alias');
});

studioTest('installed catalog keeps 1000 metadata records without reading unused font files', async t => {
  let queries = 0; let reads = 0;
  const records = Array.from({ length: 1000 }, (_, index) => ({ family: `Catalog ${index}`, fullName: `Catalog ${index} Regular`, postscriptName: `Catalog${index}`, style: 'Regular', async blob() { reads++; throw new Error('unused file must not be read'); } }));
  const { api } = await fixture(t, { queryFonts: async () => { queries++; return records; } });
  await api.loadWebFonts([], undefined, { disableExternalWebFonts: true });
  assert.equal(queries, 0, 'startup must not enumerate installed fonts');
  await api.detectLocalFonts({ force: true, includeRegistered: true, candidateFamilies: [] });
  assert.equal(api.getLocalFontRecords({ includeRegistered: true }).length, 1000);
  assert.equal(reads, 0);
  await api.detectLocalFonts({ includeRegistered: true });
  assert.equal(queries, 1, 'metadata catalog is reused without another OS query');
});

function sfntNames(names) {
  const encoded = names.map(([id, text]) => ({ id, bytes: Buffer.from(text, 'utf16le').swap16() }));
  const stringOffset = 6 + encoded.length * 12;
  const tableLength = stringOffset + encoded.reduce((length, item) => length + item.bytes.length, 0);
  const bytes = Buffer.alloc(28 + tableLength);
  bytes.writeUInt32BE(0x10000, 0); bytes.writeUInt16BE(1, 4); bytes.write('name', 12);
  bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(tableLength, 24);
  bytes.writeUInt16BE(encoded.length, 30); bytes.writeUInt16BE(stringOffset, 32);
  let offset = 0;
  for (const [index, item] of encoded.entries()) {
    const record = 34 + index * 12;
    bytes.writeUInt16BE(3, record); bytes.writeUInt16BE(1, record + 2); bytes.writeUInt16BE(0x412, record + 4);
    bytes.writeUInt16BE(item.id, record + 6); bytes.writeUInt16BE(item.bytes.length, record + 8); bytes.writeUInt16BE(offset, record + 10);
    item.bytes.copy(bytes, 28 + stringOffset + offset); offset += item.bytes.length;
  }
  return new Blob([bytes]);
}

studioTest('catalog reads only requested face names and preserves localized aliases', async t => {
  const reads = [];
  const records = [
    { family: 'QA Face', fullName: 'QA Face Bold', postscriptName: 'QAFaceBold', style: 'Bold', async blob() { reads.push('used'); return sfntNames([[16, '검증 글꼴'], [4, '검증 글꼴 진하게'], [6, 'QAFaceBold']]); } },
    { family: 'Unused Face', fullName: 'Unused Face Regular', postscriptName: 'UnusedFace', style: 'Regular', async blob() { reads.push('unused'); throw new Error('unused'); } },
  ];
  const { api } = await fixture(t, { queryFonts: async () => records });
  await api.detectLocalFonts({ force: true, candidateFamilies: ['QA Face Bold'] });
  assert.deepEqual(reads, ['used']);
  assert.equal(api.resolveLocalFont('검증 글꼴 진하게').postscriptName, 'QAFaceBold');
  assert.ok(api.resolveLocalFont('Unused Face'), 'unused metadata remains selectable');
});

studioTest('catalog derives current document targets with KoPub Korean/English aliases', async t => {
  const reads = [];
  const records = [
    { family: 'KoPubDotum', fullName: 'KoPubDotum Bold', postscriptName: 'KoPubDotumBold', style: 'Bold', async blob() { reads.push('bold'); return new Blob([]); } },
    { family: 'KoPubDotum', fullName: 'KoPubDotum Light', postscriptName: 'KoPubDotumLight', style: 'Light', async blob() { reads.push('light'); return new Blob([]); } },
  ];
  const { api } = await fixture(t, { queryFonts: async () => records });
  await api.loadWebFonts(['KoPub돋움체 Bold'], undefined, { disableExternalWebFonts: true });
  await api.detectLocalFonts({ force: true });
  assert.deepEqual(reads, ['bold']);
  reads.length = 0;
  await api.loadWebFonts(['KoPub돋움체 Light'], undefined, { disableExternalWebFonts: true });
  await api.detectLocalFonts({ force: true });
  assert.deepEqual(reads, ['light'], 'previous documents do not expand the current read scope');
});

studioTest('missing exact local face keeps Noto fallback and retries after installation', async t => {
  const name = 'KoPubWorld바탕체 Bold';
  const localFaces = [];
  const { api, requests } = await fixture(t, { localFaces, installed: [name] });
  await api.loadWebFonts([name], undefined, { disableExternalWebFonts: true });
  assert.equal(api.getDetectedOSFonts().has(name), false, 'a generic check cannot confirm the full Bold face');
  assert.equal(api.fontFamilyCandidatesForDisplay(name)[0], 'Noto Serif KR', '바탕 계열은 명조 대체(2026-11-04)');
  assert.ok(requests.every(request => !/https?:/.test(request.source)));
  localFaces.push(name);
  await Promise.all([api.loadWebFonts([name], undefined, { disableExternalWebFonts: true }),
    api.loadWebFonts([name], undefined, { disableExternalWebFonts: true })]);
  assert.equal(api.fontFamilyCandidatesForDisplay(name)[0], name);
  assert.equal(requests.filter(request => request.family === name).length, 2, 'one failure then one shared successful retry');
});

studioTest('offline Noto regular and bold use distinct files and matching CSS/API weights', async t => {
  const { api, requests, styles } = await fixture(t);
  await api.loadWebFonts([], undefined, { disableExternalWebFonts: true });
  const noto = requests.filter(request => request.family === 'Noto Sans KR');
  assert.ok(noto.some(request => request.source.includes('NotoSansKR-Regular.woff2') && request.descriptors.weight === '400'));
  assert.ok(noto.some(request => request.source.includes('NotoSansKR-Bold.woff2') && request.descriptors.weight === '700'));
  assert.match(styles[0].textContent, /NotoSansKR-Bold\.woff2[^\n]+font-weight: 700/);
});
