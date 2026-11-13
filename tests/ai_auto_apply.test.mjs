import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { startServer, uploadDoc, fixture, watchWs } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const ref = 's0/p2';
async function setup(srv, text = '반복 반복 끝') {
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  doc.mergeParagraphText(ref, text, { author: '준비' }); doc.acceptAll();
  const up = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await doc.save()));
  return { id: up.id, D: `/api/docs/${up.id}`, A: srv.api('a'), text };
}
async function mcp(srv, name, args) {
  const response = await fetch(`${srv.base}/mcp?agent=AutoApplyTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': 'auto-apply-session', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const result = JSON.parse(line ? line.slice(5) : raw).result;
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
async function request(srv, ctx, targetRef = ref) {
  const r = (await ctx.A(`${ctx.D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용을 고쳐 줘', route: 'queue', target: { ref: targetRef } } })).request;
  await mcp(srv, 'start_request', { doc_id: ctx.id, request_id: r.rid });
  return r;
}
const working = async (ctx) => HwpxDoc.load(await ctx.A(`${ctx.D}/file?kind=working`));
const complete = (srv, ctx, r) => mcp(srv, 'complete_request', { doc_id: ctx.id, request_id: r.rid, expected_attempt: 1, summary: '내용을 수정했습니다.' });

test('자동 반영 설정: 기본 수동·설정 권한·값 검증·저장 후 다시 읽기', async () => {
  const srv = await startServer();
  try {
    const c = await setup(srv);
    assert.equal((await c.A(c.D)).settings.aiApply, 'manual');
    assert.equal((await srv.api('b').res(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } })).status, 403);
    assert.equal((await c.A.res(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: true } })).status, 400);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    assert.equal((await c.A(c.D)).settings.aiApply, 'auto');
    // 옵션을 켜도 기존 대기 제안이나 사람이 만든 제안을 소급 적용하지 않는다.
    const p = await c.A(`${c.D}/proposals`, { method: 'POST', body: { ref, find: '끝', replace: '마침' } });
    assert.equal(p.status, 'pending');
    assert.equal((await working(c)).text(ref, 'final'), c.text);
  } finally { await srv.stop(); }
});

test('MCP 작업 완료 시 같은 원문의 반복 구절도 등록 순서로 자동 반영·알림·재완료 멱등성·되돌리기', async () => {
  const srv = await startServer(); let ws;
  try {
    const c = await setup(srv);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c);
    const p = await mcp(srv, 'propose_changes', { doc_id: c.id, request_id: r.rid, proposals: [
      { ref, find: '반복', replace: '첫째', occurrence: 1 }, { ref, find: '반복', replace: '둘째', occurrence: 2 },
    ] });
    assert.equal((await working(c)).text(ref, 'final'), c.text, 'AI가 결과를 만드는 중에는 원문 유지');
    ws = watchWs(srv.base, srv.tokens.a, c.id); await ws.ready;
    await complete(srv, c, r);
    assert.equal((await working(c)).text(ref, 'final'), '첫째 둘째 끝');
    const props = await c.A(`${c.D}/proposals`);
    assert.equal(props.length, 2); assert.ok(props.every((p) => p.status === 'applied' && p.autoApplied));
    const changed = await ws.waitFor((m) => m.type === 'doc' && m.action === 'changed');
    assert.ok(changed.changed.includes(ref)); assert.equal(changed.formatting, undefined, '글은 부분 동기화');
    const version = (await c.A(c.D)).version;
    await complete(srv, c, r); assert.equal((await c.A(c.D)).version, version);
    assert.ok(p);
    for (const proposal of props) await c.A(`${c.D}/proposals/${proposal.pid}/undo`, { method: 'POST' });
    assert.equal((await working(c)).text(ref, 'final'), c.text);
  } finally { ws?.close(); await srv.stop(); }
});

test('수동 설정·에이전트 반영 금지·승인 방식은 자동 반영 권한을 넘지 않는다', async () => {
  for (const { config, auto } of [
    { config: {}, auto: false },
    { config: { allowAgentApply: false }, auto: true },
    { config: { documents: { defaultEditMode: 'review' } }, auto: true },
  ]) {
    const srv = await startServer({ config });
    try {
      const c = await setup(srv);
      if (auto) await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
      const r = await request(srv, c);
      await mcp(srv, 'propose_change', { doc_id: c.id, request_id: r.rid, ref, find: '끝', replace: '마침' });
      await complete(srv, c, r);
      assert.equal((await c.A(`${c.D}/proposals`))[0].status, 'pending');
      assert.equal((await working(c)).text(ref, 'final'), c.text);
    } finally { await srv.stop(); }
  }
});

test('자동 반영을 껐거나 권한을 잃은 진행 중 작업·취소된 작업은 원문을 바꾸지 않는다', async () => {
  const srv = await startServer();
  try {
    for (const patch of [{ aiApply: 'manual' }, { editors: [] }]) {
      const c = await setup(srv);
      await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
      const r = await request(srv, c);
      await mcp(srv, 'propose_change', { doc_id: c.id, request_id: r.rid, ref, find: '끝', replace: '마침' });
      await c.A(`${c.D}/settings`, { method: 'PATCH', body: patch });
      await complete(srv, c, r);
      assert.equal((await working(c)).text(ref, 'final'), c.text);
    }
    const c = await setup(srv);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c);
    await mcp(srv, 'propose_change', { doc_id: c.id, request_id: r.rid, ref, find: '끝', replace: '마침' });
    await c.A(`${c.D}/requests/${r.rid}/cancel`, { method: 'POST' });
    await assert.rejects(complete(srv, c, r), /REQUEST_CLOSED|ATTEMPT_CHANGED/);
    assert.equal((await working(c)).text(ref, 'final'), c.text);
  } finally { await srv.stop(); }
});

test('여러 비교안은 자동 선택하지 않고, 요청 없는 AI 권장안은 즉시 자동 반영한다', async () => {
  const srv = await startServer();
  try {
    const c = await setup(srv);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c);
    await mcp(srv, 'propose_alternatives', { doc_id: c.id, request_id: r.rid, ref, find: '끝', options: [{ text: '마침' }, { text: '종료' }] });
    await complete(srv, c, r);
    assert.ok((await c.A(`${c.D}/proposals`)).every((p) => p.status === 'pending'));
    const p = await mcp(srv, 'propose_change', { doc_id: c.id, ref, find: '끝', replace: '마침' });
    assert.equal(p.status, 'applied'); assert.equal(p.autoApplied, true);
    assert.equal((await working(c)).text(ref, 'final'), '반복 반복 마침');
  } finally { await srv.stop(); }
});

test('그림 교체 자동 반영·되돌리기는 텍스트와 별도로 formatVersion·WS 갱신 알림을 남긴다', async () => {
  const srv = await startServer(); let ws;
  try {
    const c = await setup(srv);
    const original = await c.A(`${c.D}/proposals`, { method: 'POST', body: { type: 'figure', afterRef: 's0/p0', imageBase64: makePng(400, 200).toString('base64'), fileName: 'original.png' } });
    await c.A(`${c.D}/proposals/${original.pid}/apply`, { method: 'POST' });
    const figure = (await working(c)).figures()[0];
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c, figure.ref);
    const p = await mcp(srv, 'propose_figure', { doc_id: c.id, request_id: r.rid, replace_ref: figure.ref, image_base64: makePng(800, 600).toString('base64'), file_name: 'replacement.png' });
    ws = watchWs(srv.base, srv.tokens.a, c.id); await ws.ready;
    await complete(srv, c, r);
    const info = await c.A(c.D);
    const applied = (await c.A(`${c.D}/proposals`)).find((x) => x.pid === p.pid);
    assert.equal(applied.status, 'applied'); assert.notEqual(applied.binId, figure.binId);
    assert.equal(info.formatVersion, info.version);
    const event = await ws.waitFor((m) => m.type === 'doc' && m.formatting && m.version === info.version);
    assert.equal(event.formatVersion, info.version); assert.ok(event.changed.includes(figure.ref));
    assert.equal((await working(c)).figures()[0].binId, applied.binId);
    await c.A(`${c.D}/proposals/${p.pid}/undo`, { method: 'POST' });
    const undoInfo = await c.A(c.D);
    assert.equal(undoInfo.formatVersion, undoInfo.version);
    await ws.waitFor((m) => m.type === 'doc' && m.formatting && m.version === undoInfo.version);
    assert.equal((await working(c)).figures()[0].binId, figure.binId);
  } finally { ws?.close(); await srv.stop(); }
});

test('서버 모의 AI도 완료 시 권장안을 자동 반영한다', async () => {
  const srv = await startServer({ ai: 'mock' });
  try {
    const c = await setup(srv, '문장을 확인합니다.');
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const result = await c.A(`${c.D}/requests`, { method: 'POST', body: { kind: 'suggest', route: 'server', target: { ref } } });
    assert.ok(result.request);
    const props = await c.A(`${c.D}/proposals`);
    assert.ok(props.length > 0); assert.ok(props.every((p) => p.status === 'applied' && p.autoApplied));
    assert.notEqual((await working(c)).text(ref, 'final'), c.text);
  } finally { await srv.stop(); }
});

test('서식·문단·표를 한 작업에서 자동 반영하고 구조 변경 후에도 원래 서식 대상을 지킨다', async () => {
  const srv = await startServer();
  try {
    const c = await setup(srv);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c);
    await mcp(srv, 'propose_format', { doc_id: c.id, request_id: r.rid, ref, find: '끝', format: { char: { bold: true } } });
    await mcp(srv, 'propose_insert', { doc_id: c.id, request_id: r.rid, after_ref: ref, text: '자동으로 추가한 문단' });
    await mcp(srv, 'propose_table', { doc_id: c.id, request_id: r.rid, after_ref: 's0/p0', rows: [['항목', '값'], ['시험', '1']] });
    await complete(srv, c, r);
    const proposals = await c.A(`${c.D}/proposals`);
    assert.equal(proposals.length, 3); assert.ok(proposals.every((p) => p.status === 'applied' && p.autoApplied));
    const doc = await working(c);
    const formatted = proposals.find((p) => p.type === 'format');
    assert.equal(doc.text(formatted.ref, 'final'), c.text);
    assert.ok(doc.inspectFormatting(formatted.ref).runs.some((run) => run.text.includes('끝') && run.char.bold));
    assert.equal(doc.text(proposals.find((p) => p.type === 'insert').insertedRef, 'final'), '자동으로 추가한 문단');
    assert.ok(doc.tables().some((table) => table.ref === proposals.find((p) => p.type === 'table').insertedRef));
  } finally { await srv.stop(); }
});

test('원문이 바뀐 제안은 오류 기록과 함께 대기하고 나머지 결과는 자동 반영한다', async () => {
  const srv = await startServer();
  try {
    const c = await setup(srv);
    await c.A(`${c.D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r = await request(srv, c);
    const stale = await mcp(srv, 'propose_change', { doc_id: c.id, request_id: r.rid, ref, find: '끝', replace: '마침' });
    await mcp(srv, 'propose_insert', { doc_id: c.id, request_id: r.rid, after_ref: 's0/p0', text: '유효한 새 문단' });
    const human = await c.A(`${c.D}/proposals`, { method: 'POST', body: { ref, find: '끝', replace: '사람이 수정함', applyNow: true } });
    assert.equal(human.status, 'applied');
    await complete(srv, c, r);
    const proposals = await c.A(`${c.D}/proposals`);
    const pending = proposals.find((p) => p.pid === stale.pid);
    assert.equal(pending.status, 'pending'); assert.ok(pending.autoApplyError?.code);
    assert.ok(proposals.some((p) => p.type === 'insert' && p.autoApplied));
    assert.equal((await working(c)).text(pending.ref, 'final'), '반복 반복 사람이 수정함');
  } finally { await srv.stop(); }
});
