import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

// 실제 AI(튜토리얼 점검, 2026-11-01)가 글 일부를 고치면서 그 문단의 지금 서식(styleId·charPrId·paraPrId·paragraph·char)을 그대로 함께 보냈다.
// 문단모양은 문단 전체 범위만 바꿀 수 있어 제안이 통째로 버려졌다 — 바뀌지 않는 문단 서식은 빼고 글 고침은 살린다.
test('글 일부 고침에 지금 문단모양·스타일을 되풀이한 서식은 빼고 제안을 만든다, 다른 문단모양은 여전히 거절한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const { docId } = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } });
    const para = (await A(`/api/docs/${docId}/paragraphs`)).find(p => p.text.includes('학생 만족도 향상'));
    const doc = await HwpxDoc.load(await A(`/api/docs/${docId}/file`));
    const now = doc.inspectFormatting(para.ref);
    const charPrId = now.runs[0].charPrId;
    const echoed = await A(`/api/docs/${docId}/proposals`, { method: 'POST', body: { ref: para.ref, find: '학생 만족도 향상', replace: '[표 1]에 제시된 학생 만족도 향상', format: { styleId: now.styleId, charPrId, paraPrId: now.paraPrId, paragraph: now.paragraph, char: { bold: false } } } });
    assert.equal(echoed.status, 'pending');
    assert.equal(echoed.format?.paraPrId, undefined);
    assert.equal(echoed.format?.styleId, undefined);
    assert.equal(echoed.format?.paragraph, undefined);
    const aligned = await A.res(`/api/docs/${docId}/proposals`, { method: 'POST', body: { ref: para.ref, find: '본 사업은', replace: '이 사업은', format: { paragraph: { ...now.paragraph, align: now.paragraph.align === 'CENTER' ? 'LEFT' : 'CENTER' } } } });
    assert.equal(aligned.data.error, 'FORMAT_PARAGRAPH_RANGE', '실제로 다른 문단모양은 여전히 문단 전체에만');
    const other = doc.formattingCatalog().paragraphProperties.find(p => p.id !== now.paraPrId);
    const changed = await A.res(`/api/docs/${docId}/proposals`, { method: 'POST', body: { ref: para.ref, find: '본 사업은', replace: '이 사업은', format: { paraPrId: other.id } } });
    assert.equal(changed.status, 400);
    assert.equal(changed.data.error, 'FORMAT_PARAGRAPH_RANGE');
  } finally { await srv.stop(); }
});
