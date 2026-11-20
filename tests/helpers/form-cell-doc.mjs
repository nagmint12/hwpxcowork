// 시험 받침: 서식 문서(회의록 꼴) — 표의 한 칸에 내용이 문단 여럿으로 든 문서를 만든다. 글은 모두 지어낸 것이다(실제 사용자 문서를 쓰지 않는다).
// 빈 문서 본보기(server/templates/blank.hwpx)에 제목 문단과 4×4 표를 넣고 칸을 합친 뒤, 내용 칸과 서명 칸의 문단을 직접 쓴 XML 로 바꾼다:
//   r0 | 회의일시 | 날짜 | 회의장소 | 장소 |
//   r1 | 참석 | 이름들(세 칸 합침) |
//   r2 | 안건 및 ⏎ 회의내용(문단 안 줄바꿈) | 내용 칸(세 칸 합침 — 문단 9개: 제목 줄 □ 과 항목 줄 ㅇ 의 문단·글자 모양이 다르고, 첫 문단에 단 정의 hp:colPr 가 있다) |
//   r3 | 서명 칸(네 칸 합침 — 문단 2개) |
// 한/글이 저장한 회의록 서식에서 본 꼴이다(2026-11-19 — docs/MCP_REDESIGN_2026-11-16.md §17). tests/mcp_v2_cell_paragraphs.test.mjs 가 쓴다.
//   const { doc, key, lines } = await formCellDoc();          // key = 표 열쇠('s0/p2#t0'), lines = 내용 칸 문단 [갈래 'H'|'I', 글]
//   const { doc } = await formCellDoc({ bookmarkAt: 4 });     // 내용 칸 4번째(0부터) 문단에 책갈피(조판 부호)를 넣는다 — 글만 든 문단이 아닌 것
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 내용 칸 문단의 모양(빈 문서 본보기 머리에 있는 번호): H = 제목 줄(□), I = 항목 줄(ㅇ)·빈 줄 */
export const FORM_SHAPES = { H: { para: '3', char: '5' }, I: { para: '4', char: '6' } };
/** 내용 칸의 문단 [갈래, 글] */
export const FORM_LINES = [
  ['H', '□ 회의 목적'],
  ['I', '  ㅇ 지난 분기 설문 결과를 공유하고 다음 일정 확정'],
  ['I', ' '],
  ['H', '□ 안건 1. 설문 결과'],
  ['I', 'ㅇ (대상) 재학생 120명'],
  ['I', 'ㅇ (결과) 응답 96명 — 응답률 80%'],
  ['I', ''],
  ['H', '□ 결정사항'],
  ['I', 'ㅇ 다음 회의에서 최종안 확정'],
];
export const FORM_SIGN = ['작성자 : 홍길동 (인)', '확인자 : 임꺽정 (인)'];

const LINESEG = '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1100" textheight="1100" baseline="935" spacing="220" horzpos="0" horzsize="30000" flags="393216"/></hp:linesegarray>';
const paraXml = (shape, text, { first = false, bookmark = false } = {}) => {
  const head = first ? `<hp:run charPrIDRef="${shape.char}"><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>` : '';
  const mark = bookmark ? `<hp:run charPrIDRef="${shape.char}"><hp:ctrl><hp:bookmark name="시험표식"/></hp:ctrl></hp:run>` : '';
  const run = text ? `<hp:run charPrIDRef="${shape.char}"><hp:t>${esc(text)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${shape.char}"/>`;
  return `<hp:p id="0" paraPrIDRef="${shape.para}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${head}${mark}${run}${LINESEG}</hp:p>`;
};

/** 표 칸(줄, 칸 — 합친 칸은 왼쪽 위 자리)의 문단들을 주어진 XML 로 바꾼다 */
function setCellParagraphs(doc, key, row, col, xml) {
  const cell = doc.tables().find((t) => t.key === key).cells.find((c) => c.row === row && c.col === col);
  const a = doc.resolve(cell.refs[0]); const b = doc.resolve(cell.refs[cell.refs.length - 1]);
  a.sec.load(a.sec.xml.slice(0, a.p.start) + xml + a.sec.xml.slice(b.p.end));
}

/**
 * 서식 문서를 만든다 → { doc(HwpxDoc), key(표 열쇠), lines(내용 칸 문단 [갈래, 글]), sign(서명 칸 문단 글) }.
 * bookmarkAt: 내용 칸의 그 차례(0부터) 문단에 책갈피를 넣는다(글만 든 문단이 아님 — 통째로 지우거나 바꾸지 못하는 문단)
 */
export async function formCellDoc({ bookmarkAt = null } = {}) {
  const doc = await HwpxDoc.load(fs.readFileSync(path.join(root, 'server', 'templates', 'blank.hwpx')));
  doc.insertFinalParagraphsAfter(0, 0, ['분기 점검 회의록']);
  const { tableKey: key } = doc.insertTableAfter(0, 1, { headerRows: 0, rows: [
    ['회의일시', '2031. 3. 4.(화) 10:00 ~ 11:00', '회의장소', '소회의실'],
    ['참석', '가나다, 라마바', '', ''],
    ['안건 및\n회의내용', '내용', '', ''],
    ['서명', '', '', ''],
  ] }, { author: '시험' });
  doc.editTable(key, [
    { op: 'merge', range: { row_from: 1, row_to: 1, col_from: 1, col_to: 3 } },
    { op: 'merge', range: { row_from: 2, row_to: 2, col_from: 1, col_to: 3 } },
    { op: 'merge', range: { row_from: 3, row_to: 3, col_from: 0, col_to: 3 } },
  ]);
  setCellParagraphs(doc, key, 2, 1, FORM_LINES.map(([kind, text], i) => paraXml(FORM_SHAPES[kind], text, { first: i === 0, bookmark: i === bookmarkAt })).join(''));
  setCellParagraphs(doc, key, 3, 0, FORM_SIGN.map((text) => paraXml(FORM_SHAPES.I, text)).join(''));
  return { doc, key, lines: FORM_LINES, sign: FORM_SIGN };
}
