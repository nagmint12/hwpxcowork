// node --test tests/edit_verify.test.mjs — 편집 뒤 검증(server/edit-verify.js, 2026-11-12).
//   · V1 구조: 저장 직전 바이트의 ID 참조·변경 추적 짝·필드(메모) 짝·XML 짝이 이번 편집으로 새로 깨졌으면 저장하지 않고 VERIFY_STRUCTURE 오류
//   · V2 의도: 이번 커밋에 적용된 제안의 글이 결과에 있고 대상 밖 문단이 그대로인가 — 제안 객체의 기호 키(JSON 에 안 나옴)·lean 영수증 warning
// 고장은 시험에서만 넣는다: 저장 직전 한 번만 HwpxDoc.prototype.save 를 감싸 문서 XML 을 망가뜨린다(실제 서비스 경로 — 운영 코드에 시험 분기 없음).
// 정상 대조군은 실제 propose_* 흐름(바꿈·나눔·넣기·서식·표·메모·대기 제안·되돌리기·변경 수락·완료 자동 반영)으로 오탐을 센다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';
import { xmlProblem, structureIssues, intentWarnings, narrowDiff, VERIFY_NOTE } from '../server/edit-verify.js';
import { leanReceipt } from '../server/lean.js';
import { createMcpServer } from '../server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const user = { name: '검증 시험', role: 'admin' };
const TRACKED = { editMode: 'realtime', track: 'tracked' };
const FINAL = { editMode: 'realtime', track: 'final' };

async function setup(t, settings = TRACKED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, allowAgentApply: true, tutorial: { enabled: false } }, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'verify.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name, extra: { settings } }).id;
  const texts = async () => (await store.doc(id)).paragraphs({ view: 'final', nested: false }).map((p) => p.text);
  return { store, service, id, texts, meta: () => store.readMeta(id) };
}

// 다음 저장 한 번만 문서 XML 을 망가뜨린다(구역 0 글 → 글)
// mutate 가 글을 돌려주면 구역 0 을 그 글로, null 이면 문서를 직접 고친 것(서식 바꾸기 등). skip = 앞서 그대로 둘 저장 수
function breakNextSave(mutate, { skip = 0 } = {}) {
  const orig = HwpxDoc.prototype.save;
  let used = false; let n = 0;
  HwpxDoc.prototype.save = async function save() {
    if (n++ < skip) return orig.call(this);
    HwpxDoc.prototype.save = orig;
    used = true;
    const sec = this.sections[0]; const before = sec.xml;
    const xml = mutate(sec.xml, this);
    if (xml != null) { assert.notEqual(xml, before, '고장 주입이 XML 을 바꿔야 한다'); sec.load(xml); }
    else assert.notEqual(this.sections[0].xml, before, '고장 주입이 문서를 바꿔야 한다');
    return orig.call(this);
  };
  return () => { HwpxDoc.prototype.save = orig; return used; };
}
const replaceLast = (s, re, fn) => { const all = [...s.matchAll(re)]; assert.ok(all.length, `무늬 ${re} 가 없음`); const m = all.at(-1); return s.slice(0, m.index) + fn(m) + s.slice(m.index + m[0].length); };

// ───────── 결함 주입: V1(저장하지 않음) ─────────
const V1_FAULTS = [
  ['없는 charPrIDRef', (xml) => replaceLast(xml, /charPrIDRef="\d+"/g, () => 'charPrIDRef="9999"'), /charPrIDRef="9999"/],
  ['없는 paraPrIDRef', (xml) => replaceLast(xml, /paraPrIDRef="\d+"/g, () => 'paraPrIDRef="8888"'), /paraPrIDRef="8888"/],
  ['짝 없는 변경 추적(넣음 끝 없음)', (xml) => replaceLast(xml, /<hp:insertEnd\b[^>]*\/>/g, () => ''), /넣음 시작.*끝 표시가 없음/],
  ['변경 추적 머리 항목 없음', (xml) => replaceLast(xml, /<hp:insertBegin\b[^>]*\/>/g, (m) => m[0].replace(/\bTcId="\d+"/, 'TcId="777"')), /trackChange id="777"/],
  ['짝 없는 메모 필드(끝 없음)', (xml) => replaceLast(xml, /<hp:ctrl><hp:fieldEnd\b[^>]*\/><\/hp:ctrl>/g, () => ''), /필드 시작.*끝\(fieldEnd/],
  // 2026-11-12 검토 지적: 같은 Id 의 시작·끝이 '있는지'만 보면 시작 → 끝 → 시작(마지막 끝 없음)을 통과시켰다
  ['짝 없는 변경 추적(같은 Id 시작 → 끝 → 시작)', (xml) => replaceLast(xml, /<hp:insertEnd\b[^>]*\bId="(\d+)"[^>]*\/>/g, (m) => `${m[0]}<hp:insertBegin Id="${m[1]}" TcId="${m[1]}"/>`), /넣음 시작.*끝 표시가 없음/],
  ['다시 읽히지 않는 XML(닫는 태그 빠짐)', (xml) => replaceLast(xml, /<\/hp:t>/g, () => ''), /XML 오류/],
  ['다시 읽히지 않는 XML(맨 &)', (xml) => replaceLast(xml, /<hp:t>/g, () => '<hp:t>A & B'), /XML 오류.*&/],
  ['없는 binaryItemIDRef', (xml) => replaceLast(xml, /<hp:run\b[^>]*>/g, (m) => `${m[0]}<hc:img binaryItemIDRef="image999"/>`), /binaryItemIDRef="image999"/],
];

for (const [name, mutate, expect] of V1_FAULTS) {
  test(`V1 결함 주입 — ${name}: 저장하지 않고 VERIFY_STRUCTURE(무엇이 틀렸는지 + 다음 할 일)`, async (t) => {
    const { service, store, id, meta } = await setup(t);
    const v0 = meta().version; const bytes0 = store.currentBytes(id);
    const restore = breakNextSave(mutate);
    let err = null;
    try { await service.propose(id, { ref: 's0/p2', find: '셋째', replace: '세 번째', applyNow: true }, user, 'Claude'); } catch (e) { err = e; } finally { assert.ok(restore(), '주입한 저장이 불렸다'); }
    assert.ok(err, '오류가 나야 한다(검사 전 코드는 망가진 문서를 그대로 저장한다)');
    assert.equal(err.code, 'VERIFY_STRUCTURE', err.message);
    assert.match(err.message, expect);
    assert.match(err.message, /저장하지 않았습니다/); assert.match(err.message, /read_document|fail_request/);
    assert.equal(meta().version, v0, '기록이 오르지 않는다');
    assert.ok(store.currentBytes(id).equals(bytes0), '파일이 그대로다');
    assert.equal(meta().proposals.length, 0, '제안도 남지 않는다(한 거래)');
    // 망가뜨리지 않은 다음 편집은 그대로 된다(메모리 문서를 버렸다)
    const p = await service.propose(id, { ref: 's0/p2', find: '셋째', replace: '세 번째', applyNow: true }, user, 'Claude');
    assert.equal(p.status, 'applied'); assert.equal(meta().version, v0 + 1);
  });
}

// ───────── 결함 주입: V2(저장은 되고 경고) ─────────
const V2_FAULTS = [
  ['엉뚱한 문단이 바뀜', { ref: 's0/p2', find: '셋째', replace: '세 번째' }, (xml) => xml.replace('첫째 문단입니다', '첫째 문단이었습니다'), /대상 밖 문단도 바뀜\(s0\/p0/],
  // 2026-11-12 검토 지적: 글이 같은 문단의 서식 변화(XML 만 다름)를 모두 대상 밖 검사에서 뺐다
  ['대상 밖 문단의 서식이 바뀜', { ref: 's0/p2', find: '셋째', replace: '세 번째' }, (xml, doc) => { doc.formatRange('s0/p0', { start: 0, end: 2, char: { bold: true } }); return null; }, /대상 밖 문단도 바뀜\(s0\/p0/],
  ['요청한 글이 결과에 없음', { ref: 's0/p2', find: '셋째', replace: '세 번째' }, (xml) => xml.replace('세 번째', '세번'), /바꾼 글 「세 번째」 이 결과 문단에 없음/],
  ['넣은 글이 결과에 없음', { type: 'insert', afterRef: 's0/p2', text: '새로 넣는 문단입니다.' }, (xml) => xml.replace('새로 넣는 문단입니다.', '다른 글'), /넣은 글 「새로 넣는 문단입니다\.」 이 결과에 없음/],
];
for (const [name, body, mutate, expect] of V2_FAULTS) {
  test(`V2 결함 주입 — ${name}: 저장은 되고 제안에 경고(JSON·기본 응답에는 없음, lean 영수증 warning)`, async (t) => {
    const { service, id, meta } = await setup(t);
    const v0 = meta().version;
    const restore = breakNextSave(mutate);
    let p; try { p = await service.propose(id, { ...body, applyNow: true }, user, 'Claude'); } finally { assert.ok(restore()); }
    assert.equal(meta().version, v0 + 1, 'V2 는 막지 않는다');
    assert.match(String(p[VERIFY_NOTE] || ''), expect);
    assert.ok(!JSON.stringify(p).includes('검증 경고'), '기본 연결(JSON)에는 나오지 않는다');
    assert.match(leanReceipt('propose_change', p).warning || '', expect, 'lean 영수증의 경고 한 줄');
  });
}

// ───────── 정상 대조군(오탐 0) ─────────
test('정상 대조군 — 실제 propose·apply 흐름은 V1 오류도 V2 경고도 없다', async (t) => {
  const results = [];
  const check = (label, v) => { const list = Array.isArray(v) ? v : [v]; for (const x of list) { const p = x?.proposal || x; results.push([label, p?.[VERIFY_NOTE] || null]); } };
  {
    const { service, id } = await setup(t);
    // 문단 주소는 넣고 나눌 때마다 다시 매겨진다 — 글로 그때의 주소를 찾는다
    const at = async (text) => (await service.store.doc(id)).paragraphs({ view: 'final', nested: false }).find((p) => p.text.includes(text)).ref;
    check('바꿈 즉시(변경 추적)', await service.propose(id, { ref: await at('셋째'), find: '셋째', replace: '세 번째', applyNow: true }, user, 'Claude'));
    check('서식 즉시(굵게)', await service.propose(id, { type: 'format', ref: await at('제안대로'), find: '문단은', format: { char: { bold: true } }, applyNow: true }, user, 'Claude'));
    check('바꿈 + 서식(format — 대상 안 서식 변화)', await service.propose(id, { ref: await at('있던 낱말'), find: '새 낱말', replace: '새 단어', format: { char: { italic: true } }, applyNow: true }, user, 'Claude'));
    check('나눔 바꿈(줄바꿈)', await service.propose(id, { ref: await at('첫째'), find: '첫째 문단입니다. ', replace: '첫째 문단입니다.\n', applyNow: true }, user, 'Claude'));
    check('넣기 즉시', await service.propose(id, { type: 'insert', afterRef: await at('메모 대상'), text: '새 문단 하나.', applyNow: true }, user, 'Claude'));
    check('빈 줄 넣기', await service.propose(id, { type: 'insert', afterRef: await at('새 문단 하나'), text: '', blank: true, applyNow: true }, user, 'Claude'));
    check('표 즉시', await service.propose(id, { type: 'table', afterRef: await at('있던 낱말'), table: { rows: [['항목', '값'], ['가', '1']], headerRows: 1, caption: '' }, applyNow: true }, user, 'Claude'));
    check('메모', await service.addMemo(id, { ref: await at('제안대로'), find: '제안대로', text: '확인 필요' }, user, 'Claude'));
    const many = await service.proposeMany(id, [{ type: 'insert', afterRef: await at('제안대로'), text: '끝 문단 하나.' }, { ref: await at('있던 낱말'), find: '둘째', replace: '두 번째' }], user, null);
    for (const x of many) { assert.ok(x.ok, x.error); check('대기 제안 → 반영', await service.applyProposal(id, x.proposal.pid, user, 'Claude')); }
    check('반영 되돌리기', await service.undoProposal(id, many[1].proposal.pid, user, 'Claude'));
    const doc = await service.store.doc(id);
    const cid = Math.max(...doc.changes().map((c) => Number(c.id)));
    await service.resolveChange(id, cid, 'accept', user); results.push(['변경 수락', null]);
  }
  {
    // 앞 문단에 새 변경이 생기면 뒤 문단 변경 표시의 Id 가 다시 매겨진다(엔진 '목록 위치' 모형) — 서식·개체 변화로 세면 오탐(2026-11-12 서식 지문 첫 판에서 12건)
    const { service, id, store } = await setup(t);
    const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '다듬기', route: 'queue' }, user)).request;
    const refs = ['s0/p0', 's0/p1', 's0/p2'];
    for (let k = 0; k < 12; k++) {
      const ref = refs[k % 3]; const text = (await store.doc(id)).paragraphs({ view: 'final', nested: false }).find((x) => x.ref === ref).text;
      check(`변경 번호 다시 매김 ${k}`, await service.propose(id, { ref, find: text.slice(2, 8), replace: `검증${k}`, ...(k % 2 ? { applyNow: true } : { rid: request.rid }) }, user, 'Claude'));
    }
  }
  {
    const { service, id } = await setup(t, FINAL);
    check('바꿈 즉시(고친 글만)', await service.propose(id, { ref: 's0/p2', find: '셋째', replace: '세 번째', applyNow: true }, user, 'Claude'));
    check('넣기 즉시(고친 글만)', await service.propose(id, { type: 'insert', afterRef: 's0/p0', text: '고친 글만 넣기.', applyNow: true }, user, 'Claude'));
  }
  {
    const { service, id } = await setup(t, { ...TRACKED, aiApply: 'auto' });
    const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '다듬기', route: 'queue' }, user)).request;
    check('요청 제안(대기 — 작업 기록 메모)', await service.propose(id, { rid: request.rid, ref: 's0/p2', find: '셋째', replace: '세 번째' }, user, 'Claude'));
    check('요청 넣기(대기)', await service.propose(id, { rid: request.rid, type: 'insert', afterRef: 's0/p0', text: '요청으로 넣는 문단.' }, user, 'Claude'));
    await service.completeRequest(id, request.rid, { summary: '다듬었습니다' }, user, 'Claude');
    const meta = service.store.readMeta(id);
    assert.ok(meta.proposals.every((p) => p.status === 'applied'), '완료 때 자동 반영됐다');
    // 완료 응답(요청 꼴)에는 제안 경고가 실리지 않으므로, 같은 계산(그 커밋의 전후 기록 ↔ 그 커밋에 적용된 제안)을 다시 해 오탐을 센다 — 앞에 넣은 문단이 뒤 대상의 주소를 민다
    const applied = meta.proposals.filter((p) => p.appliedVersion === meta.version);
    assert.equal(applied.length, 2);
    const prevBytes = service.store.versionBytes(id, meta.version - 1); const nowBytes = service.store.versionBytes(id, meta.version);
    const w = intentWarnings(applied, await diffDocs(prevBytes, nowBytes));
    results.push(['완료 자동 반영(두 제안 한 커밋, diffDocs)', w.size ? JSON.stringify([...w]) : null]);
    const narrow = await narrowDiff(prevBytes, await HwpxDoc.load(nowBytes));
    assert.ok(narrow, '구역 수가 같으면 좁힌 비교');
    const w2 = intentWarnings(applied, narrow);
    results.push(['완료 자동 반영(두 제안 한 커밋, 좁힌 비교)', w2.size ? JSON.stringify([...w2]) : null]);
  }
  const flagged = results.filter(([, w]) => w);
  console.log(`정상 대조군 ${results.length}건, 경고 ${flagged.length}건`);
  assert.deepEqual(flagged, [], '정상 흐름에 V2 경고가 없다');
  assert.ok(results.length >= 14);
});

// ───────── 순수 함수 ─────────
test('xmlProblem: 짝·맨 &·맨 <·제어 문자·뿌리', () => {
  assert.equal(xmlProblem('<?xml version="1.0"?><a x="1>2"><b/><c>t &amp; &#65; &#x41;</c><!-- c --></a>'), null);
  assert.match(xmlProblem('<a><b></a>'), /짝이 맞지 않음/);
  assert.match(xmlProblem('<a><b>'), /닫히지 않은/);
  assert.match(xmlProblem('<a>x & y</a>'), /&/);
  assert.match(xmlProblem('<a>x < y</a>'), /</);
  assert.match(xmlProblem('<a>\u0001</a>'), /제어 문자/);
  assert.match(xmlProblem('<a/><b/>'), /뿌리 요소가 2개/);
});

test('structureIssues: 참조 없음 값(빈 값·4294967295)은 문제가 아니고, 전후를 같은 열쇠로 견준다', () => {
  const header = '<hh:head><hh:charPr id="0"/><hh:paraPr id="0"/><hh:style id="0"/><hh:borderFill id="1"/><hh:trackChange id="1"/></hh:head>';
  const sec = (body) => ['Contents/section0.xml', `<hs:sec>${body}</hs:sec>`, null];
  const parts = (body) => ({ names: new Set(['Contents/header.xml', 'Contents/section0.xml']), header, headerHash: null, manifest: '<opf:package><opf:item id="s0" href="Contents/section0.xml"/></opf:package>', sections: [sec(body)] });
  const ok = structureIssues(parts('<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="4294967295"><hc:img binaryItemIDRef=""/><hp:t><hp:insertBegin Id="1" TcId="1"/>가<hp:insertEnd Id="1" TcId="1"/></hp:t></hp:run></hp:p>'), { parse: true });
  assert.deepEqual([...ok.keys()], []);
  const bad = structureIssues(parts('<hp:p paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t><hp:deleteBegin Id="2" TcId="2"/>가</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="55"/></hp:ctrl></hp:run></hp:p>'), { parse: true });
  assert.deepEqual([...bad.keys()].sort(), ['field:55:nobegin', 'ref:paraPrIDRef:3', 'track:delete:2:nohead:2', 'track:delete:2:noend'].sort());
});

test('intentWarnings: 대상 안 덩어리·대상 밖 덩어리·빠진 글', () => {
  const p = { pid: 1, type: 'replace', ref: 's0/p2', afterRef: 's0/p2', find: '셋째', replace: '세 번째' };
  assert.equal(intentWarnings([p], { hunks: [{ type: 'replace', ref: 's0/p2', headRef: 's0/p2', newText: '세 번째 문단' }] }).size, 0);
  assert.match(intentWarnings([p], { hunks: [{ type: 'replace', ref: 's0/p2', newText: '세 번째' }, { type: 'replace', ref: 's0/p0', newText: 'x' }] }).get(1)[0], /대상 밖.*s0\/p0/);
  assert.match(intentWarnings([p], { hunks: [] }).get(1)[0], /결과 문단에 없음/);
  assert.equal(intentWarnings([{ pid: 2, type: 'toc', ref: 's0/p0' }], { hunks: [{ type: 'replace', ref: 's0/p9', newText: 'x' }] }).size, 0, '차례 새로 고침은 문서 여러 곳이 바뀌는 것이 의도');
});

test('structureIssues: 같은 Id 의 변경 추적 표시는 차례로 짝 — 시작·끝 여러 쌍은 정상, 시작 → 끝 → 시작·끝 → 시작은 문제', () => {
  const header = '<hh:head><hh:charPr id="0"/><hh:paraPr id="0"/><hh:style id="0"/><hh:borderFill id="1"/><hh:trackChange id="1"/></hh:head>';
  const parts = (body) => ({ names: new Set(['Contents/header.xml', 'Contents/section0.xml']), header, headerHash: null, manifest: '<opf:package><opf:item id="s0" href="Contents/section0.xml"/></opf:package>', sections: [['Contents/section0.xml', `<hs:sec><hp:p><hp:run charPrIDRef="0"><hp:t>${body}</hp:t></hp:run></hp:p></hs:sec>`, null]] });
  const B = '<hp:insertBegin Id="1" TcId="1"/>'; const E = '<hp:insertEnd Id="1" TcId="1"/>';
  assert.deepEqual([...structureIssues(parts(`${B}가${E}나${B}다${E}`)).keys()], [], '여러 쌍');
  assert.deepEqual([...structureIssues(parts(`${B}가${E}나${B}다`)).keys()], ['track:insert:1:noend']);
  assert.deepEqual([...structureIssues(parts(`${E}가${B}나`)).keys()].sort(), ['track:insert:1:nobegin', 'track:insert:1:noend']);
  assert.deepEqual([...structureIssues(parts(`${B}${B}가${E}${E}`)).keys()], ['track:insert:1:nested'], '겹친 시작');
});

test('lean complete 길: 완료 때 자동 반영된 제안의 V2 경고가 영수증에 실린다(경고가 없으면 영수증 그대로)', async (t) => {
  const run = async (fault) => {
    const { service, id } = await setup(t, { ...TRACKED, aiApply: 'auto' });
    const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '다듬기', route: 'queue' }, user)).request;
    const server = createMcpServer({ service, user, lean: true, agentName: 'Claude' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    const client = new Client({ name: 'lean-verify', version: '1' }); await client.connect(left);
    t.after(() => client.close());
    // 제안 저장(대기 — 작업 기록 메모) 다음 저장 = 완료 때 자동 반영 커밋에 고장을 넣는다
    const restore = fault ? breakNextSave((xml) => xml.replace('첫째 문단입니다', '첫째 문단이었습니다'), { skip: 1 }) : () => true;
    let r; try {
      r = await client.callTool({ name: 'propose_changes', arguments: { doc_id: id, request_id: request.rid, proposals: [{ ref: 's0/p2', find: '셋째', replace: '세 번째' }], complete: '고쳤습니다' } });
    } finally { assert.ok(restore()); }
    assert.ok(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  const ok = await run(false);
  assert.equal(ok.completed, true); assert.equal(ok.results[0].status, 'applied');
  assert.ok(!JSON.stringify(ok).includes('warning'), '경고가 없으면 싣지 않는다');
  const bad = await run(true);
  assert.equal(bad.completed, true); assert.equal(bad.results[0].status, 'applied');
  assert.match(bad.results[0].warning || '', /대상 밖 문단도 바뀜\(s0\/p0/);
  assert.equal(JSON.stringify(bad).length - JSON.stringify(ok).length, JSON.stringify({ warning: bad.results[0].warning }).length - 1, '늘어난 글자는 경고 한 줄뿐');
});
