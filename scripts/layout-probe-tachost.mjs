// 글자처럼 취급한 표 + 줄 바꿈 + 글줄 문단 시험지(2026-11-16).
// 표준서식 생성 보고서(저장 줄 없음)에서 "표 + <줄 바꿈> + 주: …" 문단의 표 뒤 글줄을 엔진 조판 흐름이 되감아
// 뒤 문단이 위로 당겨지고 쪽 끝 문단이 본문 밖으로 넘쳤다(한/글 76쪽 ↔ 엔진 73쪽). 같은 모양의 문단을 지어낸 글로
// 여러 쪽에 늘어놓아, 한/글이 정한 쪽·줄 위치를 기준으로 남긴다. 저장 줄(linesegarray)은 넣지 않는다.
//
//   node scripts/layout-probe-tachost.mjs [--pageend] [testdata/매크로테스트용_저장.hwpx] [출력 .hwpx]
//   node scripts/layout-trace.mjs <출력 .hwpx> --run-hangul --save-oracle <기준 .json>   (숨은 한/글 COM — 쪽 그림 + 재저장 줄)
// --pageend: 쪽 끝 시험(사례마다 새 쪽) — 빈 줄 M개(992HU씩) 뒤에 표(4행, 줄 6355HU) + 주석 n줄 문단을 두어, 표는 들어가고
//            주석은 0~n줄 들어가는 자리를 두루 만든다. 한/글이 표·주석을 어디서 나누는지(통째 넘김 / 표 뒤 / 주석 사이) 잰다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PAGE_END = process.argv.includes('--pageend');
const WRAP = process.argv.includes('--wrap'); // 주석을 강제 줄 바꿈 없이 한 덩이 글로(저절로 n줄로 접힘)
const KEEP = process.argv.includes('--keep'); // 표 문단에 문단 보호(keepLines) — 표준서식 보고서의 표 문단 모양
const CAPNUM = process.argv.includes('--capnum'); // 캡션 자동 번호 폭(번호를 표시 숫자 폭으로 재는지)
const args = process.argv.slice(2).filter((a) => !['--pageend', '--wrap', '--keep', '--capnum'].includes(a));
const tplArg = args[0];
const tpl = tplArg || path.join(root, 'testdata', fs.readdirSync(path.join(root, 'testdata')).find((n) => n.includes('매크로테스트용_저장') && n.endsWith('.hwpx')));
const out = path.resolve(args[1] || path.join(root, 'tests', 'fixtures', 'layout', 'tachost-20261116', CAPNUM ? 'tachost_capnum.hwpx' : PAGE_END ? `tachost_pageend${WRAP ? '_wrap' : ''}${KEEP ? '_keep' : ''}.hwpx` : 'tachost.hwpx'));

// 서식 번호: 틀의 paraPr 28(양쪽, 180%)을 복제해 표 문단(왼쪽 110%)·본문(양쪽 170%, 위·아래 100)을 더한다.
// 새 번호는 틀의 마지막 번호 바로 다음이어야 한다 — 한/글은 paraPr 를 목록 차례로 읽어, 번호를 건너뛰면
// (예: 60개 틀에 90·91) 엔진과 다른 문단 모양을 쓴다(첫 측정에서 한/글 160%·엔진 110% 로 갈렸다). 아래에서 확인한다.
const PARA_BODY = 28;
const PARA_HOST = 60;  // 왼쪽, 110% — 표 + 줄 바꿈 + 주석 문단(보고서 paraPr 30 과 같은 값)
const PARA_TEXT = 61;  // 양쪽, 170%, 문단 위·아래 100(보고서 본문 paraPr 6 과 같은 값)
const CHAR_BODY = 8;   // 11pt
const CHAR_NOTE = 27;  // 9pt
const CHAR_CELL = 21;  // 10pt

let uid = 1950000000;
const id = () => String(uid++);
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t, cp) => `<hp:run charPrIDRef="${cp}"><hp:t>${esc(t)}</hp:t></hp:run>`;
const para = (pp, inner, cp = CHAR_BODY) => `<hp:p id="${id()}" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${inner || `<hp:run charPrIDRef="${cp}"/>`}</hp:p>`;

const FILL = '조판 시험 문장입니다. 표 뒤 글줄이 문단 높이에 들어가는지 쪽 나눔으로 본다. ';
const body = (n) => para(PARA_TEXT, run(FILL.repeat(n).trim(), CHAR_BODY));
// 한 줄(9pt, 본문 폭 안)에 들어가는 주석 조각 — 줄 수는 한/글과 엔진 모두 같은 글로 정해진다.
const NOTE = '주: 지어낸 시험용 설명 글입니다. 이 줄은 표 뒤 같은 문단의 글줄로 놓입니다. ';

function cell(col, row, text, w) {
  return `<hp:tc name="" header="${row === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">`
    + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `${para(31, run(text, CHAR_CELL))}</hp:subList>`
    + `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${w}" height="1112"/>`
    + `<hp:cellMargin left="300" right="300" top="150" bottom="150"/></hp:tc>`;
}
function table(rows, caption) {
  const W = 42000; const cols = 3; const cw = W / cols;
  const trs = Array.from({ length: rows }, (_, r) => `<hp:tr>${Array.from({ length: cols }, (_, c) => cell(c, r, r === 0 ? `항목 ${c + 1}` : `${r}-${c + 1}`, cw)).join('')}</hp:tr>`).join('');
  const cap = caption ? `<hp:caption side="TOP" fullSz="0" width="8503" gap="850" lastWidth="${W}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${para(31, run(caption, CHAR_CELL))}</hp:subList></hp:caption>` : '';
  return `<hp:tbl id="${id()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="NONE" repeatHeader="1" rowCnt="${rows}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">`
    + `<hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${rows * 1112}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="57"/>${cap}<hp:inMargin left="56" right="56" top="56" bottom="56"/>${trs}</hp:tbl>`;
}
// 표 + 줄 바꿈 + 주석 n줄(줄마다 강제 줄 바꿈 — 줄 수를 글 폭과 무관하게 정한다).
// WRAP: 주석 한 덩이(낱말 '주석문장' 반복, 강제 줄 바꿈 없음) — 낱말 수 = (n − 1) × 13 + 3 이면 9pt·본문 폭에서 n줄로 접힌다
// (엔진 줄 수로 확인하고, 한/글 재저장 줄 수와도 견준다).
function host(rows, noteLines, caption) {
  const notes = WRAP
    ? (noteLines ? `주: ${Array.from({ length: (noteLines - 1) * 13 + 3 }, () => '주석문장').join(' ')}` : '')
    : Array.from({ length: noteLines }, (_, i) => `${NOTE}(${i + 1})`).join('\n');
  const t = esc(notes).split('\n').join('<hp:lineBreak/>');
  return `<hp:p id="${id()}" paraPrIDRef="${PARA_HOST}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">`
    + `<hp:run charPrIDRef="${CHAR_NOTE}">${table(rows, caption)}<hp:t><hp:lineBreak/></hp:t></hp:run>`
    + (noteLines ? `<hp:run charPrIDRef="${CHAR_NOTE}"><hp:t>${t}</hp:t></hp:run>` : '')
    + `</hp:p>`;
}
const gap = (pageBreak = false) => `<hp:p id="${id()}" paraPrIDRef="${PARA_HOST}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_NOTE}"/></hp:p>`;

const blocks = [];
const cases = [];
if (CAPNUM) {
  // capnumCases() 가 채운다(엔진으로 자연 폭을 잰 뒤)
} else if (!PAGE_END) {
  // 쪽마다 본문 → 표 문단 → 빈 줄을 되풀이한다. 주석 줄 수·표 행 수를 돌려 쪽 끝 걸림 자리가 여러 가지가 되게 한다.
  const notesSeq = [3, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 3, 2, 0, 3, 2, 1, 3];
  notesSeq.forEach((k, i) => {
    blocks.push(body(2 + (i % 3)));
    blocks.push(host(4 + (i % 4) * 2, k, `[표 ${i + 1}] 시험 표 제목`));
    blocks.push(gap());
  });
} else {
  // 쪽 끝 시험: 새 쪽 첫머리부터 빈 줄(9pt 110% = 900 + 92) M개, 그 뒤 표 문단. 표 줄 높이 = 행 수 × 1112 + 바깥 아래 57
  // + 캡션(10pt 1000 + 간격 850) — 첫 측정(tachost.hwpx)에서 4행 6355 를 확인했다. 주석 줄 = 900 + 92.
  // 사례마다 "주석이 몇 줄 들어갈 자리인가(fit)"를 정하고, 그 경계가 문턱에서 250HU 이상 떨어지게 M·행 수를 고른다.
  const BODY = 65762; const GAP = 992; const NOTE_LH = 900; const NOTE_LS = 92; const CAPTION = 1850; const OM = 57;
  const tableLh = (rows) => rows * 1112 + OM + CAPTION;
  let pi = 1; // 구역 첫 문단 뒤부터 센다
  for (const n of [1, 2, 3, 5]) {
    for (let fit = -1; fit <= n; fit++) {
      let pick = null;
      for (const rows of [4, 5, 6]) for (let m = 30; m <= 66 && !pick; m++) {
        const top = m * GAP; const t = tableLh(rows);
        const room = BODY - top - t; // 표 줄 뒤 남은 높이(음수면 표가 안 들어감)
        const bottom = (k) => t + NOTE_LS + (k - 1) * (NOTE_LH + NOTE_LS) + NOTE_LH; // 표 줄 위부터 k번째 주석 줄 아래까지
        const ok = fit < 0 ? room < -250
          : room > 250 && (fit === 0 || BODY - top - bottom(fit) > 250) && (fit === n || top + bottom(fit + 1) - BODY > 250);
        if (ok) pick = { rows, m };
      }
      if (!pick) throw new Error(`사례를 못 만든다: 주석 ${n}줄, 들어갈 줄 ${fit}`);
      const name = `${KEEP ? 'k' : ''}${WRAP ? 'w' : ''}n${n}-fit${fit < 0 ? 'none' : fit}`;
      const paras = [gap(true), ...Array.from({ length: pick.m - 1 }, () => gap()), host(pick.rows, n, `[표] ${name}`)];
      cases.push({ name, notes: n, fitNotes: fit, tableFits: fit >= 0, rows: pick.rows, gaps: pick.m, startPara: pi, hostPara: pi + pick.m });
      pi += paras.length;
      blocks.push(...paras);
    }
  }
}


// --capnum: 캡션 자동 번호 폭. 글자처럼 취급한 1×1 표(폭 W) + 위 캡션 "[표 <자동 번호>] 글…"(10pt, 양쪽 180%).
// 번호를 글자로 쓴 같은 글의 자연 폭(엔진 — RHWP_PKG 또는 vendor/rhwp/pkg)보다 W 를 d HU 좁힌다(d = −400·−150·+150·+400,
// 문턱에서 150HU 이상 떨어뜨림). 한/글은 번호를 표시 숫자 폭으로 재어 d > 0 이면 캡션을 두 줄로 나눈다(보고서 글꼴 시험
// artifacts/pagefix-20261116/capnum-probe.mjs 에서 d = +60 부터 나눔). 한 자리(표 1~8)·두 자리(표 10~17), 표 9 는 번호 채움.
const CAP_TEXT = '지어낸 캡션 글로 줄 끝 폭을 재는 시험 문장';
function capPara(autoNum, n) {
  const num = autoNum
    ? `<hp:ctrl><hp:autoNum num="${n}" numType="TABLE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>`
    : `<hp:t>${n}</hp:t>`;
  return `<hp:p id="${id()}" paraPrIDRef="${PARA_BODY}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_CELL}"><hp:t>[표 </hp:t>${num}<hp:t>] ${esc(CAP_TEXT)}</hp:t></hp:run></hp:p>`;
}
function capTable(W, n) {
  const sub = '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">';
  return `<hp:p id="${id()}" paraPrIDRef="${PARA_HOST}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_NOTE}">`
    + `<hp:tbl id="${id()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="NONE" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">`
    + `<hp:sz width="${W}" widthRelTo="ABSOLUTE" height="1112" heightRelTo="ABSOLUTE" protect="0"/>`
    + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
    + '<hp:outMargin left="0" right="0" top="0" bottom="57"/>'
    + `<hp:caption side="TOP" fullSz="0" width="8503" gap="850" lastWidth="${W}">${sub}${capPara(true, n)}</hp:subList></hp:caption>`
    + '<hp:inMargin left="56" right="56" top="56" bottom="56"/>'
    + `<hp:tr>${cell(0, 0, '칸', W)}</hp:tr></hp:tbl><hp:t/></hp:run></hp:p>`;
}
async function capnumCases() {
  const pkg = path.resolve(process.env.RHWP_PKG || path.join(root, 'vendor', 'rhwp', 'pkg'));
  globalThis.measureTextWidth ??= (f, t) => t.length * 10;
  const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
  mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
  const doc = new mod.HwpDocument(new Uint8Array(await buildDoc([capPara(false, 1), capPara(false, 12)])));
  doc.convertToEditable();
  const natural = [];
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    (function walk(node) {
      if (node.type === 'TextLine' && (node.pi === 1 || node.pi === 2)) {
        const runs = (node.children || []).filter((c) => c.type === 'TextRun');
        natural[node.pi - 1] = Math.round((Math.max(...runs.map((r) => r.bbox.x + r.bbox.w)) - Math.min(...runs.map((r) => r.bbox.x))) * 75);
      }
      for (const c of node.children || []) walk(c);
    })(JSON.parse(doc.getPageRenderTree(pg)));
  }
  doc.free();
  if (!(natural[0] > 0 && natural[1] > natural[0])) throw new Error(`자연 폭을 못 쟀다: ${natural}`);
  let n = 1; let pi = 1;
  const add = (W, c) => { blocks.push(capTable(W, n), gap()); if (c) cases.push({ ...c, n, W, hostPara: pi, gapPara: pi + 1 }); pi += 2; n++; };
  for (const digits of [1, 2]) {
    while (digits === 2 && n < 10) add(40000, null); // 번호를 10 으로(캡션이 넉넉한 채움 표)
    for (const d of [-400, -150, 150, 400]) add(natural[digits - 1] - d, { name: `d${digits}${d < 0 ? 'm' : 'p'}${Math.abs(d)}`, digits, d, natural: natural[digits - 1], wraps: d > 0 });
  }
}

async function buildDoc(docBlocks) {
  const zin = await JSZip.loadAsync(fs.readFileSync(tpl));
  let header = await zin.file('Contents/header.xml').async('string');
  const paraCount = +header.match(/<hh:paraProperties itemCnt="(\d+)"/)[1];
  if (paraCount !== PARA_HOST || PARA_TEXT !== PARA_HOST + 1) throw new Error(`틀의 문단 모양이 ${paraCount}개다 — PARA_HOST 를 ${paraCount} 로 맞춘다`);
  const pp28 = header.slice(header.indexOf(`<hh:paraPr id="${PARA_BODY}"`), header.indexOf('</hh:paraPr>', header.indexOf(`<hh:paraPr id="${PARA_BODY}"`)) + '</hh:paraPr>'.length);
  const ppHost = pp28.replace(`id="${PARA_BODY}"`, `id="${PARA_HOST}"`).replace(/keepLines="0"/, KEEP ? 'keepLines="1"' : 'keepLines="0"').replace('horizontal="JUSTIFY"', 'horizontal="LEFT"').replace(/type="PERCENT" value="180"/g, 'type="PERCENT" value="110"').replace(/breakNonLatinWord="KEEP_WORD"/, 'breakNonLatinWord="BREAK_WORD"');
  const ppText = pp28.replace(`id="${PARA_BODY}"`, `id="${PARA_TEXT}"`).replace(/type="PERCENT" value="180"/g, 'type="PERCENT" value="170"').replace(/<hc:prev value="0"/g, '<hc:prev value="100"').replace(/<hc:next value="0"/g, '<hc:next value="100"');
  header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (+n + 2) + b).replace('</hh:paraProperties>', ppHost + ppText + '</hh:paraProperties>');
  const sec = await zin.file('Contents/section0.xml').async('string');
  // 첫 문단(구역 정의)은 두고 나머지 본문을 시험 문단으로 바꾼다.
  let depth = 0; let firstEnd = -1;
  for (const m of sec.matchAll(/<(\/?)hp:p\b[^>]*?(\/?)>/g)) {
    if (m[2]) continue;
    if (!m[1]) depth++;
    else if (--depth === 0) { firstEnd = m.index + m[0].length; break; }
  }
  const close = sec.lastIndexOf('</hs:sec>');
  const xml = sec.slice(0, firstEnd) + docBlocks.join('') + sec.slice(close);
  zin.file('Contents/header.xml', header);
  zin.file('Contents/section0.xml', xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, ''));
  return zin.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
if (CAPNUM) await capnumCases();
fs.writeFileSync(out, await buildDoc(blocks));
if (PAGE_END || CAPNUM) {
  fs.writeFileSync(out.replace(/\.hwpx$/, '_cases.json'), JSON.stringify(cases, null, 1));
  console.log(`${out} — 사례 ${cases.length}개: ${cases.map((c) => (CAPNUM ? `${c.name}(표 ${c.n}·폭 ${c.W})` : `${c.name}(행${c.rows}·빈줄${c.gaps})`)).join(' ')}`);
} else {
  console.log(`${out} — 표 문단 ${blocks.length / 3}개`);
}
