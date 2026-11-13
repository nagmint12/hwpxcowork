// UTF-8 파일에 있는 한글·원문 수치가 요청→MCP 제안→HWPX 저장에서 보존되는지 검사한다.
// 실행 서버·계정·문서는 tests/helpers/server.mjs의 임시 환경만 사용한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { createApiWorker } from '../server/worker.js';
import { HwpxDoc } from '../engine/doc.js';

const ref = 's0/p2';
const text = '주당 AI 활용 시간은 1시간 미만 63.8%(300명), 0시간 6.8%(32명)이며 합계 70.6%(332명)임.';
const rows = [['구분', '응답수(N)', '비율(%)'], ['1시간 미만', '300', '63.8'], ['0시간', '32', '6.8'], ['1시간 미만 합계', '332', '70.6']];
const caption = '주당 AI 활용 시간 요약';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function complete(worker) {
  for (let i = 0; i < 400; i++) {
    if (worker.stats().completed === 1) return;
    if (worker.stats().failed) assert.fail('표 요청 처리 실패');
    await sleep(20);
  }
  assert.fail('표 요청 완료 시간 초과');
}

test('임의 문단 표 만들기: 한글·수치·완료 상태 및 적용 후 서식 변경·되돌리기 보존', { timeout: 20000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  let worker;
  try {
    const source = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
    source.mergeParagraphText(ref, text, { author: '시험 준비' }); source.acceptAll();
    source.formatRange(ref, { start: 0, end: [...text].length, charPrId: '0', char: { italic: true, sizePt: 13 } });
    source.formatRange(ref, { start: 0, end: 2, char: { bold: true } });
    const uploaded = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()), '한글 표·서식 회귀 시험.hwpx');
    const api = srv.api('a'); const D = `/api/docs/${uploaded.id}`;
    const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'make_table', target: { ref }, route: 'queue', instruction: '선택 문단의 응답수와 비율을 그대로 표로 정리' } })).request;
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, agent: '표 시험 AI',
      timing: { pollMs: 100, connectTimeoutMs: 3000, callTimeoutMs: 5000 }, log() {},
      ai: { async run(input) {
        assert.equal(input.kind, 'make_table'); assert.equal(input.target.ref, ref); assert.equal(input.target.text, text);
        return { proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [{ afterRef: ref, caption, headerRows: 1, rows, reason: '원문 수치로 정리' }], summary: '원문의 응답수와 비율을 표로 정리했습니다.', instructionSummary: '활용 시간 표 작성' };
      } },
    });
    worker.start(); await complete(worker);
    const finished = await api(`${D}/requests/${request.rid}`);
    assert.equal(finished.status, 'done'); assert.equal(finished.error, null); assert.ok(finished.doneAt);
    const proposals = (await api(`${D}/proposals`)).filter(p => p.rid === request.rid);
    assert.equal(proposals.length, 1); const proposal = proposals[0];
    assert.equal(proposal.type, 'table'); assert.equal(proposal.status, 'pending');
    assert.deepEqual(proposal.table.rows, rows); assert.equal(proposal.table.caption, caption);
    assert.equal((await HwpxDoc.load(await api(`${D}/file?kind=working`))).tables().some(table => table.cells.some(cell => cell.text === '70.6')), false, '제안 단계에서 표를 자동 반영하지 않음');
    await api(`${D}/proposals/${proposal.pid}/apply`, { method: 'POST' });
    const saved = await HwpxDoc.load(await api(`${D}/file?kind=working`));
    assert.equal(saved.text(ref), text);
    const table = saved.tables().find(table => table.cells.some(cell => cell.text === '70.6'));
    assert.ok(table); assert.deepEqual(table.cells.map(cell => cell.text), rows.flat());
    assert.equal(table.caption.text, `[표 ] ${caption}`, '캡션은 표 안 자동 번호 캡션');
    const reopened = await HwpxDoc.load(await saved.save());
    assert.deepEqual(reopened.tables().find(table => table.cells.some(cell => cell.text === '70.6')).cells.map(cell => cell.text), rows.flat());

    const before = saved.inspectFormatting(ref); const fingerprint = saved.formattingFingerprint(ref);
    const formatProposal = await api(`${D}/proposals`, { method: 'POST', body: { type: 'format', ref, start: 0, end: 1, format: { char: { bold: false } }, reason: '선택한 첫 글자만 굵기 해제' } });
    await api(`${D}/proposals/${formatProposal.pid}/apply`, { method: 'POST' });
    const formatted = await HwpxDoc.load(await api(`${D}/file?kind=working`));
    const chars = formatted.inspectFormatting(ref).runs.flatMap(run => [...run.text].map(() => run.char));
    assert.equal(chars[0].bold, false); assert.equal(chars[1].bold, true);
    assert.ok(chars.every(char => char.italic && char.sizePt === 13), '미지정 속성은 선택 범위와 그 밖에서 보존');
    assert.equal(formatted.inspectFormatting(ref).styleId, before.styleId);
    assert.deepEqual(formatted.tables().find(table => table.cells.some(cell => cell.text === '70.6')).cells.map(cell => cell.text), rows.flat());
    await api(`${D}/proposals/${formatProposal.pid}/undo`, { method: 'POST' });
    const undone = await HwpxDoc.load(await api(`${D}/file?kind=working`));
    assert.equal(undone.formattingFingerprint(ref), fingerprint);
    assert.deepEqual(undone.tables().find(table => table.cells.some(cell => cell.text === '70.6')).cells.map(cell => cell.text), rows.flat());
  } finally { await worker?.stop(); await srv.stop(); }
});
