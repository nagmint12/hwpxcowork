// 구역(section) XML 의 문단 모델 — 원문 위치 보존.
// 각 hp:p 를 문단 레코드로 만들고, 문단이 직접 가진 글자(코드포인트) 하나하나의 원문 위치와
// 변경 추적(삽입/삭제) 상태, 0폭 표식(메모 필드·컨트롤·마크)을 기록한다.
import { appendFileSync } from 'node:fs';
import { scan, attr, attrs, decodeWithMap } from './xmlscan.js';

const INLINE_CHAR = { 'hp:lineBreak': '\n', 'hp:tab': '\t' };
const CHANGE_MARKS = new Set(['hp:insertBegin', 'hp:insertEnd', 'hp:deleteBegin', 'hp:deleteEnd']);

/**
 * [hwpx-cowork] 그림·도형 등 개체 요소(표 제외). run 의 직접 자식으로 온 것만 센다 — 메모·구역 설정·머리말·쪽 번호 같은 컨트롤은 개체가 아니다
 * (engine/doc.js objectTags·변경 추적 개체 판정이 같은 목록을 쓴다)
 */
export const OBJECT_TAGS = new Set(['hp:pic', 'hp:container', 'hp:ole', 'hp:equation', 'hp:line', 'hp:rect', 'hp:ellipse', 'hp:arc', 'hp:polygon', 'hp:curve',
  'hp:connectLine', 'hp:textart', 'hp:video', 'hp:chart', 'hp:btn', 'hp:radioBtn', 'hp:checkBtn', 'hp:comboBox', 'hp:edit', 'hp:listBox', 'hp:scrollBar']);

/** [hwpx-cowork] 개체 anchor 의 이름 — 한/글 차트는 <hp:switch>(안에 hp:case/hp:chart) 로 싸여 있어 'hp:chart' 로 본다(inner) */
export function anchorTag(a) { return a.name === 'hp:switch' && a.inner === 'hp:chart' ? 'hp:chart' : a.name; }

/** [hwpx-cowork] 표·그림·차트·도형 등 개체 anchor 인가(변경 추적에서 개체째 넣고 지우는 것 — 메모·필드·구역 정의·머리말 등 부호는 아님) */
export function isObjectAnchor(a) { return !!a && a.kind === 'ctrl' && (a.name === 'hp:tbl' || OBJECT_TAGS.has(anchorTag(a))); }

/**
 * @typedef {object} Para
 * @property {number} idx            구역 안 전체 문단 순번(중첩 포함, 전위 순)
 * @property {number|null} body      본문 문단 번호(0부터). 중첩 문단이면 null
 * @property {Para|null} parent      이 문단을 품은 문단(표 셀·메모·머리말 등)
 * @property {string} container      부모 문단 아래의 담는 요소 이름(hp:tbl, hp:fieldBegin, hp:header …)
 * @property {Para[]} children
 * @property {number} start          '<hp:p' 위치
 * @property {number} end            '</hp:p>' 다음 위치
 * @property {Array} chars           보이는 글자 하나당 {ch, raw:[s,e], tok, run, ins, del}
 * @property {Array} anchors         0폭 요소 {kind, name, pos, start, end, tok, attrs}
 * @property {Array} runs            {start,end,openTok,closeTok,charPr}
 * @property {Array} ts              hp:t 요소 {openStart, openEnd, closeStart, closeEnd, run}
 */

let loadStamp = 0;

// [hwpx-cowork] 부분 다시 읽기(2026-11-16): 구역 XML 이 바뀌면 예전에는 구역 전체를 처음부터 다시 읽었다(scan + _build). 문단 3,700개(2.2M 글자) 구역에서
// 한 번에 50~120ms, 제안 31건 [모두 반영]이 다시 읽기 314번으로 서버를 13초 멈췄다. 이제 load 는 옛 XML 과 새 XML 의 같은 앞·뒤를 찾아 바뀐 자리를 덮는
// 본문 기록(묶인 member 포함)만 다시 읽고, 그 뒤 기록·토큰은 자리(글자 자리 d·토큰 번호 td·문단 번호)만 옮긴다. 결과는 전체 다시 읽기와 같아야 한다 —
// 경계가 조금이라도 애매하면(구역 머리·끝 태그, 짝이 안 맞는 태그, 본문 문단 조상이 다른 구역, 끝 기록의 지운 나눔이 다음 문단을 이음 등) 전체를 다시 읽는다.
//   - 앞 기록은 같은 객체를 그대로 쓰고, 뒤 기록은 그 자리에서 옮긴다(복사하면 전체 다시 읽기만큼 든다 — 3,700문단 39ms). 다시 읽기 전에 얻은 뒤쪽 기록·토큰을
//     다시 읽은 뒤에도 쓰는 부르는 쪽이 있으면 예전에는 옛 자리, 이제는 옮긴 자리를 본다 — HWPX_SECTION_VERIFY=1 이 그런 읽기를 staleReads 에 모은다.
//   - HWPX_SECTION_PARTIAL=0 이면 늘 전체 다시 읽기(되돌림 스위치). HWPX_SECTION_VERIFY=1 이면 부분 다시 읽기마다 전체 다시 읽기와 견줘 다르면 던진다(시험용).
const PARTIAL = process.env.HWPX_SECTION_PARTIAL !== '0';
const VERIFY = process.env.HWPX_SECTION_VERIFY === '1';
/** 다시 읽기 횟수(시험·측정): full = 전체, partial = 부분, why = 부분으로 못 한 까닭별 수 */
export const sectionLoadStats = { full: 0, partial: 0, why: {} };
/** (HWPX_SECTION_VERIFY=1) 다시 읽기 전에 얻은 뒤쪽 기록·토큰의 자리를 다시 읽은 뒤에 읽은 곳 → 횟수 */
export const staleReads = new Map();
// 검증 모드 기록 파일(HWPX_SECTION_VERIFY_LOG): 프로세스가 끝날 때 다시 읽기 횟수·옛 기록 읽기를 한 줄(JSON)로 덧붙인다 — 시험 묶음 전체를 돌려 모을 때
if (VERIFY && process.env.HWPX_SECTION_VERIFY_LOG) {
  process.on('exit', () => {
    if (!sectionLoadStats.partial && !staleReads.size) return;
    try {
      appendFileSync(process.env.HWPX_SECTION_VERIFY_LOG, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(1, 3), stats: sectionLoadStats, stale: [...staleReads] })}\n`);
    } catch { /* 기록 실패는 시험 결과와 무관 */ }
  });
}

export class Section {
  constructor(xml, index) {
    this.index = index;
    this.load(xml);
  }

  load(xml) {
    // [hwpx-cowork] 새 상태를 다 만든 뒤에 바꿔 끼운다 — 읽다가 던지면 구역은 그대로(engine/formatting.js commit 이 이것에 기댄다)
    const next = (PARTIAL && this.tokens && this._partial(xml)) || this._full(xml);
    this.xml = xml;
    this.loadSeq = (this.loadSeq || 0) + 1; // 다시 읽은 차례(문서 단위 캐시 열쇠 — 하이퍼링크 대상 id 등)
    this.stamp = ++loadStamp;                // [hwpx-cowork] 모든 구역에 걸쳐 겹치지 않는 읽은 차례(구역을 통째로 바꿔 끼워도 다른 값 — HwpxDoc._objectInfo 캐시 열쇠)
    this.tokens = next.tokens;
    this.paras = next.paras;
    this.bodyParas = next.bodyParas;
    this._shape = next.shape;
  }

  /** 전체 읽기 → { tokens, paras, bodyParas, shape } (this 는 건드리지 않는다) */
  _full(xml) {
    const b = builder(xml, this.index, scan(xml), 0, 0);
    b._run(0, b.tokens.length, [], null);
    sectionLoadStats.full++;
    return { tokens: b.tokens, paras: b.paras, bodyParas: b.bodyParas, shape: b._shapeOut };
  }

  /** 예전 이름(전체 읽기를 this 에) */
  _build() { this.paras = []; this.bodyParas = []; this._run(0, this.tokens.length, [], null); this._shape = this._shapeOut; }

  /**
   * [hwpx-cowork] 부분 다시 읽기 → 새 상태 | null(전체로). 바뀐 범위 [lo, hi)(옛 XML)를 덮는 본문 기록 i0..i1 을 다시 읽는다.
   * 끝 기록이 지운 나눔으로 다음 문단을 이으면(cont) 범위를 한 기록씩 늘려 다시 해 본다
   */
  _partial(xml) {
    const why = (w) => { sectionLoadStats.why[w] = (sectionLoadStats.why[w] || 0) + 1; return null; };
    const shape = this._shape; const old = this.xml;
    if (typeof xml !== 'string' || typeof old !== 'string') return why('type');
    if (!shape || !shape.uniform || shape.bodyFrames == null || !shape.root || shape.root.close == null || shape.index !== this.index) return why('shape');
    // 같은 XML(서식 되돌리기 등): 값이 같은 상태를 새 배열로(전체 다시 읽기도 값이 같은 새 객체를 만든다)
    if (xml === old) { sectionLoadStats.partial++; return { tokens: this.tokens.slice(), paras: this.paras.slice(), bodyParas: this.bodyParas.slice(), shape }; }
    const n0 = old.length, n1 = xml.length;
    // 같은 앞부분은 그 자리를 품은 옛 토큰의 시작까지 줄인다(뒤 태그와 첫 글자가 같으면 — 예: '</hs:sec>' 앞에 '<hp:p' 넣기 — 다름이 태그 안에서 시작해 뿌리 태그를 품게 된다)
    let P = commonPrefix(old, xml);
    if (P < n0) P = this.tokens[tokenAt(this.tokens, P)].start;
    const S = commonSuffix(old, xml, Math.min(n0, n1) - P);
    const lo = P, hi = n0 - S, d = n1 - n0;
    const body = this.bodyParas;
    let i0 = firstEndAfter(body, lo), i1 = lastStartBefore(body, hi);
    // 마지막 기록이 지운 나눔으로 끝나 다음 본문 문단을 이을 참이면(contTail) 그 뒤에 넣는 문단은 그 기록의 member — 마지막 기록부터 다시 읽는다
    if (shape.contTail && body.length && i0 >= body.length) { i0 = body.length - 1; i1 = Math.max(i1, i0); }
    for (let k = 0; k < 8; k++) {
      const r = this._partialTry(xml, i0, i1, lo, hi, d);
      if (r === 'cont' && i1 + 1 < body.length) { i1++; if (i0 > i1) i0 = i1; continue; }
      if (typeof r === 'string') return why(r);
      sectionLoadStats.partial++;
      return r;
    }
    return why('cont-chain');
  }

  /** 부분 다시 읽기 한 번(i0 > i1 = 기록 사이에만 넣거나 지움) → 새 상태 | 실패 까닭(글 — 'cont' 는 범위를 늘려 다시) */
  _partialTry(xml, i0, i1, lo, hi, d) {
    const ot = this.tokens; const body = this.bodyParas; const shape = this._shape;
    let a = lo, b = hi;
    if (i0 <= i1) { a = Math.min(a, body[i0].start); b = Math.max(b, body[i1].end); }
    // 옛 토큰 [ia, ib): 바뀐 자리를 덮는 토큰. 바로 앞은 태그(끝이 '>'), 바로 뒤는 태그('<')가 되게 이웃 글 토큰까지 넣는다 — 그래야 새 XML 을 처음부터
    // 읽을 때와 토큰 경계가 같다(앞 태그는 바뀌지 않은 앞부분에서 같은 자리에 끝나고, 뒤 '<' 는 바뀌지 않은 뒷부분에 그대로 있다)
    let ia = tokenAt(ot, a);
    let ib = b > ot[ia].start ? tokenAt(ot, b - 1) + 1 : ia;
    while (ia > 0 && ot[ia - 1].type === 'text') ia--;
    while (ib < ot.length && ot[ib].type === 'text') ib++;
    // 구역 뿌리(<hs:sec>) 여는·닫는 태그와 그 바깥(XML 선언 등)은 다시 읽지 않는다
    if (ia <= shape.root.open || ib > shape.root.close) return 'root';
    a = ot[ia].start; b = ib > ia ? ot[ib - 1].end : a;
    const nb = b + d;
    if (nb < a) return 'range';
    const local = scan(xml.slice(a, nb));
    for (const t of local) { t.start += a; t.end += a; if (t.attrStart != null) { t.attrStart += a; t.attrEnd += a; } }
    if (local.length && !tokenComplete(xml, local[local.length - 1])) return 'open-tag';
    const paraStart = i0 < body.length ? body[i0].idx : this.paras.length;
    const paraEnd = i0 <= i1 ? (i1 + 1 < body.length ? body[i1 + 1].idx : this.paras.length) : paraStart;
    // 옛 범위도 짝이 맞아야 하고(닫히지 않은 문단이 뒤 문단들을 품은 깨진 XML 등), 범위의 옛 기록(중첩 포함)이 범위 안에 있고 뒤 기록은 본문 기록으로 범위 뒤에서 시작해야
    // 범위 밖은 새 XML 을 처음부터 읽어도 같다
    if (!balanced(ot, ia, ib)) return 'old-unbalanced';
    for (let k = paraStart; k < paraEnd; k++) { const q = this.paras[k]; if (q.start < a || q.end > b) return 'old-span'; }
    if (paraEnd < this.paras.length && (this.paras[paraEnd].parent || this.paras[paraEnd].start < b)) return 'old-span';
    if (paraStart > 0 && this.paras[paraStart - 1].end > a) return 'old-span';
    const tokens = ot.slice(0, ia).concat(local);
    const bld = builder(xml, this.index, tokens, paraStart, i0);
    const r = bld._run(ia, tokens.length, shape.bodyFrames.map((f) => ({ ...f })), shape);
    if (r !== true) return r;
    if (bld._contEnd && i1 + 1 < body.length) return 'cont';
    const td = local.length - (ib - ia);
    const idd = bld.paras.length - (paraEnd - paraStart);
    const bd = bld.bodyParas.length - (i0 <= i1 ? i1 - i0 + 1 : 0);
    let tailTok = ot.slice(ib); let tailParas = this.paras.slice(paraEnd);
    let tailBody = body.slice(i0 <= i1 ? i1 + 1 : i0);
    if (VERIFY) ({ tailTok, tailParas, tailBody } = verifyTail(tailTok, tailParas, tailBody));
    shiftTokens(tailTok, d);
    shiftParas(tailParas, d, td, idd, bd, this.index);
    const next = {
      tokens: tokens.concat(tailTok),
      paras: this.paras.slice(0, paraStart).concat(bld.paras, tailParas),
      bodyParas: body.slice(0, i0).concat(bld.bodyParas, tailBody),
      shape: { ...shape, root: { open: shape.root.open, close: shape.root.close + td }, contTail: (i0 <= i1 ? i1 + 1 : i0) >= body.length ? !!bld._contEnd : shape.contTail },
    };
    if (VERIFY) verifyPartial(this, xml, next);
    return next;
  }

  /**
   * 토큰 [from, to) 를 읽어 this.paras·bodyParas 에 기록을 더한다(번호는 this._idxBase·_bodyBase 부터). stack = 시작 자리에 열린 요소들.
   * part(부분 다시 읽기 — 전체 읽기의 shape): 본문 문단 조상이 shape.bodyFrames 와 같아야 하고, 처음 깊이 밑으로 닫거나 열린 채 끝나면 안 된다
   * → true | 실패 까닭(글). 전체 읽기(part 없음)는 this._shapeOut 에 구역 모양(뿌리 태그 자리·본문 조상·끝 기록의 이음)을 남긴다
   */
  _run(from, to, stack, part) {
    const { xml, tokens } = this;
    let cur = null;   // 현재 글자를 받는 문단
    const paraById = this.paras;
    const idxBase = this._idxBase || 0; const bodyBase = this._bodyBase || 0;
    const nestedCounter = new Map(); // parent idx -> count
    const hiddenCounter = new Map(); // parent idx -> 지운 개체 안 문단 수('/d' 번호)
    const depth0 = stack.length;
    const bodyKey = part ? part.bodyFrames.map((f) => f.name).join('>') : null;
    const shape = part ? null : { index: this.index, bodyFrames: null, uniform: true, root: null, contTail: false };
    let firstKey = null;
    this._cont = null; // [hwpx-cowork] 나눔을 지운 본문 문단 — 다음 본문 <hp:p> 가 이 기록을 잇는다(문단 나눔 변경 추적)
    for (let ti = from; ti < to; ti++) {
      const t = tokens[ti];
      if (t.type === 'open' || t.type === 'selfclose') {
        if (shape && !shape.root && t.type === 'open' && !stack.length) shape.root = { open: ti, close: null };
        if (t.name === 'hp:p') {
          // [hwpx-cowork] 앞 본문 문단이 짝 맞는 지운 나눔(deleteEnd paraend="1", 뒤에 글자 없음)으로 끝났으면 이 물리 문단은 같은 기록의 다음 member
          // — 최종본에서 한 문단(ref·글·중첩 번호가 평탄화 사본과 같다). 상태(변경 범위·줄 정보)는 물리 문단마다
          if (!cur) {
            // [hwpx-cowork] 본문 문단의 조상(보통 hs:sec 하나)이 구역 안에서 모두 같아야 부분 다시 읽기를 한다(부분 읽기는 그 조상에서 시작한다)
            const key = stack.map((f) => f.name).join('>');
            if (part) { if (key !== bodyKey) return 'body-depth'; }
            else if (firstKey === null) { firstKey = key; shape.bodyFrames = stack.map((f) => ({ name: f.name, tok: f.tok, para: f.para })); }
            else if (key !== firstKey) shape.uniform = false;
          }
          if (!cur && this._cont && t.type === 'open') {
            const rec = this._cont; this._cont = null;
            (rec.members ??= [memberOf(rec)]).push({ start: t.start, end: t.end, openTok: ti, closeTok: ti, lineseg: null,
              c0: rec.chars.length, a0: rec.anchors.length, r0: rec.runs.length, t0: rec.ts.length });
            rec._ins = rec._del = null; rec._brk = null; rec.lineseg = null; rec._inT = null; rec._run = null;
            stack.push({ name: t.name, tok: ti, para: rec }); cur = rec;
            continue;
          }
          if (!cur) this._cont = null;
          const rec = {
            idx: idxBase + paraById.length, body: null, parent: cur, container: containerOf(stack, cur),
            children: [], start: t.start, end: t.end, openTok: ti, closeTok: ti,
            chars: [], anchors: [], runs: [], ts: [], _ctrlStack: [], _inT: null, _run: null,
            _ins: null, _del: null, lineseg: null,
          };
          if (!cur) { rec.body = bodyBase + this.bodyParas.length; this.bodyParas.push(rec); rec.ref = `s${this.index}/p${rec.body}`; }
          else {
            // [hwpx-cowork] 변경 추적으로 지운 개체(그 문단이나 조상 문단의 run 에 직접 든 표·그림·도형 — del) 안 문단은 최종본에 없다:
            // ref 를 '/d{k}'(따로 셈)로 매겨 보이는 중첩 문단의 n 번호가 평탄화 사본(작업본)과 같게 한다. 넣은 개체(ins) 안 문단은 added(원본 보기에서 숨음)
            // [hwpx-cowork] 2026-11-17 hp:switch 의 대체 갈래(뒤 hp:case·hp:default — 위 갈래 표시) 안 문단은 보이는 갈래 문단의 사본이다:
            // 어느 보기에도 없고(alt) 지운 개체 안 문단처럼 '/d' 로 따로 센다 — 같은 캡션이 n 번호 둘로 보이지 않게(한/글은 첫 갈래만 보이고 쓴다)
            const alt = !!cur.alt || stack.some((f) => f.alt);
            const hidden = alt || !!cur.hidden || cur._ctrlStack.some((a) => a.del && isObjectAnchor(a));
            const added = !!cur.added || cur._ctrlStack.some((a) => a.ins && isObjectAnchor(a));
            const counter = hidden ? hiddenCounter : nestedCounter;
            const k = (counter.get(cur.idx) || 0); counter.set(cur.idx, k + 1);
            cur.children.push(rec); rec.nested = k; rec.ref = `${cur.ref}/${hidden ? 'd' : 'n'}${k}`;
            if (hidden) { rec.hidden = true; cur.hiddenKids = (cur.hiddenKids || 0) + 1; }
            if (alt) rec.alt = true;
            if (added) rec.added = true;
          }
          paraById.push(rec);
          if (t.type === 'open') { stack.push({ name: t.name, tok: ti, para: rec }); cur = rec; }
          continue;
        }
        // [hwpx-cowork] 2026-11-17 hp:switch 의 갈래: 첫 갈래(보통 hp:case)만 보이는 쪽이고 그 뒤 갈래(뒤 hp:case·hp:default)는 대체 사본(alt).
        // 한/글 2022 COM 실측: 차트 <hp:switch><hp:case ooxmlchart><hp:chart>…<hp:caption>…</hp:case><hp:default><hp:ole>…<hp:caption>…
        // 에서 case 캡션 글만 바꾼 파일을 열면 글(GetTextFile)·PDF 모두 case 글이고, 다시 저장하면 default 캡션을 case 글로 새로 쓴다
        // (default 의 다른 글은 사라짐). hp:case 없이 hp:default 만 있으면 그것이 첫 갈래라 보인다. 빈 갈래(<hp:case …/> — 개요 8~10 수준 문단)도 첫 갈래다
        const sw = stack.length ? stack[stack.length - 1] : null;
        const altBranch = !!sw && sw.name === 'hp:switch' && (t.name === 'hp:case' || t.name === 'hp:default') && sw.branches++ > 0;
        if (t.type === 'open') {
          const fr = { name: t.name, tok: ti, para: cur };
          if (altBranch) fr.alt = true;
          if (t.name === 'hp:switch') fr.branches = 0;
          stack.push(fr);
        }
        if (cur) this._onElementStart(cur, t, ti, stack);
        continue;
      }
      if (t.type === 'close') {
        // 이름이 맞는 요소까지 닫는다(짝이 안 맞는 XML 도 예전처럼). 부분 다시 읽기는 시작할 때 열려 있던 요소를 닫으면 안 된다
        let fr;
        do {
          if (part && stack.length <= depth0) return 'unbalanced';
          fr = stack.pop();
          if (shape && fr && shape.root && shape.root.close == null && fr.tok === shape.root.open) {
            if (fr.name === t.name) shape.root.close = ti; else shape.uniform = false;
          }
        } while (fr && fr.name !== t.name);
        if (t.name === 'hp:p') {
          if (fr && fr.para) {
            const rec = fr.para;
            rec.end = t.end; rec.closeTok = ti; cur = rec.parent;
            if (rec.members) { const m = rec.members[rec.members.length - 1]; m.end = t.end; m.closeTok = ti; m.lineseg = rec.lineseg; }
            if (!rec.parent && rec._brk && rec._brk.end.pos === rec.chars.length) this._cont = rec;
          }
          continue;
        }
        if (cur) this._onElementEnd(cur, t, ti);
        continue;
      }
      if (t.type === 'text' && cur && cur._inT) {
        const d = decodeWithMap(xml, t.start, t.end);
        for (let i = 0; i < d.chars.length; i++) {
          cur.chars.push({ ch: d.chars[i], raw: d.raw[i], tok: ti, t: cur._inT, run: cur._run, ins: cur._ins, del: cur._del });
        }
      }
    }
    const contEnd = !!this._cont; // 끝 기록이 지운 나눔으로 다음 본문 문단을 이을 참인가
    this._cont = null;
    if (part && (cur || stack.length !== depth0)) return 'unbalanced';
    for (const p of this.paras) { delete p._ctrlStack; delete p._inT; delete p._run; delete p._ins; delete p._del; delete p._brk; }
    for (const p of this.paras) if (p.anchors.length > 1) attachObjectMarks(p);
    for (const p of this.paras) if (p._pe) { delete p._pe; markBreaks(p); }
    for (const p of this.bodyParas) if (p.members) setLeader(p);
    if (shape) { shape.contTail = contEnd; this._shapeOut = shape; } else this._contEnd = contEnd;
    return true;
  }

  _onElementStart(p, t, ti, stack) {
    const { xml } = this;
    if (t.name === 'hp:run') {
      const r = { start: t.start, end: t.end, openTok: ti, closeTok: ti, charPr: attr(xml, t, 'charPrIDRef') ?? '0', selfclose: t.type === 'selfclose' };
      p.runs.push(r); p._run = r; return;
    }
    if (t.name === 'hp:t') {
      const tt = { openStart: t.start, openEnd: t.end, closeStart: t.end, closeEnd: t.end, run: p._run, selfclose: t.type === 'selfclose', tok: ti };
      p.ts.push(tt); if (t.type === 'open') p._inT = tt; return;
    }
    if (t.name === 'hp:linesegarray') { p.lineseg = { start: t.start, end: t.end, tok: ti, open: t.type === 'open' }; return; }
    // run 의 직접 자식(hp:t 제외) = 컨트롤/개체: 0폭 위치로 기록
    // (open 토큰은 이미 stack 에 올라가 있으므로 부모는 stack[-2], selfclose 토큰의 부모는 stack[-1])
    const parentFrame = t.type === 'open' ? stack[stack.length - 2] : stack[stack.length - 1];
    const parentName = parentFrame ? parentFrame.name : null;
    const inRun = parentName === 'hp:run';
    // [hwpx-cowork] 변경 추적 표식은 hp:t 안(글 — level 't')이든 run 의 직접 자식(개체를 감싼 표식 — level 'run')이든 같은 표식이다.
    // 표식 사이의 글자·개체(ctrl)에 ins/del = 변경 id(문단마다, XML 차례 — 끝 표식까지 hp:t 경계를 넘어 이어짐)
    if (CHANGE_MARKS.has(t.name) && (p._inT || inRun)) {
      const a = attrs(xml, t);
      const id = a.get('Id') ?? a.get('TcId');
      if (t.name === 'hp:insertBegin') p._ins = id; else if (t.name === 'hp:insertEnd') p._ins = null;
      else if (t.name === 'hp:deleteBegin') p._del = id; else if (t.name === 'hp:deleteEnd') p._del = null;
      const anchor = { kind: 'change', name: t.name, id, pos: p.chars.length, start: t.start, end: t.end, tok: ti, attrs: a, t: p._inT, run: p._run, level: p._inT ? 't' : 'run' };
      p.anchors.push(anchor);
      // [hwpx-cowork] paraend="1" = 그 물리 문단의 나눔이 범위 안(한/글). 같은 물리 문단에 시작이 있는 지운 나눔이면 기록해 둔다(문단을 닫을 때
      // 그 뒤에 글자가 없으면 다음 본문 문단과 한 기록 — _build)
      if (a.get('paraend') === '1') {
        anchor.paraEnd = true; p._pe = true;
        if (t.name === 'hp:deleteEnd') {
          const a0 = p.members ? p.members[p.members.length - 1].a0 : 0;
          let begin = null;
          for (let i = p.anchors.length - 2; i >= a0; i--) { const x = p.anchors[i]; if (x.kind === 'change' && x.name === 'hp:deleteBegin' && x.id === id) { begin = x; break; } }
          p._brk = begin ? { begin, end: anchor } : null;
        }
      }
      return;
    }
    if (p._inT) {
      // hp:t 안의 인라인 요소: 줄바꿈, 탭, 형광펜 등 (0폭 또는 1글자)
      const a = attrs(xml, t);
      if (INLINE_CHAR[t.name]) {
        p.chars.push({ ch: INLINE_CHAR[t.name], raw: [t.start, t.end], tok: ti, t: p._inT, run: p._run, ins: p._ins, del: p._del, inline: t.name });
        return;
      }
      p.anchors.push({ kind: 'inline', name: t.name, pos: p.chars.length, start: t.start, end: t.end, tok: ti, attrs: a, t: p._inT, run: p._run });
      return;
    }
    if (inRun) {
      // [hwpx-cowork] ins/del = 이 개체를 품은 변경 추적 범위(개체 변경 추적 — 최종본 보기는 del 인 개체를 숨긴다)
      const anchor = { kind: 'ctrl', name: t.name, pos: p.chars.length, start: t.start, end: t.end, tok: ti, attrs: attrs(xml, t), run: p._run, inner: null, ins: p._ins, del: p._del };
      if (t.name === 'hp:ctrl') anchor.inner = null;
      p.anchors.push(anchor);
      if (t.type === 'open') p._ctrlStack.push(anchor);
      return;
    }
    // [hwpx-cowork] 한/글 차트는 <hp:switch><hp:case><hp:chart …/></hp:case><hp:default><hp:ole …/></hp:default></hp:switch> —
    // switch anchor 에 안의 차트를 적어 둔다(engine/doc.js anchorTag 가 'hp:chart' 도형으로 본다)
    if (t.name === 'hp:chart' && parentName === 'hp:case' && p._ctrlStack.length) {
      const c = p._ctrlStack[p._ctrlStack.length - 1];
      if (c.name === 'hp:switch' && !c.inner) { c.inner = 'hp:chart'; c.innerAttrs = attrs(xml, t); }
    }
    // hp:ctrl 의 첫 자식(fieldBegin/fieldEnd/colPr/…) 이름을 기록
    if (parentName === 'hp:ctrl' && p._ctrlStack.length) {
      const c = p._ctrlStack[p._ctrlStack.length - 1];
      if (!c.inner) { c.inner = t.name; c.innerTok = ti; c.innerAttrs = attrs(xml, t); c.innerStart = t.start; c.innerEnd = t.end; }
    }
  }

  _onElementEnd(p, t, ti) {
    if (t.name === 'hp:run') { if (p._run) { p._run.end = t.end; p._run.closeTok = ti; } p._run = null; return; }
    if (t.name === 'hp:t') { if (p._inT) { p._inT.closeStart = t.start; p._inT.closeEnd = t.end; } p._inT = null; return; }
    if (t.name === 'hp:linesegarray') { if (p.lineseg) p.lineseg.end = t.end; return; }
    const c = p._ctrlStack.length ? p._ctrlStack[p._ctrlStack.length - 1] : null;
    if (c && c.name === t.name) { c.end = t.end; c.closeTok = ti; p._ctrlStack.pop(); }
  }

  // ───────── 조회 ─────────

  byRef(ref) {
    // [hwpx-cowork] '/d{k}' = 변경 추적으로 지운 개체 안 문단(최종본에 없음 — engine/doc.js 의 canonRef·서버 REF_RE 는 받지 않는다)
    const m = /^s(\d+)\/p(\d+)((?:\/[nd]\d+)*)$/.exec(ref);
    if (!m || parseInt(m[1], 10) !== this.index) return null;
    let p = this.bodyParas[parseInt(m[2], 10)];
    if (!p) return null;
    if (m[3]) {
      for (const n of m[3].split('/').filter(Boolean)) {
        const k = parseInt(n.slice(1), 10); const d = n[0] === 'd';
        p = !d && !p.hiddenKids ? p.children[k] : p.children.find((c) => !!c.hidden === d && c.nested === k);
        if (!p) return null;
      }
    }
    return p;
  }

  /** [hwpx-cowork] 개체 anchor 가 보기(view)에서 보이는가 — final: 변경 추적으로 지운 개체(del)는 안 보임, original: 넣은 개체(ins)는 안 보임 */
  static visibleObject(a, view = 'final') {
    if (view === 'final') return !a.del;
    if (view === 'original') return !a.ins;
    return true;
  }

  /** [hwpx-cowork] 문단이 변경 추적으로 지운 개체 안에 있는가(최종본에 없는 문단 — ref 가 '/d') */
  static inHiddenObject(q) { return !!q?.hidden; }

  /** [hwpx-cowork] 문단이 보기(view)에서 보이는가 — final: 지운 개체 안 문단은 안 보임, original: 넣은 개체 안 문단은 안 보임 */
  static visibleParagraph(q, view = 'final') {
    if (q.alt) return false; // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본 — 어느 보기에도 없다
    if (view === 'final') return !q.hidden;
    if (view === 'original') return !q.added;
    return true;
  }

  /** [hwpx-cowork] 개체 anchor 인가(표·그림·차트·도형 …) */
  static isObject(a) { return isObjectAnchor(a); }

  /** 문단의 글자 배열에서 보기 방식에 따른 글자들을 돌려준다. */
  static visibleChars(p, view = 'final') {
    if (view === 'final') return p.chars.filter((c) => !c.del);
    if (view === 'original') return p.chars.filter((c) => !c.ins);
    return p.chars;
  }

  static text(p, view = 'final') {
    // [hwpx-cowork] 나눔을 지워 이은 기록의 원본 보기는 member 를 줄바꿈으로 잇는다(어림 — 원본에서는 따로 있는 문단)
    if (view === 'original' && p.members) {
      return p.members.map((m, k) => p.chars.slice(m.c0, k + 1 < p.members.length ? p.members[k + 1].c0 : p.chars.length).filter((c) => !c.ins).map((c) => c.ch).join('')).join('\n');
    }
    return Section.visibleChars(p, view).map((c) => c.ch).join('');
  }

  /** 변경 추적을 {+삽입+} [-삭제-] 로 표시한 글. [hwpx-cowork] 문단 나눔 변경(paraend="1" 끝 표식)은 그 자리에 [-¶-]·{+¶+} */
  static markupText(p) {
    let out = ''; let mode = null;
    const swap = (m) => { if (m === mode) return; if (mode === 'ins') out += '+}'; if (mode === 'del') out += '-]'; if (m === 'ins') out += '{+'; if (m === 'del') out += '[-'; mode = m; };
    const breaks = p.anchors.filter((a) => a.paraEnd && (a.name === 'hp:deleteEnd' || a.name === 'hp:insertEnd'));
    let bi = 0;
    const flush = (pos) => { for (; bi < breaks.length && breaks[bi].pos <= pos; bi++) { swap(null); out += breaks[bi].name === 'hp:deleteEnd' ? '[-¶-]' : '{+¶+}'; } };
    p.chars.forEach((c, i) => {
      flush(i);
      swap(c.ins ? 'ins' : (c.del ? 'del' : null));
      out += c.ch;
    });
    flush(Infinity);
    swap(null);
    return out;
  }

  /** 문단의 변경 표식 목록 */
  static changeMarks(p) { return p.anchors.filter((a) => a.kind === 'change'); }

  // ───────── [hwpx-cowork] 문단 나눔 변경 추적(2026-10-30 — 한/글 paraend="1") ─────────
  // 나눔을 지운(짝 맞는 deleteBegin/deleteEnd paraend="1" 로 끝나는) 본문 물리 문단과 그다음 본문 물리 문단은 한 기록(members — 최종본 한 문단).
  // 문단 속성(p.openTok)은 leader member 의 것: 남는 내용이 없는(빈·글을 모두 지운) member 는 다음 member 에 자리를 내준다(한/글 2022 실측 —
  // 모두 수락하면 내용이 남는 첫 문단의 속성이 남는다). 묶지 않은 기록은 예전 그대로다.

  /** 본문 기록의 물리 문단 목록 [{ start, end, openTok, closeTok, lineseg, c0, a0, r0, t0 }] — 묶지 않은 기록은 자기 하나 */
  static members(p) { return p.members ?? [memberOf(p)]; }

  /** 기록의 모든 줄 정보(hp:linesegarray — member 마다) */
  static linesegs(p) { return p.members ? p.members.map((m) => m.lineseg).filter(Boolean) : (p.lineseg ? [p.lineseg] : []); }

  /** 글자 ci(p.chars 번호)가 든 member 번호(빈 member 는 다음 member 와 c0 가 같다 — 글자는 뒤 member) */
  static memberAt(p, ci) {
    if (!p.members) return 0;
    let k = 0;
    for (let i = 1; i < p.members.length; i++) if (p.members[i].c0 <= ci) k = i;
    return k;
  }

  /** XML 자리 pos 가 든 member 번호 */
  static memberAtPos(p, pos) {
    if (!p.members) return 0;
    let k = 0;
    for (let i = 1; i < p.members.length; i++) if (p.members[i].start <= pos) k = i;
    return k;
  }

  /**
   * member k(기본 마지막) 끝의 문단 나눔 변경 → { type: 'Insert'|'Delete', id, begin, end, zw } | null.
   * end = 그 member 의 마지막 paraend="1" 끝 표식(뒤에 글자 없음), begin = 같은 member 의 짝 시작(없으면 null), zw = 나눔만의 폭 0 쌍(brk)
   */
  static breakOf(p, k) {
    const ms = Section.members(p); if (k == null) k = ms.length - 1;
    const m = ms[k]; if (!m) return null;
    const a1 = k + 1 < ms.length ? ms[k + 1].a0 : p.anchors.length;
    const c1 = k + 1 < ms.length ? ms[k + 1].c0 : p.chars.length;
    for (let i = a1 - 1; i >= m.a0; i--) {
      const e = p.anchors[i];
      if (e.kind !== 'change' || !e.paraEnd || (e.name !== 'hp:deleteEnd' && e.name !== 'hp:insertEnd')) continue;
      if (e.pos !== c1) return null;
      const bn = e.name === 'hp:deleteEnd' ? 'hp:deleteBegin' : 'hp:insertBegin';
      let begin = null;
      for (let j = i - 1; j >= m.a0; j--) { const x = p.anchors[j]; if (x.kind === 'change' && x.name === bn && x.id === e.id) { begin = x; break; } }
      return { type: e.name === 'hp:deleteEnd' ? 'Delete' : 'Insert', id: e.id, begin, end: e, zw: !!e.brk };
    }
    return null;
  }

  /** member k 에 최종본에 남는 내용(보이는 글자, 변경 표식·지운 개체가 아닌 부호)이 있나 */
  static memberHasContent(p, k) {
    const ms = Section.members(p); const m = ms[k];
    const c1 = k + 1 < ms.length ? ms[k + 1].c0 : p.chars.length; const a1 = k + 1 < ms.length ? ms[k + 1].a0 : p.anchors.length;
    for (let i = m.c0; i < c1; i++) if (!p.chars[i].del) return true;
    for (let i = m.a0; i < a1; i++) { const a = p.anchors[i]; if (a.kind !== 'change' && !(isObjectAnchor(a) && a.del)) return true; }
    return false;
  }

  /** run 이 최종본에 남는 내용(보이는 글자, 변경 표식·지운 개체가 아닌 부호)을 가졌나 */
  static liveRun(p, r) {
    return p.chars.some((c) => c.run === r && !c.del) || p.anchors.some((a) => a.run === r && a.kind !== 'change' && !(isObjectAnchor(a) && a.del));
  }

  /**
   * 최종본 문단의 run(모두 수락해 합친 꼴과 같은 것): leader member 의 run 은 모두, 다른 member 의 run 은 남는 내용이 있는 것만
   * (합칠 때 비게 된 run 은 버린다 — engine/doc.js _mergePhysical·acceptAll). 묶지 않은 기록은 p.runs 그대로
   */
  static finalRuns(p) {
    if (!p.members) return p.runs;
    const L = p.leader ?? 0; const ms = p.members;
    const live = new Set();
    for (const c of p.chars) if (!c.del && c.run) live.add(c.run);
    for (const a of p.anchors) if (a.run && a.kind !== 'change' && !(isObjectAnchor(a) && a.del)) live.add(a.run);
    const lo = ms[L].r0; const hi = L + 1 < ms.length ? ms[L + 1].r0 : p.runs.length;
    return p.runs.filter((r, i) => (i >= lo && i < hi) || live.has(r));
  }

  /** 최종본 문단의 마지막 run(빈 문단 글자 모양 — formatting.js). 묶지 않은 기록은 p.runs 의 마지막 그대로 */
  static lastLiveRun(p) {
    const f = Section.finalRuns(p);
    return f[f.length - 1];
  }

  /** 문단의 메모 필드 시작/끝 컨트롤 */
  static fieldCtrls(p) { return p.anchors.filter((a) => a.kind === 'ctrl' && a.name === 'hp:ctrl' && (a.inner === 'hp:fieldBegin' || a.inner === 'hp:fieldEnd')); }

  /** 담는 요소 설명(표·메모·머리말 …) */
  static where(p) {
    const names = { 'hp:tbl': '표', 'hp:fieldBegin': '메모', 'hp:header': '머리말', 'hp:footer': '꼬리말', 'hp:footNote': '각주', 'hp:endNote': '미주', 'hp:rect': '글상자', 'hp:container': '개체', 'hp:textart': '글맵시', 'hp:pic': '그림' };
    return p.parent ? (names[p.container] || p.container || '중첩') : '본문';
  }
}

/**
 * [hwpx-cowork] 문단 안 변경 범위(같은 id 의 시작·끝 표식) 가운데 개체를 품은 것을 표시한다(개체 변경 추적 — 표식 꼴은 hp:t 안·run 단계 모두):
 *  - begin.objects = end.objects = 범위 안 개체 anchor 들(문서 차례). 글자도 있으면 섞인 범위(changes() kind 'mixed'), 없으면 개체만('object')
 *  - 글자·개체 아닌 부호(메모·필드 등)·인라인 요소가 없는 범위(빈 hp:t·다른 변경 표식은 상관없음)는 개체에 붙은 표식:
 *    begin.attach = end.attach = 그 개체들, 개체.marks = { begin, end } — 글 편집(beforeChar·afterChar·assertNoOverlap·ctrlSplit)은
 *    붙은 표식을 개체의 일부로 보고 넘지 않는다
 */
function attachObjectMarks(p) {
  let marks = null; let objs = null;
  for (const a of p.anchors) {
    if (a.kind === 'change') (marks ??= []).push(a);
    else if (isObjectAnchor(a)) (objs ??= []).push(a);
  }
  if (!marks || !objs) return;
  for (const b of marks) {
    if (b.name !== 'hp:insertBegin' && b.name !== 'hp:deleteBegin') continue;
    const endName = b.name === 'hp:insertBegin' ? 'hp:insertEnd' : 'hp:deleteEnd';
    const e = marks.find((x) => x.name === endName && x.id === b.id && x.start > b.start);
    if (!e) continue;
    const inside = objs.filter((o) => o.start >= b.end && o.end <= e.start);
    if (!inside.length) continue;
    b.objects = inside; e.objects = inside;
    if (b.pos !== e.pos) continue; // 글자가 있다 — 섞인 범위
    const other = p.anchors.some((a) => a !== b && a !== e && a.kind !== 'change' && !isObjectAnchor(a) && a.start >= b.end && a.end <= e.start);
    if (other) continue;
    b.attach = inside; e.attach = inside;
    for (const o of inside) o.marks = { begin: b, end: e };
  }
}

/** [hwpx-cowork] 기록의 지금까지 모양을 첫 member 로(나눔을 지워 이을 때) */
function memberOf(p) {
  return { start: p.start, end: p.end, openTok: p.members ? p.members[0].openTok : p.openTok, closeTok: p.closeTok, lineseg: p.lineseg, c0: 0, a0: 0, r0: 0, t0: 0 };
}

/**
 * [hwpx-cowork] 문단 나눔 변경 표식: paraend="1" 끝 표식마다 같은 member 의 짝 시작에 paraEnd, 사이에 글자·부호가 없는 폭 0 쌍(나눔만의 변경)은
 * 두 표식에 brk(글 편집은 개체에 붙은 표식처럼 넘지 않고, 수락·거절은 표식만 든 hp:t 째 지운다)
 */
function markBreaks(p) {
  for (let i = 0; i < p.anchors.length; i++) {
    const e = p.anchors[i];
    if (!e.paraEnd || (e.name !== 'hp:deleteEnd' && e.name !== 'hp:insertEnd')) continue;
    const bn = e.name === 'hp:deleteEnd' ? 'hp:deleteBegin' : 'hp:insertBegin';
    const k = Section.memberAtPos(p, e.start); const a0 = p.members ? p.members[k].a0 : 0;
    let bi = -1;
    for (let j = i - 1; j >= a0; j--) { const x = p.anchors[j]; if (x.kind === 'change' && x.name === bn && x.id === e.id) { bi = j; break; } }
    if (bi < 0) continue;
    const b = p.anchors[bi];
    b.paraEnd = true;
    if (b.pos !== e.pos) continue;
    let only = true;
    for (let j = bi + 1; j < i; j++) if (p.anchors[j].kind !== 'change') { only = false; break; }
    if (only) { b.brk = true; e.brk = true; }
  }
}

/** [hwpx-cowork] 묶인 기록의 leader(속성을 주는 member): 남는 내용이 있는 첫 member, 없으면 마지막. p.openTok = leader 의 여는 태그 */
function setLeader(p) {
  let L = p.members.length - 1;
  for (let k = 0; k < p.members.length - 1; k++) if (Section.memberHasContent(p, k)) { L = k; break; }
  p.leader = L;
  p.openTok = p.members[L].openTok;
}

// ───────── [hwpx-cowork] 부분 다시 읽기 도우미(2026-11-16) ─────────

/** 새 상태를 만들 읽기 일꾼(this 를 건드리지 않게 — Section 메서드를 그대로 쓴다). 번호는 idxBase(전체 문단 차례)·bodyBase(본문 문단 번호)부터 */
function builder(xml, index, tokens, idxBase, bodyBase) {
  const b = Object.create(Section.prototype);
  b.xml = xml; b.index = index; b.tokens = tokens; b.paras = []; b.bodyParas = []; b._idxBase = idxBase; b._bodyBase = bodyBase;
  return b;
}

const CHUNK = 4096;
/** 두 글의 같은 앞부분 길이(4K 덩어리로 견준 뒤 한 글자씩) */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length); let i = 0;
  while (i + CHUNK <= n && a.substring(i, i + CHUNK) === b.substring(i, i + CHUNK)) i += CHUNK;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
/** 두 글의 같은 뒷부분 길이(max 이하 — 앞부분과 겹치지 않게) */
function commonSuffix(a, b, max) {
  const na = a.length, nb = b.length; let k = 0;
  while (k + CHUNK <= max && a.substring(na - k - CHUNK, na - k) === b.substring(nb - k - CHUNK, nb - k)) k += CHUNK;
  while (k < max && a.charCodeAt(na - 1 - k) === b.charCodeAt(nb - 1 - k)) k++;
  return k;
}
/** 본문 기록(자리 차례) 가운데 end > pos 인 첫 번호(없으면 길이) */
function firstEndAfter(body, pos) {
  let lo = 0, hi = body.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (body[m].end > pos) hi = m; else lo = m + 1; }
  return lo;
}
/** 본문 기록 가운데 start < pos 인 마지막 번호(없으면 -1) */
function lastStartBefore(body, pos) {
  let lo = 0, hi = body.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (body[m].start < pos) lo = m + 1; else hi = m; }
  return lo - 1;
}
/** 자리 pos 를 품은(start <= pos 인 마지막) 토큰 번호 — 토큰은 XML 전체를 빈틈없이 덮는다 */
function tokenAt(tokens, pos) {
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tokens[m].start <= pos) lo = m + 1; else hi = m; }
  return Math.max(0, lo - 1);
}
/** 잘라 읽은 마지막 토큰이 그 안에서 제대로 끝났나(잘린 자리 밖으로 이어지는 태그·주석·CDATA 면 전체 읽기와 경계가 다르다) */
function tokenComplete(xml, t) {
  const s = xml.slice(t.start, t.end);
  if (t.type === 'text') return !t.cdata || s.endsWith(']]>');
  if (t.type === 'other') return s.startsWith('<!--') ? s.length >= 7 && s.endsWith('-->') : s.endsWith('>');
  if (!s.endsWith('>')) return false;
  let quote = null;
  for (let i = 1; i < s.length - 1; i++) { const c = s[i]; if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') return false; }
  return quote === null;
}

/** 토큰 [from, to) 가 짝이 맞나(_run 과 같은 닫기 규칙 — 이름이 맞는 요소까지 닫고, 시작 전에 열린 요소를 닫지 않으며, 끝에 열린 것이 없다) */
function balanced(tokens, from, to) {
  const stack = [];
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.type === 'open') stack.push(t.name);
    else if (t.type === 'close') {
      let name;
      do { if (!stack.length) return false; name = stack.pop(); } while (name !== t.name);
    }
  }
  return stack.length === 0;
}

/** 뒤쪽 토큰 자리 옮기기(그 자리에서) */
function shiftTokens(list, d) {
  if (!d) return;
  for (const t of list) { t.start += d; t.end += d; if (t.attrStart != null) { t.attrStart += d; t.attrEnd += d; } }
}

/**
 * 뒤쪽 기록(전위 차례 — 부모가 자식보다 앞) 옮기기(그 자리에서): XML 자리 d, 토큰 번호 td, 전체 문단 번호 idd, 본문 번호 bd(바뀌면 ref 도 다시).
 * 기록 안의 자리 칸: 기록·member·줄 정보·run·hp:t·글자 raw·부호(시작·끝·안쪽 요소·닫는 토큰)
 */
function shiftParas(list, d, td, idd, bd, index) {
  for (const p of list) {
    p.start += d; p.end += d; p.openTok += td; p.closeTok += td; p.idx += idd;
    if (bd) p.ref = p.parent ? `${p.parent.ref}/${p.hidden ? 'd' : 'n'}${p.nested}` : `s${index}/p${(p.body += bd)}`;
    if (!d && !td) continue;
    const seen = p.members ? new Set() : null;
    const ls = (x) => { if (!x || (seen && seen.has(x))) return; seen?.add(x); x.start += d; x.end += d; x.tok += td; };
    ls(p.lineseg);
    if (p.members) for (const m of p.members) { m.start += d; m.end += d; m.openTok += td; m.closeTok += td; ls(m.lineseg); }
    for (const r of p.runs) { r.start += d; r.end += d; r.openTok += td; r.closeTok += td; }
    for (const t of p.ts) { t.openStart += d; t.openEnd += d; t.closeStart += d; t.closeEnd += d; t.tok += td; }
    for (const c of p.chars) { c.raw[0] += d; c.raw[1] += d; c.tok += td; }
    for (const a of p.anchors) {
      a.start += d; a.end += d; a.tok += td;
      if (a.innerTok != null) a.innerTok += td;
      if (a.innerStart != null) { a.innerStart += d; a.innerEnd += d; }
      if (a.closeTok != null) a.closeTok += td;
    }
  }
}

// ── 검증 모드(HWPX_SECTION_VERIFY=1): 뒤쪽은 사본을 옮기고(옛 객체는 예전처럼 옛 자리로 남긴 채) 옛 객체의 자리 읽기를 staleReads 에 모은다 ──

const POS_KEYS = {
  para: ['start', 'end', 'openTok', 'closeTok', 'idx', 'body', 'ref'], member: ['start', 'end', 'openTok', 'closeTok'], lineseg: ['start', 'end', 'tok'],
  run: ['start', 'end', 'openTok', 'closeTok'], t: ['openStart', 'openEnd', 'closeStart', 'closeEnd', 'tok'], char: ['tok'],
  anchor: ['start', 'end', 'tok', 'innerTok', 'innerStart', 'innerEnd', 'closeTok'], token: ['start', 'end', 'attrStart', 'attrEnd'],
};
function poison(obj, keys) {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    let v = obj[k];
    Object.defineProperty(obj, k, { configurable: true, enumerable: true,
      get() { const site = new Error().stack.split('\n').slice(2, 5).map((l) => l.trim()).join(' < '); staleReads.set(site, (staleReads.get(site) || 0) + 1); return v; },
      set(x) { v = x; } });
  }
}
function verifyTail(tailTok, tailParas, tailBody) {
  const tok = tailTok.map((t) => ({ ...t }));
  const map = new Map();
  const paras = tailParas.map((p) => {
    const rm = new Map(p.runs.map((r) => [r, { ...r }])); const tm = new Map(p.ts.map((t) => [t, { ...t, run: rm.get(t.run) ?? t.run }]));
    const lm = new Map(); const ls = (x) => { if (!x) return x; if (!lm.has(x)) lm.set(x, { ...x }); return lm.get(x); };
    const am = new Map(p.anchors.map((a) => [a, { ...a, t: tm.get(a.t) ?? a.t, run: rm.get(a.run) ?? a.run }]));
    // 시작·끝 표식은 같은 objects/attach 배열을 함께 쓴다(engine/doc.js changes() 가 end.objects === m.objects 로 짝을 본다) — 사본도 같이 쓰게
    const arr = new Map(); const arrOf = (x) => { if (!arr.has(x)) arr.set(x, x.map((o) => am.get(o) ?? o)); return arr.get(x); };
    for (const a of am.values()) {
      if (a.objects) a.objects = arrOf(a.objects);
      if (a.attach) a.attach = arrOf(a.attach);
      if (a.marks) a.marks = { begin: am.get(a.marks.begin) ?? a.marks.begin, end: am.get(a.marks.end) ?? a.marks.end };
    }
    const q = { ...p, runs: [...rm.values()], ts: [...tm.values()], anchors: [...am.values()], lineseg: ls(p.lineseg),
      chars: p.chars.map((c) => ({ ...c, raw: [...c.raw], t: tm.get(c.t) ?? c.t, run: rm.get(c.run) ?? c.run })) };
    if (p.members) q.members = p.members.map((m) => ({ ...m, lineseg: ls(m.lineseg) }));
    map.set(p, q); return q;
  });
  for (const q of paras) { q.parent = q.parent ? (map.get(q.parent) ?? q.parent) : null; q.children = q.children.map((c) => map.get(c) ?? c); }
  // 옛 객체: 값은 그대로(예전처럼 옛 자리), 다시 읽은 뒤의 읽기는 staleReads 에
  for (const t of tailTok) poison(t, POS_KEYS.token);
  for (const p of tailParas) {
    poison(p, POS_KEYS.para);
    for (const m of p.members || []) poison(m, POS_KEYS.member);
    for (const x of new Set([p.lineseg, ...(p.members || []).map((m) => m.lineseg)].filter(Boolean))) poison(x, POS_KEYS.lineseg);
    for (const r of p.runs) poison(r, POS_KEYS.run);
    for (const t of p.ts) poison(t, POS_KEYS.t);
    for (const c of p.chars) { poison(c, POS_KEYS.char); poison(c.raw, ['0', '1']); }
    for (const a of p.anchors) poison(a, POS_KEYS.anchor);
  }
  return { tailTok: tok, tailParas: paras, tailBody: tailBody.map((p) => map.get(p)) };
}

/** 상태를 견줄 수 있는 글로(객체 참조는 번호로, 키는 차례대로) */
function canonState(st) {
  const pidx = new Map(st.paras.map((p, i) => [p, i]));
  const plain = (x) => {
    if (x instanceof Map) return [...x];
    if (Array.isArray(x)) return x.map(plain);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) o[k] = plain(x[k]); return o; }
    return x;
  };
  const out = st.paras.map((p, i) => {
    if (p.idx !== i) return `idx ${p.idx} at ${i}`;
    const rm = new Map(p.runs.map((r, k) => [r, k])); const tm = new Map(p.ts.map((t, k) => [t, k])); const am = new Map(p.anchors.map((a, k) => [a, k]));
    const lsl = []; const lid = (x) => { if (!x) return null; let k = lsl.indexOf(x); if (k < 0) { lsl.push(x); k = lsl.length - 1; } return [k, plain(x)]; };
    const ref = (m, x) => (x == null ? null : (m.has(x) ? m.get(x) : 'FOREIGN'));
    const o = {};
    for (const k of Object.keys(p).sort()) {
      const v = p[k];
      if (k === 'parent') o[k] = v ? (pidx.has(v) ? pidx.get(v) : 'FOREIGN') : null;
      else if (k === 'children') o[k] = v.map((c) => (pidx.has(c) ? pidx.get(c) : 'FOREIGN'));
      else if (k === 'lineseg') o[k] = lid(v);
      else if (k === 'members') o[k] = v.map((m) => ({ ...plain({ ...m, lineseg: null }), lineseg: lid(m.lineseg) }));
      else if (k === 'ts') o[k] = v.map((t) => ({ ...plain({ ...t, run: null }), run: ref(rm, t.run) }));
      else if (k === 'chars') o[k] = v.map((c) => ({ ...plain({ ...c, t: null, run: null }), t: ref(tm, c.t), run: ref(rm, c.run) }));
      else if (k === 'anchors') {
        // 함께 쓰는 배열(objects·attach)은 처음 나온 차례 번호로 — 같은 배열을 쓰는가까지 견준다
        const arrs = []; const aid = (x) => { if (!x) return null; let n = arrs.indexOf(x); if (n < 0) { arrs.push(x); n = arrs.length - 1; } return n; };
        o[k] = v.map((a) => ({ ...plain({ ...a, t: null, run: null, objects: null, attach: null, marks: null }), t: ref(tm, a.t), run: ref(rm, a.run),
          objects: a.objects ? [aid(a.objects), a.objects.map((x) => ref(am, x))] : null, attach: a.attach ? [aid(a.attach), a.attach.map((x) => ref(am, x))] : null,
          marks: a.marks ? [ref(am, a.marks.begin), ref(am, a.marks.end)] : null }));
      } else o[k] = plain(v);
    }
    return JSON.stringify(o);
  });
  return { paras: out, body: st.bodyParas.map((p) => (pidx.has(p) ? pidx.get(p) : 'FOREIGN')), tokens: st.tokens.map((t) => JSON.stringify(plain(t))) };
}
function verifyPartial(sec, xml, next) {
  const full = sec._full(xml); sectionLoadStats.full--;
  const A = canonState(next), B = canonState(full);
  const diff = (x, y, what) => {
    if (x.length !== y.length) return `${what} 수 ${x.length} ≠ ${y.length}`;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${what}[${i}] 다름\n부분: ${String(x[i]).slice(0, 600)}\n전체: ${String(y[i]).slice(0, 600)}`;
    return null;
  };
  const shapeA = JSON.stringify({ ...next.shape, bodyFrames: next.shape.bodyFrames.map((f) => [f.name, f.tok]) });
  const shapeB = JSON.stringify({ ...full.shape, bodyFrames: full.shape.bodyFrames?.map((f) => [f.name, f.tok]) });
  const bad = diff(A.tokens, B.tokens, '토큰') || diff(A.paras, B.paras, '문단') || diff(A.body, B.body, '본문 문단')
    || (shapeA !== shapeB ? `구역 모양 다름 ${shapeA} ≠ ${shapeB}` : null);
  if (bad) throw new Error(`SECTION_PARTIAL_MISMATCH s${sec.index}: ${bad}`);
}

function containerOf(stack, cur) {
  if (!cur) return null;
  // 부모 문단 프레임 다음에 오는 첫 번째 '의미 있는' 요소 이름
  let seen = false;
  for (const fr of stack) {
    if (fr.para === cur && !seen && fr.name === 'hp:p') { seen = true; continue; }
    if (seen && fr.name !== 'hp:run' && fr.name !== 'hp:ctrl' && fr.name !== 'hp:subList' && fr.name !== 'hp:tr' && fr.name !== 'hp:tc') return fr.name;
  }
  return seen ? 'hp:subList' : null;
}
