// 격리된 실제 구독 Codex 비교. 운영 config/data/worker/포트는 사용하지 않는다.
// 명시 실행: node scripts/compare-native-request-context.mjs --run
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createWorkerPackage, WORKER_PACKAGE_PREFIX } from '../server/worker-package.js';
import JSZip from 'jszip';
import { HwpxDoc } from '../engine/doc.js';
import { tocRegions, physicalParas } from '../engine/toc.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';

if (!process.argv.includes('--run')) throw new Error('구독 Codex 실제 비교는 --run으로 명시 실행합니다.');
const root = path.resolve('.'), evidenceRoot = path.resolve('artifacts/native-context-dedup-20261105');
const outputArg = process.argv.find(a => a.startsWith('--out='));
const fixtureArg = process.argv.find(a => a.startsWith('--fixture='));
const out = outputArg ? path.resolve(outputArg.slice(6)) : evidenceRoot;
const onlyReport = process.argv.includes('--only-report');
const model = 'gpt-6.1-sol', effort = 'medium';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runId = Date.now().toString(36);
const report = { startedAt: new Date().toISOString(), runId, provider: 'ChatGPT subscription / Codex CLI', actualGatewayApiCalled: false,
  model, effort, cacheProtocol: '각 작업 ABBA 순서, 각 요청 새 CLI 세션. 제공자 캐시 강제 초기화는 불가하므로 실제 cacheRead와 캐시 제외 입력을 개별 기록.', rows: [] };
let srv, active;
await fs.mkdir(out, { recursive: true });
const writeReport = () => fs.writeFile(path.join(out, 'real-comparison.json'), JSON.stringify(report, null, 2) + '\n');

async function runtimes() {
  const zip = await JSZip.loadAsync(await createWorkerPackage(root));
  for (const variant of ['before', 'after']) {
    const base = path.join(out, 'runtime', variant); await fs.mkdir(base, { recursive: true });
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.startsWith(WORKER_PACKAGE_PREFIX)) continue;
      const relative = entry.name.slice(WORKER_PACKAGE_PREFIX.length), target = path.join(base, relative);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, await entry.async('nodebuffer'));
    }
    if (variant === 'before') {
      const baseline = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'baseline.json'), 'utf8'));
      for (const entry of baseline.files) {
        const bytes = await fs.readFile(path.join(evidenceRoot, 'before', path.basename(entry.file)));
        assert.equal(sha(bytes), entry.sha256); await fs.writeFile(path.join(base, entry.file), bytes);
      }
    }
  }
}

function observe(trace) {
  return (file, args, options) => {
    if (!args.includes('exec') || !args.includes('--json') || args.includes('--help')) return spawn(file, args, options);
    const settings = Object.fromEntries(args.filter((x, i) => args[i - 1] === '-c').map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    const actual = { model: args[args.indexOf('--model') + 1], effort: JSON.parse(settings.model_reasoning_effort) };
    assert.deepEqual(actual, { model, effort }, '실제 CLI exec의 모델·effort를 확인한다');
    trace.invocation = actual;
    const child = spawn(file, args, options), decoder = new StringDecoder('utf8'); let pending = '';
    const consume = line => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'thread.started') trace.threadId = e.thread_id;
      if (e.type === 'turn.completed') trace.completedUsage = e.usage;
      if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call') trace.toolNames.push(e.item.tool || e.item.name || 'mcp_tool_call');
    };
    child.stdout.on('data', chunk => { pending += decoder.write(chunk); const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(consume); });
    child.stdout.on('end', () => { pending += decoder.end(); if (pending) consume(pending); });
    return child;
  };
}

async function ownUsage(trace, startedAt) {
  if (!trace.threadId || !/^[a-f0-9-]+$/i.test(trace.threadId)) return { modelCalls: null };
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  // 이번에 만든 정확한 thread ID의 기록만 읽고 지시·본문·추론 원문을 수집하지 않는다.
  for (const delta of [-1, 0, 1]) {
    const d = new Date(Date.parse(startedAt) + delta * 86400000);
    const folder = path.join(home, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    let names; try { names = await fs.readdir(folder); } catch { continue; }
    const name = names.find(n => n.endsWith(`${trace.threadId}.jsonl`)); if (!name) continue;
    let total = -1, usageUpdates = 0, last, turnSettings;
    for (const line of (await fs.readFile(path.join(folder, name), 'utf8')).split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'turn_context') turnSettings = { model: event.payload.model, effort: event.payload.effort || event.payload.reasoning_effort };
      const u = event.payload?.info?.total_token_usage;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count' && u && u.total_tokens > total) { total = u.total_tokens; last = u; usageUpdates++; }
    }
    if (turnSettings) assert.deepEqual(turnSettings, { model, effort }, '이번 실제 세션의 turn_context 설정도 대조한다');
    return { modelCalls: null, observedUsageUpdates: usageUpdates, reasoningOutputTokens: last?.reasoning_output_tokens ?? null, turnSettings: turnSettings || null };
  }
  return { modelCalls: null, reasoningOutputTokens: null, note: '자기 세션의 usage 기록을 찾지 못함; CLI 실행 인수와 공개 usage만 사용' };
}

function charShapes(doc, ref) {
  const result = doc.inspectFormatting(ref), text = doc.text(ref);
  return [...text].map((_, i) => result.runs.find(r => r.start <= i && i < r.end)?.char || null);
}

async function runCase(variant, item, repeat, fixtureBytes) {
  const app = path.join(out, 'runtime', variant), user = variant === 'before' ? 'a' : 'b';
  const { CodexProposer } = await import(pathToFileURL(path.join(app, 'server/codex-ai.js')).href);
  const { createApiWorker } = await import(pathToFileURL(path.join(app, 'server/worker.js')).href);
  const api = srv.api(user), label = `${item.id}-${variant}-${repeat}`;
  const uploaded = await uploadDoc(srv.base, srv.tokens[user], fixtureBytes, `${label}.hwpx`), D = `/api/docs/${uploaded.id}`;
  const paragraphs = await api(`${D}/paragraphs`), numeric = paragraphs.find(p => p.text.includes('비교시험 응답률은 75.0%'));
  assert.ok(numeric, '실제로 존재하는 수치가 있어야 서식 시험을 한다');
  const start = [...numeric.text.slice(0, numeric.text.indexOf('75.0%'))].length;
  const target = item.id === 'format' ? { ref: numeric.ref, start, end: start + 5, text: '75.0%' } : { scope: 'document' };
  const trace = { toolNames: [] }, logs = [], startedAt = new Date().toISOString();
  const ai = new CodexProposer({ model, effort }, { spawn: observe(trace) });
  const worker = active = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens[user], ai,
    agent: `격리 비교 ${variant}`, clientName: `isolated-context-${variant}`, timing: { pollMs: 250 }, log: line => logs.push(line) });
  const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction: item.instruction, target } })).request;
  report.current = { label, docId: uploaded.id, requestId: request.rid, variant, startedAt }; await writeReport();
  console.log(JSON.stringify({ event: 'started', ...report.current })); worker.start();
  try {
    while (!worker.stats().completed && !worker.stats().failed && !worker.stopped) {
      if (await fs.stat(path.join(out, 'STOP')).then(() => true, () => false)) throw new Error('시험 STOP 요청');
      await pause(250);
    }
    const done = await api(`${D}/requests/${request.rid}`), proposals = (await api(`${D}/proposals`)).filter(p => p.rid === request.rid);
    const row = { label, variant, repeat, case: item.id, fixtureSha256: sha(fixtureBytes), instruction: item.instruction, target,
      docId: uploaded.id, requestId: done.rid, status: done.status, error: done.error, model: done.model, effort, execution: done.execution,
      invocation: trace.invocation, usage: done.usage ? { ...done.usage, modelCalls: done.usage.modelCallsUnknown ? null : done.usage.modelCalls,
        uncachedInput: done.usage.input == null ? null : done.usage.input - (done.usage.cacheRead || 0) } : null,
      claimedAt: done.claim?.at, doneAt: done.doneAt,
      queueSeconds: (Date.parse(done.claim?.at) - Date.parse(request.at)) / 1000,
      processingSeconds: (Date.parse(done.doneAt) - Date.parse(done.claim?.at)) / 1000,
      requestToSavedSeconds: (Date.parse(done.doneAt) - Date.parse(request.at)) / 1000,
      workerSessionMatched: done.claim?.session === worker.session,
      modelMetadata: await ownUsage(trace, startedAt), toolNames: trace.toolNames, summary: done.aiSummary || done.summary,
      proposals: proposals.map(p => ({ pid: p.pid, type: p.type, status: p.status, text: p.text, format: p.format })), logs };
    report.rows.push(row); await writeReport();
    assert.equal(done.status, 'done', done.error); assert.equal(row.workerSessionMatched, true, '다른 실행기가 처리하면 비교에서 제외한다');
    assert.ok(proposals.length, 'done 글만으로 성공시키지 않는다');
    const pending = proposals.filter(p => p.status === 'pending').map(p => p.pid);
    if (pending.length) {
      const applied = await api(`${D}/requests/${done.rid}/resolve`, { method: 'POST', body: { apply: pending } });
      assert.equal(applied.counts.failed, 0, '격리된 제안을 실제로 반영해야 한다');
    }
    const bytes = await api(`${D}/file?kind=working`), reopened = await HwpxDoc.load(bytes);
    // 검증 실패 결과도 그대로 검토할 수 있도록 먼저 보존한다.
    await fs.writeFile(path.join(out, `${label}.hwpx`), bytes);
    row.validation = { passed: false }; await writeReport();
    if (item.id === 'format') {
      const actual = reopened.paragraphs({ view: 'final', nested: true }).find(p => p.text === numeric.text); assert.ok(actual);
      const shapes = charShapes(reopened, actual.ref), original = charShapes(await HwpxDoc.load(fixtureBytes), numeric.ref);
      assert.ok(original.slice(start, start + 5).every(c => !c?.bold), '시험 전 수치가 실제 비강조 상태');
      assert.ok(shapes.slice(start, start + 5).every(c => c?.bold), '저장된 수치가 실제 굵게 됨');
      assert.deepEqual(shapes.map((c, i) => i >= start && i < start + 5 ? { ...c, bold: false } : c), original, '다른 글자 서식은 유지');
      row.validation = { passed: true, presentNumericTarget: '75.0%', sourceWasBold: false, savedBold: true, otherCharPropertiesPreserved: true };
    } else {
      const texts = reopened.paragraphs({ view: 'final', nested: true }).map(p => p.text);
      const markers = ['시사점 1', '시사점 2', '시사점 3', '정책제언 1', '정책제언 2', '정책제언 3'];
      assert.ok(markers.every(m => texts.some(t => t.includes(`[${m}]`))), '실제 HWPX에 3개씩 항목 저장');
      assert.ok(proposals.some(p => p.type === 'toc'), '차례 갱신 실제 결과');
      const toc = tocRegions(reopened)[0]; assert.ok(toc);
      const physical = physicalParas(reopened.sections[toc.sec]);
      const tocText = physical.slice(toc.start, toc.end + 1).map(p => reopened.text(p.rec.ref)).join('\n');
      row.validation = { passed: false, sixMarkersPresent: true, references: texts.filter(t => markers.some(m => t.includes(`[${m}]`))).map(t => ({ marker: t.match(/\[(시사점|정책제언) \d\]/)?.[0], hasReference: /표\s*1\b/.test(t) })),
        tocExists: true, tocUpdated: proposals.some(p => p.type === 'toc'), tocHasNewSectionNames: tocText.includes('시사점') && tocText.includes('정책제언') };
      assert.ok(row.validation.references.every(x => x.hasReference), '각 항목에 실제 근거 표/그림 번호 포함');
      assert.ok(row.validation.tocHasNewSectionNames, '실제 차례에 새 절 제목 포함');
      row.validation.passed = true;
    }
    await writeReport();
    console.log(JSON.stringify({ event: 'completed', label, usage: row.usage, processingSeconds: row.processingSeconds, validation: row.validation }));
  } finally { await worker.stop(); active = null; }
}

async function preview() {
  const dataDir = path.join(out, `review-data-${runId}`); await fs.cp(srv.dataDir, dataDir, { recursive: true });
  const cfg = { host: '127.0.0.1', port: 0, dataDir, allowAgentApply: false,
    ai: { enabled: false, mock: false, keyFile: path.join(out, 'no-api-key') },
    users: [{ name: '비교 결과 검토', role: 'admin', token: 'isolated-context-review-only' }] };
  const configFile = path.join(out, `review-config-${runId}.json`); await fs.writeFile(configFile, JSON.stringify(cfg, null, 2));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
  Object.assign(env, { HWPX_COWORK_CONFIG: configFile, HWPX_COWORK_DATA_DIR: dataDir, HWPX_COWORK_HOST: '127.0.0.1', HWPX_COWORK_PORT: '0', HWPX_COWORK_AI_ENABLED: '0' });
  const log = path.join(out, `review-server-${runId}.log`), fd = await fs.open(log, 'w');
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', fd.fd, fd.fd] });
  child.unref(); await fd.close();
  for (let i = 0; i < 60; i++) {
    const match = /LISTENING (\d+)/.exec(await fs.readFile(log, 'utf8').catch(() => ''));
    if (match) {
      const url = `http://127.0.0.1:${match[1]}`;
      const response = await fetch(`${url}/api/config`).catch(() => null);
      if (response?.ok) return { running: true, pid: child.pid, url, user: '비교 결과 검토', testToken: 'isolated-context-review-only', aiWorkersRunning: false, configFile, dataDir };
    }
    await pause(250);
  }
  return { running: false, pid: child.pid, log };
}

try {
  await runtimes();
  srv = await startServer({ ai: 'off', users: [{ name: '비교 검토 관리자', role: 'admin' }, { name: '변경 전 시험', role: 'editor' }, { name: '변경 후 시험', role: 'editor' }] });
  report.testServer = { url: srv.base, isolated: true, ai: 'off' }; await writeReport();
  let bytes;
  if (fixtureArg) {
    bytes = await fs.readFile(path.resolve(fixtureArg.slice(10)));
    report.fixtureNote = '명시한 기존 격리 fixture의 원본 바이트를 그대로 사용. 캡션/자동번호/수치를 수정하지 않음. 양쪽 변형은 같은 개선된 자동번호 메타데이터 백엔드를 사용하며 중복 제거만 비교.';
  } else {
    const source = await HwpxDoc.load(await fs.readFile(path.join(root, 'tutorial/결과보고서.hwpx')));
    const section = source.sections.length - 1, last = source.paragraphs({ nested: false }).filter(p => p.ref.startsWith(`s${section}/`)).at(-1);
    source.insertFinalParagraphsAfter(section, Number(/\/p(\d+)/.exec(last.ref)[1]), ['비교시험 응답률은 75.0%이며, 참여자는 120명이다.']);
    const number = source.paragraphs({ nested: false }).find(p => p.text.includes('비교시험 응답률은 75.0%'));
    source.formatRange(number.ref, { start: 0, end: [...number.text].length, char: { bold: false } });
    bytes = await source.save();
  }
  report.fixtureSha256 = sha(bytes); await fs.writeFile(path.join(out, 'comparison-fixture.hwpx'), bytes);
  const cases = [{ id: 'format', instruction: '선택한 수치 75.0%만 굵게 표시해줘. 글 내용과 다른 글자·문단 서식은 유지해줘.' },
    { id: 'report', instruction: '분석 결과를 근거로 시사점과 정책제언을 3개씩 작성해줘. 새 절 제목은 각각 시사점, 정책제언으로 두고 문서의 제목 서식에 맞춰줘. 각 항목은 독립 문단으로 [시사점 1], [시사점 2], [시사점 3], [정책제언 1], [정책제언 2], [정책제언 3]으로 시작하며 근거 표·그림 번호를 함께 적어줘. 마지막에 차례도 새로 고쳐줘.' }];
  for (const item of cases) {
    if (onlyReport && item.id !== 'report') continue;
    let b = 0, a = 0;
    for (const variant of ['before', 'after', 'after', 'before']) await runCase(variant, item, variant === 'before' ? ++b : ++a, bytes);
  }
  report.finishedAt = new Date().toISOString(); report.current = null;
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  await active?.stop();
  if (srv) { report.preview = await preview().catch(e => ({ running: false, error: e.message })); await srv.stop(); }
  await writeReport(); console.log(JSON.stringify({ event: 'finished', status: report.error ? 'failed' : 'complete', preview: report.preview, report: path.join(out, 'real-comparison.json'), error: report.error }));
}
