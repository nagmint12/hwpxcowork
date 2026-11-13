// 나뉜 칸 컷 시험지(2026-11-11): 쪽 맨 위 1행 CELL(나눔) 표의 칸 안 빨간 표지 줄 B 의 줄 윗끝에서 쪽 끝까지 d HU 가 되도록
// 아래 여백을 바꿔 가며 사례마다 파일을 만든다. 한/글이 B 를 첫 쪽에 두는 최소 d 를 잰다(줄 높이·칸 아래 여백·101HU — vendor/README 76).
//   [CH=1100 PCT=180 SA=500 CMT=0 CMB=0 LO=0 HI=2600 STEP=100 VAR=pend-empty,mid] node scripts/layout-probe-cellcut.mjs testdata/매크로테스트용_저장.hwpx <out_dir>
//   python -I scripts/layout-probe-cellcut-oracle.py <out_dir>      (숨은 한/글 COM — 쪽 그림 + 재저장 줄, PDF 없음)
//   node scripts/layout-probe-cellcut-engine.mjs <out_dir> [pkg]     (엔진: 입력·한/글 재저장본에서 B 쪽 비교)
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
const [,, tpl, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });

const CH = +(process.env.CH || 1100);
const PCT = +(process.env.PCT || 180);
const LS = Math.round(CH * (PCT - 100) / 100);
const SA = +(process.env.SA ?? 500);                // 문단 뒤 간격
const PITCH_P = CH + LS + SA;  // 2480
const PITCH_L = CH + LS;       // 1980
const K = Math.floor(58000 / (CH + LS + SA));
const BODY0 = 65762;           // 틀의 본문 높이(아래 여백 4252)
const MB0 = 4252;
const PARA = 60, RED = 52;
const CMT = +(process.env.CMT || 0), CMB = +(process.env.CMB || 0);

let uid = 1700000000;
const id = () => String(uid++);
const BODYCP = 53;
const run = (t, cp = BODYCP) => `<hp:run charPrIDRef="${cp}"><hp:t>${t}</hp:t></hp:run>`;
const p = (runs, pp = PARA) => `<hp:p id="${id()}" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs || `<hp:run charPrIDRef="${BODYCP}"/>`}</hp:p>`;

function cellParas(kind) {
  const fill = Array.from({ length: K }, (_, i) => p(run(`채움 ${i + 1}`)));
  if (kind === 'mid') {
    // 마지막 채움 뒤 한 문단 안에 A / B / C 세 줄(강제 줄 나눔) — B 는 문단 가운데 줄
    fill.pop();
    return [...fill, p(run('A 줄') + `<hp:run charPrIDRef="${RED}"><hp:t><hp:lineBreak/>BBBB 표지<hp:lineBreak/></hp:t></hp:run>` + run('C 줄')), p(run('뒤 문단'))];
  }
  // last: B 가 칸(표)의 마지막 줄 — 끝 조각이 쪽 끝에 닿을 때도 같은 문턱인지 본다.
  const next = kind === 'last' ? [] : kind === 'emptyNext' ? [p(''), p(run('C 다음'))] : [p(run('C 다음')), p(run('D 다음'))];
  return [...fill, p(run('BBBB 표지', RED)), ...next];
}
function cell(col, paras) {
  return `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras.join('')}</hp:subList>`
    + `<hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="21000" height="2000"/><hp:cellMargin left="141" right="141" top="${CMT}" bottom="${CMB}"/></hp:tc>`;
}
function table(kind, shared) {
  const a = cellParas(kind);
  const b = shared ? cellParas(kind).map((x) => x.replace(/id="\d+"/, () => `id="${id()}"`)) : [p(run('x'))];
  return `<hp:tbl id="${id()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="2" cellSpacing="0" borderFillIDRef="1" noAdjust="0">`
    + `<hp:sz width="42000" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="${CMT}" bottom="${CMB}"/><hp:tr>${cell(0, a)}${cell(1, b)}</hp:tr></hp:tbl>`;
}
// B 의 줄 윗끝(칸 안, HU)
const yB = (kind) => CMT + (kind === "mid" ? (K - 1) * PITCH_P + PITCH_L : K * PITCH_P);

const z0 = fs.readFileSync(tpl);
const zt = await JSZip.loadAsync(z0);
let header = await zt.file('Contents/header.xml').async('string');
const pp28 = header.match(/<hh:paraPr id="28"[\s\S]*?<\/hh:paraPr>/)[0];
const pp60 = pp28.replace('id="28"', `id="${PARA}"`).replace(/<hc:next value="0"/g, `<hc:next value="${SA}"`).replace(/type="PERCENT" value="180"/g, `type="PERCENT" value="${PCT}"`);
header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (+n + 1) + b).replace('</hh:paraProperties>', pp60 + '</hh:paraProperties>');
const cp8 = header.match(/<hh:charPr id="8"[\s\S]*?<\/hh:charPr>/)[0];
const cpH = cp8.replace('height="1100"', `height="${CH}"`);
const cpRed = cpH.replace('id="8"', `id="${RED}"`).replace('textColor="#000000"', 'textColor="#FF0000"');
const cpBody = cpH.replace('id="8"', `id="${BODYCP}"`);
header = header.replace(/(<hh:charProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (+n + 2) + b).replace('</hh:charProperties>', cpRed + cpBody + '</hh:charProperties>');
const sec = await zt.file('Contents/section0.xml').async('string');
let depth = 0, firstEnd = -1;
for (const m of sec.matchAll(/<(\/?)hp:p\b[^>]*?(\/?)>/g)) {
  if (m[2]) continue;
  if (!m[1]) depth++;
  else if (--depth === 0) { firstEnd = m.index + m[0].length; break; }
}
const close = sec.lastIndexOf('</hs:sec>');

const VARIANTS0 = [
  { name: 'pend-empty', kind: 'emptyNext', shared: false },
  { name: 'pend-text', kind: 'textNext', shared: false },
  { name: 'pend-empty-shared', kind: 'emptyNext', shared: true },
  { name: 'mid', kind: 'mid', shared: false },
  { name: 'last', kind: 'last', shared: false },
  { name: 'last-shared', kind: 'last', shared: true },
];
const VARIANTS = process.env.VAR ? VARIANTS0.filter((v) => process.env.VAR.split(',').includes(v.name)) : VARIANTS0;
const step = +(process.env.STEP || 100);
const lo = +(process.env.LO || 0), hi = +(process.env.HI || 2600);
const cases = [];
for (const v of VARIANTS) {
  const y = yB(v.kind);
  for (let d = lo; d <= hi; d += step) {
    // 본문 높이 = y + d  → 아래 여백 = MB0 + (BODY0 - (y + d))
    const mb = MB0 + (BODY0 - (y + d));
    if (mb < 0) continue;
    const name = `${v.name}_d${String(d).padStart(4, '0')}`;
    const host = `<hp:p id="${id()}" paraPrIDRef="28" styleIDRef="0" pageBreak="1" columnBreak="0" merged="0"><hp:run charPrIDRef="8">${table(v.kind, v.shared)}<hp:t/></hp:run></hp:p>`;
    const body = sec.slice(0, firstEnd).replace(/(<hp:margin [^>]*bottom=")(\d+)(")/, (m, a, n, b) => a + mb + b) + host + p(run('표 뒤 글'), 28) + sec.slice(close);
    const z = await JSZip.loadAsync(z0);
    z.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
    z.file('Contents/header.xml', header);
    z.file('Contents/section0.xml', body);
    z.remove('Preview/PrvImage.png');
    fs.writeFileSync(path.join(outDir, name + '.hwpx'), await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' }));
    cases.push({ name, variant: v.name, kind: v.kind, shared: v.shared, d, yB: y, inkEnd: y + CH, lineEnd: y + CH + LS, paraEnd: y + PITCH_P, bodyHeight: y + d, bottomMargin: mb });
  }
}
fs.writeFileSync(path.join(outDir, 'cases.json'), JSON.stringify({ CH, LS, SA, K, cases }, null, 1));
console.log('cases', cases.length);
