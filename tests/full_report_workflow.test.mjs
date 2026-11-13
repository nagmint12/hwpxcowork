// 실제 모델 품질 시험이 아니다. 네이티브 API 대역 + 실제 임시 서버/MCP/문서 저장의 계약 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { HwpxDoc } from '../engine/doc.js';
import { AiProposer } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { tocRegions } from '../engine/toc.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const ORIGINAL = '분석 결과를 근거로 시사점과 정책제언을 3개씩 작성해줘. 근거가 된 표·그림 번호를 함께 적고, 마지막에 차례도 새로 고쳐줘';
const empty = () => ({ proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '보고서 문단·표·그림과 차례를 제안했습니다.', instructionSummary: '보고서 작성' });
const message = (content, stop_reason = 'tool_use') => new Response(JSON.stringify({ id: 'fake_report', type: 'message', role: 'assistant', model: 'fake-native', stop_reason, content, usage: { input_tokens: 90000, output_tokens: 1000 } }), { headers: { 'content-type': 'application/json' } });
const textOf = body => body.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(c => c.type === 'text').map(c => c.text)).join('\n');
const tail = doc => doc.paragraphs({ nested: false }).at(-1).ref;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><rect x="10" y="10" width="580" height="180" fill="#eef3ff"/><text x="40" y="110" font-size="30">Analysis → Policy → Evaluation</text></svg>';

async function waitWorker(worker) {
  const end = Date.now() + 30000;
  while (worker.stats().completed + worker.stats().failed < 1 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(worker.stats().failed, 0, JSON.stringify({ stats: worker.stats(), log: worker.testLog }));
  assert.equal(worker.stats().completed, 1, '실제 요청 완료까지 기다림');
}

// 옛 80k prompt/누적 token 예산을 초과하면서 마지막 문단과 미사용 서식 정의도 가진다.
async function richFixture() {
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  let last = Number(tail(doc).split('/p')[1]);
  for (let i = 0; i < 42; i++) doc.insertParagraphAfter(0, last++, `분석 근거 ${i}: ${'참여율은 75%이며 지원체계를 개선할 필요가 있다. '.repeat(85)}`, { author: '시험 준비' });
  doc.insertParagraphAfter(0, last, '문서전체마지막문단_SENTINEL: 모든 근거와 끝 문단까지 확인해야 한다.', { author: '시험 준비' });
  doc.acceptAll();
  const zip = await JSZip.loadAsync(await doc.save());
  let header = await zip.file('Contents/header.xml').async('string');
  const char = /<hh:charPr\b[^>]*>[\s\S]*?<\/hh:charPr>/.exec(header)?.[0];
  assert.ok(char);
  const copies = Array.from({ length: 140 }, (_, i) => char.replace(/\bid="\d+"/, `id="${1000 + i}"`)).join('');
  header = header.replace('</hh:charProperties>', copies + '</hh:charProperties>').replace(/(<hh:charProperties\b[^>]*\bitemCnt=")\d+"/, (_, start) => `${start}${[...header.matchAll(/<hh:charPr\b/g)].length + 140}"`);
  zip.file('Contents/header.xml', header);
  return zip.generateAsync({ type: 'nodebuffer' });
}

for (const scenario of ['blank', 'blank-manual', 'tutorial', 'original']) test(`사용자 지시 하나 → ${scenario} 문서에 보고서 실제 제안 저장`, { timeout: 60000 }, async () => {
  const srv = await startServer(); let worker;
  try {
    const source = scenario.replace('-manual', ''), manual = scenario.endsWith('-manual');
    const api = srv.api('a');
    let id;
    if (source === 'blank') id = (await api('/api/library/docs', { method: 'POST', body: { title: '보고서 계약 시험' } })).id;
    else {
      const selected = (await api('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } })).docId;
      // 체험용 공유 유료 API 라우팅을 쓰지 않고 선택한 체험 문서의 사본을 개인 실행기로 처리한다.
      id = (await uploadDoc(srv.base, srv.tokens.a, await api(`/api/docs/${selected}/file?kind=working`), '선택한_체험보고서.hwpx')).id;
    }
    const route = `/api/docs/${id}`;
    const before = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    const anchor = tail(before);
    const heading = before.formattingCatalog().styles.find(s => s.name === '&본문 1.') || before.formattingCatalog().styles.find(s => s.type === 'PARA' && s.id !== '0');
    assert.ok(heading);
    const paragraphs = [1, 2, 3].map(n => `시사점 ${n}: 참여율 75%의 분석 결과는 지원체계의 개선 필요성을 보여준다([표 1], [그림 1]).`).concat([1, 2, 3].map(n => `정책제언 ${n}: 지원체계 개선과 성과 점검을 추진한다([표 1], [그림 1]).`));
    const script = [
      ['get_formatting', {}],
      ...paragraphs.map(text => ['propose_insert', { after_ref: anchor, text, format: { char: { bold: true }, styleId: heading.id } }]),
      ...(source === 'original' ? [] : [
      ['propose_table', { after_ref: anchor, rows: [['지표', '결과'], ['참여율', '75%']], header_rows: 1, caption: '분석 결과 요약' }],
      ['preview_figure', { after_ref: anchor, svg, width_mm: 120 }],
      ['propose_figure', { after_ref: anchor, svg, width_mm: 120, caption: '분석과 정책의 연결' }],
      ]),
      ['read_document', {}],
      ['propose_toc_update', { apply_now: true, create_if_missing: true, after_ref: 's0/p0', collect_styles: [heading.name], apply_styles: true, one_line: true }],
    ];
    let round = 0; const seen = [];
    const ai = new AiProposer({ ai: { enabled: true, provider: 'anthropic', model: 'fake-native' } }, { key: 'fake-test-key', fetch: async (_url, init) => {
      const body = JSON.parse(init.body); seen.push(body);
      if (round === 0) {
        const prompt = textOf(body);
        // 서식 낱말(굵게)이 있는 지시는 서식 정의를 싣고, 없는 지시(original)는 스타일 이름만 — 필요하면 get_formatting
        assert.match(prompt, source === 'original' ? /get_formatting\(refs=/ : /문서 서식 정의/);
        assert.ok(body.tools.some(t => t.name === 'propose_insert') && body.tools.some(t => t.name === 'propose_figure') && body.tools.some(t => t.name === 'propose_toc_update'));
        assert.ok(!JSON.stringify(body).includes(srv.tokens.a));
      } else {
        const receipt = body.messages.at(-1).content.find(c => c.type === 'tool_result');
        assert.ok(receipt && !receipt.is_error, JSON.stringify(receipt));
        if (script[round - 1][0] === 'preview_figure') assert.ok(receipt.content.some(c => c.type === 'image'), '실제 미리보기 이미지를 모델에 전달');
        if (script[round - 1][0] === 'get_formatting') assert.match(JSON.stringify(receipt), /charPr|charProperties/);
        if (script[round - 1][0] === 'read_document') assert.match(JSON.stringify(receipt), /\[s\d+\/p\d+\]/, '차례 직전에 현재 ref 재조회');
      }
      if (round < script.length) {
        const [name, input] = script[round++];
        return message([{ type: 'tool_use', id: `r${round}`, name, input }]);
      }
      return message([{ type: 'text', text: JSON.stringify(empty()) }], 'end_turn');
    } });
    const log = [];
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log(line) { log.push(line); }, timing: { pollMs: 50 } });
    worker.testLog = log;
    await api(`${route}/settings`, { method: 'PATCH', body: { aiApply: manual ? 'manual' : 'auto' } });
    const instruction = source === 'original' ? ORIGINAL : `${ORIGINAL} 표 1의 참여율은 75%이다. 이를 요약한 표와 분석→정책→평가 그림을 만들고 각 항목을 굵게 작성해줘. 차례가 없으면 새 차례를 만들어줘.`;
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction, target: { ref: anchor } } })).request;
    worker.start(); await waitWorker(worker);
    const result = await api(`${route}/requests/${request.rid}`);
    assert.equal(result.status, 'done', result.error);
    let saved = (await api(`${route}/proposals`)).filter(p => p.rid === request.rid);
    assert.deepEqual(saved.filter(p => p.type === 'insert').map(p => p.text).sort(), [...paragraphs].sort(), '응답 텍스트가 아닌 실제 문단 제안 6개');
    assert.equal(saved.filter(p => p.type === 'table').length, source === 'original' ? 0 : 1);
    assert.equal(saved.filter(p => p.type === 'figure').length, source === 'original' ? 0 : 1);
    assert.ok(saved.filter(p => p.type === 'insert').every(p => p.format?.char?.bold === true), '실제 서식 제안도 저장');
    assert.equal(saved.filter(p => p.type === 'toc').length, 1, '마지막 차례도 실제 저장');
    if (manual) {
      assert.ok(saved.every(p => p.status === 'pending'), '수동 정책에서는 본문과 마지막 차례를 승인 대기로 함께 보존');
      assert.equal(tocRegions(await HwpxDoc.load(await api(`${route}/file?kind=working`))).length, 0, '본문 승인 전 새 차례를 먼저 만들지 않음');
    }
    if (source !== 'original') assert.ok((await api(`${route}/attachments`)).length >= 1, '그림 결과 파일도 저장');
    // 사람이 승인하는 HTTP API로 반영한 다음 파일을 다시 열어 본문·개체·서식 저장까지 확인한다.
    // 실행기에는 apply_proposal 권한을 추가하지 않는다.
    for (const p of saved.filter(p => ['insert', 'table', 'figure'].includes(p.type))) {
      if (p.status === 'pending') await api(`${route}/proposals/${p.pid}/apply`, { method: 'POST' });
    }
    if (manual) {
      await api(`${route}/proposals/${saved.find(p => p.type === 'toc').pid}/apply`, { method: 'POST' });
      saved = (await api(`${route}/proposals`)).filter(p => p.rid === request.rid);
    }
    const bytes = await api(`${route}/file?kind=working`);
    const reopened = await HwpxDoc.load(bytes);
    const reportText = reopened.paragraphs().map(p => p.text).join('\n');
    for (const paragraph of paragraphs) {
      assert.ok(reportText.includes(paragraph), '실제 HWPX 본문에 작성 문단 저장');
      const actual = reopened.paragraphs().find(p => p.text === paragraph);
      assert.ok(reopened.inspectFormatting(actual.ref).runs.every(r => r.char.bold), '다시 연 HWPX에도 굵은 서식 저장');
    }
    if (source !== 'original') {
      assert.ok(reopened.tables().some(t => JSON.stringify(t).includes('75%')), '실제 HWPX 표의 자료 저장');
      assert.ok(reopened.figures().length > before.figures().length, '실제 HWPX 그림 개체 저장');
    }
    assert.match(reopened.sections.map(s => s.xml).join(''), /type="TABLEOFCONTENTS"/, '빈 문서에도 실제 차례 필드 생성');
    if (source === 'blank') {
      const toc = saved.find(p => p.type === 'toc');
      assert.ok(toc.tocResult?.created, '새 차례 생성 영수증');
      assert.ok(toc.tocResult.entries >= 6, '새로 쓴 문단 6개의 헤딩을 포함하는 실제 차례');
      const region = tocRegions(reopened)[0];
      const tocText = reopened.paragraphs({ nested: false }).filter(p => Number(p.ref.split('/p')[1]) >= Number(region.startRef.split('/p')[1]) && Number(p.ref.split('/p')[1]) <= Number(region.endRef.split('/p')[1])).map(p => p.text).join('\n');
      for (const paragraph of paragraphs) assert.ok(tocText.includes(paragraph), '완료 후 차례에 새 본문 제목이 포함됨');
    }
    assert.equal(round, script.length);
    assert.ok(seen.length > 8, '중간 쓰기 완료를 전체 작업 완료로 오인하지 않음');
  } finally { await worker?.stop(); await srv.stop(); }
});

test('새 차례는 영역만 가져와 기존 문단·메모·변경 추적·서식을 보존하고 되돌린다', { timeout: 30000 }, async () => {
  const srv = await startServer();
  try {
    const api = srv.api('a'), uploaded = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${uploaded.id}`;
    const before = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    const paragraphs = before.paragraphs({ nested: false }).map(p => ({ text: p.text, format: before.inspectFormatting(p.ref) }));
    const memos = before.memos().map(m => ({ id: m.id, text: m.text }));
    const changes = before.changes();
    const style = before.formattingCatalog().styles.find(s => s.type === 'PARA' && s.id === '0');
    const proposal = await api(`${route}/proposals`, { method: 'POST', body: { type: 'toc', toc: { createIfMissing: true, afterRef: 's0/p0', collectStyles: [style.name] } } });
    await api(`${route}/proposals/${proposal.pid}/apply`, { method: 'POST' });
    const after = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    const region = tocRegions(after)[0]; assert.ok(region, '실제 새 차례 필드');
    const retained = after.paragraphs({ nested: false }).filter(p => !(/^s0\/p(\d+)$/.test(p.ref) && Number(p.ref.split('/p')[1]) >= Number(region.startRef.split('/p')[1]) && Number(p.ref.split('/p')[1]) <= Number(region.endRef.split('/p')[1])));
    assert.deepEqual(retained.map(p => p.text), paragraphs.map(p => p.text));
    for (let i = 0; i < retained.length; i++) {
      const original = paragraphs[i].format, current = after.inspectFormatting(retained[i].ref);
      assert.deepEqual(current.runs.map(r => r.char), original.runs.map(r => r.char), '차례 밖 글자서식 보존');
      assert.deepEqual(current.paragraph, original.paragraph, '차례 밖 문단서식 보존');
    }
    assert.deepEqual(after.memos().filter(m => memos.some(b => b.id === m.id)).map(m => ({ id: m.id, text: m.text })), memos);
    const trackedContent = list => list.map(({ ref, ...c }) => c);
    assert.deepEqual(trackedContent(after.changes()), trackedContent(changes), '기존 추적 내용·작성자·날짜·범위 보존');
    for (const definition of before.formattingCatalog().styles) assert.deepEqual(after.formattingCatalog().styles.find(s => s.id === definition.id), definition, '기존 스타일 정의 보존');
    await api(`${route}/proposals/${proposal.pid}/undo`, { method: 'POST' });
    const undone = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    assert.equal(tocRegions(undone).length, 0);
    assert.deepEqual(undone.paragraphs({ nested: false }).map(p => p.text), paragraphs.map(p => p.text));
    assert.deepEqual(undone.changes(), changes, '되돌리면 기존 추적 주소까지 복원');
  } finally { await srv.stop(); }
});

test('대용량 문서: 요청에는 필요한 만큼만(쓰지 않는 서식 정의 없이, 문맥은 한도 안) 싣고 끝 문단은 read_document 로 읽어 실제 제안 저장', { timeout: 60000 }, async () => {
  const srv = await startServer(); let worker;
  try {
    const api = srv.api('a'), uploaded = await uploadDoc(srv.base, srv.tokens.a, await richFixture(), '대용량_서식.hwpx');
    const route = `/api/docs/${uploaded.id}`;
    const original = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    const lastRef = tail(original), lastText = original.text(lastRef);
    const lastBody = Number(/^s\d+\/p(\d+)$/.exec(lastRef)?.[1]);
    let round = 0;
    const ai = new AiProposer({ ai: { enabled: true, provider: 'anthropic', model: 'fake-native' } }, { key: 'fake-test-key', fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      round++;
      if (round === 1) {
        const prompt = textOf(body);
        assert.ok(prompt.length < 80000, `요청 글은 필요한 만큼만: ${prompt.length}자`);
        assert.ok(!prompt.includes('1139'), '쓰지 않는 서식 정의는 싣지 않는다(서식 낱말 없는 지시)');
        assert.match(prompt, /get_formatting\(refs=/);
        return message([{ type: 'tool_use', id: 'read', name: 'read_document', input: { from: lastBody, to: lastBody + 1 } }]);
      }
      if (round === 2) {
        const receipt = body.messages.at(-1).content.find(c => c.type === 'tool_result');
        assert.ok(receipt && !receipt.is_error && JSON.stringify(receipt).includes(lastText.slice(0, 20)), '필요한 범위를 읽어 끝 문단을 받는다');
        return message([{ type: 'tool_use', id: 'last', name: 'propose_changes', input: { proposals: [{ ref: lastRef, find: lastText, replace: lastText + ' 검토 완료.' }] } }]);
      }
      assert.ok(!body.messages.at(-1).content[0].is_error);
      return message([{ type: 'text', text: JSON.stringify(empty()) }], 'end_turn');
    } });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 50 } });
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction: '문서 전체를 읽고 마지막 문단의 오탈자를 고쳐줘.', target: { scope: 'document', ref: 's0/p0' } } })).request;
    worker.start(); await waitWorker(worker);
    assert.equal((await api(`${route}/requests/${request.rid}`)).status, 'done');
    const proposal = (await api(`${route}/proposals`)).find(p => p.rid === request.rid && p.ref === lastRef);
    assert.ok(proposal && proposal.replace === lastText + ' 검토 완료.', '실제 마지막 문단 제안 저장');
    assert.equal(round, 3);
  } finally { await worker?.stop(); await srv.stop(); }
});
