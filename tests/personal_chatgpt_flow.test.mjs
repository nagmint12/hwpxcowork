// 실제 모델·로그인 파일 없이 웹 요청 → 개인 CLI → HWPX 결과 저장을 통합 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProposer } from '../server/codex-ai.js';
import { createApiWorker } from '../server/worker.js';
import { checkWorkerConnection } from '../scripts/ai-worker.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { makePng } from './helpers/image.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(20); }
  assert.fail(message);
}

test('개인 ChatGPT: 요청 클릭으로 CLI 응답을 저장하고 로그인 끊김 뒤 남은 대기열을 보존', { timeout: 30000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-personal-flow-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const paragraphs = await api(`${route}/paragraphs`);
    const target = paragraphs.find(p => p.ref === 's0/p1'); assert.ok(target?.text);
    const original = paragraphs.map(p => p.text);
    const auth = path.join(temp, 'fake-auth-state.txt');
    const receipt = path.join(temp, 'fake-exec-receipt.json');
    await fs.writeFile(auth, 'ready');
    const reply = { proposals: [{ ref: target.ref, find: target.text, replace: `${target.text} 자동 검토`, reason: '표현을 명확하게 함' }], alternatives: [],
      comments: [{ ref: target.ref, find: '', text: '자동 검토 의견입니다.' }], inserts: [], tables: [], summary: '표현 보완안과 확인 의견을 남겼습니다.', instructionSummary: '표현 검토' };
    const launch = await fakeCodex(temp, { mode: 'mcp', auth, receipt });
    const ai = new CodexProposer({ model: 'fake-approved-model' }, {
      tempRoot: temp, env: { ...process.env, HWPX_COWORK_TOKEN: srv.tokens.a },
      resolveCommand: async () => launch,
    });
    assert.equal((await ai.check()).ready, true);
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, agent: 'ChatGPT (Codex)', clientName: 'hwpx-codex-worker',
      timing: { pollMs: 80, connectTimeoutMs: 3000, callTimeoutMs: 5000, backoffMs: 30, maxBackoffMs: 60, deadMs: 5000 }, log() {} });
    assert.equal((await checkWorkerConnection(worker)).toolsReady, true);
    assert.equal((await api('/api/automation/status')).channels.online, false, 'preflight는 실행 중인 연결로 표시하지 않음');
    worker.start();
    await until(async () => (await api('/api/automation/status')).channels.online, '개인 실행기가 연결되지 않음');
    const create = instruction => api(`${route}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: target.ref }, instruction, route: 'auto' } });
    const first = (await create('문장 표현을 검토해 주세요.')).request;
    assert.equal(first.route, 'agent', '웹의 자동 경로가 개인 실행기로 전달');
    await until(() => worker.stats().completed === 1, 'CLI 결과가 완료 상태로 돌아오지 않음');
    const completed = await api(`${route}/requests/${first.rid}`);
    assert.equal(completed.status, 'done'); assert.equal(completed.summary, reply.summary);
    assert.equal(completed.execution, 'tool-agent'); assert.equal(completed.model, 'fake-approved-model');
    assert.equal(completed.usage.input, 200); assert.equal(completed.usage.output, 20);
    assert.equal(completed.usage.modelCallsUnknown, true); assert.equal(completed.usage.modelCalls, 0);
    const proposals = await api(`${route}/proposals`);
    assert.equal(proposals.length, 1); assert.equal(proposals[0].rid, first.rid); assert.equal(proposals[0].status, 'pending');
    const memos = await api(`${route}/memos`);
    assert.ok(memos.some(m => m.link?.rid === first.rid && m.body === reply.comments[0].text));
    assert.deepEqual((await api(`${route}/paragraphs`)).map(p => p.text), original, '결과는 제안·의견으로 저장하고 본문은 유지');
    const subprocess = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(subprocess.env.HWPX_COWORK_TOKEN, srv.tokens.a);
    assert.ok(subprocess.prompt.includes('문장 표현을 검토해 주세요'), '실제 지시 전문을 최초 stdin에도 전달한다');
    assert.equal(subprocess.requestContext.instruction, subprocess.request.instruction);
    assert.equal(subprocess.request.instruction, '문장 표현을 검토해 주세요.', 'Codex가 MCP에서 원문을 읽었다');
    assert.ok(subprocess.document.length); assert.ok(subprocess.guide.length);
    assert.match(subprocess.instructions, /복합 요청/);
    assert.equal(completed.usage.toolCalls, subprocess.toolCount);
    await assert.rejects(fs.stat(subprocess.cwd), { code: 'ENOENT' });
    await fs.writeFile(auth, 'logout');
    const failed = (await create('다음 요청입니다.')).request;
    const remaining = (await create('로그인 복구 뒤 처리할 요청입니다.')).request;
    await until(() => worker.stats().failed === 1 && worker.stopped && !worker.stats().active, '로그인 실패 뒤 실행기가 중지되지 않음');
    await until(async () => !(await api('/api/automation/status')).channels.online, '중지된 실행기의 연결 표시가 남아 있음');
    assert.equal((await api(`${route}/requests/${failed.rid}`)).status, 'failed');
    const pending = await api(`${route}/requests/${remaining.rid}`);
    assert.equal(pending.status, 'pending'); assert.equal(pending.claim, null);
    assert.equal((await api(`${route}/proposals`)).length, 1, '로그인 끊김 뒤 새 결과를 쓰지 않음');
  } finally {
    await worker?.stop();
    await srv.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^hwpx-personal-flow-/);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Codex 직접 MCP: 메모 답장 원문·셀 합치기·서식·그림 원본 다운로드와 교체 제안을 끝까지 처리', { timeout: 30000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-personal-flow-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const source = await HwpxDoc.load(await fs.readFile(fixture('tool_memo_tracked.hwpx')));
    for (let i = 0; i < 40; i++) source.insertParagraphAfter(0, 0, `전체 문서 근거 ${i}: ${'문맥 보존 자료입니다. '.repeat(25)}`, { author: '시험' });
    source.insertTableAfter(0, 0, { rows: [['항목', '점수'], ['만족도', '4.0']], headerRows: 1, caption: '시험 표' }, { author: '시험' });
    source.insertPictureAfter(0, 0, { data: makePng(100, 60), caption: '시험 그림' }, { author: '시험' });
    source.acceptAll();
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()));
    const api = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const paragraphs = await api(`${D}/paragraphs`);
    const tableRef = source.tables()[0].cells[0].refs[0];
    const target = paragraphs.find(p => p.ref === tableRef); assert.ok(target, tableRef);
    const memo = await api(`${D}/memos`, { method: 'POST', body: { ref: target.ref, text: '근거로 [표 1]을 함께 제시해 주세요.' } });
    const requested = await api(`${D}/memos/${memo.id}/ask-ai`, { method: 'POST', body: { text: '이 메모대로 문장을 고치고 표 셀 합치기, 강조와 그림 교체를 제안해 줘.', route: 'queue' } });
    const receipt = path.join(temp, 'receipt.json');
    const launch = await fakeCodex(temp, { mode: 'features', receipt });
    const ai = new CodexProposer({}, { tempRoot: temp, resolveCommand: async () => launch });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, timing: { pollMs: 80 }, log() {} });
    worker.start();
    await until(() => worker.stats().completed || worker.stats().failed, 'MCP 작업이 끝나지 않음', 20000);
    const diagnostic = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(worker.stats().failed, 0, JSON.stringify({ error: diagnostic.error, target: diagnostic.request?.target, tables: diagnostic.request?.tables, originalTarget: target.ref }));
    const r = await api(`${D}/requests/${requested.request.rid}`); assert.equal(r.status, 'done');
    const props = (await api(`${D}/proposals`)).filter(p => p.rid === r.rid);
    assert.deepEqual(props.map(p => p.type).sort(), ['replace', 'table_edit', 'format', 'figure'].sort());
    assert.ok(props.every(p => p.status === 'pending'), '모델은 본문 반영 없이 제안만 등록');
    assert.equal(props.find(p => p.type === 'table_edit').tableEdit.ops[0].op, 'merge');
    const figure = props.find(p => p.type === 'figure'); assert.ok(figure.figure.replace.binId);
    const state = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(state.request.followUp.memoText, '근거로 [표 1]을 함께 제시해 주세요.');
    // 필요한 만큼만(2026-11-05): 대상과 앞뒤 문단만 — 먼 문단은 read_document(from/to)로. 서식 낱말 없는 지시는 스타일 이름만(get_formatting(refs))
    const ctxChars = state.request.contextItems.reduce((sum, p) => sum + p.text.length, 0);
    assert.ok(ctxChars < 10000, `대상 주변 문단만: ${ctxChars}자`);
    assert.ok(!(state.request.contextItems.some(p => p.text.includes('전체 문서 근거 0:')) && state.request.contextItems.some(p => p.text.includes('전체 문서 근거 39:'))), '문서 전체를 싣지 않는다');
    assert.deepEqual(state.requestContext.contextItems, state.request.contextItems, 'stdin 자료 = get_request 결과');
    assert.ok(state.request.formattingHeader?.lean && !('rawHeaderXml' in state.request.formattingHeader), '서식은 필요할 때 get_formatting(refs)');
    assert.ok(state.tools.includes('propose_table_edit') && state.tools.includes('upload_result_file'));
    assert.ok(state.tools.includes('propose_page_layout') && state.tools.includes('get_formatting'));
    assert.equal(r.usage.input, 200); assert.equal(r.usage.toolCalls, state.toolCount);
    assert.equal(r.usage.modelCallsUnknown, true); assert.equal(r.execution, 'tool-agent');
    await assert.rejects(fs.stat(state.cwd), { code: 'ENOENT' });
  } finally {
    await worker?.stop(); await srv.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^hwpx-personal-flow-/);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('직접 MCP 실행은 최종 답변만으로 완료하지 않고 서버 완료 직후 CLI 오류도 성공을 덮지 않는다', { timeout: 15000 }, async () => {
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a'); const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const D = `/api/docs/${doc.id}`; let registered = false;
    const ai = { async runMcp(job) {
      if (registered) {
        await worker.callJson('complete_request', { doc_id: doc.id, request_id: job.requestId, expected_attempt: job.attempt, summary: '문서 변경 없음', no_changes_reason: '이 회귀에서는 검토 결과 변경할 필요가 없음을 확인했다.' });
        throw Object.assign(new Error('CLI closed after successful MCP completion'), { code: 'CODEX_FAILED' });
      }
      return { summary: '답변에만 완료라고 써도 완료되지 않음' };
    } };
    worker = createApiWorker({ url: srv.base + '/mcp', token: srv.tokens.a, ai, log() {} });
    const create = async () => (await api(`${D}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p1' } } })).request;
    const first = await create(); await worker.process(await worker.callJson('claim_next_request', { doc_id: doc.id }));
    assert.equal((await api(`${D}/requests/${first.rid}`)).status, 'failed'); assert.equal(worker.stats().failed, 1);
    registered = true;
    const second = await create(); await worker.process(await worker.callJson('claim_next_request', { doc_id: doc.id }));
    assert.equal((await api(`${D}/requests/${second.rid}`)).status, 'done'); assert.equal(worker.stats().completed, 1);
    assert.equal(worker.stats().failed, 1);
  } finally { await worker?.stop(); await srv.stop(); }
});


test('native CLI가 완료 등록 뒤 실패해도 공개 이벤트 usage/model은 원요청에 보존한다', { timeout: 15000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-personal-flow-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a'); const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const D = `/api/docs/${doc.id}`;
    const launch = await fakeCodex(temp, { mode: 'mcp-fail-after' });
    const ai = new CodexProposer({ model: 'verified-native-model' }, { tempRoot: temp, resolveCommand: async () => launch });
    worker = createApiWorker({ url: srv.base + '/mcp', token: srv.tokens.a, ai, log() {} });
    const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p1' } } })).request;
    await worker.process(await worker.callJson('claim_next_request', { doc_id: doc.id }));
    const done = await api(`${D}/requests/${req.rid}`);
    assert.equal(done.status, 'done'); assert.equal(worker.stats().completed, 1); assert.equal(worker.stats().failed, 0);
    assert.equal(done.model, 'verified-native-model'); assert.equal(done.execution, 'tool-agent');
    assert.equal(done.usage.input, 200); assert.equal(done.usage.output, 20); assert.equal(done.usage.modelCallsUnknown, true);
    assert.ok(done.usage.toolCalls >= 5);
  } finally {
    await worker?.stop(); await srv.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^hwpx-personal-flow-/);
    await fs.rm(temp, { recursive: true, force: true });
  }
});


test('native 완료·실패 후 사용량 보충은 문서 bytes·버전·메모·완료기록을 다시 만들지 않는다', { timeout: 15000 }, async () => {
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a'); const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const D = `/api/docs/${doc.id}`;
    const fileBytes = async () => {
      const response = await fetch(`${srv.base}${D}/file`, { headers: { Authorization: `Bearer ${srv.tokens.a}` } });
      assert.ok(response.ok); return Buffer.from(await response.arrayBuffer());
    };
    let snapshot; let finishTool; let taskError;
    const usage = { input: 321, output: 45, toolCalls: 4, modelCalls: 0, modelCallsUnknown: true, unknownModelTasks: 1 };
    const ai = { async runMcp(job) { try {
      await worker.callJson(finishTool, { doc_id: doc.id, request_id: job.requestId, expected_attempt: job.attempt,
        ...(finishTool === 'complete_request' ? { summary: '문서 변경 없음', no_changes_reason: '메타데이터 보충 회귀의 변경 불필요 검토' } : { error: '실행 중 제공자 오류' }) });
      snapshot = { bytes: await fileBytes(), history: await api(`${D}/history`), memos: await api(`${D}/memos`), request: await api(`${D}/requests/${job.requestId}`) };
      return { directMcp: true, usage, model: 'native-measured-model', execution: 'tool-agent' };
    } catch(e) { taskError = e; throw e; } } };
    worker = createApiWorker({ url: srv.base + '/mcp', token: srv.tokens.a, ai, log() {} });
    for (finishTool of ['complete_request', 'fail_request']) {
      const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p1' } } })).request;
      await worker.process(await worker.callJson('claim_next_request', { doc_id: doc.id }));
      const after = await api(`${D}/requests/${req.rid}`);
      assert.equal(taskError, undefined, taskError?.stack);
      assert.deepEqual(after.usage, usage, JSON.stringify({finishTool, status: after.status, stats: worker.stats()})); assert.equal(after.model, 'native-measured-model'); assert.equal(after.execution, 'tool-agent');
      assert.equal(after.status, finishTool === 'complete_request' ? 'done' : 'failed');
      assert.equal(after.doneAt, snapshot.request.doneAt); assert.deepEqual(after.log, snapshot.request.log);
      assert.deepEqual(await fileBytes(), snapshot.bytes); assert.deepEqual(await api(`${D}/history`), snapshot.history);
      assert.deepEqual(await api(`${D}/memos`), snapshot.memos);
    }
  } finally { await worker?.stop(); await srv.stop(); }
});
