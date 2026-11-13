// 한 MCP 사용자 세션에서 업로드 없이 새 보고서를 만들고 실제 파일까지 저장한다.
// 모델 추론은 검증하지 않는다. 실행은 실제 MCP/임시 서버/문서 엔진을 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { tocRegions } from '../engine/toc.js';
import { TOOL_PROFILES, RUNNER_EXCLUDED } from '../server/tool-profiles.js';

async function connect(srv, who = 'a') {
  const client = new Client({ name: 'chatgpt-work-create-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}` } } });
  await client.connect(transport);
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    const text = result.content.find(c => c.type === 'text')?.text;
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, raw, call, close: async () => { await transport.terminateSession().catch(() => {}); await client.close(); } };
}

test('Work 단일 MCP 세션: create_document → 전체 서식 → 보고서·표·그림·새 차례 실제 저장', { timeout: 30000 }, async () => {
  const srv = await startServer(); let mcp;
  try {
    mcp = await connect(srv);
    assert.ok((await mcp.client.listTools()).tools.some(t => t.name === 'create_document'));
    assert.ok(RUNNER_EXCLUDED.create_document);
    for (const names of Object.values(TOOL_PROFILES)) assert.ok(!names.includes('create_document'), '고정 대상 실행기에 문서 생성 권한을 주지 않음');
    const made = await mcp.call('create_document', { title: 'Work에서 새로 작성한 보고서', space: 'private' });
    assert.equal(made.space, 'private'); assert.equal(made.canEdit, true);
    assert.equal(made.settings.aiApply, 'auto'); assert.equal(made.settings.editMode, 'realtime');
    const doc_id = made.id;
    const definitions = await mcp.call('get_formatting', { doc_id });
    assert.ok(JSON.stringify(definitions).includes('&본문 1.'), '실제 빈 문서의 전체 스타일 정의 수신');
    const texts = ['1. 분석 개요', '2. 분석 결과', '3. 시사점', '4. 정책제언'];
    const proposed = [];
    const apply = async proposal => { proposed.push(proposal.pid); return proposal.status === 'applied' ? proposal : mcp.call('apply_proposal', { doc_id, proposal_id: proposal.pid }); };
    for (const text of texts) await apply(await mcp.call('propose_insert', { doc_id, after_ref: 's0/p0', text, format: { styleId: '6', char: { bold: true } } }));
    await apply(await mcp.call('propose_table', { doc_id, after_ref: 's0/p0', rows: [['지표', '실적'], ['응답 수', '30']], caption: '시험 분석 결과' }));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect x="10" y="10" width="380" height="100" fill="#dce8ff"/><text x="30" y="70" font-size="24">Evidence → Policy</text></svg>';
    const preview = await mcp.raw('preview_figure', { doc_id, svg, width_mm: 100, after_ref: 's0/p0' });
    assert.ok(!preview.isError && preview.content.some(c => c.type === 'image'), '실제 PNG 미리보기 확인');
    await apply(await mcp.call('propose_figure', { doc_id, svg, width_mm: 100, after_ref: 's0/p0', caption: '근거와 정책의 연결' }));
    assert.match(await mcp.call('read_document', { doc_id }), /\[s0\/p\d+\]/, '차례 직전 현재 주소 재조회');
    const toc = await mcp.call('propose_toc_update', { doc_id, create_if_missing: true, collect_styles: ['&본문 1.'], after_ref: 's0/p0', apply_now: true, apply_styles: true });
    assert.equal(toc.status, 'applied'); assert.ok(toc.tocResult.created && toc.tocResult.entries >= texts.length);
    const saved = await HwpxDoc.load(await srv.api('a')(`/api/docs/${doc_id}/file?kind=working`));
    for (const text of texts) {
      const paragraph = saved.paragraphs({ nested: false }).find(p => p.text === text);
      assert.ok(paragraph, '실제 보고서 본문 저장');
      assert.ok(saved.inspectFormatting(paragraph.ref).runs.every(r => r.char.bold));
    }
    assert.ok(saved.tables().some(t => t.cells.some(c => c.text === '30')));
    assert.equal(saved.figures().length, 1); assert.equal(tocRegions(saved).length, 1);
    assert.ok((await mcp.call('list_proposals', { doc_id })).every(p => p.status === 'applied'));
  } finally { await mcp?.close(); await srv.stop(); }
});

test('create_document는 승인 요청·전역 반영 금지·문서함 ACL을 지키고 기존 문서 설정을 바꾸지 않는다', { timeout: 30000 }, async () => {
  const srv = await startServer({ config: { allowAgentApply: false, documents: { defaultAiApply: 'auto', defaultEditMode: 'realtime' } } }); let mcp;
  try {
    mcp = await connect(srv);
    const review = await mcp.call('create_document', { title: '검토할 새 초안', review_required: true });
    assert.equal(review.settings.aiApply, 'manual');
    const automatic = await mcp.call('create_document', { title: '직접 작성할 새 초안' });
    assert.equal(automatic.settings.aiApply, 'auto');
    assert.equal((await srv.api('a')(`/api/docs/${review.id}`)).settings.aiApply, 'manual', '다른 문서 설정 보존');
    const proposal = await mcp.call('propose_insert', { doc_id: automatic.id, after_ref: 's0/p0', text: '권한 시험' });
    const blocked = await mcp.raw('apply_proposal', { doc_id: automatic.id, proposal_id: proposal.pid });
    assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /FORBIDDEN/);
    const forbidden = await mcp.raw('create_document', { title: '다른 사람 문서함', space: 'private', owner: srv.users.b.name });
    assert.equal(forbidden.isError, true, '다른 사용자 개인 문서함 작성 금지');
    const file = await HwpxDoc.load(await srv.api('a')(`/api/docs/${automatic.id}/file?kind=working`));
    assert.ok(!file.paragraphs().some(p => p.text === '권한 시험'));
  } finally { await mcp?.close(); await srv.stop(); }
});
