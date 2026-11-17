// 모델/운영 데이터 없이 20개 표를 실제 서비스·MCP·API 어댑터의 두 단계로 처리한다.
// 토큰/비용 절감 실측이 아니라, 입력 표현·새 대화·전체 범위·저장 결과의 재현 가능한 측정이다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { docBytesSync } from '../engine/toc.js';
import { contentMarkdown } from '../server/document-edit.js';
import { AiProposer } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { startServer, uploadDoc, fixture } from '../tests/helpers/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const measureRoot = path.join(root, 'artifacts/content-format-workflow-20261114/20-tables');
const out = path.resolve(process.argv[2] || path.join(measureRoot, String(Date.now())));
fs.mkdirSync(out, { recursive: true });
const source = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx'))); source.acceptAll();
const rows = [['항목', '설명', '값'], ...Array.from({ length: 39 }, (_, i) => [`ROW_${i + 1}`, '기능설명', String((i + 1) * 10)])];
source.insertTableAfter(0, 0, { rows, headerRows: 1, caption: '측정 표' }, { author: '실험' }); source.acceptAll();
const xml = source.sections[0].xml;
source.sections = Array.from({ length: 20 }, (_, i) => new Section(xml.replace(/ROW_(\d+)/g, `T${i}_R$1`), i)); source._rewriteSectionFiles();
const bytes = docBytesSync(source), markdown = contentMarkdown(source);
fs.writeFileSync(path.join(out, 'input.hwpx'), bytes); fs.writeFileSync(path.join(out, 'input.markdown.txt'), markdown);
const requests = [], stageFirstInputs = [];
const ai = new AiProposer({ ai: { enabled: true, provider: 'anthropic', model: 'fake-measurement' } }, { key: 'fake-measurement-key',
  fetch: async (_url, init) => {
    const body = JSON.parse(init.body), input = body.messages[0].content.find(c => c.type === 'text').text;
    const context = JSON.parse(input.split('<document_context>')[1].split('</document_context>')[0]);
    if (context.nextFrom != null || !context.markdown.includes('T19_R39')) throw new Error('전체 20개 표의 내용이 최초 입력에 포함되지 않았습니다');
    const stage = context.stage, first = body.messages.length === 1;
    requests.push({ stage, freshConversation: first, bodyBytes: Buffer.byteLength(init.body), inputTextChars: input.length, tools: body.tools.map(t => t.name), toolDefinitionChars: JSON.stringify(body.tools).length });
    const requestDir = path.join(out, 'requests'); fs.mkdirSync(requestDir, { recursive: true });
    fs.writeFileSync(path.join(requestDir, `${requests.length}-${stage}.json`), init.body);
    if (first) stageFirstInputs.push({ stage, markdownChars: context.markdown.length, firstMessages: body.messages.length });
    const tables = [...context.markdown.matchAll(/<!-- table ([^;]+); ref ([^;]+); (\d+)x(\d+) -->/g)];
    if (tables.length !== 20) throw new Error(`표 전체를 읽지 않았습니다: ${tables.length}`);
    let tool, args;
    if (first) { tool = 'get_edit_capabilities'; args = { operations: stage === 'content' ? ['replace'] : ['import_styles', 'format', 'table_edit'] }; }
    else {
      tool = 'edit_workspace';
      const operations = stage === 'content' ? tables.map(t => ({ op: 'replace', args: { table: t[1], row: 1, col: 2, find: '10', replace: '11' } }))
        : [{ op: 'import_styles', args: { preset: 'hwpx_standard' } }, { op: 'format', args: { refs: Array.from({ length: 20 }, (_, i) => `s${i}/p0`), style_name: '&본문제목' } },
          ...tables.map(t => ({ op: 'table_edit', args: { table: t[1], ops: [{ op: 'table', width_mm: 150, align: 'CENTER' }] } }))];
      args = { stage, revision: context.revision, operations, complete_stage: true, summary: stage === 'content' ? '표 20개의 값을 정리했습니다.' : '표 20개의 모양과 제목 스타일을 맞췄습니다.' };
    }
    return new Response(JSON.stringify({ id: `fake-${requests.length}`, type: 'message', role: 'assistant', model: 'fake-measurement', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `tool-${requests.length}`, name: tool, input: args }], usage: { input_tokens: 0, output_tokens: 0 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
// 이 실험 방식은 기본으로 꺼져 있다(config.experiments.contentFormat — 2026-11-16) — 재려면 임시 서버에서만 켠다
const srv = await startServer({ config: { experiments: { contentFormat: true } } }), worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 30 } });
try {
  const doc = await uploadDoc(srv.base, srv.tokens.a, bytes, '20-tables.hwpx'), api = srv.api('a'), D = `/api/docs/${doc.id}`;
  await api(`${D}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction: '모든 표의 첫 자료행 값을 10에서 11로 고치고, 전체 표를 150mm 가운데로 맞추고 제목을 표준 역할 스타일로 정리해줘',
    target: { scope: 'document', ref: 's0/p0' }, options: { workflow: 'content_format' } } })).request;
  worker.start(); const deadline = Date.now() + 45000; let current;
  do { current = await api(`${D}/requests/${req.rid}`); if (['done', 'failed'].includes(current.status)) break; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < deadline);
  if (current.status !== 'done') throw new Error(current.error || '실험 시간 초과');
  const resultBytes = await api(`${D}/file?kind=working`), result = await HwpxDoc.load(resultBytes);
  const tables = result.tables();
  const changed = tables.filter(t => t.cells.find(c => c.row === 1 && c.col === 2)?.text === '11').length;
  const centered = tables.filter(t => result.inspectFormatting(t.ref).paragraph.align === 'CENTER').length;
  if (changed !== 20 || centered !== 20) throw new Error(`일부만 처리했습니다: 내용 ${changed}/20, 정렬 ${centered}/20`);
  const proposals = await api(`${D}/proposals`);
  if (proposals.length !== 1 || proposals[0].status !== 'applied') throw new Error('한 묶음 자동 반영 결과가 아닙니다');
  fs.writeFileSync(path.join(out, 'result.hwpx'), resultBytes); fs.writeFileSync(path.join(out, 'result.markdown.txt'), contentMarkdown(result));
  const metadata = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'docs', doc.id, 'meta.json'), 'utf8'));
  const w = metadata.requests.find(r => r.rid === req.rid).editWorkspace;
  const report = { kind: 'model-free simulation; not measured model tokens/cost', tables: 20, rows: 800, cells: 2400, markdownChars: markdown.length,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), changedTables: changed, centeredTables: centered, proposals: proposals.length,
    stageFirstInputs, requests, recordedStages: w.stages, independentModelConversations: stageFirstInputs.length,
    originalRecordsOrConfigUsed: false, paidModelCalls: 0, browserUsed: false };
  fs.writeFileSync(path.join(out, 'measurement.json'), JSON.stringify(report, null, 2));
  fs.mkdirSync(measureRoot, { recursive: true }); fs.writeFileSync(path.join(measureRoot, 'latest.json'), JSON.stringify({ out, ...report }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await worker.stop(); await srv.stop(); }
