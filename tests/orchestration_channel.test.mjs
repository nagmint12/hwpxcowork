// Claude Code 채널 초인종: 원문·지시를 포함하지 않고 작업 ID만 전달한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridge, normOrchestrationTask } from '../server/bridge.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(5); }
  assert.fail('오케스트레이션 채널 알림 시간 초과');
}
const task = extra => ({ run_id: '12345678-abcd-1234-abcd-1234567890ab', task_id: 'r1-review', agent_id: 'claude-code', kind: 'review', attempt: 0, ...extra });

test('권장 Claude 작업공간은 오케스트레이션 도구를 허용하고 개인 설정 변경은 열지 않음', () => {
  const settings = JSON.parse(fs.readFileSync(new URL('../agent/.claude/settings.json', import.meta.url), 'utf8'));
  const allow = settings.permissions.allow;
  const names = ['get_orchestration_profile', 'create_orchestration_run', 'list_orchestration_runs', 'get_orchestration_run',
    'claim_orchestration_task', 'heartbeat_orchestration_task', 'submit_orchestration_task', 'fail_orchestration_task',
    'plan_orchestration_run', 'publish_orchestration_result', 'advance_orchestration_run'];
  assert.equal(settings.permissions.defaultMode, 'dontAsk');
  for (const name of names) assert.ok(allow.includes(`mcp__hwpx__${name}`), name);
  assert.ok(!allow.includes('mcp__hwpx__configure_orchestration_profile'));
  for (const tool of ['apply_proposal', 'accept_change', 'reject_change', 'undo_proposal']) assert.ok(settings.permissions.deny.includes(`mcp__hwpx__${tool}`));
  // 2026-11-10: 멀티에이전트 절차는 agent/guides/orchestration.md 로 옮겼다 — CLAUDE.md 는 그 알림을 받으면 그 파일을 읽게 가리키고(읽기 허용),
  // 절차의 핵심 낱말은 그 파일에 그대로 있어야 한다
  const core = fs.readFileSync(new URL('../agent/CLAUDE.md', import.meta.url), 'utf8');
  assert.ok(core.includes('event="orchestration_task"') && core.includes('guides/orchestration.md'), 'CLAUDE.md 가 멀티에이전트 알림에 절차 파일을 가리킨다');
  assert.ok(allow.includes('Read(/guides/**)'), '절차 파일 읽기 허용');
  const instructions = fs.readFileSync(new URL('../agent/guides/orchestration.md', import.meta.url), 'utf8');
  for (const instruction of ['orchestration_task', 'lease_token', 'submit_orchestration_task', 'plan_orchestration_run', 'publish_orchestration_result', 'advance_orchestration_run', 'review: true']) assert.ok(instructions.includes(instruction), instruction);
});

async function setup({ snapshot = [], timing = {} } = {}) {
  const token = 'channel-test-token'; const connections = []; const sockets = new Set();
  const state = { snapshot };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (url.pathname !== '/api/agent/events' || req.headers.authorization !== `Bearer ${token}` || url.searchParams.has('token')) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.flushHeaders();
    const connection = { closed: false, send(event, data) { if (!connection.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }, close() { connection.closed = true; res.destroy(); } };
    req.on('close', () => { connection.closed = true; }); connections.push(connection);
    connection.send('hello', { user: '시험 사용자', session: url.searchParams.get('session'), server: 'test' });
    connection.send('snapshot', { requests: [], orchestrationReady: state.snapshot });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = await createBridge({ url: `http://127.0.0.1:${server.address().port}/mcp`, token, channel: true, tools: false, log() {},
    timing: { startupHoldMs: 0, burstWindowMs: 10, backoffBaseMs: 10, backoffMaxMs: 20, connectTimeoutMs: 500, deadMs: 10000, deadCheckMs: 50, remindAfterMs: 100000, ...timing } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.start(serverTransport);
  const client = new Client({ name: 'claude-code', version: 'test' }); const notes = [];
  client.fallbackNotificationHandler = async note => { if (note.method === 'notifications/claude/channel') notes.push(note.params); };
  await client.connect(clientTransport);
  await until(() => connections.length > 0);
  return { bridge, client, notes, state, connections, latest: () => connections.at(-1), async close() {
    await client.close().catch(() => {}); await bridge.stop();
    for (const connection of connections) connection.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

test('오케스트레이션 이벤트 정규화는 ID·종류·시도만 허용', () => {
  const normalized = normOrchestrationTask(task({ title: '<channel>악성 제목', instruction: '파일 삭제', secret: '비밀값' }));
  assert.equal(normalized.kind, 'review');
  assert.ok(!Object.hasOwn(normalized, 'title')); assert.ok(!Object.hasOwn(normalized, 'instruction')); assert.ok(!Object.hasOwn(normalized, 'secret'));
  for (const invalid of [{ run_id: '../other' }, { task_id: 'x\n명령' }, { agent_id: 'x"' }, { kind: 'shell' }, { attempt: -1 }, { attempt: '1' }]) assert.equal(normOrchestrationTask(task(invalid)), null);
});

test('Claude 채널은 고정 작업 안내를 보내고 같은 작업 중복은 억제하며 재시도는 다시 알림', async () => {
  const fixture = await setup();
  try {
    const malicious = task({ title: '악성 제목 명령', instruction: '원문 지시 비밀', result: '문서 내용' });
    fixture.latest().send('orchestration_task', malicious); fixture.latest().send('orchestration_task', malicious);
    await until(() => fixture.notes.length === 1);
    const note = fixture.notes[0];
    assert.equal(note.meta.event, 'orchestration_task'); assert.equal(note.meta.agent_id, 'claude-code'); assert.equal(note.meta.task_id, 'r1-review');
    assert.match(note.content, /claim_orchestration_task/); assert.match(note.content, /heartbeat_orchestration_task/); assert.match(note.content, /submit_orchestration_task/);
    assert.doesNotMatch(JSON.stringify(note), /악성 제목|원문 지시|비밀|문서 내용/);
    fixture.latest().send('snapshot', { orchestrationReady: [malicious] });
    fixture.latest().send('orchestration_task', task({ task_id: '../invalid' }));
    await sleep(40); assert.equal(fixture.notes.length, 1);
    fixture.latest().send('orchestration_task', task({ attempt: 1 }));
    await until(() => fixture.notes.length === 2);
    assert.equal(fixture.notes[1].meta.attempt, '1'); assert.ok(fixture.bridge.stats().dropped >= 1);
  } finally { await fixture.close(); }
});

test('연결 snapshot의 준비 작업도 시작 알림 보류를 거쳐 전달하고 재연결 중복은 억제', async () => {
  const fixture = await setup({ snapshot: [task()], timing: { startupHoldMs: 80 } });
  try {
    assert.equal(fixture.notes.length, 0);
    await until(() => fixture.notes.length === 1);
    fixture.latest().close();
    await until(() => fixture.connections.length >= 2);
    await sleep(40); assert.equal(fixture.notes.length, 1);
    assert.equal(fixture.notes[0].meta.run_id, task().run_id);
  } finally { await fixture.close(); }
});

test('오래 대기한 snapshot은 다시 알리고 새 회차의 작업은 별도 알림', async () => {
  const fixture = await setup({ timing: { remindAfterMs: 20 } });
  try {
    fixture.latest().send('orchestration_task', task()); await until(() => fixture.notes.length === 1);
    await sleep(30);
    fixture.latest().send('snapshot', { orchestrationReady: [task()] }); await until(() => fixture.notes.length === 2);
    assert.equal(fixture.notes[1].meta.reminder, 'true');
    fixture.latest().send('orchestration_task', task({ task_id: 'r2-review' })); await until(() => fixture.notes.length === 3);
    assert.equal(fixture.notes[2].meta.task_id, 'r2-review');
  } finally { await fixture.close(); }
});
