// node --test tests/preview_figure.test.mjs — 그림 미리보기(preview_figure): propose_figure 에 줄 svg·chart 를 같은 글꼴·본문 폭으로 그려
// 모델에게 그림으로 보여 준다(제안·첨부·기록 없음). API 실행기는 미리 보고 고친 뒤 제안한다(2026-11-04 — 우수 사례의 '그린 그림을 보고 고치기').
// API 는 가짜 fetch, 문서·서버는 임시 복사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.js';
import { validateImage } from '../server/image-integrity.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { TOOL_PROFILES } from '../server/tool-profiles.js';
import { toolRules } from '../server/api-tool-loop.js';
import { fixture } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const DIAGRAM = `<svg viewBox="0 0 1600 600">
  <rect x="40" y="40" width="700" height="260" rx="24" fill="#dce6f1" stroke="#1f4e79" stroke-width="6"/>
  <text x="390" y="190" text-anchor="middle" font-size="56" font-weight="bold">분석 대상</text>
  <rect x="860" y="40" width="700" height="260" rx="24" fill="#f2f2f2" stroke="#7f7f7f" stroke-width="6" stroke-dasharray="16 10"/>
  <text x="1210" y="190" text-anchor="middle" font-size="56">제외</text>
</svg>`;
const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const finalJson = (value) => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const call = (name, args, n = 1) => json({ status: 'completed', output: [{ type: 'function_call', call_id: `call_${n}`, name, arguments: JSON.stringify(args) }] });
const emptyResult = { proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '표를 도식으로 그렸습니다.', instructionSummary: '표 시각화' };

function tempService(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-preview-figure-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  return { service, user, config, docId };
}

test('previewFigure: svg 를 150dpi 로 그리고 보일 크기를 알려 준다 — 첨부·제안·버전은 그대로', { timeout: 60000 }, async (t) => {
  const { service, user, docId } = tempService(t);
  // 교체 미리보기용 그림 하나(s0/p2)를 먼저 넣어 둔다
  const made = await service.proposeFigure(docId, { afterRef: 's0/p1', caption: '응답률', imageBase64: makePng(400, 200).toString('base64'), widthMm: 90 }, user);
  await service.applyProposal(docId, made.pid, user);
  const before = JSON.stringify(service._meta(docId));
  const out = await service.previewFigure(docId, { svg: DIAGRAM, widthMm: 120, afterRef: 's0/p1' });
  const info = validateImage(out.png);
  assert.equal(out.kind, 'svg'); assert.equal(out.widthMm, 120);
  assert.equal(info.width, Math.round((120 / 25.4) * 150));                 // 150dpi(문서에 넣을 그림은 300dpi)
  assert.deepEqual(out.px, [info.width, info.height]);
  assert.equal(out.heightMm, Math.round((120 * info.height * 10) / info.width) / 10);
  assert.equal(JSON.stringify(service._meta(docId)), before);                 // 첨부·제안·기록·버전 없음
  // 교체 미리보기는 폭을 주지 않으면 지금 그림 폭
  const fig = (await service.listFigures(docId)).find((f) => f.figure === 's0/p2');
  const rep = await service.previewFigure(docId, { svg: DIAGRAM, replaceRef: 's0/p2' });
  assert.equal(fig.widthMm, 90); assert.ok(Math.abs(rep.widthMm - 90) <= 0.2, `${rep.widthMm}`);
  // 잘못된 입력
  await assert.rejects(service.previewFigure(docId, {}), { code: 'BAD_FIGURE' });
  await assert.rejects(service.previewFigure(docId, { svg: DIAGRAM, chart: { type: 'bar', categories: ['a'], series: [{ name: 'x', values: [1] }] } }), { code: 'BAD_FIGURE' });
  await assert.rejects(service.previewFigure(docId, { svg: DIAGRAM, replaceRef: 'p2' }), { code: 'BAD_FIGURE' });
  await assert.rejects(service.previewFigure(docId, { svg: DIAGRAM, replaceRef: 's0/p0' }), { code: 'NO_FIGURE' });
  await assert.rejects(service.previewFigure(docId, { svg: '<svg' }), { code: 'BAD_SVG' });
  await assert.rejects(service.previewFigure('nodoc', { svg: DIAGRAM }), { code: 'NO_DOC' });
});

test('MCP preview_figure: 읽기 도구(힌트), 결과는 글 + PNG 그림 — API·Codex 프로필에 있다', { timeout: 60000 }, async (t) => {
  const { service, user, docId } = tempService(t);
  const server = createMcpServer({ service, user, agentName: 'Claude Code' });
  const client = new Client({ name: 'test', version: '1' });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await server.connect(y); await client.connect(x);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find((tl) => tl.name === 'preview_figure');
  assert.ok(tool.inputSchema.properties.svg && tool.inputSchema.properties.chart);
  assert.equal(tool.annotations.readOnlyHint, true);
  const r = await client.callTool({ name: 'preview_figure', arguments: { doc_id: docId, svg: DIAGRAM, width_mm: 100 } });
  assert.ok(!r.isError, JSON.stringify(r.content).slice(0, 300));
  assert.match(r.content[0].text, /100×[\d.]+mm/); assert.match(r.content[0].text, /propose_figure/);
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png'); assert.equal(validateImage(Buffer.from(img.data, 'base64')).width, Math.round((100 / 25.4) * 150));
  const bad = await client.callTool({ name: 'preview_figure', arguments: { doc_id: docId } });
  assert.ok(bad.isError); assert.match(bad.content[0].text, /BAD_FIGURE/);
  assert.ok(TOOL_PROFILES.api.includes('preview_figure') && TOOL_PROFILES.codex.includes('preview_figure'));
  assert.match(toolRules(TOOL_PROFILES.api), /preview_figure/);
  assert.doesNotMatch(toolRules(['propose_figure']), /preview_figure/);       // 미리보기 도구가 없는 묶음에는 규칙도 없음
});

test('서버 개인 키(API): preview_figure 로 그린 그림을 모델이 보고(input_image) 고친 뒤 propose_figure', { timeout: 60000 }, async (t) => {
  const { service, user, config, docId } = tempService(t);
  let round = 0; let seen = null;
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    round++;
    if (round === 1) {
      assert.ok(body.tools.some((tl) => tl.name === 'preview_figure'));
      assert.match(body.instructions, /preview_figure/);
      return call('preview_figure', { after_ref: 's0/p1', svg: DIAGRAM, width_mm: 120 }, 1);
    }
    if (round === 2) {
      const out = body.input.find((i) => i.type === 'function_call_output' && i.call_id === 'call_1');
      seen = Array.isArray(out.output) ? out.output.find((c) => c.type === 'input_image') : null;
      return call('propose_figure', { after_ref: 's0/p1', svg: DIAGRAM.replace('font-size="56">제외', 'font-size="48">제외'), caption: '분석 대상과 제외', width_mm: 120 }, 2);
    }
    return finalJson(emptyResult);
  } });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', key: 'fake-api-key' });
  const attachments = service._meta(docId).attachments.length;
  const done = await service.createRequest(docId, { kind: 'instruct', target: { ref: 's0/p1' }, instruction: '표1을 시각화하여 제시해줘', route: 'server' }, user);
  assert.equal(done.request.status, 'done'); assert.equal(round, 3);
  assert.ok(seen, '미리보기 그림이 모델 입력으로 가야 한다'); assert.match(seen.image_url, /^data:image\/png;base64,/);
  assert.equal(done.proposals.length, 1); assert.equal(done.proposals[0].figure.widthMm, 120);
  assert.equal(service._meta(docId).attachments.length, attachments + 2);   // 제안의 PNG·SVG 원문만(미리보기는 첨부를 만들지 않음)
});
