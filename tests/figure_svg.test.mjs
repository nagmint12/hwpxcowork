// 어떤 그림이든: AI 가 SVG 로 그린 그림을 서버가 PNG 로 그려 그림 제안으로 넣는다(API 도구·최종 JSON·개인 실행기),
// BMP 는 모델에 보기용 PNG 로 보낸다. API 는 가짜 fetch, 문서·서버는 임시 복사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AiProposer, parseResult, outputJsonSchema, claudeOutputJsonSchema } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { createMcpServer } from '../server/mcp.js';
import { normSvg, renderSvg, figureFonts } from '../server/figure-svg.js';
import { decodeBmp, bmpToPng, imageForModel } from '../server/image-convert.js';
import { validateImage } from '../server/image-integrity.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const DIAGRAM = `<svg viewBox="0 0 1600 700">
  <rect x="40" y="40" width="700" height="280" rx="24" fill="#eaf1fb" stroke="#1f4e79" stroke-width="6"/>
  <text x="390" y="200" text-anchor="middle" font-size="56" font-weight="bold">분석 대상</text>
  <rect x="860" y="40" width="700" height="280" rx="24" fill="#fdf1e6" stroke="#b05a00" stroke-width="6"/>
  <text x="1210" y="200" text-anchor="middle" font-size="56">재수강 판정</text>
  <path d="M740 180 L860 180" stroke="#333" stroke-width="8" marker-end="url(#a)"/>
  <defs><marker id="a" markerWidth="10" markerHeight="10" refX="6" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>
</svg>`;

/** BMP 만들기: bpp 24(아래→위) · 8(색표) · 32(BGRA) */
function makeBmp(w, h, bpp, pixel) {
  const stride = Math.floor((bpp * w + 31) / 32) * 4; const pal = bpp === 8 ? 256 * 4 : 0;
  const off = 54 + pal; const b = Buffer.alloc(off + stride * h);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(off, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(bpp, 28); b.writeUInt32LE(stride * h, 34);
  if (bpp === 8) { b.writeUInt32LE(256, 46); for (let i = 0; i < 256; i++) { b[54 + i * 4] = i; b[55 + i * 4] = 255 - i; b[56 + i * 4] = (i * 3) & 255; } }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = off + (h - 1 - y) * stride; const [r, g, bl, a] = pixel(x, y);
    if (bpp === 24) { b[o + x * 3] = bl; b[o + x * 3 + 1] = g; b[o + x * 3 + 2] = r; }
    else if (bpp === 32) { b[o + x * 4] = bl; b[o + x * 4 + 1] = g; b[o + x * 4 + 2] = r; b[o + x * 4 + 3] = a ?? 0; }
    else b[o + x] = r;   // 색표 번호
  }
  return b;
}
const at = (d, x, y) => [...d.rgba.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)];
const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const emptyResult = (extra = {}) => ({ proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '표를 상자형 도식으로 그렸습니다.', instructionSummary: '표를 그림으로', ...extra });
const finalJson = (value) => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const call = (name, args, n = 1) => json({ status: 'completed', output: [{ type: 'function_call', call_id: `call_${n}`, name, arguments: JSON.stringify(args) }] });

function tempService(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-figure-svg-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), allowAgentApply: true, ai: {}, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  return { service, store, user, config, docId };
}

test('BMP → PNG: 24·8·32비트를 무손실로 읽고, 모델에는 PNG 로만 보낸다', () => {
  const grad = (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255];
  const d24 = decodeBmp(makeBmp(37, 23, 24, grad));
  assert.deepEqual([d24.width, d24.height], [37, 23]); assert.deepEqual(at(d24, 5, 3), [...grad(5, 3), 255]); assert.deepEqual(at(d24, 36, 22), [...grad(36, 22), 255]);
  const d8 = decodeBmp(makeBmp(9, 4, 8, (x) => [x * 20]));
  assert.deepEqual(at(d8, 3, 1), [180, 195, 60, 255]);   // 색표 60번 = R 180·G 195·B 60
  // 32비트: 네 번째 바이트가 모두 0 이면 불투명, 값이 있으면 투명도
  assert.equal(at(decodeBmp(makeBmp(4, 4, 32, () => [10, 20, 30, 0])), 1, 1)[3], 255);
  assert.deepEqual(at(decodeBmp(makeBmp(4, 4, 32, () => [10, 20, 30, 77])), 1, 1), [10, 20, 30, 77]);
  const png = bmpToPng(makeBmp(37, 23, 24, grad));
  assert.equal(validateImage(png).width, 37);
  const view = imageForModel(makeBmp(37, 23, 24, grad), 'image/bmp');
  assert.equal(view.mime, 'image/png'); assert.equal(view.converted, 'bmp'); assert.equal(validateImage(view.bytes).height, 23);
  const p = makePng(5, 5); assert.deepEqual(imageForModel(p, 'image/png'), { bytes: p, mime: 'image/png' });
  assert.equal(imageForModel(Buffer.from('not an image'), 'application/octet-stream'), null);
  assert.throws(() => decodeBmp(Buffer.from('BMxx')), { code: 'BAD_IMAGE' });
});

test('SVG 그리기: 코드 울타리·xmlns 보정, DTD 거절, 한글 글꼴, 보일 폭(mm) → 300dpi PNG, 시간 제한', { timeout: 60000 }, async () => {
  const svg = normSvg('```svg\n' + DIAGRAM + '\n```');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.throws(() => normSvg('<!DOCTYPE svg [<!ENTITY a "x">]><svg></svg>'), { code: 'BAD_SVG' });
  assert.throws(() => normSvg('그림입니다'), { code: 'BAD_SVG' });
  assert.ok(figureFonts().length >= 1, '서버 PC 에 한글 글꼴이 있어야 한다');
  const out = await renderSvg(svg, { widthMm: 150 });
  assert.equal(out.widthMm, 150); assert.equal(out.width, Math.round((150 / 25.4) * 300)); assert.equal(out.height, Math.round(out.width * 700 / 1600));
  assert.equal(validateImage(out.png).width, out.width);
  const intrinsic = await renderSvg(svg, {});   // viewBox 1600px(96dpi) = 423mm → 최대 300mm
  assert.equal(intrinsic.widthMm, 300);
  await assert.rejects(renderSvg(normSvg('<svg viewBox="0 0 10 10"><rect></svg>')), { code: 'BAD_SVG' });
  const heavy = normSvg(`<svg viewBox="0 0 4000 4000"><defs><filter id="f"><feGaussianBlur stdDeviation="400"/></filter></defs>${Array.from({ length: 300 }, (_, i) => `<rect x="${i}" y="${i}" width="3000" height="3000" filter="url(#f)" fill="red"/>`).join('')}</svg>`);
  await assert.rejects(renderSvg(heavy, { timeoutMs: 1500 }), { code: 'SVG_TIMEOUT' });
});

test('그림 제안(svg): PNG·SVG 원문 첨부, 보일 폭, 반영하면 HWPX 에 그림 — SVG 첨부(attachment_id)도 그린다', { timeout: 60000 }, async (t) => {
  const { service, store, user, docId } = tempService(t);
  const p = await service.proposeFigure(docId, { afterRef: 's0/p1', svg: DIAGRAM, caption: '재수강 분석 틀', widthMm: 140 }, user, 'AI');
  assert.equal(p.type, 'figure'); assert.equal(p.figure.widthMm, 140); assert.ok(p.figure.svgAid);
  const png = await service.getAttachment(docId, p.figure.aid); assert.equal(validateImage(png.bytes).ext, 'png');
  const src = await service.getAttachment(docId, p.figure.svgAid); assert.match(src.entry.name, /\.svg$/); assert.match(src.bytes.toString('utf8'), /분석 대상/);
  assert.match((await service.attachmentText(docId, p.figure.svgAid, 20000)).text, /<svg/);   // AI 가 다시 고칠 때 읽는 글
  await service.applyProposal(docId, p.pid, user);
  const saved = await store.doc(docId); const fig = saved.figures().find((f) => f.caption?.text.includes('재수강 분석 틀'));
  assert.ok(fig); assert.deepEqual(Buffer.from(saved.binaryItem(fig.binId).bytes), png.bytes);
  assert.ok(Math.abs(fig.width - Math.round(140 * 7200 / 25.4)) < 3, `보일 폭 140mm: ${fig.width}`);
  // .svg 첨부를 attachment_id 로 → 그 SVG 를 그린다(새 PNG, 원문 첨부는 그 첨부)
  const up = await service.addAttachment(docId, { name: '작업공간.svg', bytes: Buffer.from(DIAGRAM) }, user);
  const q = await service.proposeFigure(docId, { afterRef: 's0/p0', aid: up.aid }, user, 'AI');
  assert.equal(q.figure.svgAid, up.aid); assert.notEqual(q.figure.aid, up.aid); assert.ok(q.figure.widthMm > 0);
  await assert.rejects(service.proposeFigure(docId, { afterRef: 's0/p0', svg: '<svg viewBox="0 0 10 10"><g></svg>' }, user, 'AI'), { code: 'BAD_SVG' });
  await assert.rejects(service.proposeFigure(docId, { afterRef: 's0/p0', svg: DIAGRAM, chart: { type: 'bar' } }, user, 'AI'), { code: 'BAD_FIGURE' });
});

test('MCP: read_attachment 의 BMP 는 보기용 PNG, propose_figure 에 svg 입력', async (t) => {
  const { service, user, docId } = tempService(t);
  const bmp = makeBmp(40, 30, 24, (x, y) => [x * 6, y * 8, 100]);
  const a = await service.addAttachment(docId, { name: '원본.bmp', bytes: bmp }, user);
  const server = createMcpServer({ service, user, agentName: 'Claude Code' });
  const client = new Client({ name: 'test', version: '1' });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await server.connect(y); await client.connect(x);
  t.after(async () => { await client.close(); await server.close(); });
  const r = await client.callTool({ name: 'read_attachment', arguments: { doc_id: docId, attachment_id: a.aid } });
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png'); assert.equal(validateImage(Buffer.from(img.data, 'base64')).width, 40);
  assert.match(r.content[0].text, /BMP.*PNG/);
  assert.deepEqual((await service.getAttachment(docId, a.aid)).bytes, bmp);   // 원본은 그대로
  const tool = (await client.listTools()).tools.find((tl) => tl.name === 'propose_figure');
  assert.ok(tool.inputSchema.properties.svg); assert.match(tool.description, /svg/);
});

test('서버 개인 키: API 도구로 propose_figure(svg) — 표를 도식 그림으로, 위치·크기는 AI 가 정한다', { timeout: 60000 }, async (t) => {
  const { service, user, config, docId } = tempService(t);
  let round = 0;
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (++round === 1) {
      const tool = body.tools.find((tl) => tl.name === 'propose_figure');
      assert.ok(tool.parameters.properties.svg); assert.ok(!tool.parameters.properties.image_base64);
      assert.match(body.instructions, /svg=SVG/);
      return call('propose_figure', { after_ref: 's0/p1', svg: DIAGRAM, caption: '분석 틀', width_mm: 120 });
    }
    assert.ok(body.input.some((i) => i.type === 'function_call_output' && i.output.includes('"figure"')));
    return finalJson(emptyResult());
  } });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', target: { ref: 's0/p1' }, instruction: '표3을 그림으로 작성해줘', route: 'server' }, user);
  assert.equal(done.request.status, 'done'); assert.equal(round, 2);
  assert.equal(done.proposals.length, 1); assert.equal(done.proposals[0].figure.widthMm, 120);
  const meta = service._meta(docId);
  assert.ok(!meta.requests[0].log.some((l) => /그림 제안 없음/.test(l.detail)));
});

test('서버 개인 키: 최종 JSON 의 figures(SVG) → 그림 제안, 못 그린 그림은 건너뛰고 나머지는 받는다', { timeout: 60000 }, async (t) => {
  const { service, user, config, docId } = tempService(t);
  const value = emptyResult({ figures: [
    { afterRef: 's0/p1', replaceRef: '', caption: '분석 틀', widthMm: 0, svg: DIAGRAM, reason: '표 내용을 네 영역 도식으로' },
    { afterRef: 's0/p1', replaceRef: '', caption: '깨진 그림', widthMm: 100, svg: '<svg viewBox="0 0 10 10"><g></svg>', reason: '시험' },
  ] });
  assert.equal(parseResult(JSON.stringify(value)).figures.length, 2);
  assert.ok(outputJsonSchema().required.includes('figures'));
  assert.ok((JSON.stringify(claudeOutputJsonSchema()).match(/anyOf/g) || []).length <= 16);
  service.personalAi = createPersonalAi({ config, fetchImpl: async () => finalJson(value) });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', target: { ref: 's0/p1' }, instruction: '이 표를 도식으로 그려줘', route: 'server' }, user);
  assert.equal(done.request.status, 'done');
  const figs = done.proposals.filter((p) => p.type === 'figure');
  assert.equal(figs.length, 1); assert.equal(figs[0].figure.caption, '분석 틀');
  assert.ok(figs[0].figure.widthMm > 100 && figs[0].figure.widthMm < 200, `0 = SVG 고유 폭을 본문 폭으로 줄임: ${figs[0].figure.widthMm}`);
  assert.ok(service._meta(docId).requests[0].skipped.some((s) => /SVG/.test(s.error)));
});

test('개인 API 실행기: 최종 JSON 의 figures 를 MCP propose_figure(svg)로 저장', { timeout: 60000 }, async () => {
  const srv = await startServer(); let worker;
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const value = emptyResult({ figures: [{ afterRef: 's0/p1', replaceRef: '', caption: '실행기 도식', widthMm: 130, svg: DIAGRAM, reason: '도식' }] });
    const model = new AiProposer({ ai: { provider: 'gemini', model: 'fake-model', enabled: true } }, { key: 'fake-api-key', fetch: async () => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: {} }) });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai: model, log() {}, timing: { pollMs: 100 } });
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', target: { ref: 's0/p1' }, instruction: '도식으로 그려줘', route: 'queue' } })).request;
    worker.start();
    const end = Date.now() + 40000;
    while (Date.now() < end && worker.stats().completed + worker.stats().failed === 0) await new Promise((r) => setTimeout(r, 50));
    assert.equal(worker.stats().failed, 0); assert.equal(worker.stats().completed, 1);
    assert.equal((await api(`${route}/requests/${request.rid}`)).status, 'done');
    const figs = (await api(`${route}/proposals`)).filter((p) => p.type === 'figure');
    assert.equal(figs.length, 1); assert.equal(figs[0].figure.widthMm, 130); assert.ok(figs[0].figure.svgAid);
  } finally { await worker?.stop(); await srv.stop(); }
});
