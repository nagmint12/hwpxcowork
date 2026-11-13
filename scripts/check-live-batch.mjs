// 실시간 밀어 넣기(server/live.js)의 엔진 묶음(LiveEditor.batch — clearParagraphsTracked·deleteBreaksTracked·insertTrackedParagraphsAfter 등)을
// 켠 결과와 끈 결과(하나씩)를 바이트로 견준다. 묶음 길을 고치거나 새 묶음을 더할 때 '같은 결과'인지 큰 문서로 확인하는 도구
// (npm test 의 tests/live_track_batch.test.mjs 는 작은 fixture 만 — 운영 문서 사본·표본 보고서는 이 도구로).
//
//   node scripts/check-live-batch.mjs <hwpx...> [--track tracked|final]
//
// 문서마다 여섯 장면: 가운데 덩어리 잘라내기·전체 잘라내기·잘라 낸 것 다시 붙이기·전체 잘라낸 뒤 다시 붙이기·바꿔 붙이기·잘라낸 뒤 바꿔 붙이기.
// 날짜·Math.random(개체 새 id)은 고정한다(tests/helpers/live-batch.mjs). 출력: 장면마다 SAME/DIFF, 두 길의 시간, 묶음 함수가 일한 횟수.
// 데이터 폴더·운영 서버는 쓰지 않는다(임시 저장소). 운영 문서를 쓰려면 data/docs/<id>/current.hwpx 를 다른 곳에 복사해서 넘긴다.
import fs from 'node:fs';
import path from 'node:path';
import { compareBatch, withoutParagraphs, withCopiedParagraphs, bodyCount } from '../tests/helpers/live-batch.mjs';
import { HwpxDoc } from '../engine/doc.js';

const args = process.argv.slice(2);
const ti = args.indexOf('--track');
const track = ti >= 0 ? args.splice(ti, 2)[1] : 'tracked';
if (!args.length) { console.error('사용: node scripts/check-live-batch.mjs <hwpx...> [--track tracked|final]'); process.exit(2); }

const hits = {};
for (const n of ['clearParagraphsTracked', 'deleteBreaksTracked', 'insertTrackedParagraphsAfter']) {
  const f = HwpxDoc.prototype[n];
  HwpxDoc.prototype[n] = function (...a) { const r = f.apply(this, a); const k = `${n}:${r ? 'ok' : 'null'}`; hits[k] = (hits[k] || 0) + 1; return r; };
}
const firstDiff = (A, B) => { let k = 0; while (k < A.length && A[k] === B[k]) k++; return k; };

let bad = 0;
for (const f of args) {
  const D = fs.readFileSync(f);
  const N = await bodyCount(D);
  if (N < 4) { console.log(path.basename(f), '건너뜀(본문 문단', N, ')'); continue; }
  const a = Math.max(1, Math.floor(N * 0.2)); const b = Math.max(a + 1, Math.floor(N * 0.6));
  const cut = await withoutParagraphs(D, a, b);
  const all = await withoutParagraphs(D, 1, N - 1);
  const n2 = await bodyCount(cut);
  const c = Math.max(1, Math.floor(n2 * 0.5)); const d = Math.min(n2 - 1, c + Math.max(2, Math.floor(N * 0.15)));
  const replaced = await withCopiedParagraphs(cut, c, d, a);
  const scenes = { cutBlock: [D, [cut]], cutAll: [D, [all]], pasteBack: [cut, [D]], cutAllThenPaste: [D, [all, D]], replace: [D, [replaced]], cutThenReplace: [D, [cut, replaced]] };
  for (const [name, [base, heads]] of Object.entries(scenes)) {
    let r;
    try { r = await compareBatch(base, heads, { track }); } catch (e) { console.log(path.basename(f), name, 'ERROR', e.code || '', e.message); bad++; continue; }
    const same = r.on.header === r.off.header && r.on.xml.length === r.off.xml.length && r.on.xml.every((x, i) => x === r.off.xml[i]);
    const sameRes = JSON.stringify(r.on.res) === JSON.stringify(r.off.res);
    if (!same || !sameRes) bad++;
    let where = '';
    if (!same) {
      const i = r.on.xml.findIndex((x, k) => x !== r.off.xml[k]);
      const A = i >= 0 ? r.off.xml[i] : r.off.header; const B = i >= 0 ? r.on.xml[i] : r.on.header; const k = firstDiff(A, B);
      where = `\n   ${i >= 0 ? `구역 ${i}` : '머리'} @${k}\n   하나씩=${JSON.stringify(A.slice(Math.max(0, k - 120), k + 120))}\n   묶음  =${JSON.stringify(B.slice(Math.max(0, k - 120), k + 120))}`;
    }
    const h = JSON.stringify(hits); for (const k of Object.keys(hits)) delete hits[k];
    console.log(path.basename(f).slice(0, 32).padEnd(32), name.padEnd(16), same && sameRes ? 'SAME' : `DIFF(xml ${same}, 응답 ${sameRes})`, `하나씩 ${Math.round(r.off.ms)}ms 묶음 ${Math.round(r.on.ms)}ms`, h, where);
  }
}
console.log(bad ? `다름 ${bad}` : '모두 같음');
process.exitCode = bad ? 1 : 0;
