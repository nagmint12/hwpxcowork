// 시험지(입력)·한/글 재저장본을 rhwp 엔진으로 조판해 표지 줄 B 가 표 첫 조각 쪽에 남는지 본다.
//   node scripts/layout-probe-cellcut-engine.mjs <시험지 폴더> [pkg 폴더]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [,, dir, pkgArg] = process.argv;
const pkg = pkgArg || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'rhwp', 'pkg');
globalThis.measureTextWidth ??= (font, text) => [...text].length * 10;
const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const oracle = fs.existsSync(path.join(dir, 'oracle', 'oracle.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'oracle', 'oracle.json'), 'utf8')) : null;

function where(file) {
  const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(file)));
  let first = -1, b = -1;
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    const s = doc.getPageRenderTree(pg);
    if (first < 0 && s.includes('"text":"채움 "')) first = pg;
    if (s.includes('BBBB')) b = pg;
  }
  return first < 0 || b < 0 ? null : b - first;
}
let agreeIn = 0, agreeSaved = 0, n = 0;
for (const c of meta.cases) {
  const o = oracle?.cases.find((x) => x.name === c.name);
  const hg = o ? o.red[0].page - 1 : null; // 한/글: 표는 둘째 쪽(1)에서 시작
  const eIn = where(path.join(dir, c.name + '.hwpx'));
  const saved = path.join(dir, 'oracle', c.name + '.saved.hwpx');
  const eSaved = fs.existsSync(saved) ? where(saved) : null;
  n++; if (eIn === hg) agreeIn++; if (eSaved === hg) agreeSaved++;
  console.log(`${c.name.padEnd(28)} 한/글 ${hg} | 엔진(입력) ${eIn}${eIn === hg ? '' : ' ✗'} | 엔진(한/글 재저장) ${eSaved}${eSaved === hg ? '' : ' ✗'}`);
}
console.log(`일치: 입력 ${agreeIn}/${n}, 재저장 ${agreeSaved}/${n}`);
