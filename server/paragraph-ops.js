// [hwpx-cowork] 본문 문단 통째로 지우기·옮기기 제안(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-1). Service.prototype 에 섞는다(server/service.js 끝).
// 새 연결의 delete_paragraphs·move_paragraphs op(server/mcp2/ops.js)가 제안 종류 para_delete·para_move 로 풀린다(REST POST /proposals 로도 낼 수 있다).
// 2026-11-16 밤 실험 T10(절 지우기)은 글만 지워 빈 문단 6개가 남았고, T09(절 옮기기)는 새 자리에 다시 만들고(표는 새 표) 원래 자리에 빈 문단 5개가 남았다.
//
// 제안: p.ref = 범위 첫 문단, p.paras = { count, first(첫 글 몇 줄), prints(문단마다 지문 — 반영 때 그대로인지), dest(옮길 자리 글) }, 옮기기는 p.afterRef = 옮길 자리
//   (그 문단 뒤 — before 로 받았으면 그 앞 문단). 둘 다 같은 구역 안(구역 첫 문단·구역 나누기 문단은 못 고름 — engine/para-move.js paragraphRange).
// 반영:
//   - 변경 추적 문서(실시간 '변경 추적으로'·승인 방식 — service._breakTracking): 사람 편집 반영(server/live.js 문단 지우기)과 같은 길 —
//     1차 문단마다 글 지움 표식·개체 지움 표식(뒤에서부터), 2차 앞 문단 끝 나눔 지움(paraend="1" — 한/글 2022 실측 b꼴, engine/track-objects.js BREAK_TRACK).
//     옮기기 = 원래 자리 지움 + 새 자리 넣음(한/글 변경 추적에는 '옮김' 종류가 없다 — 머리 항목 hh:trackChange type 은 Insert·Delete·…뿐이고, 잘라 붙이기는
//     지움 + 넣음으로 남는다). 넣음은 실시간 붙여넣기와 같은 길(insertParagraphAfter trackBreak + copyFormattingFrom + copyObjectsTracked — 표·그림은
//     원본 XML 을 새 id 로 가져온다). 되돌리기 = 이 제안이 만든 변경을 모두 거절.
//   - 실시간 '고친 글만'(V4 §4.2): 지우기 = 문단째 지움(engine removeParagraphsRaw), 옮기기 = XML 그대로 잘라 붙임(moveParagraphsRaw — 다른 제안도 따라간다).
//     되돌리기 = 지우기는 직전 사본(store undo)으로(문서가 그 뒤 그대로면 통째로, 아니면 사본에서 문단을 다시 만든다), 옮기기는 거꾸로 옮김.
// 주소: 지운 문단(변경 추적 문서에서 옮긴 원래 문단)을 가리키던 대기 제안은 lost(_remapRefs 규칙) — 되돌리면 그 문단 글이 그대로일 때 되살린다.
// 반영 뒤 p.ref = 지운(옮겨 간) 자리 바로 앞 문단(늘 있다 — 구역 첫 문단은 고를 수 없다), 옮긴 문단의 새 자리 = insertedRef(첫 문단) + extraRefs(나머지, 문서 차례).
//
// 같은 요청의 다른 제안과 함께 반영(2026-11-17 L1 — 실제 Codex 실험 X02: 한 edit 에 절 제목 번호 replace + 그 절 move_paragraphs 를 냈더니 replace 가
// 먼저 반영되면 옮기기가 STALE '옮길 문단이 바뀌었습니다'):
//   ① 같은 요청(요청 없는 제안은 같은 작성자의 요청 없는 제안 — _advancePendingFormats·_insertAfterRef 와 같은 규칙)의 제안을 반영·되돌릴 때,
//      그 요청의 대기 지우기·옮기기 범위 안 문단 가운데 '반영 직전에 제안 때 지문 그대로였던' 문단의 지문(p.paras.prints)을 새 글로 넘긴다
//      (_paraPrintsBefore/_paraPrintsAfter — _applyCore·_undoCore 머리·끝). 사람 편집·다른 요청의 변경으로 이미 달라진 문단은 넘기지 않는다 → 지금처럼 STALE.
//      범위 문단은 반영 동안 주소 옮김(_remapSectionsDeep 의 meta[PARA_TRACK])을 따라가며, 범위가 갈라지거나(문단 넣기·여러 줄 바꿈) 지워지면 넘기지 않는다.
//      되돌리기(undo)도 같은 길이라 글이 돌아오면 지문도 돌아온다.
//   ② 변경 추적 문서에서 옮기기를 먼저 반영하면, 원래 자리(지움 표시) 문단을 가리키던 대기 제안(요청과 상관없이 — '고친 글만' 문서에서 XML 째 옮겨
//      모든 대기 제안이 따라가는 것과 같게)은 새 자리 사본으로 따라간다(중첩 꼬리 /nK·표 열쇠 #t 는 사본 구조가 같을 때만 — 다르면 lost 그대로).
//      되돌리면(거절) 원래 자리로 돌아온다(paraUndo.followed). 따라간 제안을 반영한 채로는 옮기기를 되돌리지 않는다(STALE — 그 제안 먼저 되돌리기).
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { docBytesSync, containerFromBytesSync } from '../engine/toc.js';
import { paragraphRange, moveParagraphsRaw, moveIndexMap, removeParagraphsRaw, planParagraphs, paragraphPrint, paragraphLabel, insertParagraphsFrom } from '../engine/para-move.js';
import { ServiceError } from './service.js';

export const PARA_TYPES = Object.freeze(['para_delete', 'para_move']);
/** 반영 동안 따라갈 대기 지우기·옮기기 범위 문단(meta 에 잠깐 — 기호 열쇠라 저장·복사되지 않는다). service._remapSectionsDeep 이 옮긴다 */
export const PARA_TRACK = Symbol('paraTrack');
const PREVIEW_LINES = 3;   // engine/para-move.js planParagraphs 의 first 줄 수와 같게
const BODY = /^s(\d+)\/p(\d+)$/;
const parse = (ref) => { const m = BODY.exec(String(ref || '')); return m ? { sec: Number(m[1]), body: Number(m[2]) } : null; };
const docSig = (doc) => crypto.createHash('sha256').update([doc.header?.xml, ...doc.sections.map((s) => s.xml)].join(String.fromCharCode(1))).digest('hex').slice(0, 16);

export const paragraphOpMethods = {
  /** _proposeCore 의 para_delete·para_move 갈래: p 에 자리·범위를 적는다 → memoLoc */
  _proposeParas(ctx, p, inp, type) {
    const { doc, meta } = ctx;
    const move = type === 'para_move';
    const plan = this._engine(() => planParagraphs(doc, { ref: inp.ref, toRef: inp.toRef, afterRef: inp.afterRef, beforeRef: inp.beforeRef }, { move }));
    p.ref = plan.refs[0];
    p.afterRef = move ? `s${plan.sec}/p${plan.after}` : p.ref;
    if (meta.proposals.some((q) => q.type === type && q.status === 'pending' && !q.lost && q.ref === p.ref && q.paras?.count === plan.count && (!move || q.afterRef === p.afterRef))) {
      throw new ServiceError('SAME', `${p.ref} 부터 문단 ${plan.count}개를 ${move ? '옮기는' : '지우는'} 제안이 이미 있습니다`);
    }
    p.paras = { count: plan.count, first: plan.first, ...(plan.last ? { last: plan.last } : {}), prints: plan.prints, ...(move ? { dest: plan.dest } : {}) };
    return { ref: p.ref, start: 0, end: [...doc.text(p.ref, 'final')].length };
  },

  /**
   * (2026-11-17 L1 ①) _applyCore·_undoCore 머리: p 와 같은 요청의 대기 지우기·옮기기 가운데 범위 안에 '지금 제안 때 지문 그대로'인 문단이 있는 것을 적어 둔다
   * → 끝에서 _paraPrintsAfter 에 넘길 목록(없으면 null). 범위 문단 주소는 이 반영 동안 meta[PARA_TRACK] 로 주소 옮김을 따라간다
   */
  _paraPrintsBefore(ctx, p) {
    const { doc, meta } = ctx;
    delete meta[PARA_TRACK];   // 앞 반영이 오류로 끝나 남은 것
    // 지우기·옮기기 자신(범위 지문을 스스로 다룬다)·쪽 구성(문단 구조를 통째로 바꾼다 — 주소 옮김이 _layoutRemap)은 넘기지 않는다
    if (PARA_TYPES.includes(p.type) || p.type === 'page_layout') return null;
    const mate = (q) => (p.rid != null ? q.rid === p.rid : q.rid == null && q.by === p.by);
    const list = [];
    for (const q of meta.proposals) {
      if (q === p || !PARA_TYPES.includes(q.type) || q.status !== 'pending' || q.lost || !mate(q)) continue;
      const head = parse(q.ref); const count = Number(q.paras?.count) || 0; const prints = q.paras?.prints;
      if (!head || !count || !Array.isArray(prints)) continue;
      const refs = Array.from({ length: count }, (_, k) => `s${head.sec}/p${head.body + k}`);
      const fresh = refs.map((r, k) => { try { return paragraphPrint(doc, r) === prints[k]; } catch { return false; } });
      if (fresh.some(Boolean)) list.push({ q, refs, fresh });
    }
    if (!list.length) return null;
    meta[PARA_TRACK] = list;
    return list;
  },

  /** (2026-11-17 L1 ①) _applyCore·_undoCore 끝: 적어 둔 범위가 그대로 이어져 있으면 그 사이 바뀐(반영 직전엔 그대로였던) 문단의 지문·첫 글을 새 글로 */
  _paraPrintsAfter(ctx, list) {
    const { doc, meta } = ctx;
    if (meta[PARA_TRACK] === list) delete meta[PARA_TRACK];
    if (!list) return;
    for (const { q, refs, fresh } of list) {
      if (q.status !== 'pending' || q.lost || q.ref !== refs[0]) continue;
      const at = refs.map(parse);
      // 범위 안에 문단이 끼거나(넣기·여러 줄 바꿈) 지워졌으면 무엇을 옮길지 달라졌다 — 넘기지 않는다(반영 때 STALE)
      if (at.some((x, k) => !x || x.sec !== at[0].sec || x.body !== at[0].body + k)) continue;
      const prints = [...q.paras.prints]; const first = [...(q.paras.first || [])]; let last = q.paras.last; let changed = false;
      refs.forEach((r, k) => {
        if (!fresh[k]) return;
        let now; try { now = paragraphPrint(doc, r); } catch { return; }
        if (now === prints[k]) return;
        prints[k] = now; changed = true;
        if (k < PREVIEW_LINES && k < first.length) first[k] = paragraphLabel(doc, r);
        if (last != null && k === refs.length - 1) last = paragraphLabel(doc, r);
      });
      if (changed) q.paras = { ...q.paras, prints, first, ...(last != null ? { last } : {}) };
    }
  },

  /**
   * (2026-11-17 L1 ②) 변경 추적 문서의 옮기기: 원래 자리(지움 표시)를 가리켜 잃은 대기 제안을 새 자리 사본으로. src = 지우기 전 문서 사본,
   * spot = { k(범위 첫 문단부터 몇째), tail(본문 번호 뒤 꼬리) }, placed = 사본 첫 문단 번호 → 새 주소 | null(사본 구조가 달라 따라갈 수 없음)
   */
  _followCopy(src, doc, sec, from, placed, spot) {
    const srcRef = `s${sec}/p${from + spot.k}`; const newRef = `s${sec}/p${placed + spot.k}`;
    if (!spot.tail) return newRef;
    try {
      // 직접 중첩 문단(표 칸·글상자 글 …)의 담는 요소 차례가 같아야 한다. 메모 글(hp:fieldBegin 안 문단)은 빼고 센다 — 본문 글의 메모는 사본에 따라오지 않고
      // (글만 다시 넣는다) 개체 안 메모는 위에서 뺐다. 메모 글도 '/nK' 차례에 끼므로 꼬리 번호는 메모를 뺀 차례로 옮겨 단다
      const kids = (d, ref) => d.resolve(ref).p.children.filter((c) => !c.hidden && c.container !== 'hp:fieldBegin');
      const ks = kids(src, srcRef); const kd = kids(doc, newRef);
      if (ks.map((c) => c.container || '').join(',') !== kd.map((c) => c.container || '').join(',')) return null;
      if (spot.tail.startsWith('#')) {
        // 표 열쇠(#t0, 칸 #t0@r,c): 같은 차례의 표가 같은 칸 짜임이어야 한다
        const key = spot.tail.replace(/@.*$/, '');
        const grid = (d, ref) => { const t = d.tables().find((x) => x.key === `${ref}${key}`); return t ? JSON.stringify(t.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.text ?? null])) : null; };
        const g = grid(src, srcRef);
        return g != null && g === grid(doc, newRef) ? `${newRef}${spot.tail}` : null;
      }
      const m = /^(\/n\d+)(.*)$/.exec(spot.tail);
      if (!m) return null;   // 숨은 중첩(/d — 지운 개체 안)은 따라가지 않는다
      const at = ks.findIndex((c) => c.ref === `${srcRef}${m[1]}`);
      if (at < 0) return null;
      const to = `${kd[at].ref}${m[2]}`;
      return src.text(`${srcRef}${spot.tail}`, 'final') === doc.text(to, 'final') ? to : null;
    } catch { return null; }
  },

  /** 반영(_applyCore 의 갈래) */
  _applyParas(ctx, p) {
    const { doc, meta } = ctx;
    const author = p.by;
    const move = p.type === 'para_move';
    // 제안 메모 자리(_locate)는 쓰지 않는다 — 메모는 범위 첫 문단에 달려 afterRef(옮길 자리)와 다르고, 문단 주소는 _remapRefs 가 늘 따라 옮긴다
    const head = parse(p.ref);
    const count = Number(p.paras?.count) || 0;
    if (!head || !count) throw new ServiceError('STATE', `제안 ${p.pid} 의 범위를 모릅니다`, 409);
    const sec = head.sec; const from = head.body; const to = from + count - 1;
    const stale = (why) => new ServiceError('STALE', `${why} — 다시 읽고 제안하세요`, 409);
    const n = doc.sections[sec]?.bodyParas.length ?? 0;
    if (to >= n) throw stale(`제안한 뒤 문단이 줄어 ${p.ref} 부터 ${count}개가 없습니다`);
    for (let k = 0; k < count; k++) {
      if (paragraphPrint(doc, `s${sec}/p${from + k}`) !== p.paras.prints[k]) throw stale(`제안한 뒤 ${move ? '옮길' : '지울'} 문단(s${sec}/p${from + k})이 바뀌었습니다`);
    }
    let after = null;
    if (move) {
      const d = parse(p.afterRef);
      if (!d || d.sec !== sec) throw stale('옮길 자리를 찾지 못했습니다');
      after = d.body;
      if (after >= from - 1 && after <= to) throw stale(`옮길 자리(${p.afterRef})가 옮길 범위 안이거나 바로 앞입니다`);
    }
    this._engine(() => paragraphRange(doc, sec, from, to, { move }));
    const tracked = this._breakTracking(meta, doc);
    // 이 제안 자신은 주소 옮김에서 뺀다(지울 범위를 가리켜 lost 가 되지 않게 — 반영 뒤 자리는 아래에서 정한다).
    // 변경 번호 지킴이(holder): 다시 매김(_syncChangeIds)을 함께 받아, 이 반영이 만든 변경 = 지금 머리 항목 가운데 holder 에 없는 것
    const idx = meta.proposals.indexOf(p);
    const holder = { pid: 0, status: 'holder', changeIds: doc.header.changes().map((c) => Number(c.id)) };
    // 이 반영으로 잃을 대기 제안의 범위 안 자리(k = 범위 첫 문단부터 몇째, 꼬리) — 잃은 주소도 그 뒤 주소 옮김을 계속 받으므로 지금 적어 둔다(되돌릴 때 되살림)
    const inRange = (ref) => { const m = /^s(\d+)\/p(\d+)(.*)$/.exec(String(ref || '')); return m && Number(m[1]) === sec && Number(m[2]) >= from && Number(m[2]) <= to ? { k: Number(m[2]) - from, tail: m[3] } : null; };
    const spots = new Map(meta.proposals.filter((q) => q !== p && !q.lost && !q.refGone).map((q) => [q.pid, { ref: inRange(q.ref), afterRef: inRange(q.afterRef), ...(q.tableKey ? { tableKey: inRange(q.tableKey) } : {}) }]));
    if (idx >= 0) meta.proposals.splice(idx, 1);
    meta.proposals.push(holder);
    let anchor; let placed = null;
    const followed = [];   // (2026-11-17 L1 ②) 변경 추적 옮기기에서 사본으로 따라간 대기 제안
    try {
      const gone = (i) => (i < from ? i : i <= to ? -1 : i - count);
      if (!tracked && !move) {
        if (!ctx.preview && !ctx.batchExecution) this.store.writeUndo(ctx.id, p.pid, docBytesSync(doc));
        this._engine(() => removeParagraphsRaw(doc, sec, from, to));
        this._syncChangeIds(meta, doc);
        this._remapRefs(meta, sec, gone);
        anchor = from - 1;
      } else if (!tracked) {
        const r = this._engine(() => moveParagraphsRaw(doc, sec, from, to, after));
        this._syncChangeIds(meta, doc);
        const fn = moveIndexMap(from, to, after);
        this._remapRefs(meta, sec, fn);
        anchor = fn(from - 1); placed = r.from;
      } else {
        const src = move ? new HwpxDoc(containerFromBytesSync(docBytesSync(doc))) : null;
        // (2026-11-17 L1) 사본 개체(표 칸·글상자 글)에 든 메모는 옮겨 가지 않는다: copyObjectsTracked 가 표 XML 을 그대로 가져와 메모 필드 id 가 겹쳤다
        // (구조 검사 V1 '필드 시작 id 가 2번' — 제안 메모가 달린 표 칸이 든 절을 옮기면 반영이 거절됨). 본문 글의 메모처럼 지운 쪽(원래 자리)에 남는다
        if (src) {
          const nested = new RegExp(`^s${sec}/p(\\d+)/`);
          for (const m of src.memos()) { const x = nested.exec(String(m.ref || '')); if (x && Number(x[1]) >= from && Number(x[1]) <= to) this._engine(() => src.deleteMemo(m.id)); }
        }
        this._clearParagraphsTracked(ctx, sec, from, to, author);
        this._remapRefs(meta, sec, gone);
        anchor = from - 1;
        if (move) {
          let at = after > to ? after - count : after;
          placed = at + 1;
          const date = new Date();
          for (let k = 0; k < count; k++) {
            const srcRef = `s${sec}/p${from + k}`;
            const newRef = this._engine(() => doc.insertParagraphAfter(sec, at, src.text(srcRef, 'final'), { author, date, trackBreak: true }));
            const nb = parse(newRef).body;
            this._remapRefs(meta, sec, (i) => (i >= nb ? i + 1 : i));
            if (anchor >= nb) anchor += 1;
            this._engine(() => doc.copyFormattingFrom(src, srcRef, newRef));
            this._engine(() => doc.copyObjectsTracked(src, srcRef, newRef, { author, date }));
            this._syncChangeIds(meta, doc);
            at = nb;
          }
          // (2026-11-17 L1 ②) 원래 자리(지움 표시)를 가리켜 방금 잃은 대기 제안은 새 자리 사본으로 — 실시간 '고친 글만'이 XML 째 옮겨 모든 대기 제안이
          // 따라가는 것과 같은 결과(내용이 옮겨 갔으니 요청과 상관없이). 꼬리(중첩·표)는 사본 구조가 같을 때만, 하나라도 못 따라가면 lost 그대로.
          // 반영되지 않은 것(대기·복구·거절 — 다시 열 수 있다)만: 반영된 제안의 변경 표식은 원래 문단(지움 표시) 안에 남았다(refGone 그대로)
          for (const q of meta.proposals) {
            const s = spots.get(q.pid);
            if (!s || q === holder || q.status === 'applied' || !(q.lost || q.refGone)) continue;
            const next = {}; let ok = false;
            for (const key of ['ref', 'afterRef', 'tableKey']) {
              if (!s[key]) continue;
              const r = this._followCopy(src, doc, sec, from, placed, s[key]);
              if (!r) { ok = false; break; }
              next[key] = r; ok = true;
            }
            if (!ok) continue;
            Object.assign(q, next); delete q.lost; delete q.refGone;
            // 요청 없는 제안의 제안 메모는 원래 자리(지움 표시 쪽)에 남는다(위 — 사본 개체에서 메모를 뺀다) — 자리는 메모가 아니라 주소로 찾는다(service._locate)
            if (q.memo && q.memoId) q.memoLeft = true;
            followed.push({ pid: q.pid, ...s });
          }
        }
      }
    } finally {
      meta.proposals.splice(meta.proposals.indexOf(holder), 1);
      if (idx >= 0) meta.proposals.splice(idx, 0, p);
    }
    const own = new Set(holder.changeIds);
    p.changeIds = doc.header.changes().map((c) => Number(c.id)).filter((id) => !own.has(id));
    const lost = meta.proposals.filter((q) => (q.lost || q.refGone) && spots.get(q.pid)?.ref).map((q) => ({ pid: q.pid, ...spots.get(q.pid) }));
    p.paraUndo = { sec, from, to, tracked, total: p.changeIds.length, ...(lost.length ? { lost } : {}), ...(followed.length ? { followed } : {}) };
    p.ref = `s${sec}/p${anchor}`;
    if (!move) p.afterRef = p.ref;
    if (placed != null) {
      p.insertedRef = `s${sec}/p${placed}`;
      p.extraRefs = Array.from({ length: count - 1 }, (_, k) => `s${sec}/p${placed + k + 1}`);
    }
    if (!tracked) {
      p.appliedFinal = true; p.changeIds = [];
      if (!move) { p.objectUndo = { para: true, doc: null }; (ctx.objectSnapshots ||= []).push(p); }   // 문서 지문은 커밋 뒤(_finish)
    }
    ctx.formatting = true;
    ctx.changed.add(p.ref);
    if (p.insertedRef) ctx.changed.add(p.insertedRef);
  },

  /**
   * 변경 추적 문서의 문단 통째로 지우기(server/live.js 문단 지우기의 1·2차와 같은 차례·같은 XML): 뒤에서부터 글 지움(applyLiveText '')·개체 지움 표식,
   * 그다음 뒤에서부터 앞 문단 끝 나눔 지움(deleteBreakAfter — 엔진이 흉내 낼 수 있으면 묶음 함수로 구역 한 번 다시 읽기). 주소 옮김은 부르는 쪽
   */
  _clearParagraphsTracked(ctx, sec, from, to, author) {
    const { doc, meta } = ctx;
    const date = new Date();
    const idxs = []; for (let i = to; i >= from; i--) idxs.push(i);
    const objects = this._objectTracking(meta, doc);
    const batch = objects && idxs.length > 1 && idxs.every((i) => doc.canClearTracked(sec, i))
      ? this._engine(() => doc.clearParagraphsTracked(sec, idxs, { author, date, objectDate: date })) : null;
    if (batch) this._syncChangeIds(meta, doc);
    else {
      for (const i of idxs) {
        const ref = `s${sec}/p${i}`;
        // (2026-11-17 L1) 승인 방식('plain')도 실시간 '변경 추적으로'(applyLiveText tracked)처럼 이 작성자의 처리 안 된 글 변경은 먼저 거절하고 지운다 —
        // 같은 요청이 그 문단 글을 먼저 바꾼 경우(X02: 절 제목 번호 바꾸기 → 그 절 옮기기)에 OVERLAP 으로 막히지 않게. 옮긴 사본은 지우기 전 최종 글
        // (바꾼 글)로 만들므로 결과는 같다. 남의 변경과 겹치면 예전처럼 OVERLAP(사람이 먼저 수락·거절)
        if (this._textMode(meta) === 'plain') {
          const own = doc.changes().filter((c) => c.ref === ref && c.author === author && !c.spansParagraph && !c.kind && !c.paraEnd && c.scope !== 'paragraph').map((c) => c.id);
          if (own.length) this._resolveIds(ctx, own, 'reject', { keepIfStuck: true });
        }
        this.applyLiveText(ctx, ref, '', author);
        if (objects) { this._engine(() => doc.removeOwnObjectsTracked(ref, { author, date })); this._syncChangeIds(meta, doc); }
      }
    }
    const done = idxs.length > 1 && this._engine(() => doc.deleteBreaksTracked(sec, idxs, { author, date }));
    if (!done) for (const i of idxs) this._engine(() => doc.deleteBreakAfter(`s${sec}/p${i - 1}`, { author, date }));
    this._syncChangeIds(meta, doc);
    ctx.dirty = true;
  },

  /** 되돌리기(_undoCore 의 갈래). rejectIds = _undoCore 의 거절 함수 */
  _undoParas(ctx, p, by, rejectIds) {
    const { doc, meta } = ctx;
    const u = p.paraUndo;
    const stale = (why) => new ServiceError('STALE', `${why} — 이력 탭에서 그 시점으로 복구하세요`, 409);
    if (!u) throw new ServiceError('STATE', '되돌릴 기록이 없습니다', 409);
    const a = parse(p.ref);
    if (!a || p.refGone) throw stale('그 뒤 지운 자리 앞 문단이 지워져 되돌릴 수 없습니다');
    const count = u.to - u.from + 1; const sec = u.sec;
    // 이 반영으로 잃은 제안(u.lost — 범위 안 자리)은 돌아온 문단 글이 그대로면 그 자리로 되살린다(아래)
    const spots = new Map((u.lost || []).map((x) => [x.pid, x]));
    const revive = meta.proposals.filter((q) => spots.has(q.pid) && (q.lost || q.refGone));
    // (2026-11-17 L1 ②) 변경 추적 옮기기에서 사본으로 따라간 대기 제안: 거절하면 사본이 없어지므로 원래 자리로 돌린다(아래). 그 사이 사본에서 반영한
    // 것이 있으면 되돌리지 않는다 — 거절이 그 제안의 글까지 거두어 반영 기록과 문서가 어긋난다(그 제안을 먼저 되돌리면 된다)
    const followers = u.tracked ? (u.followed || []).map((x) => [x, meta.proposals.find((q) => q.pid === x.pid)]).filter(([, q]) => q) : [];
    const busy = followers.find(([, q]) => q.status === 'applied');
    if (busy) throw new ServiceError('STALE', `옮긴 문단에 그 뒤 반영한 제안 ${busy[1].pid} 이 있습니다 — 그 제안을 먼저 되돌린 뒤 옮기기를 되돌리세요`, 409);
    let first;
    {
      if (u.tracked) {
        const live = new Set(doc.changes().map((c) => Number(c.id)));
        const mine = (p.changeIds || []).map(Number).filter((x) => live.has(x));
        if (!mine.length) throw stale('되돌릴 변경이 남아 있지 않습니다(지움이 이미 수락·거절됨)');
        if (u.total != null && mine.length !== u.total) throw stale('이 제안의 변경 가운데 일부를 그새 수락·거절해 되돌릴 수 없습니다');
        rejectIds(mine);
        first = parse(p.ref).body + 1;
      } else if (p.type === 'para_delete') {
        const bytes = this.store.undoBytes(ctx.id, p.pid);
        if (!bytes) throw stale('지운 문단의 되돌리기 기록이 남아 있지 않습니다');
        const source = new HwpxDoc(containerFromBytesSync(bytes));
        if (p.objectUndo?.doc && p.objectUndo.doc === docSig(doc)) Object.assign(doc, source);
        else if (this._engine(() => insertParagraphsFrom(doc, sec, a.body, source, sec, u.from, u.to))) this._syncChangeIds(meta, doc);
        else {
          // 그 뒤 문서가 바뀌었다: 사본의 문단 XML 을 그대로 다시 넣는다(위 — 메모·필드도 돌아온다). 차트가 들었거나 id 가 겹치면 사본에서 문단을
          // 다시 만든다(글·글자/문단 모양·표·그림·도형·조판 부호 — 메모는 돌아오지 않는다). 변경 추적 없이(고친 글만)
          let at = a.body;
          for (let k = 0; k < count; k++) {
            const srcRef = `s${sec}/p${u.from + k}`;
            const before = new Set(doc.changes().map((c) => c.id));
            const newRef = this._engine(() => doc.insertParagraphAfter(sec, at, source.text(srcRef, 'final'), { author: by }));
            const made = doc.changes().filter((c) => !before.has(c.id)).map((c) => c.id);
            if (made.length) this._resolveIds(ctx, made, 'accept');
            this._engine(() => doc.copyFormattingFrom(source, srcRef, newRef));
            this._engine(() => doc.copyObjectsFrom(source, srcRef, newRef));
            this._syncChangeIds(meta, doc);
            at = parse(newRef).body;
          }
        }
        this._syncChangeIds(meta, doc);
        this._remapRefs(meta, sec, (i) => (i > a.body ? i + count : i));
        first = a.body + 1;
      } else {
        const refs = [p.insertedRef, ...(p.extraRefs || [])];
        const at = refs.map(parse);
        if (at.some((x) => !x || x.sec !== sec) || at.some((x, k) => x.body !== at[0].body + k) || p.insertedGone) throw stale('그 뒤 옮긴 문단이 지워지거나 사이에 문단이 들어가 되돌릴 수 없습니다');
        const f = at[0].body; const t = f + count - 1;
        const r = this._engine(() => moveParagraphsRaw(doc, sec, f, t, a.body));
        this._remapRefs(meta, sec, moveIndexMap(f, t, a.body));
        first = r.from;
      }
    }
    const at = (spot) => {
      let ok = false; try { ok = paragraphPrint(doc, `s${sec}/p${first + spot.k}`) === p.paras?.prints?.[spot.k]; } catch { ok = false; }
      return ok ? `s${sec}/p${first + spot.k}${spot.tail}` : null;
    };
    for (const q of revive) {
      const x = spots.get(q.pid);
      const r = at(x.ref);
      if (!r) continue;
      q.ref = r;
      const ar = x.afterRef ? at(x.afterRef) : null; if (ar) q.afterRef = ar;
      const tk = x.tableKey ? at(x.tableKey) : null; if (tk) q.tableKey = tk;
      delete q.lost; delete q.refGone;
    }
    for (const [x, q] of followers) {
      if (q.lost || q.refGone) continue;
      const next = {}; let ok = true;
      for (const key of ['ref', 'afterRef', 'tableKey']) { if (!x[key]) continue; const r = at(x[key]); if (!r) { ok = false; break; } next[key] = r; }
      if (ok) { Object.assign(q, next); delete q.memoLeft; }
      else if (q.status === 'pending') q.lost = true;   // 돌아온 문단 글이 달라 그 자리를 믿을 수 없다(잃은 것으로 — 다른 지운 문단 제안과 같게)
      else q.refGone = true;
    }
    p.ref = `s${sec}/p${first}`;
    if (p.type === 'para_delete') p.afterRef = p.ref;
    delete p.paraUndo; delete p.objectUndo; delete p.extraRefs;
    ctx.formatting = true; ctx.changed.add(p.ref);
  },
};
