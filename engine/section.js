// 구역(section) XML 의 문단 모델 — 원문 위치 보존.
// 각 hp:p 를 문단 레코드로 만들고, 문단이 직접 가진 글자(코드포인트) 하나하나의 원문 위치와
// 변경 추적(삽입/삭제) 상태, 0폭 표식(메모 필드·컨트롤·마크)을 기록한다.
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

export class Section {
  constructor(xml, index) {
    this.index = index;
    this.load(xml);
  }

  load(xml) {
    this.xml = xml;
    this.loadSeq = (this.loadSeq || 0) + 1; // 다시 읽은 차례(문서 단위 캐시 열쇠 — 하이퍼링크 대상 id 등)
    this.stamp = ++loadStamp;                // [hwpx-cowork] 모든 구역에 걸쳐 겹치지 않는 읽은 차례(구역을 통째로 바꿔 끼워도 다른 값 — HwpxDoc._objectInfo 캐시 열쇠)
    this.tokens = scan(xml);
    this.paras = [];
    this.bodyParas = [];
    this._build();
  }

  _build() {
    const { xml, tokens } = this;
    const stack = []; // {name, tok, para}
    let cur = null;   // 현재 글자를 받는 문단
    const paraById = this.paras;
    const nestedCounter = new Map(); // parent idx -> count
    const hiddenCounter = new Map(); // parent idx -> 지운 개체 안 문단 수('/d' 번호)
    this._cont = null; // [hwpx-cowork] 나눔을 지운 본문 문단 — 다음 본문 <hp:p> 가 이 기록을 잇는다(문단 나눔 변경 추적)
    for (let ti = 0; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (t.type === 'open' || t.type === 'selfclose') {
        if (t.name === 'hp:p') {
          // [hwpx-cowork] 앞 본문 문단이 짝 맞는 지운 나눔(deleteEnd paraend="1", 뒤에 글자 없음)으로 끝났으면 이 물리 문단은 같은 기록의 다음 member
          // — 최종본에서 한 문단(ref·글·중첩 번호가 평탄화 사본과 같다). 상태(변경 범위·줄 정보)는 물리 문단마다
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
            idx: paraById.length, body: null, parent: cur, container: containerOf(stack, cur),
            children: [], start: t.start, end: t.end, openTok: ti, closeTok: ti,
            chars: [], anchors: [], runs: [], ts: [], _ctrlStack: [], _inT: null, _run: null,
            _ins: null, _del: null, lineseg: null,
          };
          if (!cur) { rec.body = this.bodyParas.length; this.bodyParas.push(rec); rec.ref = `s${this.index}/p${rec.body}`; }
          else {
            // [hwpx-cowork] 변경 추적으로 지운 개체(그 문단이나 조상 문단의 run 에 직접 든 표·그림·도형 — del) 안 문단은 최종본에 없다:
            // ref 를 '/d{k}'(따로 셈)로 매겨 보이는 중첩 문단의 n 번호가 평탄화 사본(작업본)과 같게 한다. 넣은 개체(ins) 안 문단은 added(원본 보기에서 숨음)
            const hidden = !!cur.hidden || cur._ctrlStack.some((a) => a.del && isObjectAnchor(a));
            const added = !!cur.added || cur._ctrlStack.some((a) => a.ins && isObjectAnchor(a));
            const counter = hidden ? hiddenCounter : nestedCounter;
            const k = (counter.get(cur.idx) || 0); counter.set(cur.idx, k + 1);
            cur.children.push(rec); rec.nested = k; rec.ref = `${cur.ref}/${hidden ? 'd' : 'n'}${k}`;
            if (hidden) { rec.hidden = true; cur.hiddenKids = (cur.hiddenKids || 0) + 1; }
            if (added) rec.added = true;
          }
          paraById.push(rec);
          if (t.type === 'open') { stack.push({ name: t.name, tok: ti, para: rec }); cur = rec; }
          continue;
        }
        if (t.type === 'open') stack.push({ name: t.name, tok: ti, para: cur });
        if (cur) this._onElementStart(cur, t, ti, stack);
        continue;
      }
      if (t.type === 'close') {
        let fr = stack.pop();
        while (fr && fr.name !== t.name) fr = stack.pop();
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
    this._cont = null;
    for (const p of this.paras) { delete p._ctrlStack; delete p._inT; delete p._run; delete p._ins; delete p._del; delete p._brk; }
    for (const p of this.paras) if (p.anchors.length > 1) attachObjectMarks(p);
    for (const p of this.paras) if (p._pe) { delete p._pe; markBreaks(p); }
    for (const p of this.bodyParas) if (p.members) setLeader(p);
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
