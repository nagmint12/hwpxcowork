// node --test tests/memo_delete.test.mjs — 메모(MEMO 필드)를 편집기에서 지우고, 그 지우기가 공유 문서(메모·답글)까지 가는가.
//  1) 편집기 엔진(rhwp WASM): 메모가 붙은 글을 모두 지우면(선택 지우기) 메모도 빠진다, 일부만 지우면 남는다,
//     붙은 글 없는 메모는 캐럿 자리의 '메모' 조판 부호로 잡혀 지울 수 있다(글은 그대로), 메모만 남은 빈 줄을 합치면 메모는 앞 줄로 옮겨 가고
//     앞 줄의 글자 모양은 그대로다(빈 조각을 남기지 않는다)
//  2) 서버 실시간 밀어 넣기: 편집기에서 지운 메모는 서버에서도 지워지고 답글 기록도 정리된다(되돌리기로 돌아오면 답글도 돌아온다),
//     메모만 남은 빈 줄을 Backspace 로 합치면 서버도 그 줄을 지우고 메모를 앞 줄로 옮긴다(종전에는 메모가 든 문단을 지우지 않아 편집기가
//     서버 판으로 다시 열려 빈 줄이 되살아났다)
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const SRC = fixture('toc_source.hwpx');
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const text = (d, p) => d.getTextRange(0, p, 0, d.getParagraphLength(0, p));
const memosOf = async (bytes) => (await HwpxDoc.load(Buffer.from(bytes))).memos();
const byText = (list) => Object.fromEntries(list.map((m) => [m.text.split('\n')[0], m]));

/**
 * 시험지: 글 문단 A([2,6) 에 '글 메모') 뒤에 빈 줄 둘 — 첫 빈 줄에 붙은 글 없는 메모 둘, 둘째 빈 줄에 하나(글을 지우고 남은 메모 모양)
 * → { bytes, a: A 번호 }
 */
async function memoFixture() {
  const d = open(fs.readFileSync(SRC));
  let a = -1;
  for (let i = 1; i < d.getParagraphCount(0); i++) if (text(d, i).length >= 8) { a = i; break; }
  assert.ok(a > 0, '글 문단이 있어야 한다');
  d.splitParagraph(0, a, d.getParagraphLength(0, a));
  d.splitParagraph(0, a + 1, 0);
  const doc = await HwpxDoc.load(Buffer.from(d.exportHwpx()));
  doc.addMemo(`s0/p${a}`, { start: 2, end: 6, author: '갑', text: '글 메모' });
  doc.addMemo(`s0/p${a + 1}`, { start: 0, end: 0, author: '을', text: '빈 메모 1' });
  doc.addMemo(`s0/p${a + 1}`, { start: 0, end: 0, author: '을', text: '빈 메모 2' });
  doc.addMemo(`s0/p${a + 2}`, { start: 0, end: 0, author: '병', text: '빈 메모 3' });
  return { bytes: await doc.save(), a };
}
const FIX = await memoFixture();

test('편집기: 메모가 붙은 글을 모두 지우면 메모도 빠지고, 일부만 지우면 남는다', async () => {
  const { bytes, a } = FIX;
  const d = open(bytes);
  const before = text(d, a);
  d.deleteRange(0, a, 3, a, 5);   // 붙은 글 [2,6) 의 가운데만
  let m = byText(await memosOf(d.exportHwpx()));
  assert.ok(m['글 메모'], '일부만 지우면 메모가 남는다');
  assert.equal(m['글 메모'].start, 2); assert.equal(m['글 메모'].end, 4);
  const d2 = open(bytes);
  d2.deleteRange(0, a, 1, a, 7);  // 붙은 글을 감싸는 범위
  const out = d2.exportHwpx();
  m = byText(await memosOf(out));
  assert.equal(m['글 메모'], undefined, '붙은 글을 모두 지우면 메모도 빠진다');
  assert.ok(m['빈 메모 1'] && m['빈 메모 2'] && m['빈 메모 3'], '다른 메모는 그대로');
  assert.equal(text(d2, a), before.slice(0, 1) + before.slice(7));
  // 여러 문단에 걸쳐 지우면 가운데 문단(빈 메모 1·2 줄)의 메모는 문단째 빠진다
  const d3 = open(bytes);
  d3.deleteRange(0, a, d3.getParagraphLength(0, a), a + 2, 0);
  m = byText(await memosOf(d3.exportHwpx()));
  assert.equal(m['빈 메모 1'], undefined); assert.equal(m['빈 메모 2'], undefined);
  assert.ok(m['글 메모'] && m['빈 메모 3']);
});

test('편집기: 붙은 글 없는 메모는 캐럿 자리의 메모 부호 — 지우면 메모만 빠지고 되돌리기 조각이 그대로 돌아온다', async () => {
  const { bytes, a } = FIX;
  const d = open(bytes);
  const target = { sec: 0, para: a + 1 };
  const hit = JSON.parse(d.getCodeControlAt(JSON.stringify({ ...target, charOffset: 0, direction: 'forward' })));
  assert.equal(hit.found, true); assert.equal(hit.kind, 'memo'); assert.equal(hit.label, '메모');
  assert.equal(hit.memoCount, 2, '같은 자리 빈 메모 둘');
  // 문단 맨 앞 Backspace 는 문단 합치기가 먼저다(다른 부호와 같은 규칙)
  assert.equal(JSON.parse(d.getCodeControlAt(JSON.stringify({ ...target, charOffset: 0, direction: 'backward' }))).found, false);
  d.deleteCodeControl(JSON.stringify({ ...target, codeIndex: hit.codeIndex }));
  const next = JSON.parse(d.getCodeControlAt(JSON.stringify({ ...target, charOffset: 0, direction: 'forward' })));
  assert.equal(next.kind, 'memo'); assert.equal(next.memoCount, 1);
  d.deleteCodeControl(JSON.stringify({ ...target, codeIndex: next.codeIndex }));
  assert.equal(JSON.parse(d.getCodeControlAt(JSON.stringify({ ...target, charOffset: 0, direction: 'forward' }))).found, false);
  const out = d.exportHwpx();
  const m = byText(await memosOf(out));
  assert.equal(m['빈 메모 1'], undefined); assert.equal(m['빈 메모 2'], undefined);
  assert.ok(m['글 메모'] && m['빈 메모 3']);
  // 다시 열어도 같다(저장한 스트림 자리가 맞다)
  const again = open(out);
  assert.equal(again.getParagraphCount(0), d.getParagraphCount(0));
  assert.equal(text(again, a), text(d, a));
});

test('편집기: 메모만 남은 빈 줄을 합치면 메모는 앞 줄로 옮겨 가고 앞 줄 글자 모양은 그대로', async () => {
  const { bytes, a } = FIX;
  const d = open(bytes);
  const base = await HwpxDoc.load(Buffer.from(d.exportHwpx()));
  const n = d.getParagraphCount(0);
  d.mergeParagraph(0, a + 2);   // 빈 메모 3 줄 → 빈 메모 1·2 줄
  assert.equal(d.getParagraphCount(0), n - 1);
  const head = await HwpxDoc.load(Buffer.from(d.exportHwpx()));
  const m = byText(head.memos());
  assert.equal(m['빈 메모 3'].ref, `s0/p${a + 1}`);
  assert.equal(head.formattingFingerprint(`s0/p${a + 1}`), base.formattingFingerprint(`s0/p${a + 1}`), '앞 줄 서식이 그대로');
});

test('편집기: 메모만 남은 빈 줄들을 골라 지우면(빈 줄에서 시작) 그 메모가 모두 빠지고 줄도 없어진다 — 한/글 실측과 같음', async () => {
  const { bytes, a } = FIX;
  const d = open(bytes);
  const n = d.getParagraphCount(0);
  d.deleteRange(0, a + 1, 0, a + 3, 0);   // 빈 메모 1·2 줄 머리 ~ 빈 메모 3 줄 다음 문단 머리
  assert.equal(d.getParagraphCount(0), n - 2);
  const m = byText(await memosOf(d.exportHwpx()));
  assert.deepEqual(Object.keys(m), ['글 메모']);
});

test('메모 zorder: 없는 메모에 서버 저장·편집기 내보내기가 zorder(= Number)를 단다 — 없으면 한/글이 저장할 때 메모 끝을 모두 버린다', async () => {
  const doc = await HwpxDoc.load(Buffer.from(FIX.bytes));
  // zorder·metaTag 를 뗀 메모(예전 편집기 내보내기 꼴)
  for (const sec of doc.sections) sec.load(sec.xml.replace(/(<hp:fieldBegin\b[^>]*type="MEMO"[^>]*?) zorder="\d+"/g, '$1').replace(/(<hp:fieldBegin\b[^>]*type="MEMO"[^>]*?) metaTag=""/g, '$1'));
  assert.ok(!/<hp:fieldBegin\b[^>]*type="MEMO"[^>]*zorder=/.test(doc.sections[0].xml));
  const saved = await doc.save();
  const xml = (await HwpxDoc.load(Buffer.from(saved))).sections[0].xml;
  const tags = [...xml.matchAll(/<hp:fieldBegin\b[^>]*type="MEMO"[^>]*>/g)].map((x) => x[0]);
  assert.equal(tags.length, 4);
  assert.ok(tags.every((t) => /\szorder="\d+"/.test(t) && /\smetaTag=""/.test(t)), tags.join('\n'));
  // 편집기(rhwp)도 zorder 없는 메모를 Number 로 내보낸다(save 를 거치지 않은 파일 — 구역 XML 을 그대로 담는다)
  doc.sections.forEach((s, i) => doc.container.setText(doc.sectionNames[i], s.xml));
  const ed = open(Buffer.from(await doc.container.save()));
  const out = (await HwpxDoc.load(Buffer.from(ed.exportHwpx()))).sections[0].xml;
  const t2 = [...out.matchAll(/<hp:fieldBegin\b[^>]*type="MEMO"[^>]*>/g)].map((x) => x[0]);
  assert.ok(t2.length === 4 && t2.every((t) => /\szorder="[1-9]\d*"/.test(t)), t2.join('\n'));
});

test('서버: 편집기에서 지운 메모·합친 빈 줄이 공유 문서에 반영되고, 되돌리면 메모와 답글이 돌아온다', async () => {
  const { bytes, a } = FIX;
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, 'memo.hwpx');
    const working = async () => {
      const w = await A.res(`/api/docs/${id}/file?kind=working`);
      return { v: Number(w.headers.get('x-doc-version')), bytes: Buffer.from(w.data) };
    };
    const push = async (v, head) => {
      const r = await A.res(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(head) });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data;
    };
    const serverMemos = async () => byText(await memosOf((await working()).bytes));
    // 답글 단 메모
    const m0 = await serverMemos();
    const r0 = await A.res(`/api/docs/${id}/memos/${m0['글 메모'].id}/replies`, { method: 'POST', body: { text: '답글 하나' } });
    assert.equal(r0.status, 200, JSON.stringify(r0.data));

    // 1) 메모가 붙은 글을 지움 → 서버 메모·답글 기록도 지워진다
    let w = await working();
    let d = open(w.bytes);
    const snap = d.exportHwpx();
    d.deleteRange(0, a, 1, a, 7);
    let r = await push(w.v, d.exportHwpx());
    assert.equal(r.clean, true, JSON.stringify(r));
    let sm = await serverMemos();
    assert.equal(sm['글 메모'], undefined, '서버 메모도 지워진다');
    const items = async () => { const x = (await A.res(`/api/docs/${id}/memos`)).data; return Array.isArray(x) ? x : (x.memos || []); };
    assert.ok(!(await items()).some((x) => x.id === m0['글 메모'].id), '메모 목록에서도 빠진다');

    // 2) 되돌리기(지우기 전 문서를 다시 보냄) → 메모와 답글이 돌아온다
    w = await working();
    r = await push(w.v, snap);
    sm = await serverMemos();
    assert.ok(sm['글 메모'], '되돌린 메모가 돌아온다');
    const back = (await items()).find((x) => x.id === m0['글 메모'].id);
    assert.ok(back?.thread?.replies?.some((x) => x.text === '답글 하나'), '답글 기록도 돌아온다: ' + JSON.stringify(back?.thread));

    // 3) 메모만 남은 빈 줄을 Backspace 로 합침 → 서버도 그 줄을 지우고 메모는 앞 줄로
    w = await working();
    d = open(w.bytes);
    const n = d.getParagraphCount(0);
    d.mergeParagraph(0, a + 2);
    r = await push(w.v, d.exportHwpx());
    assert.equal(r.clean, true, JSON.stringify(r));
    assert.deepEqual(r.applied.deleted, [`s0/p${a + 2}`]);
    w = await working();
    assert.equal(open(w.bytes).getParagraphCount(0), n - 1);
    sm = await serverMemos();
    assert.equal(sm['빈 메모 3'].ref, `s0/p${a + 1}`, '메모는 앞 줄로 옮겨 간다');
    assert.ok(sm['빈 메모 1'] && sm['빈 메모 2']);

    // 4) 그 줄의 메모 부호를 지우고(메모만 바뀐 밀어 넣기 — 글 덩어리 없음) 줄도 합친다
    d = open(w.bytes);
    for (;;) {
      const hit = JSON.parse(d.getCodeControlAt(JSON.stringify({ sec: 0, para: a + 1, charOffset: 0, direction: 'forward' })));
      if (!hit.found) break;
      d.deleteCodeControl(JSON.stringify({ sec: 0, para: a + 1, codeIndex: hit.codeIndex }));
    }
    r = await push(w.v, d.exportHwpx());
    assert.equal(r.clean, true, JSON.stringify(r));
    sm = await serverMemos();
    assert.deepEqual(Object.keys(sm).sort(), ['글 메모']);
    w = await working();
    d = open(w.bytes);
    d.mergeParagraph(0, a + 1);
    r = await push(w.v, d.exportHwpx());
    assert.equal(r.clean, true, JSON.stringify(r));
    assert.equal(open((await working()).bytes).getParagraphCount(0), n - 2);
  } finally {
    await srv.stop();
  }
});

test('서버: 머리말과 메모만 든 둘째 빈 줄을 첫 줄로 합치면 머리말·메모가 첫 줄로 옮겨 가고 그 줄이 지워진다', async () => {
  // 시험지: 첫 문단 뒤 빈 줄에 꼬리말(쪽 번호)과 붙은 글 없는 메모 — 사용자 문서 '복사한 내용' 의 꼬리말 줄 모양
  const d0 = open(fs.readFileSync(SRC));
  d0.splitParagraph(0, 0, d0.getParagraphLength(0, 0));
  const doc = await HwpxDoc.load(Buffer.from(d0.exportHwpx()));
  const footer = '<hp:ctrl><hp:footer id="5" applyPageType="BOTH"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="BOTTOM" linkListIDRef="0" '
    + 'linkListNextIDRef="0" textWidth="42519" textHeight="4252" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
    + '<hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="PAGE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>'
    + '</hp:run></hp:p></hp:subList></hp:footer></hp:ctrl>';
  const hf = [{ key: 'hp:footer|BOTH', xml: footer }];
  doc.putHeaderFooters('s0/p1', hf);
  assert.deepEqual(doc.headerFooterKeys()[0][1], ['hp:footer|BOTH']);
  doc.addMemo('s0/p1', { start: 0, end: 0, author: '정', text: '머리말 줄 메모' });
  const bytes = await doc.save();
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, 'hf.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const d = open(w.data);
    const n = d.getParagraphCount(0);
    d.mergeParagraph(0, 1);
    const r = await A.res(`/api/docs/${id}/live?base=${w.headers.get('x-doc-version')}`, { method: 'PUT', body: Buffer.from(d.exportHwpx()) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.clean, true, JSON.stringify(r.data));
    assert.equal(r.data.unsupported, 0);
    const after = await HwpxDoc.load(Buffer.from((await A.res(`/api/docs/${id}/file?kind=working`)).data));
    assert.equal(after.bodyEntries()[0].length, n - 1, '그 줄이 지워진다');
    assert.deepEqual(after.headerFooterKeys()[0][0], hf.map((x) => x.key), '머리말이 첫 줄로');
    assert.equal(after.headerFooterKeys()[0].flat().length, hf.length, '머리말이 겹치지 않는다');
    assert.equal(after.memos().find((m) => m.text === '머리말 줄 메모')?.ref, 's0/p0', '메모도 첫 줄로');
  } finally {
    await srv.stop();
  }
});

test('서버: 편집기에서 머리말·꼬리말을 새로 만들거나 지우면 공유 문서에도 그대로(조판 부호 object 덩어리)', async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(SRC), 'hf2.hwpx');
    const keys = async () => (await HwpxDoc.load(Buffer.from((await A.res(`/api/docs/${id}/file?kind=working`)).data))).headerFooterKeys()[0].flat().sort();
    const push = async (edit) => {
      const w = await A.res(`/api/docs/${id}/file?kind=working`);
      const d = open(w.data); edit(d);
      const r = await A.res(`/api/docs/${id}/live?base=${w.headers.get('x-doc-version')}`, { method: 'PUT', body: Buffer.from(d.exportHwpx()) });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.clean, true, JSON.stringify(r.data));
      return r.data;
    };
    const before = await keys();
    await push((d) => d.createHeaderFooter(0, false, 0));   // 꼬리말(양 쪽) 만들기
    const made = await keys();
    assert.equal(made.length, before.length + 1, `꼬리말이 하나 늘어남 ${JSON.stringify(made)}`);
    assert.ok(made.some((k) => k.startsWith('hp:footer|')));
    await push((d) => d.deleteHeaderFooter(0, false, 0));
    assert.deepEqual(await keys(), before, '지우면 공유 문서에서도 빠진다');
  } finally {
    await srv.stop();
  }
});

test('서버: 실시간 편집기는 연 판의 메모만 안다 — 남이 단 메모를 지우지 않고 남이 지운 메모를 되살리지 않으며, 제 지우기·되돌리기는 그대로(?loaded)', async () => {
  // 2026-11-04 test:ui:studio [13g]: 편집기는 메모만 바뀐 판을 다시 열지 않고 기준만 옮긴다(web/editor.js quietAdvance·맞추기). 기준 판의 메모로 견주던
  // 서버가 그 편집기의 다음 밀어 넣기에서 남이 단 메모를 '편집기에서 지운 메모'로 보고 지웠다(서식 커밋 → 다른 창 다시 열기)
  const { bytes, a } = FIX;
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a'); const B = srv.api('b'); const ADM = srv.api('admin');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, 'memo-known.hwpx');
    const info = async () => A(`/api/docs/${id}`);
    const serverMemos = async () => byText(await memosOf((await A.res(`/api/docs/${id}/file?kind=working`)).data));
    // 편집기 창 하나: 작업본 판 L 을 열고 다시 열지 않는다. 밀어 넣기마다 기준 = 지금 판(글만 맞춤), 같은 창 차례(seq), 연 판(loaded)
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const L = Number(w.headers.get('x-doc-version'));
    let ed = open(w.data);
    let k = 123456000;
    const push = async (body) => {
      const r = await A.res(`/api/docs/${id}/live?base=${(await info()).version}&seq=${++k}&loaded=${L}`, { method: 'PUT', body: Buffer.from(body) });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data;
    };
    // 1) 남(B)이 메모를 닮(서식 커밋 아님 — 편집기는 다시 열지 않음) → 편집기가 글을 쳐 밀어 넣어도 그 메모는 남고 글만 커밋(서식 커밋 아님)
    const m1 = await B.res(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', start: 0, end: 1, text: '남이 단 메모' } });
    assert.equal(m1.status, 200, JSON.stringify(m1.data));
    assert.ok(!((await info()).formatVersion > L), '메모 달기는 서식 커밋이 아니다(편집기는 기준만 옮김)');
    ed.insertText(0, 0, 0, '가');
    let r = await push(ed.exportHwpx());
    assert.equal(r.clean, true, JSON.stringify(r));
    assert.equal(r.formatVersion, undefined, `글만 바꾼 밀어 넣기는 서식 커밋이 아니다: ${JSON.stringify(r)}`);
    let sm = await serverMemos();
    assert.ok(sm['남이 단 메모'], '남이 단 메모는 지우지 않는다');
    // 2) 남(관리자)이 메모를 지움(REST — 편집기 문서에는 남아 있다) → 편집기 밀어 넣기가 그 메모를 되살리지 않는다
    const gone = sm['빈 메모 3'];
    const del = await ADM.res(`/api/docs/${id}/memos/${gone.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    ed.insertText(0, 0, 0, '나');
    r = await push(ed.exportHwpx());
    sm = await serverMemos();
    assert.equal(sm['빈 메모 3'], undefined, '남이 지운 메모를 되살리지 않는다');
    assert.ok(sm['남이 단 메모'] && sm['글 메모']);
    // 3) 이 편집기가 메모가 붙은 글을 지움 → 서버 메모도 지워진다. 되돌리기(지우기 전 문서) → 돌아온다(남이 지운 메모는 그대로 없음)
    const snap = ed.exportHwpx();
    ed.deleteRange(0, a, 1, a, 7);
    r = await push(ed.exportHwpx());
    sm = await serverMemos();
    assert.equal(sm['글 메모'], undefined, '편집기에서 지운 메모는 서버에서도 지워진다');
    ed = open(snap);
    r = await push(ed.exportHwpx());
    sm = await serverMemos();
    assert.ok(sm['글 메모'], '되돌린 메모가 돌아온다');
    assert.equal(sm['빈 메모 3'], undefined, '남이 지운 메모는 되돌리기와 함께 돌아오지 않는다');
    assert.ok(sm['남이 단 메모'], '남이 단 메모는 그대로');
  } finally {
    await srv.stop();
  }
});
