// 편집기 한컴 호환 층(vendor/rhwp/rhwp-studio/src/hwpctl) 누름틀 PutFieldText·GetFieldText·GetFieldList — 한/글 2022 실측과 같은가 (2026-11-12)
// 실측: 한/글 2022 12.0.0.3146 COM, research/edit-preservation-20261112/range/hangul_same_name.md(원자료 hangul_same_name.json).
// 같은 seed(tests/fixtures/field_fill_seed.hwpx — 한/글이 다시 저장한 문서: 신청인·소속·날짜·날짜)에 같은 호출을 하고, 문단 글을 한/글 GetTextFile 결과와 견준다.
// 편집기 빌드 없이 WASM(vendor/rhwp/pkg)과 field-api.ts(가져오기 없는 TS — Node 형 지우기)로 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';
import { root, fixture } from './helpers/server.mjs';

const api = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/hwpctl/field-api.ts')).href);
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(root, 'vendor/rhwp/pkg/rhwp.js')).href);
mod.initSync({ module: fs.readFileSync(path.join(root, 'vendor/rhwp/pkg/rhwp_bg.wasm')) });
const SEED = fs.readFileSync(fixture('field_fill_seed.hwpx'));
const SEP = '\x02';
const open = () => new mod.HwpDocument(new Uint8Array(SEED));
// index.ts PutFieldText 와 같은 쓰기 콜백(엔진 setFieldValue)을 넘긴다
const put = (d, field, text) => api.putFieldText(d, field, text, (id, value) => d.setFieldValue(id, value));
const para2 = async (d) => (await HwpxDoc.load(Buffer.from(d.exportHwpx()))).paragraphs({ nested: false })[2].text;

test('PutFieldText — 이름만은 같은 이름 칸 모두, {{n}} 은 그 칸, 넘침·없는 이름·{n} 은 바꾸지 않음, "" 는 모두 비움 (한/글 B·C)', async () => {
  const d = open();
  // 한/글 B: PutFieldText('날짜','D') → 'D가나다라마바사2 날짜:D'
  assert.equal(put(d, '날짜', 'D'), true);
  assert.equal(await para2(d), 'D가나다라마바사2 날짜:D');
  // 한/글 B: PutFieldText('날짜{{1}}','E') → 'D가나다라마바사2 날짜:E'
  assert.equal(put(d, '날짜{{1}}', 'E'), true);
  assert.equal(await para2(d), 'D가나다라마바사2 날짜:E');
  // 한/글 A·C: 넘침·없는 이름·중괄호 하나는 아무것도 바꾸지 않고 오류도 없다
  for (const key of ['날짜{{9}}', '없는칸', '날짜{1}', '날짜{{-1}}']) assert.equal(put(d, key, 'x'), false, key);
  assert.equal(await para2(d), 'D가나다라마바사2 날짜:E');
  // 한/글 C: GetFieldText('날짜') = 첫 칸 값, 목록은 \x02 로
  assert.equal(api.getFieldText(d, '날짜'), 'D');
  assert.equal(api.getFieldText(d, '날짜{{1}}'), 'E');
  assert.equal(api.getFieldText(d, `날짜${SEP}날짜`), `D${SEP}D`);
  assert.equal(api.getFieldText(d, '날짜{{-1}}'), '');
  assert.equal(api.getFieldText(d, '없는칸'), '');
  // 한/글 C: PutFieldText('날짜','') → '가나다라마바사2 날짜:'
  assert.equal(put(d, '날짜', ''), true);
  assert.equal(await para2(d), '가나다라마바사2 날짜:');
  assert.equal(api.getFieldText(d, '날짜{{0}}'), '');
});

test('PutFieldText 목록 꼴 — 이름마다 그 이름 칸 모두, 같은 이름 두 번이면 뒤 값 (한/글 A: 이름\\x02이름 / X\\x02Y → 모두 Y)', async () => {
  const d = open();
  put(d, `날짜${SEP}날짜`, `X${SEP}Y`);
  assert.equal(await para2(d), 'Y가나다라마바사2 날짜:Y');
});

test('GetFieldList(number, option) — 한/글 B 목록 글과 같다', () => {
  const d = open();
  // 한/글 B 실측(hangul_same_name.json)
  assert.equal(api.fieldListText(d, 0, 0), ['신청인', '소속', '날짜', '날짜'].join(SEP));
  assert.equal(api.fieldListText(d, 1, 0), ['신청인{{0}}', '소속{{0}}', '날짜{{0}}', '날짜{{1}}'].join(SEP));
  assert.equal(api.fieldListText(d, 2, 0), ['신청인{{1}}', '소속{{1}}', '날짜{{2}}'].join(SEP));
  assert.equal(api.fieldListText(d, 1, 1), '');
  assert.equal(api.fieldListText(d, 1, 2), api.fieldListText(d, 1, 0));
});

test('고치기 전 경로(setFieldValueByName — 첫 칸만)는 한/글과 다르다 · hwpctl 이 새 경로를 부른다', async () => {
  const d = open();
  JSON.parse(d.setFieldValueByName('날짜', 'D'));
  assert.notEqual(await para2(d), 'D가나다라마바사2 날짜:D', '예전 PutFieldText 는 첫 칸만 채웠다');
  const src = fs.readFileSync(path.join(root, 'vendor/rhwp/rhwp-studio/src/hwpctl/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = (name) => { const at = src.indexOf(`  ${name}(field`); const rest = src.slice(at); return rest.slice(0, rest.indexOf('\n  }\n')); };
  assert.match(body('PutFieldText'), /putFieldText\(this\.wasmDoc, field, text, \(id, value\) => this\.wasmDoc\.setFieldValue\(id, value\)\)/);
  assert.doesNotMatch(body('PutFieldText'), /setFieldValueByName/);
  assert.match(body('GetFieldText'), /getFieldText\(this\.wasmDoc/);
});

// 운영 편집기에 실리는 한컴 호환 층은 vendor/rhwp/npm/hwpctrl-ocx(studio/plugin → studio-plugin 청크)다 — 같은 한/글 실측으로 견준다
const ocx = await import(pathToFileURL(path.join(root, 'vendor/rhwp/npm/hwpctrl-ocx/src/index.mjs')).href);
const ctrl = () => { const doc = open(); return { doc, hwp: new ocx.HwpCtrl({ wasm: mod, doc }) }; };

test('hwpctrl-ocx PutFieldText·GetFieldText — 한/글 B·C 실측과 같다', async () => {
  const { doc, hwp } = ctrl();
  assert.equal(hwp.PutFieldText('날짜', 'D'), undefined, '규격 §8.3.34 — 반환값 없음');
  assert.equal(await para2(doc), 'D가나다라마바사2 날짜:D');
  hwp.PutFieldText('날짜{{1}}', 'E');
  assert.equal(await para2(doc), 'D가나다라마바사2 날짜:E');
  for (const key of ['날짜{{9}}', '없는칸', '날짜{1}', '날짜{{-1}}']) hwp.PutFieldText(key, 'x');
  assert.equal(await para2(doc), 'D가나다라마바사2 날짜:E');
  assert.equal(hwp.GetFieldText('날짜'), 'D');
  assert.equal(hwp.GetFieldText('날짜{{1}}'), 'E');
  assert.equal(hwp.GetFieldText(`날짜${SEP}날짜`), `D${SEP}D`);
  assert.equal(hwp.GetFieldText('날짜{{-1}}'), '');
  assert.equal(hwp.GetFieldText('날짜{{9}}'), '');
  hwp.PutFieldText(`날짜${SEP}날짜`, `X${SEP}Y`);
  assert.equal(await para2(doc), 'Y가나다라마바사2 날짜:Y');
  hwp.PutFieldText('날짜', '');
  assert.equal(await para2(doc), '가나다라마바사2 날짜:');
});

test('hwpctrl-ocx GetFieldList — 한/글 B 목록 글과 같다(number 2 = 이름마다 {{개수}})', () => {
  const { hwp } = ctrl();
  assert.equal(hwp.GetFieldList(0, 0), ['신청인', '소속', '날짜', '날짜'].join(SEP));
  assert.equal(hwp.GetFieldList(1, 0), ['신청인{{0}}', '소속{{0}}', '날짜{{0}}', '날짜{{1}}'].join(SEP));
  assert.equal(hwp.GetFieldList(2, 0), ['신청인{{1}}', '소속{{1}}', '날짜{{2}}'].join(SEP));
  assert.equal(hwp.GetFieldList(1, 1), '');
  assert.equal(hwp.GetFieldList(1, 2), hwp.GetFieldList(1, 0));
});
