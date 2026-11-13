// 우리가 만든 HWPX 와 한글이 다시 저장한 HWPX 를 엔진으로 읽어 메모 글·변경 추적·표가 그대로인지 비교한다.
// 사용: node tests/compare_saved.mjs <ours.hwpx> <hangul_saved.hwpx>   (끝 코드 0 = 같음, 1 = 다름)
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('사용: node tests/compare_saved.mjs <ours.hwpx> <hangul_saved.hwpx>'); process.exit(2); }
const A = await HwpxDoc.load(fs.readFileSync(a)); const B = await HwpxDoc.load(fs.readFileSync(b));
const ma = A.memos(); const mb = B.memos();
const lost = ma.filter((m) => !mb.some((x) => x.text === m.text && x.author === m.author));
const ca = A.changes(); const cb = B.changes();
const sig = (c) => `${c.type}:${c.author}:${c.text}`;
const changesSame = ca.length === cb.length && ca.every((c) => cb.some((x) => sig(x) === sig(c)));
const ta = A.tables(); const tb = B.tables();
const cells = (t) => t.cells.map((c) => c.text).join('\u0001');
const tablesSame = ta.length === tb.length && ta.every((t, i) => cells(t) === cells(tb[i]));
const textSame = A.paragraphs({ nested: true }).filter((p) => p.where !== '메모').map((p) => p.text).join('\n') === B.paragraphs({ nested: true }).filter((p) => p.where !== '메모').map((p) => p.text).join('\n');
const dates = mb.map((m) => m.created).filter(Boolean);
const badDates = dates.filter((d) => { const y = new Date(d).getUTCFullYear(); return y < 2000 || y > 2100; });
console.log(JSON.stringify({ memos: [ma.length, mb.length], memoTextsKept: !lost.length, changes: [ca.length, cb.length], changesSame, tables: [ta.length, tb.length], tablesSame, textSame, memoDates: dates.length, badDates: badDates.length }));
for (const m of lost) console.log('  잃은 메모:', JSON.stringify(m.text.slice(0, 100)));
for (const m of mb.filter((x) => /^\[(복구|제안 \d+ ·|AI 작업|AI 의견)/.test(x.text))) console.log(`  ${m.ref} ${m.created || ''} ${m.text.split('\n')[0]}`);
process.exit(!lost.length && changesSame && tablesSame && textSame && !badDates.length ? 0 : 1);
