// 조판 시험지 — 행 단위(CELL) 자리차지 표가 쪽 끝에서 어디서 나뉘는가(vendor/README.md 43). 표 + 줄 바꿈(1pt) + '주:' 글 host 를
// 쪽 맨 위에 두고, 마지막으로 들어갈 행의 끝이 본문 끝보다 X HU 앞이 되게 첫 행 높이를 고른다(쪽마다 사례 하나).
// 변형: anchor9pt(앵커 글자 9pt) · cell180(칸 문단 180%) · merged(마지막 네 행 첫 칸 세로 병합) · base · whole(표가 통째로 들어갈 때 앵커 줄).
// 서식 틀은 보고서 생성 스킬 문서(charPr 34 = 1pt, 3 = 9pt, 85 = 칸 10pt, paraPr 20·18·17·6 — 재수강 분석보고서_v4 의 머리글)여야 한다.
//   node scripts/layout-probe-rowsplit.mjs <틀.hwpx> <out.hwpx>        → out.hwpx + out.cases.json
//   python -I tests/hangul_roundtrip.py <out.hwpx> <한글 결과 폴더> --pdf
//   node scripts/layout-trace.mjs <out.hwpx> --hangul <한글 결과 폴더>   (또는 scripts/layout-probe-rowsplit-read.mjs <out.hwpx> <saved.hwpx>)
import fs from 'node:fs';
import JSZip from 'jszip';
const [,, tpl, out] = process.argv;
const BODY = 65764;
const ROW = 1112;
let uid = 1800000000;
const id = () => String(uid++);

function cell(r, c, h, { cellPara = 18, rowSpan = 1 } = {}) {
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="12"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `<hp:p id="0" paraPrIDRef="${cellPara}" styleIDRef="4" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="85"><hp:t>${r}-${c}</hp:t></hp:run></hp:p></hp:subList>`
    + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="${rowSpan}"/><hp:cellSz width="21120" height="${h}"/><hp:cellMargin left="300" right="300" top="150" bottom="150"/></hp:tc>`;
}
function table(heights, { marginBottom = 57, cellPara = 18, mergeFrom = -1 } = {}) {
  const rows = heights.map((h, r) => {
    let c0 = cell(r, 0, h, { cellPara });
    if (mergeFrom >= 0 && r >= mergeFrom && r < mergeFrom + 4) {
      c0 = r === mergeFrom ? cell(r, 0, heights.slice(r, r + 4).reduce((a, b) => a + b, 0), { cellPara, rowSpan: 4 }) : '';
    }
    return `<hp:tr>${c0}${cell(r, 1, h, { cellPara })}</hp:tr>`;
  }).join('');
  const total = heights.reduce((a, b) => a + b, 0);
  return `<hp:tbl id="${id()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${heights.length}" colCnt="2" cellSpacing="0" borderFillIDRef="9" noAdjust="0">`
    + `<hp:sz width="42240" widthRelTo="ABSOLUTE" height="${total}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="${marginBottom}"/><hp:inMargin left="56" right="56" top="56" bottom="56"/>${rows}</hp:tbl>`;
}
function host(heights, o) {
  const anchor = o.anchorChar ?? 34;
  return `<hp:p id="${id()}" paraPrIDRef="20" styleIDRef="8" pageBreak="1" columnBreak="0" merged="0"><hp:run charPrIDRef="${anchor}">${table(heights, o)}<hp:t><hp:lineBreak/></hp:t></hp:run><hp:run charPrIDRef="3"><hp:t>주: 시험 주석 첫 줄입니다. 표 바로 아래에 붙는가를 본다.</hp:t></hp:run></hp:p>`;
}
const after = (t) => `<hp:p id="${id()}" paraPrIDRef="6" styleIDRef="1" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="16"><hp:t>${t}</hp:t></hp:run></hp:p>`;

const cases = [];
const VARIANTS = [
  { name: 'anchor9pt', anchorChar: 3, xs: [100, 160, 200, 400, 700, 900, 1000, 1050, 1100, 1200] },
  { name: 'cell180', cellPara: 17, xs: [100, 160, 200, 400, 700, 800, 860, 900, 1000] },
  { name: 'merged', merge: true, xs: [0, 100, 160, 200, 300, 400, 600] },
  { name: 'base', xs: [160, 170] },
  { name: 'whole', whole: true, xs: [0, 57, 100, 120, 140, 157, 160, 200, 300] },
];
for (const v of VARIANTS) {
  for (const x of v.xs) {
    const m = x <= 156 ? 59 : 58;
    const h0 = BODY - x - (m - 1) * ROW;
    if (h0 < 1112) throw new Error(`h0 ${h0}`);
    const heights = [h0, ...Array(m - 1 + (v.whole ? 0 : 3)).fill(ROW)];
    const o = { marginBottom: 57, cellPara: v.cellPara ?? 18, anchorChar: v.anchorChar ?? 34, mergeFrom: v.merge ? m - 4 : -1 };
    cases.push({ variant: v.name, x, m, n: heights.length, h0, marginBottom: 57, xml: host(heights, o) + after(`사례 ${v.name} X=${x} 뒤 글`) });
  }
}

const z = await JSZip.loadAsync(fs.readFileSync(tpl));
z.file('mimetype', await z.file('mimetype').async('string'), { compression: 'STORE' });
const sec = await z.file('Contents/section1.xml').async('string');
let depth = 0, firstEnd = -1;
for (const m of sec.matchAll(/<(\/?)hp:p\b[^>]*?(\/?)>/g)) {
  if (m[2]) continue;
  if (!m[1]) depth++;
  else if (--depth === 0) { firstEnd = m.index + m[0].length; break; }
}
const close = sec.lastIndexOf('</hs:sec>');
z.file('Contents/section1.xml', sec.slice(0, firstEnd) + cases.map((c) => c.xml).join('') + sec.slice(close));
fs.writeFileSync(out, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' }));
fs.writeFileSync(out.replace(/\.hwpx$/, '.cases.json'), JSON.stringify(cases.map(({ xml, ...c }) => c), null, 1));
console.log('cases', cases.length);
