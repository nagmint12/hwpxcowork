// node --test tests/propose_delete.test.mjs — 개체 지우기 제안(propose_delete — 2026-11-10).
// 글상자 206개를 없애라는 지시에 AI 가 '도형째 지우는 도구가 없어' 글상자 안 글을 비우는 제안 206건을 낸 일이 있어 만든 도구다.
// 엔진(ownObjects · nestedAfterRemoval · removeOwnObjects/removeOwnObjectsTracked 의 kinds)과 서버 제안 → 적용(고친 글만: 바로 지움 /
// 변경 추적으로: 개체 지움 변경) → 되돌리기, 같은 문단 안 다른 제안의 중첩 주소 옮기기·되돌리기, MCP·lean·작업 기록 글을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import * as MT from '../server/memotext.js';
import { activityItem } from '../server/activity.js';
import { TOOL_PROFILES } from '../server/tool-profiles.js';
import { COMPLETABLE_TOOLS } from '../server/lean.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const author = '홍길동(Claude)';
const reload = async (d) => HwpxDoc.load(await d.save());
const nestedOf = (d, ref) => d.paragraphs({ view: 'final', nested: true }).filter((p) => p.ref.startsWith(`${ref}/`)).map((p) => [p.ref, p.text]);

/**
 * shapes_hangul 의 글상자 문단(s0/p7) 뒤에 2×2 표 문단(s0/p8)을 넣고, 그 표 문단 run 머리에 그 글상자의 사본(id 만 새로)을 넣는다
 * → s0/p8 = 글상자 1 + 표 1. 중첩 문단 n0 = 글상자 안 글, n1~n4 = 표 칸 가·나·다·라
 */
async function mixedDoc() {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('shapes_hangul.hwpx')));
  const res = d.insertTableAfter(0, 7, { rows: [['가', '나'], ['다', '라']] }, { author });
  d.acceptAll();
  const sec = d.sections[0];
  const box = d.resolve('s0/p7').p.anchors.find((a) => a.kind === 'ctrl' && a.name === 'hp:rect');
  const xml = sec.xml.slice(box.start, box.end).replace(/^<hp:rect\b[^>]*>/, (o) => o.replace(/\sid="\d+"/, ' id="987654"').replace(/\sinstid="\d+"/, ' instid="987655"'));
  const tbl = d.resolve(res.ref).p.anchors.find((a) => a.kind === 'ctrl' && a.name === 'hp:tbl');
  sec.load(sec.xml.slice(0, tbl.start) + xml + sec.xml.slice(tbl.start));
  return reload(d);
}

test('엔진: ownObjects·nestedAfterRemoval·removeOwnObjects(kinds) — 고른 종류만 지우고 남는 중첩 문단은 앞으로, copyObjectsFrom·거절로 그대로 돌아온다', async () => {
  const d = await mixedDoc();
  assert.deepEqual(d.ownObjects('s0/p8'), [{ kind: 'shape', name: '글상자' }, { kind: 'table', name: '표' }]);
  assert.deepEqual(d.ownObjects('s0/p0'), []);
  assert.deepEqual(nestedOf(d, 's0/p8'), [['s0/p8/n0', '글상자 안 글'], ['s0/p8/n1', '가'], ['s0/p8/n2', '나'], ['s0/p8/n3', '다'], ['s0/p8/n4', '라']]);
  assert.deepEqual(d.nestedAfterRemoval('s0/p8', ['shape']), [null, 0, 1, 2, 3]);
  assert.deepEqual(d.nestedAfterRemoval('s0/p8', ['table']), [0, null, null, null, null]);
  assert.deepEqual(d.nestedAfterRemoval('s0/p8'), [null, null, null, null, null]);
  const print0 = d.objectPrint('s0/p8');
  const source = await reload(d);

  // 추적 없이: 글상자만 → 표는 남고 칸 주소가 n0~n3 으로
  assert.equal(d.removeOwnObjects('s0/p8', { kinds: ['shape'] }), 1);
  let r = await reload(d);
  assert.deepEqual(r.ownObjects('s0/p8'), [{ kind: 'table', name: '표' }]);
  assert.deepEqual(nestedOf(r, 's0/p8'), [['s0/p8/n0', '가'], ['s0/p8/n1', '나'], ['s0/p8/n2', '다'], ['s0/p8/n3', '라']]);
  assert.equal(r.text('s0/p8', 'final'), source.text('s0/p8', 'final'), '글은 그대로');
  // copyObjectsFrom 으로 다시 옮겨 오면 개체는 모두 돌아오지만 표·도형 사이 차례는 바뀔 수 있다(종류별로 따로 넣는다) — 서버는 nestedSignature 로 가린다
  assert.equal(r.copyObjectsFrom(source, 's0/p8', 's0/p8'), true);
  const back = await reload(r);
  assert.equal(back.objectPrint('s0/p8'), print0);
  assert.deepEqual(nestedOf(back, 's0/p8').map((x) => x[1]).sort(), nestedOf(source, 's0/p8').map((x) => x[1]).sort());
  assert.equal(source.nestedSignature('s0/p8'), 'hp:rect,hp:tbl,hp:tbl,hp:tbl,hp:tbl');
  assert.notEqual(back.nestedSignature('s0/p8'), source.nestedSignature('s0/p8'), '이 경우 차례가 바뀐다(되돌리기는 다른 길을 쓴다)');

  // 변경 추적으로: 표만 → 개체 지움 변경 1건(최종본에서 표와 칸이 사라짐), 거절하면 XML 그대로(차례까지)
  r = await reload(source);
  const res = r.removeOwnObjectsTracked('s0/p8', { author, date: new Date(), kinds: ['table'] });
  assert.equal(res.ids.length, 1);
  r = await reload(r);
  assert.deepEqual(r.ownObjects('s0/p8'), [{ kind: 'shape', name: '글상자' }]);
  assert.deepEqual(nestedOf(r, 's0/p8'), [['s0/p8/n0', '글상자 안 글']]);
  r.resolveChanges(res.ids, 'reject');
  r = await reload(r);
  assert.equal(r.objectPrint('s0/p8'), print0);
  assert.equal(r.changes().length, 0);
  assert.deepEqual(nestedOf(r, 's0/p8'), nestedOf(source, 's0/p8'));
});

test('도구 목록·진행 기록·메모 글: propose_delete 가 API·Codex 실행기와 lean 완료 도구에 들고, 작업 기록 글은 지울 개체를 센다', () => {
  assert.ok(TOOL_PROFILES.api.includes('propose_delete') && TOOL_PROFILES.codex.includes('propose_delete'));
  assert.ok(COMPLETABLE_TOOLS.includes('propose_delete'));
  assert.equal(activityItem('propose_delete', { ref: 's0/p0' }).label, '개체 지우기 제안');
  assert.equal(activityItem('propose_delete', { refs: ['s0/p0', 's0/p3'] }).label, '개체 지우기 제안 2곳');
  const p = { pid: 3, type: 'delete', by: author, status: 'pending', ref: 's0/p0', delete: { what: 'objects', count: 257, names: [{ name: '글상자', n: 206 }, { name: '사각형', n: 51 }] }, log: [] };
  assert.equal(MT.deleteSummary(p), '글상자 206개 · 사각형 51개');
  const memo = MT.renderProposalMemo(p);
  assert.match(memo, /^\[제안 3 · 개체 지우기\]/);
  assert.ok(memo.includes('이 문단의 개체 지우기: 글상자 206개 · 사각형 51개(글은 그대로)'));
  const log = MT.renderRequestMemo({ rid: 1, kind: 'instruct', by: '홍길동', proposals: [3], log: [] }, [{ ...p, rid: 1, status: 'applied' }]);
  assert.ok(log.includes(' · 개체 지우기: 글상자 206개 · 사각형 51개'), log);
});

/** MCP 도구 한 번 → 결과 JSON | { error } */
async function mcp(srv, name, args, { lean = false, session = 'sessD' } = {}) {
  const r = await fetch(`${srv.base}/mcp?agent=DeleteTest${lean ? '&lean=1' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('서버: propose_delete → 적용(고친 글만 — 바로 지움)·다른 제안의 중첩 주소 옮김·되돌리기, 변경 추적으로는 개체 지움 변경·거절', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const d0 = await mixedDoc();
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await d0.save()), 'mixed.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const working = async () => HwpxDoc.load(await A(`${D}/file?kind=working`));
    const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '글상자를 지워 줘', route: 'queue', target: { ref: 's0/p8' } } })).request;
    const got = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: req.rid });
    assert.match(got.howTo, /propose_delete/);
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid });

    // 같은 문단 안 다른 제안: 표 칸 '다'(n3)와 글상자 안 글(n0)
    const pc = await mcp(srv, 'propose_changes', { doc_id: doc.id, request_id: req.rid, proposals: [{ ref: 's0/p8/n3', find: '다', replace: '다다' }, { ref: 's0/p8/n0', find: '글상자 안 글', replace: '바꾼 글' }] });
    const [cellPid, boxPid] = (Array.isArray(pc) ? pc : pc.results).map((x) => x.proposal?.pid ?? x.pid);
    assert.ok(cellPid && boxPid);

    // 틀린 주소(글상자 안 문단)·개체 없는 문단·모르는 종류
    assert.match((await mcp(srv, 'propose_delete', { doc_id: doc.id, ref: 's0/p8/n0', request_id: req.rid })).error, /BAD_REF/);
    assert.match((await mcp(srv, 'propose_delete', { doc_id: doc.id, ref: 's0/p0', request_id: req.rid })).error, /NO_OBJECT/);
    assert.match((await mcp(srv, 'propose_delete', { doc_id: doc.id, ref: 's0/p8', kinds: ['memo'], request_id: req.rid })).error, /kinds|invalid|enum/i);
    // lean 연결: 영수증에 지울 개체가 실리고 complete 로 완료까지
    const del = await mcp(srv, 'propose_delete', { doc_id: doc.id, ref: 's0/p8', kinds: ['shape'], reason: '글상자 삭제', request_id: req.rid, expected_attempt: 1, complete: '글상자 지우기를 제안함.' }, { lean: true });
    assert.deepEqual([del.type, del.ref, del.status, del.completed, del.delete], ['delete', 's0/p8', 'pending', true, { what: 'objects', kinds: ['shape'], count: 1, names: [{ name: '글상자', n: 1 }] }]);
    assert.match((await mcp(srv, 'propose_delete', { doc_id: doc.id, ref: 's0/p8', kinds: ['shape'] })).error, /SAME/);
    assert.equal((await working()).ownObjects('s0/p8').length, 2, '적용 전에는 그대로');

    // 수정본 반영은 안 된다(문서에 바로 적용만)
    assert.equal((await A.res(`${D}/proposals/${del.pid}/adopt`, { method: 'POST' })).status, 400);

    // 적용(고친 글만): 바로 지움 — 변경 추적 없음, 표 칸 제안은 n2 로 옮겨 가고 글상자 안 제안은 잃는다
    const ap = await A(`${D}/proposals/${del.pid}/apply`, { method: 'POST' });
    assert.deepEqual([ap.status, ap.delete.removed], ['applied', 1]);
    let file = await working();
    assert.deepEqual(file.ownObjects('s0/p8'), [{ kind: 'table', name: '표' }]);
    assert.equal(file.changes().length, 0);
    let props = await A(`${D}/proposals`);
    assert.equal(props.find((x) => x.pid === cellPid).ref, 's0/p8/n2', '표 칸 제안 주소가 앞으로 당겨진다');
    assert.equal(props.find((x) => x.pid === boxPid).lost, true, '지운 글상자 안 제안은 잃는다');
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === req.rid);
    assert.match(memo.text, /반영 1건/);

    // 되돌리기: 지우기 직전 사본에서 개체를 다시 옮겨 오고, 주소·잃은 제안도 되돌린다
    const un = await A(`${D}/proposals/${del.pid}/undo`, { method: 'POST' });
    assert.equal(un.status, 'undone');
    file = await working();
    assert.deepEqual(file.ownObjects('s0/p8').map((o) => o.name), ['글상자', '표']);
    assert.equal(file.objectPrint('s0/p8'), d0.objectPrint('s0/p8'));
    assert.equal(file.text('s0/p8/n0', 'final'), '글상자 안 글');
    props = await A(`${D}/proposals`);
    assert.equal(props.find((x) => x.pid === cellPid).ref, 's0/p8/n3');
    assert.ok(!props.find((x) => x.pid === boxPid).lost, '되돌리면 글상자 안 제안도 되살아난다');

    // 다시 열어 적용 → 옮긴 주소의 표 칸 제안이 바른 칸('다')에 들어간다
    await A(`${D}/proposals/${del.pid}/reopen`, { method: 'POST' });
    await A(`${D}/proposals/${del.pid}/apply`, { method: 'POST' });
    const cellAp = await A(`${D}/proposals/${cellPid}/apply`, { method: 'POST' });
    assert.equal(cellAp.status, 'applied');
    file = await working();
    assert.deepEqual(nestedOf(file, 's0/p8').map((x) => x[1]), ['가', '나', '다다', '라']);
    // 지운 글상자 안 제안은 적용하면 GONE
    assert.equal((await A.res(`${D}/proposals/${boxPid}/apply`, { method: 'POST' })).status, 409);

    // 지운 뒤 문서가 바뀌었으면(표 칸 제안 적용) 그 문단 개체만 사본에서 옮겨 온다 — 이 문단은 표·글상자 차례가 바뀌어(copyObjectsFrom)
    // 중첩 주소를 믿을 수 없으므로 그 문단 안 주소를 가진 제안은 잃은 것으로(엉뚱한 칸을 고치지 않게)
    const un2 = await A(`${D}/proposals/${del.pid}/undo`, { method: 'POST' });
    assert.equal(un2.status, 'undone');
    file = await working();
    assert.deepEqual(file.ownObjects('s0/p8').map((o) => o.name).sort(), ['글상자', '표']);
    assert.deepEqual(nestedOf(file, 's0/p8').map((x) => x[1]).sort(), ['가', '글상자 안 글', '나', '다다', '라']);
    props = await A(`${D}/proposals`);
    assert.equal(props.find((x) => x.pid === cellPid).refGone, true);
    assert.equal(props.find((x) => x.pid === boxPid).lost, true);

    // 변경 추적으로: 표 지우기 → '개체 지움' 변경 1건(최종본에서 사라짐), 되돌리기 = 그 변경 거절
    await A(`${D}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
    const del2 = await A(`${D}/proposals`, { method: 'POST', body: { type: 'delete', ref: 's0/p8', delete: { kinds: ['table'] }, reason: '표 삭제' } });
    assert.deepEqual([del2.type, del2.delete.count, del2.delete.names], ['delete', 1, [{ name: '표', n: 1 }]]);
    const ap2 = await A(`${D}/proposals/${del2.pid}/apply`, { method: 'POST' });
    assert.equal(ap2.changeIds.length, 1);
    const tracked = async () => HwpxDoc.load(await A(`${D}/file?kind=tracked`));   // working 은 최종본 사본이다
    file = await tracked();
    assert.deepEqual(file.ownObjects('s0/p8'), [{ kind: 'shape', name: '글상자' }], '최종본에서 표가 사라진다');
    assert.equal(file.changes().length, 1, '개체 지움 변경 1건');
    await A(`${D}/proposals/${del2.pid}/undo`, { method: 'POST' });
    file = await tracked();
    assert.equal(file.changes().length, 0);
    // 거절은 XML 그대로 — 차례까지(위 되돌리기로 바뀐 표 → 글상자 차례)
    assert.deepEqual(file.ownObjects('s0/p8'), [{ kind: 'table', name: '표' }, { kind: 'shape', name: '글상자' }]);
  } finally { await srv.stop(); }
});
