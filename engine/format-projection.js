// 엔진·편집기가 공유하는 순수 코드포인트 서식 투영(Node/DOM 의존성 없음).
import { charOps } from './diff.js';

/** 교체의 같은 글자는 원래 모양, 새 글자는 삭제 구간의 다수 모양을 받는다. */
export function replacementShapes(oldChars, text, fallback = '0') {
  const original = oldChars.map(c => c.ch).join(''); const out = []; let at = 0;
  const dominant = chars => { const counts = new Map(); for (const c of chars) { const id = c.run?.charPr ?? fallback; counts.set(id, (counts.get(id) || 0) + 1); } return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback; };
  const base = dominant(oldChars);
  for (const op of charOps(original, text)) {
    while (at < op.start) out.push(oldChars[at++].run?.charPr ?? fallback);
    const removed = oldChars.slice(op.start, op.end);
    const left = oldChars[op.start - 1]?.run?.charPr; const right = oldChars[op.end]?.run?.charPr;
    const cp = removed.length ? dominant(removed) : left === right ? left ?? base : right ?? left ?? base;
    out.push(...Array.from(op.text, () => cp)); at = op.end;
  }
  while (at < oldChars.length) out.push(oldChars[at++].run?.charPr ?? fallback);
  return out;
}

/** runs=[{start,end,charPrId}], 반환=새 글의 코드포인트마다 모양 ID. */
export function projectTextFormats(oldText, newText, runs, fallback = '0') {
  const chars = Array.from(oldText, ch => ({ ch, run: { charPr: fallback } }));
  for (const run of runs) for (let i = run.start; i < Math.min(run.end, chars.length); i++) if (i >= 0) chars[i].run.charPr = run.charPrId;
  return replacementShapes(chars, newText, fallback);
}
