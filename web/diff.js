// 원문 ↔ 제안 글 차이(화면 표시용). 짧은 글은 글자 단위 LCS, 긴 글은 낱말 단위. 순수 함수.

function tokens(s, unit) {
  if (unit === 'char') return Array.from(s);
  return s.match(/\s+|[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]+|[^\s0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/gu) || [];
}

/** a → b 차이: [{ t: 'eq'|'del'|'ins', s }] */
export function diffText(a = '', b = '') {
  const unit = Array.from(a).length * Array.from(b).length <= 250000 ? 'char' : 'word';
  const A = tokens(a, unit); const B = tokens(b, unit);
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a1 = A.slice(pre, A.length - suf); const b1 = B.slice(pre, B.length - suf);
  const n = a1.length; const m = b1.length; const ops = [];
  if (n * m > 4e6) { ops.push(...a1.map((s) => ['del', s]), ...b1.map((s) => ['ins', s])); }
  else {
    const w = m + 1; const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a1[i] === b1[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a1[i] === b1[j]) { ops.push(['eq', a1[i]]); i++; j++; }
      else if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { ops.push(['ins', b1[j]]); j++; }
      else { ops.push(['del', a1[i]]); i++; }
    }
  }
  const all = [...A.slice(0, pre).map((s) => ['eq', s]), ...ops, ...A.slice(A.length - suf).map((s) => ['eq', s])];
  // 붙어 있는 같은 종류를 합치고, 바뀐 곳 사이의 아주 짧은 같은 글(1글자)은 바뀐 것으로 묶어 읽기 쉽게
  let out = [];
  for (const [t, s] of all) { const last = out[out.length - 1]; if (last && last.t === t) last.s += s; else out.push({ t, s }); }
  for (let k = 1; k < out.length - 1; k++) {
    const x = out[k];
    if (x.t === 'eq' && Array.from(x.s).length <= 1 && out[k - 1].t !== 'eq' && out[k + 1].t !== 'eq') {
      out.splice(k, 1, { t: 'del', s: x.s }, { t: 'ins', s: x.s }); k++;
    }
  }
  // 다시 정리: del 들을 앞, ins 들을 뒤로 모은 덩어리
  const merged = []; let dels = ''; let inss = '';
  const flush = () => { if (dels) merged.push({ t: 'del', s: dels }); if (inss) merged.push({ t: 'ins', s: inss }); dels = ''; inss = ''; };
  for (const x of out) { if (x.t === 'eq') { flush(); merged.push(x); } else if (x.t === 'del') dels += x.s; else inss += x.s; }
  flush();
  out = merged;
  return out;
}

/** 차이를 HTML 로(이스케이프 포함) */
export function diffHtml(a, b) {
  const e = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return diffText(a, b).map((x) => (x.t === 'eq' ? e(x.s) : x.t === 'del' ? `<del>${e(x.s)}</del>` : `<ins>${e(x.s)}</ins>`)).join('');
}
