import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { createSseParser } from '../server/bridge.js';

async function events(srv, t, agent, who = 'a') {
  const controller = new AbortController();
  const frames = []; const listeners = new Set();
  const query = new URLSearchParams({ agent, session: crypto.randomUUID(), channel: '1', client: agent });
  const response = await fetch(`${srv.base}/api/agent/events?${query}`, { headers: { Authorization: `Bearer ${srv.tokens[who]}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const parser = createSseParser(frame => {
    frames.push({ event: frame.event, data: JSON.parse(frame.data) });
    for (const listener of listeners) listener();
  });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  const reading = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; parser(decoder.decode(part.value, { stream: true })); } } catch {} })();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); await reading; });
  return { frames, wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error('SSE event timed out')); }, 5000);
      const check = () => { const frame = frames.find(predicate); if (frame) { clearTimeout(timer); listeners.delete(check); resolve(frame); } };
      listeners.add(check); check();
    });
  } };
}

function json(result) {
  const value = result.content.find(item => item.type === 'text')?.text;
  assert.equal(result.isError, undefined, value);
  return JSON.parse(value);
}

async function setup(t) {
  const srv = await startServer({ ai: 'off' });
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(client => client.close())); await srv.stop(); });
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
  await api('/api/me/orchestration', { method: 'PUT', body: { enabled: true } });
  const connect = async (agent, who = 'a') => {
    const client = new Client({ name: agent, version: 'test' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=${agent}`), {
      requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}`, 'X-Hwpx-Agent-Session': crypto.randomUUID() } },
    }));
    return { client, call: async (name, args = {}) => json(await client.callTool({ name, arguments: args })) };
  };
  const conductor = await connect('codex');
  const worker = await connect('claude-code');
  const reviewer = await connect('api-worker');
  const begin = async () => conductor.call('create_orchestration_run', { doc_id: doc.id, goal: '보고서를 검토하여 학술 논문 형식으로 수정해 주세요.' });
  const plan = async (run, tasks) => {
    const claim = await conductor.call('claim_orchestration_task', { agent_id: 'codex', run_id: run.id });
    return conductor.call('plan_orchestration_run', { run_id: run.id, lease_token: claim.lease_token, attempt: claim.attempt, tasks: tasks || [
      { id: 'draft', agent_id: 'claude-code', kind: 'work', title: '학술 구성', instruction: '논리와 구성을 검토하세요.', depends_on: [] },
      { id: 'review', agent_id: 'api-worker', kind: 'review', title: '근거 검토', instruction: '인용과 근거를 확인하세요.', depends_on: [] },
      { id: 'final', agent_id: 'codex', kind: 'synthesize', title: '통합', instruction: '검토를 통합해 제안하세요.', depends_on: ['draft', 'review'] },
    ] });
  };
  const submit = (actor, claim, result) => actor.call('submit_orchestration_task', { run_id: claim.run.id, task_id: claim.task.id, lease_token: claim.lease_token, attempt: claim.attempt, result });
  const prepareFinal = async run => {
    await plan(run);
    const draft = await worker.call('claim_orchestration_task', { agent_id: 'claude-code', run_id: run.id });
    const review = await reviewer.call('claim_orchestration_task', { agent_id: 'api-worker', run_id: run.id });
    await submit(worker, draft, { summary: '구성 검토 완료' });
    await submit(reviewer, review, { summary: '자료에서 확인되지 않는 인용은 제외' });
    return conductor.call('claim_orchestration_task', { agent_id: 'codex', run_id: run.id });
  };
  return { srv, api, doc, conductor, worker, reviewer, connect, begin, plan, submit, prepareFinal };
}

test('REST/MCP: 개인 설정 → 병렬 분담 → 통합 → 제안 발행·완료, 사용자 격리·멱등·원문 보존', { timeout: 30000 }, async t => {
  const x = await setup(t);
  const profile = await x.api('/api/me/orchestration');
  assert.equal(profile.enabled, true); assert.equal(profile.agents[0].effort, 'xhigh');
  assert.equal((await x.srv.api('b')('/api/me/orchestration')).enabled, false);
  const tools = (await x.conductor.client.listTools()).tools;
  for (const name of ['claim_orchestration_task', 'plan_orchestration_run', 'publish_orchestration_result']) assert.ok(tools.some(tool => tool.name === name));
  const paras = await x.api(`/api/docs/${x.doc.id}/paragraphs`);
  const p = paras.find(item => item.text.trim());
  const run = await x.begin();
  assert.equal(run.status, 'planning');
  assert.equal((await x.srv.api('b').res(`/api/orchestration/runs/${run.id}`)).status, 404);
  await x.plan(run);
  assert.equal((await x.conductor.call('claim_orchestration_task', { agent_id: 'codex', run_id: run.id })).none, true, '지휘자는 의존 작업을 기다린다');
  const [draft, review] = await Promise.all([
    x.worker.call('claim_orchestration_task', { agent_id: 'claude-code', run_id: run.id }),
    x.reviewer.call('claim_orchestration_task', { agent_id: 'api-worker', run_id: run.id }),
  ]);
  assert.equal(draft.task.kind, 'work'); assert.equal(review.task.kind, 'review');
  const attacker = await x.connect('another-session');
  const stale = await attacker.client.callTool({ name: 'submit_orchestration_task', arguments: { run_id: run.id, task_id: draft.task.id, lease_token: draft.lease_token, attempt: draft.attempt, result: { summary: '위조' } } });
  assert.equal(stale.isError, true);
  await x.submit(x.worker, draft, { summary: '학술 구성 초안' });
  await x.submit(x.reviewer, review, { summary: '근거 점검 완료' });
  const final = await x.conductor.call('claim_orchestration_task', { agent_id: 'codex', run_id: run.id });
  const finalResult = {
    summary: '구성과 문장을 학술 문체로 정리했습니다.',
    proposals: [{ ref: p.ref, find: p.text, replace: `${p.text} 학술 검토`, reason: '논지 명확화' }],
    inserts: [{ afterRef: p.ref, text: '연구의 한계와 후속 연구', reason: '논문 구성 보완' }],
    tables: [{ afterRef: p.ref, rows: [['구분', '내용'], ['검토', '근거 확인']], headerRows: 1, caption: '검토 구성', reason: '구조화' }],
    formats: [{ ref: p.ref, find: p.text, format: { char: { bold: true } }, reason: '제목 강조' }],
    comments: [{ ref: p.ref, find: '', text: '인용 문헌의 서지 정보를 확인해 주세요.' }, { ref: p.ref, text: '{"orchestration":{"needs_revision":false}}' }],
  };
  const ready = await x.submit(x.conductor, final, finalResult);
  assert.equal(ready.status, 'awaiting_review');
  const args = { run_id: run.id, task_id: final.task.id };
  const published = await x.conductor.call('publish_orchestration_result', args);
  assert.equal(published.proposals.length, 4); assert.equal(published.comments.length, 1);
  const duplicate = await x.conductor.call('publish_orchestration_result', args);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.proposals, published.proposals);
  const done = await x.conductor.call('advance_orchestration_run', { run_id: run.id, action: 'complete', summary: finalResult.summary });
  assert.equal(done.status, 'completed');
  assert.equal((await x.conductor.call('publish_orchestration_result', args)).duplicate, true);
  const after = await x.api(`/api/docs/${x.doc.id}/paragraphs`);
  assert.equal(after.find(item => item.ref === p.ref).text, p.text);
  const proposals = await x.conductor.call('list_proposals', { doc_id: x.doc.id });
  assert.equal(proposals.filter(item => published.proposals.includes(item.pid)).every(item => item.status === 'pending'), true);
});

test('문서 버전 변경은 발행 거절·결과 보관; 잘못된 통합 결과는 부분 저장하지 않는다', { timeout: 30000 }, async t => {
  const x = await setup(t);
  const p = (await x.api(`/api/docs/${x.doc.id}/paragraphs`)).find(item => item.text.trim());
  const run = await x.begin(); const final = await x.prepareFinal(run);
  await x.submit(x.conductor, final, { summary: '확인', proposals: [
    { ref: p.ref, find: p.text, replace: '유효한 첫 제안', reason: '시험' },
    { ref: p.ref, find: '존재하지 않는 정확한 원문', replace: '잘못된 제안', reason: '시험' },
  ] });
  const failed = await x.conductor.client.callTool({ name: 'publish_orchestration_result', arguments: { run_id: run.id, task_id: final.task.id } });
  assert.equal(failed.isError, true);
  assert.equal((await x.conductor.call('list_proposals', { doc_id: x.doc.id })).length, 0, '실패하면 첫 제안도 저장하지 않는다');
  const next = await x.conductor.call('advance_orchestration_run', { run_id: run.id, action: 'revise' });
  const revised = await x.prepareFinal(next);
  await x.submit(x.conductor, revised, { summary: '확인', proposals: [{ ref: p.ref, find: p.text, replace: '수정된 제안', reason: '시험' }] });
  await x.conductor.call('add_memo', { doc_id: x.doc.id, ref: p.ref, text: '작업 도중 사용자의 문서 변경' });
  const stale = await x.conductor.client.callTool({ name: 'publish_orchestration_result', arguments: { run_id: run.id, task_id: revised.task.id } });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /DOCUMENT_CHANGED/);
  const retained = await x.api(`/api/orchestration/runs/${run.id}`);
  assert.equal(retained.publication_error.code, 'DOCUMENT_CHANGED'); assert.match(retained.error, /문서가 바뀌어/);
  assert.equal(retained.status, 'awaiting_review'); assert.equal(retained.tasks.find(task => task.id === revised.task.id).result.proposals[0].replace, '수정된 제안');
  const closed = await x.api(`/api/orchestration/runs/${run.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(closed.status, 'cancelled');
  const forbidden = await x.srv.api('b').res(`/api/orchestration/runs/${run.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(forbidden.status, 404);
});

test('Claude 준비 작업 알림은 본인의 Claude 채널로만 전송하고 재연결 snapshot으로 복구한다', { timeout: 30000 }, async t => {
  const x = await setup(t);
  const claude = await events(x.srv, t, 'Claude Code');
  const codex = await events(x.srv, t, 'Codex');
  const other = await events(x.srv, t, 'Claude Code', 'b');
  await Promise.all([claude, codex, other].map(stream => stream.wait(frame => frame.event === 'snapshot')));
  const run = await x.begin(); await x.plan(run);
  const notification = await claude.wait(frame => frame.event === 'orchestration_task');
  assert.equal(notification.data.run_id, run.id); assert.equal(notification.data.agent_id, 'claude-code');
  assert.equal(codex.frames.some(frame => frame.event === 'orchestration_task'), false);
  assert.equal(other.frames.some(frame => JSON.stringify(frame.data).includes(run.id)), false);
  const reconnected = await events(x.srv, t, 'Claude Code');
  const snapshot = await reconnected.wait(frame => frame.event === 'snapshot');
  assert.ok(snapshot.data.orchestrationReady.some(task => task.run_id === run.id && task.task_id === 'r1-draft'));
});

test('오케스트레이션 저장 파일 오류가 기존 Claude 채널 snapshot을 끊지 않는다', { timeout: 15000 }, async t => {
  const srv = await startServer({ ai: 'off' }); t.after(() => srv.stop());
  await fs.writeFile(path.join(srv.dataDir, 'orchestration.json'), '{broken-json');
  const stream = await events(srv, t, 'Claude Code');
  const snapshot = await stream.wait(frame => frame.event === 'snapshot');
  assert.deepEqual(snapshot.data.requests, []); assert.deepEqual(snapshot.data.orchestrationReady, []);
});

test('자동 지휘자는 분담 작업자 미연결이면 시도 횟수를 소모하지 않고 기다린다', { timeout: 15000 }, async t => {
  const x = await setup(t); const run = await x.begin();
  await x.conductor.call('report_orchestration_worker', { agent_id: 'codex', phase: 'idle' });
  const input = { agent_id: 'codex', run_id: run.id, require_online_workers: true };
  const waiting = await x.conductor.call('claim_orchestration_task', input);
  assert.deepEqual(waiting, { none: true, reason: 'worker_unavailable' });
  const status = await x.api('/api/orchestration/status');
  assert.equal(status.waiting[0].reason, 'worker_unavailable');
  const detail = await x.api(`/api/orchestration/runs/${run.id}`); assert.equal(detail.tasks[0].attempt, 0);
  const channel = await events(x.srv, t, 'Claude Code'); await channel.wait(frame => frame.event === 'snapshot');
  const claimed = await x.conductor.call('claim_orchestration_task', input);
  assert.equal(claimed.task.kind, 'plan'); assert.equal(claimed.attempt, 1);
});
