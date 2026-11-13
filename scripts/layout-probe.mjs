// 조판 시험지(probe) — 빈 줄·쪽 끝·그림 배치(글자처럼/위아래/어울림/글 뒤·앞/쪽 기준)·빈 앵커 표를 한 문서에 늘어놓고,
// 이 PC 의 한/글로 열어 한/글이 정한 값(줄 vertpos·horzpos, 그림 상자)을 기준 JSON 으로 남긴다.
// 문단에는 저장 줄(linesegarray)을 넣지 않는다 — 편집기·AI 가 문단·그림을 넣은 문서처럼 엔진이 직접 조판하는 경로를 시험한다.
//
//   node scripts/layout-probe.mjs                 → tests/fixtures/layout/probe_objects.hwpx 생성(기본 서식: testdata/매크로테스트용_저장.hwpx)
//   node scripts/layout-probe.mjs --hangul        → 위 + 한/글 COM 으로 열어(인쇄 없이 CreatePageImage) tests/fixtures/layout/probe_objects_hangul.json 생성
//   node scripts/layout-trace.mjs tests/fixtures/layout/probe_objects.hwpx --hangul <한/글 결과 폴더>   → 문단별 비교
// 시험 사례(쪽마다 하나, `CASES`)의 이름·설명이 기준 JSON 의 cases 에 들어가 tests/layout_fidelity.test.mjs 가 사례별로 보고한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FIX = path.join(root, 'tests', 'fixtures', 'layout');

// ── 서식 번호(기본 서식 문서 header.xml 기준) ─────────────────────────────
const PARA_PLAIN = 28;   // 양쪽 정렬, 줄간격 180%, 여백 0
const PARA_BULLET = 29;  // 글머리표 ◦, 왼쪽 600, 170%
const PARA_CENTER = 59;  // 가운데, 180% — 글자처럼 그림 문단
const PARA_CAPTION = 18; // 캡션
const CHAR_BODY = 8;     // 11pt
const CHAR_CAPTION = 1;  // 10pt
const BODY_HEIGHT = 65762; // 이 서식의 본문 높이(HU) — 쪽 끝 사례의 높이 계산에 쓴다

let uid = 1900000000;
const nextId = () => String(uid++);
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FILL = '조판 시험 문장입니다. 한/글과 같은 줄에서 끊기는지 본다. ';
const LONG = (n) => FILL.repeat(n).trim();

function para({ paraPr = PARA_PLAIN, charPr = CHAR_BODY, pageBreak = false, runs = [] } = {}) {
  return `<hp:p id="${nextId()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${runs.length ? runs.join('') : `<hp:run charPrIDRef="${charPr}"/>`}</hp:p>`;
}
const textRun = (t, charPr = CHAR_BODY) => `<hp:run charPrIDRef="${charPr}"><hp:t>${esc(t)}</hp:t></hp:run>`;
const text = (t, o = {}) => para({ ...o, runs: [textRun(t, o.charPr)] });
const empty = (o = {}) => para(o);

function caption(side, label) {
  return `<hp:caption side="${side}" fullSz="0" width="8503" gap="850" lastWidth="42520"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `<hp:p id="0" paraPrIDRef="${PARA_CAPTION}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_CAPTION}"><hp:t>${esc(label)}</hp:t></hp:run></hp:p></hp:subList></hp:caption>`;
}

/** 그림 개체 XML. wrap: TOP_AND_BOTTOM | SQUARE | BEHIND_TEXT | IN_FRONT_OF_TEXT */
function pic({ w = 42520, h = 20000, tac = true, wrap = 'TOP_AND_BOTTOM', vertRelTo = 'PARA', horzRelTo = 'PARA', vertAlign = 'TOP', horzAlign = 'LEFT', vOff = 0, hOff = 0, margin = [0, 0, 0, 283], cap = null }) {
  const id = nextId();
  return `<hp:pic id="${id}" zOrder="${uid % 50}" numberingType="PICTURE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${nextId()}" reverse="0">`
    + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>`
    + `<hp:rotationInfo angle="0" centerX="${w >> 1}" centerY="${h >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    + `<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>`
    + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect><hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/>`
    + `<hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hp:effects/>`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="${tac ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="${tac ? 1 : 0}" holdAnchorAndSO="0" vertRelTo="${vertRelTo}" horzRelTo="${horzRelTo}" vertAlign="${vertAlign}" horzAlign="${horzAlign}" vertOffset="${vOff}" horzOffset="${hOff}"/>`
    + `<hp:outMargin left="${margin[0]}" right="${margin[1]}" top="${margin[2]}" bottom="${margin[3]}"/>`
    + (cap ? caption(cap.side || 'BOTTOM', cap.label || '[그림] 시험 그림') : '')
    + `</hp:pic>`;
}
const picRun = (o, charPr = CHAR_BODY) => `<hp:run charPrIDRef="${charPr}">${pic(o)}<hp:t/></hp:run>`;

/** 2행 2열 자리차지 표(문단 기준). */
function table({ pageBreak = 'CELL', cap = null, rows = 2, rowH = 2000 }) {
  const cell = (r, c) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="19"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `<hp:p id="0" paraPrIDRef="${PARA_PLAIN}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_BODY}"><hp:t>칸 ${r}-${c}</hp:t></hp:run></hp:p></hp:subList>`
    + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="21000" height="${rowH}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
  const trs = Array.from({ length: rows }, (_, r) => `<hp:tr>${cell(r, 0)}${cell(r, 1)}</hp:tr>`).join('');
  return `<hp:tbl id="${nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="${pageBreak}" repeatHeader="1" rowCnt="${rows}" colCnt="2" cellSpacing="0" borderFillIDRef="19" noAdjust="0">`
    + `<hp:sz width="42000" widthRelTo="ABSOLUTE" height="${rows * rowH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + (cap ? caption('TOP', cap).replace('lastWidth="42520"', 'lastWidth="42000"') : '')
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>${trs}</hp:tbl>`;
}

// 한 줄(11pt, 180%) = 1100 + 880. 쪽 끝 사례는 이 줄 K 개 뒤 남은 높이 R 을 기준으로 개체 높이를 고른다.
const LINE = 1100 + 880;
const fillLines = (k, first) => Array.from({ length: k }, (_, i) => text(`채움 줄 ${i + 1}. 짧은 한 줄 문단.`, { pageBreak: first && i === 0 }));
const fillEmpty = (k, first) => [text('빈 줄 채움 시작.', { pageBreak: first }), ...Array.from({ length: k - 1 }, () => empty())];

/** 글자처럼 그림 줄 높이 = 그림 + 아래 여백 283 + 캡션 간격 850 + 캡션 1000(10pt). */
const tacPicExtra = 283 + 850 + 1000;

const CASES = [];
function add(name, desc, paras) { CASES.push({ name, desc, paras }); }

// A. 쪽 끝 — 글자처럼 그림(캡션 포함)이 남은 높이에 딱 맞거나 1HU 넘칠 때
for (const d of [-75, -10, -1, 0, 1]) {
  const k = 20;
  const room = BODY_HEIGHT - k * LINE;
  add(`tac-fit${d >= 0 ? '+' : ''}${d}`, `채움 ${k}줄 뒤 남은 ${room} HU 에 글자처럼 그림(줄 높이 = 남은 높이 ${d >= 0 ? '+' : ''}${d}). 넘치면 다음 쪽.`,
    [...fillLines(k, true), para({ paraPr: PARA_CENTER, runs: [picRun({ h: room - tacPicExtra + d, cap: { label: `[그림] 쪽 끝 ${d}` } })] }), text('그림 뒤 글.')]);
}
// B. 빈 줄로 채운 뒤 글자처럼 그림
for (const d of [0, 1]) {
  const k = 20;
  const room = BODY_HEIGHT - k * LINE;
  add(`empty-fill${d >= 0 ? '+' : ''}${d}`, `빈 문단 ${k - 1}개(+첫 글줄) 뒤 글자처럼 그림(줄 높이 = 남은 높이 +${d}).`,
    [...fillEmpty(k, true), para({ paraPr: PARA_CENTER, runs: [picRun({ h: room - tacPicExtra + d, cap: { label: '[그림] 빈 줄 뒤' } })] }), text('그림 뒤 글.')]);
}
// C. 빈 줄만으로 쪽을 넘김 — 몇 번째 빈 줄에서 다음 쪽으로 가는가
add('empty-overflow', '빈 문단 40개 — 한/글이 쪽을 넘기는 빈 줄 차례.', [text('빈 줄 넘김 시작.', { pageBreak: true }), ...Array.from({ length: 39 }, () => empty()), text('빈 줄 뒤 글.')]);
// D. 자리차지(위아래) 그림이 쪽 끝에 걸릴 때 — 앵커 문단(빈/글) 과 함께 넘어가는가
add('topbottom-near-end-empty-host', '채움 28줄 뒤 자리차지 그림(높이 12000, 빈 앵커 문단) — 남은 높이보다 큼.',
  [...fillLines(28, true), para({ paraPr: PARA_PLAIN, runs: [picRun({ tac: false, h: 12000, w: 30000 })] }), text('자리차지 그림 뒤 글.')]);
add('topbottom-near-end-flow', '채움 28줄 뒤 자리차지 그림(빈 앵커) 다음 글 12줄 — 다음 쪽에서 글이 그림 아래로 가는가.',
  [...fillLines(28, true), para({ paraPr: PARA_PLAIN, runs: [picRun({ tac: false, h: 12000, w: 30000 })] }), ...Array.from({ length: 12 }, (_, i) => text(`그림 뒤 흐름 ${i + 1}.`))]);
add('topbottom-fits', '채움 20줄 뒤 자리차지 그림(높이 12000, 들어감) 다음 글.',
  [...fillLines(20, true), para({ paraPr: PARA_PLAIN, runs: [picRun({ tac: false, h: 12000, w: 30000 })] }), text('들어간 자리차지 그림 뒤 글.')]);
add('topbottom-near-end-text-host', '채움 28줄 뒤 자리차지 그림 + 같은 문단의 글 두 줄.',
  [...fillLines(28, true), para({ paraPr: PARA_PLAIN, runs: [picRun({ tac: false, h: 12000, w: 30000 }), textRun(LONG(3))] }), text('자리차지 그림 문단 다음 글.')]);
// E. 어울림(Square) 그림 — 글이 그림 옆으로 흐르는 자리(horzpos/horzsize)
add('square-left', '긴 문단 맨 앞에 왼쪽 어울림 그림(15000×12000).',
  [text('어울림 시작.', { pageBreak: true }), para({ runs: [picRun({ tac: false, wrap: 'SQUARE', w: 15000, h: 12000, margin: [283, 283, 283, 283] }), textRun(LONG(14))] }), text('어울림 뒤 글.')]);
add('square-right-offset', '긴 문단에 오른쪽 어울림 그림, 세로 오프셋 3000.',
  [text('어울림 오른쪽 시작.', { pageBreak: true }), para({ runs: [picRun({ tac: false, wrap: 'SQUARE', w: 15000, h: 12000, horzAlign: 'RIGHT', vOff: 3000, margin: [283, 283, 283, 283] }), textRun(LONG(14))] }), text('어울림 뒤 글.')]);
// F. 글 뒤 / 글 앞 — 글이 비키지 않는다
add('behind-infront', '글 뒤로·글 앞으로 그림 — 글 흐름에 영향이 없어야 한다.',
  [text('글뒤 시작.', { pageBreak: true }), para({ runs: [picRun({ tac: false, wrap: 'BEHIND_TEXT', w: 20000, h: 8000 }), textRun(LONG(4))] }),
    para({ runs: [picRun({ tac: false, wrap: 'IN_FRONT_OF_TEXT', w: 20000, h: 8000, horzAlign: 'RIGHT' }), textRun(LONG(4))] }), text('글앞 뒤 글.')]);
// G. 쪽 기준 위아래 그림 — 본문 중간 띠를 글이 건너뛴다
add('page-relative-topbottom', '쪽 기준(세로 30000) 위아래 그림 — 그 띠를 글이 건너뛴다.',
  [para({ pageBreak: true, runs: [picRun({ tac: false, vertRelTo: 'PAGE', horzRelTo: 'PAGE', horzAlign: 'CENTER', vOff: 30000, w: 30000, h: 10000 }), textRun('쪽 기준 그림 앵커 문단.')] }),
    ...Array.from({ length: 24 }, (_, i) => text(`쪽 기준 그림 아래로 흐르는 글 ${i + 1}.`))]);
// H. 글 사이 글자처럼 그림 — 줄 높이
add('inline-tac-in-text', '글 사이에 작은 글자처럼 그림(3000×2000) — 그 줄의 높이와 기준선.',
  [text('글 사이 그림 시작.', { pageBreak: true }), para({ runs: [textRun('앞 글 '), picRun({ w: 3000, h: 2000, margin: [0, 0, 0, 0] }), textRun(' 뒤 글. ' + LONG(3))] }), text('다음 문단.')]);
// I. 빈 앵커 표 — 앵커 줄(글머리표 유무·표 나눔 방식)이 표 아래 한 줄을 차지하는가
add('empty-anchor-tables', '빈 앵커 문단의 자리차지 표 4개: 글머리표 없음/있음 × 표 나눔 CELL/NONE.',
  [text('표 앵커 시작.', { pageBreak: true }),
    para({ paraPr: PARA_PLAIN, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${table({ pageBreak: 'CELL' })}<hp:t/></hp:run>`] }), text('표1 뒤 글(앵커 글머리표 없음, CELL).'),
    para({ paraPr: PARA_BULLET, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${table({ pageBreak: 'CELL' })}<hp:t/></hp:run>`] }), text('표2 뒤 글(앵커 글머리표, CELL).'),
    para({ paraPr: PARA_PLAIN, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${table({ pageBreak: 'NONE' })}<hp:t/></hp:run>`] }), text('표3 뒤 글(글머리표 없음, NONE).'),
    para({ paraPr: PARA_BULLET, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${table({ pageBreak: 'NONE', cap: '[표] 캡션 있는 표' })}<hp:t/></hp:run>`] }), text('표4 뒤 글(글머리표, NONE, 위 캡션).')]);

// ── 문서 만들기 ─────────────────────────────────────────────────────────
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 80 + (x * 150) / w; raw[o + 1] = 120 + (y * 100) / h; raw[o + 2] = 200; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function buildProbe(templatePath, outPath) {
  const zin = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const section = await zin.file('Contents/section0.xml').async('string');
  // 첫 문단의 구역·단 정의만 남긴다(글·메모는 뺀다).
  const start = section.indexOf('<hp:p ');
  const secEnd = section.indexOf('</hp:secPr>');
  const colEnd = section.indexOf('</hp:ctrl>', secEnd) + '</hp:ctrl>'.length;
  const head = section.slice(0, start);
  const first = section.slice(start, colEnd).replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${PARA_PLAIN}"`) + `</hp:run>${textRun('조판 시험지 — 사례마다 새 쪽에서 시작한다.')}</hp:p>`;
  const body = CASES.flatMap((c) => c.paras).join('');
  const out = new JSZip();
  for (const [name, f] of Object.entries(zin.files)) {
    if (f.dir) continue;
    if (name === 'Contents/section0.xml') out.file(name, head + first + body + '</hs:sec>');
    else if (/^BinData\/image\d+\.png$/.test(name)) out.file(name, png(60, 30));
    else if (/^Preview\//.test(name)) continue;
    else out.file(name, await f.async('uint8array'), { compression: name === 'mimetype' ? 'STORE' : 'DEFLATE' });
  }
  // mimetype 은 첫 항목·무압축이어야 한다.
  const ordered = new JSZip();
  ordered.file('mimetype', await out.file('mimetype').async('uint8array'), { compression: 'STORE' });
  for (const [name, f] of Object.entries(out.files)) if (name !== 'mimetype' && !f.dir) ordered.file(name, await f.async('uint8array'));
  fs.writeFileSync(outPath, await ordered.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  // 사례 경계 — 사례 i 는 문단 [startPara, endPara) (0번 문단은 구역 정의 문단).
  let pi = 1;
  return CASES.map((c) => { const r = { name: c.name, desc: c.desc, startPara: pi, endPara: pi + c.paras.length }; pi += c.paras.length; return r; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const template = args.includes('--template') ? args[args.indexOf('--template') + 1] : path.join(root, 'testdata', '매크로테스트용_저장.hwpx');
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(FIX, 'probe_objects.hwpx');
  const cases = await buildProbe(template, outPath);
  console.log(`시험지: ${outPath} (사례 ${cases.length}개)`);
  if (args.includes('--hangul')) {
    // 한/글 기준: 인쇄 없이 CreatePageImage 쪽 그림(그림은 표식 색 사본) + 재저장본 저장 줄 + 문단 쪽 번호(scripts/hangul-oracle.mjs)
    const { runHangulOracle, alignPagesWithParaPages } = await import('./hangul-oracle.mjs');
    const { hangulLayout, hangulView, oracleFromHangul } = await import('./layout-trace.mjs');
    const dir = await runHangulOracle(outPath, { tables: true });
    const hangul = await hangulLayout(path.join(dir, 'saved.hwpx'));
    const view = await hangulView(dir);
    alignPagesWithParaPages(hangul, view.paraPages);
    const oracle = oracleFromHangul(path.relative(root, outPath).replace(/\\/g, '/'), hangul, view, { cases });
    const oraclePath = outPath.replace(/\.hwpx$/, '_hangul.json');
    fs.writeFileSync(oraclePath, JSON.stringify(oracle));
    console.log(`한/글 기준: ${oraclePath} (한/글 쪽 그림 ${view.pages.length}쪽) · 한/글 결과 폴더 ${dir}`);
  }
}
