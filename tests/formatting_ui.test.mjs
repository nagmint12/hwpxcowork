import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFormatDraft, formatFromDraft, paragraphFormatRequested, formatSummary, isRichProposal, formatAdoptionOf, runPreviewStyle } from '../web/formatting.js';
import { paragraphGeo, proposalRange, buildAnnotations } from '../web/annotations.js';

test('선택 서식: 빈 값은 유지, false는 해제, ID 0·음수 들여쓰기 보존', () => {
  assert.equal(formatFromDraft(emptyFormatDraft()), null);
  assert.deepEqual(formatFromDraft({ ...emptyFormatDraft(), styleId: '0', bold: 'false', italic: 'true', sizePt: '11.5', indentPt: '-5', lineValue: '160' }), {
    styleId: '0', char: { bold: false, italic: true, sizePt: 11.5 }, paragraph: { lineSpacing: { type: 'PERCENT', value: 160 }, indentPt: -5 },
  });
  assert.throws(() => formatFromDraft({ sizePt: 'NaN' }));
  assert.throws(() => formatFromDraft({ color: 'red;display:none' }));
});

test('문단 전체 범위: 글자 속성·CHAR 스타일은 범위를 넓히지 않는다', () => {
  const catalog = { styles: [{ id: '1', type: 'CHAR' }, { id: '2', type: 'PARA' }] };
  assert.equal(paragraphFormatRequested({ char: { bold: true } }, catalog), false);
  assert.equal(paragraphFormatRequested({ styleId: '1' }, catalog), false);
  assert.equal(paragraphFormatRequested({ styleId: '2' }, catalog), true);
  assert.equal(paragraphFormatRequested({ paraPrId: '0' }, catalog), true);
  assert.equal(paragraphFormatRequested({ paragraph: { align: 'CENTER' } }, catalog), true);
});

test('서식 미리보기: false 해제를 표시하고 안전한 문자 스타일만 사용한다', () => {
  const summary = formatSummary({ char: { bold: false, sizePt: 12 }, paragraph: { align: 'CENTER' } });
  assert.ok(summary.includes('굵게 끔')); assert.ok(summary.includes('12pt')); assert.ok(summary.includes('가운데 정렬'));
  assert.deepEqual(runPreviewStyle({ char: { bold: false, color: 'url(bad)', font: 'injected' } }), { fontWeight: '400' });
  assert.equal(isRichProposal({ type: 'format' }), true);
  assert.equal(isRichProposal({ type: 'replace', format: { char: { bold: false } } }), true);
  assert.equal(isRichProposal({ type: 'replace' }), false);
  assert.equal(formatAdoptionOf({ adoptedBy: { '나': { cid: 2, formatApplied: true, canUndo: true } } }, '나').canUndo, true);
  assert.equal(formatAdoptionOf({ adoptedBy: { '다른 사람': { formatApplied: true } } }, '나'), null);
});

test('서식 전용 제안도 코드포인트 범위에 강조되고 문단 뒤로 이동하지 않는다', () => {
  const paragraphs = [{ ref: 's0/p0', text: '가😀나다' }];
  const p = { pid: 1, type: 'format', status: 'pending', ref: 's0/p0', find: '😀나', start: 1, end: 3, format: { char: { bold: true } } };
  assert.deepEqual(proposalRange(p, new Map(), paragraphGeo(paragraphs)), { ref: 's0/p0', start: 1, end: 3, endRef: 's0/p0' });
  const annotations = buildAnnotations({ paragraphs, proposals: [p] });
  assert.equal(annotations.proposals[0].type, 'format');
  assert.equal(annotations.proposals[0].start, 1); assert.equal(annotations.proposals[0].end, 3);
  assert.equal(annotations.proposals[0].afterRef, undefined);
});
