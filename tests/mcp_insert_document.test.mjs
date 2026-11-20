// 문서 끼워 넣기(MCP v3 실험 — 2026-11-20, docs/MCP_REDESIGN_2026-11-16.md §21). 사용자 결정: 긴 장은 표준서식 생성기가 아니라 '이 문서의 스타일을 가진 빈 문서'에
// 써서 통째로 넣는다. download_attachment_file 'template'(빈 서식)·'document'(사본) → 모델이 HWPX 를 씀 → upload_result_file → edit {op:'insert_document'}
// 이 시험은 모델 자리에서: 사본의 문단·표 XML 을 빈 서식에 복사해 글을 고치고, 올려서 넣고, 되돌린다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { docBytesSync, containerFromBytesSync } from '../engine/toc.js';
import { opsBrief, OPS_BRIEF, opsGuide, opGuide, parseOps } from '../server/mcp2/ops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const AGENT = 'codex';

function setup(t, { pages = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-insert-doc-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, verify: { pages: pages ? undefined : false } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'report.hwpx', bytes: fs.readFileSync(REPORT), by: user.name }).id;
  return { store, service, docId };
}
async function request(service, docId) {
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction: '장 하나를 문서로 써서 넣어 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: r.rid });
  return r.rid;
}
const upload = async (service, docId, rid, name, bytes) => {
  const out = await service.addRequestFile(docId, { rid, sourceFileId: `local:${crypto.createHash('sha256').update(bytes).digest('hex')}`, name, bytes }, user, AGENT);
  return String(out.aid);
};
const load = (bytes) => new HwpxDoc(containerFromBytesSync(bytes));
const bodyTexts = (doc) => doc.sections.flatMap((s, si) => s.bodyParas.map((_, i) => doc.text(`s${si}/p${i}`, 'final')));

test('빈 서식(template)은 이 문서의 스타일·쪽 설정만, 사본(document)은 글 그대로', { timeout: 60000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const orig = await store.doc(docId);
  const tpl = load((await service.documentFile(docId, 'template')).bytes);
  const copy = load((await service.documentFile(docId, 'document')).bytes);
  assert.equal(tpl.sections.length, orig.sections.length);
  for (const s of tpl.sections) { assert.equal(s.bodyParas.length, 1, '구역마다 구역 정의 문단 하나'); assert.match(s.xml, /<hp:secPr\b/); }
  assert.deepEqual(bodyTexts(tpl).map((x) => x.trim()), tpl.sections.map(() => ''), '본문 글 없음');
  assert.equal(tpl.header.xml, orig.header.xml, '머리(스타일·모양)는 그대로');
  assert.deepEqual(bodyTexts(copy), bodyTexts(orig));
  const f = await service.documentFile(docId, 'template'); assert.match(f.name, /-빈 서식\.hwpx$/);
});

test('빈 서식에 쓴 문서를 insert_document 로 넣으면 제안 하나 — 글·스타일·표가 들어가고 표 id 는 새로, 되돌리면 원래대로', { timeout: 180000 }, async (t) => {
  const { store, service, docId } = setup(t, { pages: true });   // 실제 운영 길: 저장 전 사본 검사·쪽 수 어림을 켠다
  const rid = await request(service, docId);
  const orig = await store.doc(docId);
  const before = bodyTexts(orig), tablesBefore = orig.tables().length;   // store.doc 은 같은 객체를 고쳐 쓰므로 수를 먼저 적어 둔다
  // 모델 자리: 사본의 s1/p5(글 문단)와 첫 표 문단을 빈 서식의 첫 문단 뒤에 복사하고 글을 고친다
  const copy = load((await service.documentFile(docId, 'document')).bytes);
  const tpl = load((await service.documentFile(docId, 'template')).bytes);
  const srcSec = copy.sections[1];
  // 같은 꼴 문단을 본떠 새로 쓴다(문단 머리·첫 글자 모양 그대로, 글만 새로 — 안내 2단계의 문단 꼴)
  const src = srcSec.xml.slice(srcSec.bodyParas[5].start, srcSec.bodyParas[5].end);
  const para = `${/^<hp:p\b[^>]*>/.exec(src)[0]}<hp:run charPrIDRef="${/charPrIDRef="(\d+)"/.exec(src)[1]}"><hp:t>끼워 넣은 장의 첫 문단</hp:t></hp:run></hp:p>`;
  const tKey = copy.tables().find((x) => x.key.startsWith('s1/'))?.key; assert.ok(tKey, '사본에 표가 있다');
  const tp = srcSec.bodyParas[Number(/p(\d+)#/.exec(tKey)[1])];
  const tableXml = srcSec.xml.slice(tp.start, tp.end);
  const sec0 = tpl.sections[0];
  sec0.load(sec0.xml.slice(0, sec0.bodyParas[0].end) + para + tableXml + sec0.xml.slice(sec0.bodyParas[0].end));
  const filled = Buffer.from(docBytesSync(tpl));
  const aid = await upload(service, docId, rid, '끼워 넣을 장.hwpx', filled);
  assert.match(aid, /^a\d+$/);
  // dry_run: 구조 미리 보기에 넣을 문단·표 수
  const dry = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'insert_document', after: 's1/p6', attachment_id: aid }] }, user, AGENT);
  assert.ok(!dry.failed, JSON.stringify(dry.failed));
  assert.match(JSON.stringify(dry.structure), /문서 끼워 넣기\(s1\/p6 뒤\): 문단 2개 · 표 1개 — 「끼워 넣은 장의 첫 문단」/);
  // 저장 → 반영
  const saved = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'insert_document', after: 's1/p6', attachment_id: aid }] }, user, AGENT);
  assert.ok(!saved.failed, JSON.stringify(saved.failed)); assert.ok(saved.structure?.pid, JSON.stringify(saved).slice(0, 300));
  assert.equal(saved.pages.all_applied, saved.pages.now + 1, `쪽 수 어림이 넣은 문서를 반영해 본다: ${JSON.stringify(saved.pages)}`);
  assert.deepEqual(saved.structure.result, [{ document: aid, after: 's1/p6', paragraphs: 2, tables: 1, chars: saved.structure.result[0].chars, first: '끼워 넣은 장의 첫 문단' }]);
  // 카드: 머리말 '본문 추가', 넣을 자리 앞 문단에
  const card = (await service.listProposals(docId)).find((p) => p.pid === saved.structure.pid);
  assert.equal(card.pageLayout.title, '본문 추가'); assert.equal(card.ref, 's1/p6');
  await service.applyProposal(docId, saved.structure.pid, user);
  const doc = await store.doc(docId);
  const after = bodyTexts(doc);
  assert.equal(after.length, before.length + 2, '본문 문단 2개 늘어남');
  assert.equal(doc.text('s1/p7', 'final'), '끼워 넣은 장의 첫 문단', 's1/p6 뒤에 들어감');
  // 스타일: 복사한 문단의 스타일 번호 그대로(빈 서식 = 이 문서 머리)
  const sid = (x) => (/styleIDRef="(\d+)"/.exec(x) || [])[1];
  const s1 = doc.sections[1]; assert.equal(sid(s1.xml.slice(s1.bodyParas[7].start, s1.bodyParas[7].end)), sid(para));
  // 표 id 가 문서 안에서 겹치지 않는다
  const ids = [...s1.xml.matchAll(/<hp:tbl\b[^>]*\sid="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `표 id 겹침 없음: ${ids.join(',')}`);
  assert.equal(doc.tables().length, tablesBefore + 1);
  // 되돌리기 → 원래 본문
  await service.undoProposal(docId, saved.structure.pid, user);
  assert.deepEqual(bodyTexts(await store.doc(docId)), before);
});

test('HWPX 가 아닌 첨부·빈 문서는 거절', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const png = fs.readFileSync(path.join(root, 'web', 'icons', 'icon-128.png'));
  const badAid = await upload(service, docId, rid, 'x.png', png);
  const r1 = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'insert_document', after: 's1/p6', attachment_id: badAid }] }, user, AGENT);
  assert.match(JSON.stringify(r1.failed), /HWPX 문서가 아닙니다/);
  const emptyAid = await upload(service, docId, rid, '빈.hwpx', Buffer.from((await service.documentFile(docId, 'template')).bytes));
  const r2 = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'insert_document', after: 's1/p6', attachment_id: emptyAid }] }, user, AGENT);
  assert.match(JSON.stringify(r2.failed), /끼워 넣을 본문 문단이 없습니다/);
});

test('안내: insert_document 는 v3 에만(꼴·guide), v2 는 그대로 · 꼴 검사', () => {
  assert.match(opsBrief('v3'), /op:'insert_document'/); assert.doesNotMatch(OPS_BRIEF, /insert_document/);
  assert.match(opsGuide('document', 'v3'), /download_attachment_file\(\{doc_id, attachment_id:'template'\}\)/);
  // 사용자 결정(11-20 밤): 도구 설명에는 '이런 op 가 있다'만 — 이 길로 문서를 만들라는 권유·효율 비교·작성 절차를 싣지 않는다
  const line = opsBrief('v3').split('\n').find((l) => l.includes("op:'insert_document'"));
  assert.ok(line.length < 160, line);
  for (const w of ['template', 'download_attachment_file', 'upload_result_file', '긴 장', '효율', '번거로', '표준서식', '권장']) assert.ok(!line.includes(w), `도구 설명에 '${w}'`);
  assert.match(opsGuide('ops', 'v3'), /insert_document/); assert.doesNotMatch(opsGuide('ops', 'v2'), /insert_document/);
  assert.match(opGuide('insert_document', 'v3'), /read\(view='guide', id='document'\)/); assert.equal(opGuide('insert_document', 'v2'), null);
  assert.equal(parseOps([{ op: 'insert_document', after: 's1/p3', attachment_id: 'a1' }], { surface: 'v3' }).errors.length, 0);
  assert.equal(parseOps([{ op: 'insert_document', after: 's1/p3' }], { surface: 'v3' }).errors.length, 1);
  // v2(기본 연결)에서는 모르는 op — 이름 목록·쪽 구성 꼴에도 없다
  const v2 = parseOps([{ op: 'insert_document', after: 's1/p3', attachment_id: 'a1' }]);
  assert.equal(v2.errors.length, 1); assert.match(v2.errors[0].error, /v3 연결의 실험 기능/);
  assert.doesNotMatch(parseOps([{ op: 'nope' }]).errors[0].error, /insert_document/);
  assert.match(parseOps([{ op: 'nope' }], { surface: 'v3' }).errors[0].error, /insert_document/);
  assert.doesNotMatch(opsGuide('page', 'v2'), /insert_document/);
});

test('그림이 든 문서 — 다른 문서면 그림 파일을 옮기고, 같은 그림은 다시 넣지 않는다 · 개체 id 는 문서 안에서 겹치지 않는다', { timeout: 180000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId);
  const binIds = (doc) => [...(doc.container.getText('Contents/content.hpf') || '').matchAll(/<opf:item\b[^>]*\bid="([^"]+)"[^>]*href="BinData\/[^"]+"/g)].map((m) => m[1]);
  const allXml = (doc) => doc.sections.map((s) => s.xml).join('');
  const objIds = (doc) => [...allXml(doc).matchAll(/<hp:(?:tbl|pic|rect|ellipse|line|polygon|curve|arc|container|ole|equation|textart)\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1]);
  const doc0 = await store.doc(docId);
  const bins0 = binIds(doc0).length, objs0 = objIds(doc0).length, pics0 = (allXml(doc0).match(/<hp:pic\b/g) || []).length;
  // ① 다른 문서 통째(머리·그림 파일이 다른 사용자 가이드) — 스타일·모양 번호는 이 문서 정의로 옮기고 그림 파일을 더한다
  const guideBytes = fs.readFileSync(path.join(root, 'tutorial', 'AI 연결 — 사용자 가이드.hwpx'));
  const guide = load(guideBytes);
  const guidePics = (allXml(guide).match(/<hp:pic\b/g) || []).length;
  const a1 = await upload(service, docId, rid, '다른 문서.hwpx', guideBytes);
  const s1 = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'insert_document', after: 's1/p6', attachment_id: a1 }] }, user, AGENT);
  assert.ok(!s1.failed, JSON.stringify(s1.failed));
  assert.equal(s1.structure.result[0].figures, guidePics, JSON.stringify(s1.structure));
  await service.applyProposal(docId, s1.structure.pid, user);
  const doc1 = await store.doc(docId);
  const bins1 = binIds(doc1), doc1Memos = doc1.memos().length;
  assert.ok(bins1.length > bins0, `그림 파일이 더해진다 ${bins0} → ${bins1.length}`);
  for (const ref of new Set([...allXml(doc1).matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]))) assert.ok(bins1.includes(ref), `그림 파일 ${ref} 가 문서에 있다`);
  const ids1 = objIds(doc1);
  assert.equal(new Set(ids1).size, ids1.length, '개체 id 겹침 없음');
  assert.equal((allXml(doc1).match(/<hp:pic\b/g) || []).length, pics0 + guidePics);
  // ② 이 문서 사본 통째 — 같은 그림 파일은 다시 넣지 않는다(내용이 같으면 그 번호)
  const copyBytes = Buffer.from((await service.documentFile(docId, 'document')).bytes);
  const a2 = await upload(service, docId, rid, '사본.hwpx', copyBytes);
  const s2 = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'insert_document', after: 's0/p0', attachment_id: a2 }] }, user, AGENT);
  assert.ok(!s2.failed, JSON.stringify(s2.failed));
  await service.applyProposal(docId, s2.structure.pid, user);
  const doc2 = await store.doc(docId);
  assert.equal(binIds(doc2).length, bins1.length, '같은 그림 파일은 더하지 않는다');
  const ids2 = objIds(doc2);
  assert.equal(new Set(ids2).size, ids2.length, '개체 id 겹침 없음(같은 문서를 또 넣어도)');
  assert.ok(objs0 > 0);
  // 사본에는 이 요청의 메모('[AI 작업 #1]')가 들어 있다 — 부호만 지우고 넣으므로 요청 메모가 둘이 되지 않는다
  const copyMemos = load(copyBytes).memos().length;
  assert.ok(copyMemos >= 1);
  assert.equal(s2.structure.result[0].memos_dropped, copyMemos, '사본에 묻어 온 메모는 부호만 지운다');
  assert.equal(doc2.memos().length, doc1Memos, '넣은 뒤에도 메모 수 그대로');
  // 되돌리기(쪽 구성 제안처럼 마지막 구조 제안만 — 그 뒤 새 제안이 없을 때) → ① 뒤 상태
  await service.undoProposal(docId, s2.structure.pid, user);
  assert.equal(binIds(await store.doc(docId)).length, bins1.length);
});

test('엔진: 각주·미주 instId 도 새로, 번호가 32비트 끝에 닿으면 1부터 빈 번호(겹침 없음)', () => {
  const bytes = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'codes_hangul_all.hwpx'));
  const ids = (doc) => [...doc.sections.map((s) => s.xml).join('').matchAll(/<hp:(?:tbl|pic|rect|line|ellipse|arc|polygon|curve|connectLine|container|equation|ole|textart|footNote|endNote|fieldBegin)\s[^>]*?\s(?:id|instid|instId)="(\d+)"/g)].map((m) => Number(m[1]));
  // ① 자기 자신을 넣기 — 각주 instId 가 둘이 되지 않는다
  const doc = load(bytes);
  doc.insertDocumentAfter(0, doc.sections[0].bodyParas.length - 1, load(bytes));
  const notes = [...doc.sections.map((s) => s.xml).join('').matchAll(/<hp:footNote\b[^>]*\sinstId="(\d+)"/g)].map((m) => m[1]);
  assert.ok(notes.length >= 2); assert.equal(new Set(notes).size, notes.length, `각주 instId 겹침: ${notes.join(',')}`);
  const a = ids(doc); assert.equal(new Set(a).size, a.length, '개체 id 겹침 없음');
  // ② 문서에 32비트 끝 번호(4294967295)가 있으면 새 번호는 1부터 빈 번호 — 넘거나 겹치지 않는다
  const edge = load(bytes);
  const s0 = edge.sections[0];
  s0.load(s0.xml.replace(/(<hp:tbl\b[^>]*?\sid=")\d+(")/, '$14294967295$2'));
  edge.insertDocumentAfter(0, 0, load(bytes));
  const b = ids(edge);
  assert.equal(new Set(b).size, b.length, '끝 번호 뒤에도 겹침 없음');
  assert.ok(b.every((n) => n >= 1 && n <= 4294967295), `32비트 안: ${Math.max(...b)}`);
  assert.ok(b.some((n) => n < 1233959081), '끝에 닿으면 앞쪽(1부터)의 빈 번호를 쓴다');
});

test('빈 서식은 본문이 쓰던 그림 파일을 싣지 않는다(바탕쪽·머리말이 쓰는 것만) · 내려받기는 압축', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const f = await service.documentFile(docId, 'template');
  const tpl = load(f.bytes);
  const hpf = tpl.container.getText('Contents/content.hpf') || '';
  const xml = [tpl.header.xml, ...tpl.sections.map((s) => s.xml), ...tpl.container.order.filter((n) => /\.xml$/i.test(n)).map((n) => tpl.container.getText(n) || '')].join('');
  for (const m of hpf.matchAll(/<opf:item\b[^>]*\bid="([^"]+)"[^>]*\bhref="BinData\/[^"]+"/g)) assert.ok(xml.includes(`binaryItemIDRef="${m[1]}"`), `빈 서식에 쓰지 않는 그림 파일 ${m[1]}`);
  const copy = await service.documentFile(docId, 'document');
  assert.ok(f.bytes.length * 5 < copy.bytes.length, `빈 서식 ${f.bytes.length} ≪ 사본 ${copy.bytes.length}`);
  // 압축(deflate): 사본이 원문 파일보다 훨씬 커지지 않는다(무압축이면 2~3배)
  assert.ok(copy.bytes.length < fs.readFileSync(REPORT).length * 1.5, `사본 ${copy.bytes.length} vs 원문 ${fs.readFileSync(REPORT).length}`);
  assert.equal(Buffer.from(copy.bytes).subarray(30, 38).toString(), 'mimetype');
});
