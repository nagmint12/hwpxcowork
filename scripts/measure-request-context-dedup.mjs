// 모델을 호출하지 않는다. 임시 문서의 동일 get_request 자료에서 표현 중복만 제거한 전송량을 비교한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';
import { modelRequestContext } from '../server/editor-instructions.js';

const srv = await startServer({ ai: 'off' }); let client, transport;
try {
  const api = srv.api('a'), source = 'tutorial/결과보고서.hwpx';
  const doc = await uploadDoc(srv.base, srv.tokens.a, path.resolve(source));
  const route = `/api/docs/${doc.id}`, paragraphs = await api(`${route}/paragraphs`);
  const paragraph = paragraphs.find(p => p.text.includes('일정 부분 기여한 것으로 보인다')) || paragraphs.find(p => p.text.trim());
  assert.ok(paragraph);
  client = new Client({ name: 'isolated-context-size-audit', version: '1' });
  transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
  await client.connect(transport);
  const cases = [
    { label: '문단 표현 수정', instruction: '문장 표현을 자연스럽게 고쳐 줘', target: { ref: paragraph.ref } },
    { label: '문단 서식 요청', instruction: '이 문단의 글꼴과 문단 서식을 확인하고 숫자만 굵게 해 줘', target: { ref: paragraph.ref } },
    { label: '문서 전체 결론과 차례', instruction: '분석 결과를 근거로 시사점과 정책제언을 3개씩 작성해줘. 근거가 된 표·그림 번호를 함께 적고, 마지막에 차례도 새로 고쳐줘', target: { scope: 'document' } },
  ];
  const rows = [];
  for (const item of cases) {
    const request = (await api(`${route}/requests`, { method: 'POST', body: { ...item, kind: 'instruct', route: 'queue' } })).request;
    const raw = await client.callTool({ name: 'get_request', arguments: { doc_id: doc.id, request_id: request.rid } });
    assert.ok(!raw.isError);
    const before = JSON.parse(raw.content.find(c => c.type === 'text').text), after = modelRequestContext(before);
    assert.notEqual(before, after, '실제 서버의 정확히 중복된 문단 표현을 확인한다');
    const expected = { ...before }; delete expected.context; assert.deepEqual(after, expected);
    const a = JSON.stringify(before), b = JSON.stringify(after);
    rows.push({ label: item.label, contextItems: before.contextItems.length, sourceTruncationPreserved: JSON.stringify(before.truncated) === JSON.stringify(after.truncated),
      before: { chars: a.length, utf8Bytes: Buffer.byteLength(a) }, after: { chars: b.length, utf8Bytes: Buffer.byteLength(b) },
      removedUtf8Bytes: Buffer.byteLength(a) - Buffer.byteLength(b), payloadByteReductionPercent: Number((100 * (1 - Buffer.byteLength(b) / Buffer.byteLength(a))).toFixed(2)) });
  }
  const report = { at: new Date().toISOString(), source, method: '동일한 실제 MCP 요청 자료를 JSON.stringify한 전/후 비교. 모델/제공자 호출 및 tokenizer 추정 없음.',
    actualModelCalled: false, inputTokensMeasured: false, rows };
  await fs.mkdir('artifacts/native-context-dedup-20261105', { recursive: true });
  await fs.writeFile('artifacts/native-context-dedup-20261105/payload-comparison.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await transport?.terminateSession().catch(() => {}); await client?.close().catch(() => {}); await srv.stop(); }
