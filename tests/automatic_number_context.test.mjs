import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Section } from '../engine/section.js';
import { HwpxDoc } from '../engine/doc.js';
import { automaticNumberFields } from '../server/automatic-number-context.js';
import { modelRequestContext } from '../server/editor-instructions.js';
import { taskText } from '../server/ai.js';
import { Service } from '../server/service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from './helpers/server.mjs';

const sourcePath = new URL('../tutorial/결과보고서.hwpx', import.meta.url);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('자동번호는 원문·서식 오프셋을 바꾸지 않고 저장값과 모든 번호 서식 속성으로 전달', async () => {
  const doc = await HwpxDoc.load(await fs.readFile(sourcePath));
  const caption = doc.tables().find(t => t.caption?.text.includes('영역별 만족도')).caption;
  const xml = doc.sections.map(s => s.xml), text = doc.text(caption.ref), formatting = doc.inspectFormatting(caption.ref);
  const numbers = automaticNumberFields(doc, caption.ref).automaticNumbers;
  assert.equal(text, '[표 ] 영역별 만족도');
  assert.deepEqual(numbers, [{ offset: 3, type: 'TABLE', storedNumber: '1',
    format: { type: 'DIGIT', userChar: '', prefixChar: '', suffixChar: '', supscript: '0' } }]);
  assert.equal(doc.text(caption.ref), text); assert.deepEqual(doc.inspectFormatting(caption.ref), formatting);
  assert.deepEqual(doc.sections.map(s => s.xml), xml, '읽기만으로 XML을 고치거나 자동번호를 글로 바꾸지 않음');
  assert.deepEqual(automaticNumberFields(doc, 's1/p9'), {});
});

test('삭제·삽입 자동번호의 보기 구분, 코드포인트 위치와 알 수 없는 형식 보존', () => {
  const number = (n, format) => `<hp:ctrl><hp:autoNum num="${n}" numType="TABLE"><hp:autoNumFormat type="${format}" userChar="별" prefixChar="(" suffixChar=")" future="유지"/></hp:autoNum></hp:ctrl>`;
  const sec = new Section(`<hs:sec><hp:p><hp:run charPrIDRef="0"><hp:t>가😀</hp:t><hp:deleteBegin Id="1"/>${number('77', 'UNKNOWN_NUMBER_FORMAT')}<hp:deleteEnd Id="1"/><hp:insertBegin Id="2"/>${number('5', 'DIGIT')}<hp:insertEnd Id="2"/><hp:t>끝</hp:t></hp:run></hp:p></hs:sec>`, 0);
  const doc = { resolve: () => ({ sec, p: sec.bodyParas[0] }) };
  const final = automaticNumberFields(doc, 's0/p0').automaticNumbers;
  assert.equal(final.length, 1); assert.equal(final[0].storedNumber, '5'); assert.equal(final[0].offset, 2);
  const original = automaticNumberFields(doc, 's0/p0', 'original').automaticNumbers;
  assert.equal(original.length, 1); assert.equal(original[0].storedNumber, '77');
  assert.equal(original[0].format.type, 'UNKNOWN_NUMBER_FORMAT'); assert.equal(original[0].format.future, '유지');
  assert.equal(automaticNumberFields(doc, 's0/p0', 'markup').automaticNumbers.length, 2);
  assert.equal(Section.text(sec.bodyParas[0]), '가😀끝', '번호를 편집 글자 배열에 넣지 않음');
});

test('검색 발췌의 자동번호 위치는 전체 원문 기준임을 명시하고 발췌 시작의 코드포인트 위치 제공', async () => {
  const text = '😀'.repeat(125) + '가'.repeat(180) + '찾기' + '뒤'.repeat(130);
  const paragraph = { ref: 's0/p0', where: '본문', text, automaticNumbers: [{ offset: 310, type: 'TABLE', storedNumber: '77' }] };
  const [found] = await Service.prototype.search.call({ paragraphs: async () => [paragraph] }, 'test-doc', '찾기');
  assert.equal(found.automaticNumberOffsetBasis, 'fullParagraph'); assert.equal(found.textStart, 225);
  assert.deepEqual(found.automaticNumbers, paragraph.automaticNumbers);
  assert.equal(found.text, [...text].slice(found.textStart, found.textStart + [...found.text].length).join(''));
});

test('실제 MCP·API 최초 입력·표/그림 조회에 번호 전파, 정확한 원문 제안과 저장된 자동번호 유지', { timeout: 30000 }, async () => {
  const source = await HwpxDoc.load(await fs.readFile(sourcePath));
  source.insertPictureAfter(1, 16, { data: png, caption: '만족도 변화', widthMm: 80 }, { author: '시험' });
  const bytes = await source.save(), srv = await startServer({ ai: 'off' }); let client, transport;
  try {
    const api = srv.api('a'), made = await uploadDoc(srv.base, srv.tokens.a, bytes), D = `/api/docs/${made.id}`;
    client = new Client({ name: 'auto-number-contract-test', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': 'auto-number-test' } } });
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: { doc_id: made.id, ...args } }); assert.ok(!result.isError, result.content[0]?.text);
      const text = result.content[0].text; try { return JSON.parse(text); } catch { return text; }
    };
    const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction: '근거 표 번호와 시사점을 작성해줘', target: { scope: 'document' } } })).request;
    const raw = await call('get_request', { request_id: request.rid });
    const caption = raw.contextItems.find(p => p.text === '[표 ] 영역별 만족도'); assert.ok(caption);
    assert.equal(caption.automaticNumbers[0].storedNumber, '1');
    assert.deepEqual(modelRequestContext(raw).contextItems, raw.contextItems);
    assert.equal(raw.tables.length, 0, '문서 전체 대상에서도 contextItems로 번호를 전달');
    const read = await call('read_document'); assert.match(read, /\[표 \] 영역별 만족도/); assert.match(read, /storedNumber.*1/);
    const formatting = await call('get_formatting', { refs: [caption.ref] });
    assert.deepEqual(formatting.paragraphs[0].automaticNumbers, caption.automaticNumbers);
    assert.deepEqual((await call('search_document', { query: '영역별 만족도' }))[0].automaticNumbers, caption.automaticNumbers);
    const table = (await api(`${D}/tables`)).find(t => t.caption?.ref === caption.ref);
    assert.deepEqual(table.caption.automaticNumbers, caption.automaticNumbers);
    const figures = await call('list_figures'), added = figures.find(f => f.caption.includes('만족도 변화'));
    assert.equal(added.automaticNumbers[0].type, 'PICTURE');
    assert.equal(raw.document.figures.find(f => f.caption.includes('만족도 변화')).automaticNumbers[0].storedNumber, '1');
    for (const formattingLean of [true, false]) {
      const text = taskText({ kind: 'instruct', label: '지시', instruction: '번호 인용', target: { scope: 'document' }, context: raw.contextItems, tables: [table], formattingLean });
      assert.match(text, /자동 번호 정보/); assert.match(text, /storedNumber.*1/);
    }
    await call('start_request', { request_id: request.rid });
    const proposal = await call('propose_changes', { request_id: request.rid, expected_attempt: 1, proposals: [{ ref: caption.ref, find: '영역별 만족도', replace: '영역별 만족도 검증' }] });
    assert.ok(proposal);
    const pending = (await api(`${D}/proposals`)).map(p => p.pid);
    const applied = await api(`${D}/requests/${request.rid}/resolve`, { method: 'POST', body: { apply: pending } }); assert.equal(applied.counts.failed, 0);
    const saved = await HwpxDoc.load(await api(`${D}/file?kind=working`));
    const savedCaption = saved.tables().find(t => t.caption?.text.includes('영역별 만족도 검증')).caption;
    assert.equal(savedCaption.text, '[표 ] 영역별 만족도 검증');
    assert.equal(automaticNumberFields(saved, savedCaption.ref).automaticNumbers[0].storedNumber, '1');
  } finally { await transport?.terminateSession().catch(() => {}); await client?.close(); await srv.stop(); }
});
