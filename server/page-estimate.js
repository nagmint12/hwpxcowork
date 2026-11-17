// 쪽 수 어림(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-7·나-9). Service.prototype 에 섞는다(server/mcp2/service.js 가 agentServiceMethods 에 더한다).
// 5쪽 논문 실험(P1·P2)에서 "꼭 5쪽"을 확인할 길이 없어 에이전트가 서식 수치로 어림했다 — 새 연결(v2)의 edit 영수증·dry_run·read(view='page')에 쪽 수를 싣는다.
//   · 지금 쪽 수: 저장된 문서를 편집기 엔진(우리 fork WASM — server/layout-worker.js)으로 조판한 쪽 수(기록 번호별로 기억한다)
//   · 모두 반영하면: 문서 사본 + meta 깊은 사본에 (dry_run 이면 이번 ops 의 제안을 만들고) 이 요청의 대기 제안을 실제 반영 경로(_orderedApplier → _applyCore)로
//     반영해 본 뒤, 반영이 만든 변경 추적은 사본에서 수락하고(최종 글 기준 — rhwp 는 지운 글도 조판한다) 조판한 쪽 수
//   · 사본 흉내는 사본 전용 서비스(Object.create — store·hub·attach·activity 를 막은 것)로 한다: 실제 meta·문서·제안 상태·방송·저장·작업 기록은 바뀌지 않는다
//   · 이벤트 루프: 사본 만들기·반영 흉내는 서버 스레드(동기 엔진)라 문서 크기·대기 제안 수·시간 한도를 두고, 넘으면 '모두 반영하면'을 빼고 이유를 한 줄로.
//     조판은 작업자 스레드(server/layout-check.js estimate — 기다리는 편집 뒤 검사보다 먼저, 바쁘면 이유를 적고 뺀다)
// 쪽 수는 편집기(rhwp) 조판이라 한/글과 다를 수 있다(알려진 차이 vendor/README.md) — 응답에 basis 로 적는다.
// 끄기: 환경 HWPX_COWORK_PAGE_ESTIMATE=0 또는 config.verify.pages === false. 한도: config.verify.pages = { maxChars, maxPending, budgetMs, waitMs }
import { HwpxDoc, EngineError } from '../engine/doc.js';
import { docBytesSync, containerFromBytesSync } from '../engine/toc.js';
import { expandFieldFill } from '../engine/fields.js';
import * as MT from './memotext.js';
import { ServiceError } from './service.js';
import { layoutChecker, pageEstimateEnabled } from './layout-check.js';

export const PAGES_BASIS = '편집기 조판 어림 — 한/글과 다를 수 있다';
// maxChars: 머리글·구역 XML 글자 합(사본 직렬화·읽기는 한 덩어리로 서버 스레드에서 돈다 — 2026-11-17 측정: 10쪽 연습 보고서 35만 자 9ms, 5쪽 논문 21만 자 5ms).
// budgetMs: 사본에서 만들기·반영 흉내의 벽시계 한도(30ms 마다 물러나며 돈다 — P1 논문 대기 제안 54건 1.7초, 가장 긴 한 덩어리 91ms). maxPending: 그보다 많으면 흉내하지 않는다
const LIMITS = { maxChars: 6_000_000, maxPending: 300, budgetMs: 6000, waitMs: 20000 };
const FULL_LAST_PAGE = 0.9;
const FULL_NOTE = '마지막 쪽이 거의 찼다 — 한/글에서는 한 쪽 넘칠 수 있다(편집기 조판 어림). 쪽 수가 꼭 맞아야 하면 여유를 둔다';
// 거의 빈 쪽(2026-11-17 작업 Q — artifacts/mcp-round3-20261117/codex/REPORT-G3.md 문제 2): 마지막 쪽이 아닌 쪽 가운데 본문이 SPARSE_FILL 보다 적게 찬 쪽.
// Z01(연습 보고서 줄이기)은 9쪽에서 멈췄는데 5쪽에는 2장 끝 144자(찬 비율 0.11 — 장마다 새 쪽 때문에 넘친 몇 줄)만 있었다 — 그 몇 줄을 줄이면 한 쪽이 준다.
// 같은 문서의 일부러 짧은 쪽은 차례 쪽 0.18·장 끝 쪽 0.23 이었다 → 문턱 0.15(A4·10pt 로 대여섯 줄). 쪽 번호와 비율만 싣는다(문서 글은 싣지 않는다).
// 글이 적은 쪽만 재므로(server/layout-worker.js SPARSE_TEXT) 글자가 아주 작은 쪽은 놓칠 수 있다
const SPARSE_FILL = 0.15;
const SPARSE_NOTE = (list) => `${list.map((x) => `${x.page}쪽`).join('·')}이 거의 비었다(sparse — 앞 쪽에서 넘친 몇 줄). 분량을 줄이는 일이면 그 몇 줄을 줄여 한 쪽을 줄일 수 있다`;
const isolated = (e) => e instanceof ServiceError || e instanceof EngineError;
// 문서를 건드렸는가(service.js docSig·sameDoc 과 같은 생각 — 같은 글 객체면 비교가 빠르다)
const docSig = (doc) => [doc.header?.xml, ...doc.sections.map((s) => s.xml)];
const sameDoc = (doc, sig) => doc.sections.length === sig.length - 1 && doc.header?.xml === sig[0] && doc.sections.every((s, i) => s.xml === sig[i + 1]);
const errText = (e) => (e?.code ? `오류(${e.code}): ${e.message}` : String(e?.message || e));
const BUSY = { busy: '조판 작업자가 다른 검사로 바빠 쪽 수를 빼었다 — 잠시 뒤 read(view=\'page\')', timeout: '조판이 시간 한도를 넘어 쪽 수를 빼었다', 'too-big': '문서 파일이 커서 쪽 수를 빼었다', worker: '조판 작업자 오류로 쪽 수를 빼었다' };

// 지금 쪽 수: 저장소·문서·기록 번호 → 조판 결과(같은 기록은 내용이 같다)
const nowCache = new Map();
const remember = (k, v) => { nowCache.set(k, v); while (nowCache.size > 64) nowCache.delete(nowCache.keys().next().value); };

/** 사본 전용 서비스: 메서드는 원래 서비스의 것을 쓰고, 저장·방송·첨부 쓰기·작업 기록에 닿으면 던진다(흉내가 실제 상태를 바꾸지 않게) */
function sandbox(service, extraBytes) {
  const sim = Object.create(service);
  const no = (what) => () => { throw new Error(`[쪽 수 어림] 사본 흉내가 ${what} 에 닿았다`); };
  const READ = new Set(['doc', 'readMeta', 'list', 'has', 'versionBytes', 'currentBytes', 'undoBytes', 'dir', 'dataDir', '_docDir']);
  const store = new Proxy(service.store, { get(t, k) {
    if (k === 'log') return () => {};   // 사본 meta 에 남길 기록(버린다)
    if (typeof k === 'string' && !READ.has(k)) return typeof t[k] === 'function' ? no(`store.${k}`) : undefined;
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const attach = { bytes: (docId, a) => (extraBytes.has(a.aid) ? extraBytes.get(a.aid) : service.attach.bytes(docId, a)), save: no('attach.save'), remove: no('attach.remove'), fullText: no('attach.fullText') };
  for (const [k, v] of Object.entries({ store, attach, hub: { broadcast: no('hub.broadcast'), broadcastAll: no('hub.broadcastAll') }, activity: { add: no('activity.add') } })) {
    Object.defineProperty(sim, k, { value: v, writable: false, configurable: true });
  }
  return sim;
}

export const pageEstimateMethods = {
  /**
   * 쪽 수 어림 → 영수증용 { now, all_applied?, last_page_fill?, sections?, pending?, apply_failed?, note?, skipped?, basis } (던지지 않는다 — 안 되면 skipped 에 이유).
   * rid: 이 요청의 대기 제안(열린 항목·비교안 아닌 것 — [모두 반영]과 같은 고르기)을 반영해 본다. pids: rid 없는 저장에서 이번에 만든 제안.
   * steps(dry_run): server/mcp2/ops.js prepareOps 의 단계 — 사본에서 제안을 만든 뒤 함께 반영한다 → 반환에 made·failed(만들기 실패 op) 를 더한다.
   */
  async agentEstimate(id, { rid = null, pids = [], steps = null, author = '서버' } = {}) {
    const dry = Array.isArray(steps);
    const out = { basis: PAGES_BASIS };
    let sim = null;
    // dry_run 이면 { made, failed, skipped_ops, pages }, 아니면 pages 그대로
    const result = (pages) => (dry ? { ...(sim ? { made: sim.made, failed: sim.failed, skipped_ops: sim.skippedOps } : {}), pages } : pages);
    if (!pageEstimateEnabled(this.cfg)) return result({ skipped: '쪽 수 어림이 꺼져 있다' });
    const lim = { ...LIMITS, ...(this.cfg?.verify?.pages && typeof this.cfg.verify.pages === 'object' ? this.cfg.verify.pages : {}) };
    const t0 = Date.now();
    try {
      // ① 한 시점의 문서·meta 를 잡는다(문서 대기열 안 — 짧게: 직렬화와 깊은 사본만)
      const snap = await this._read(id, async () => {
        const { doc, meta } = await this._load(id);
        const chars = (doc.header?.xml?.length || 0) + doc.sections.reduce((n, s) => n + s.xml.length, 0);
        const key = `${this.store.dir}\u0000${id}\u0000${meta.version}`;
        const r = rid != null ? meta.requests.find((x) => x.rid === Number(rid)) : null;
        if (rid != null && !r) return { key, gone: `요청 #${rid} 이 없다` };
        const pending = r ? MT.requestItems(this._reqProposals(meta, r)).filter((x) => x.state === 'open' && x.gid == null).flatMap((x) => x.list.filter((p) => p.status === 'pending')).length
          : meta.proposals.filter((p) => pids.includes(p.pid) && p.status === 'pending').length;
        const want = dry || pending > 0;
        const tooBig = chars > lim.maxChars ? `문서가 커서(XML ${Math.round(chars / 1e4) / 100}MB > ${Math.round(lim.maxChars / 1e4) / 100}MB) 반영 흉내를 하지 않았다` : pending > lim.maxPending ? `대기 제안이 많아(${pending} > ${lim.maxPending}) 반영 흉내를 하지 않았다` : null;
        const needNow = !nowCache.has(key);
        const bytes = (want && !tooBig) || needNow ? docBytesSync(doc) : null;
        return { key, version: meta.version, pending, want, tooBig, bytes, meta: want && !tooBig ? structuredClone(meta) : null };
      });
      if (snap.gone) return result({ skipped: snap.gone });
      // ② 사본에서 제안 만들기(dry_run)·반영 흉내 — 서버 스레드, 시간 한도
      if (snap.want && snap.tooBig) out.note = snap.tooBig;
      else if (snap.want) {
        sim = await this._simulateAll(id, { bytes: snap.bytes, meta: snap.meta, rid: rid != null ? Number(rid) : null, pids, steps, author, deadline: t0 + lim.budgetMs });
        if (sim.abort) { out.note = sim.abort; sim.after = null; }
      }
      // ③ 조판(작업자 스레드)
      const docs = []; const cached = nowCache.get(snap.key);
      if (!cached) docs.push({ bytes: snap.bytes });
      if (sim?.after) docs.push({ bytes: sim.after });
      let res = { ok: true, results: [] };
      if (docs.length) res = await layoutChecker().estimate(docs, { waitMs: lim.waitMs, sparseBelow: SPARSE_FILL });
      if (!res.ok) return result({ skipped: BUSY[res.reason] || `쪽 수를 빼었다(${res.error || res.reason})` });
      const now = cached || res.results[0];
      if (!cached) remember(snap.key, now);
      const after = sim?.after ? res.results[cached ? 0 : 1] : null;
      const shown = after || now;
      Object.assign(out, {
        now: now.pages,
        ...(after ? { all_applied: after.pages } : {}),
        ...(shown.lastFill != null ? { last_page_fill: shown.lastFill } : {}),
        ...(shown.sections.length > 1 ? { sections: shown.sections } : {}),
        ...(sim && !sim.abort ? { pending: sim.applied + sim.applyFailed.length } : {}),
        ...(sim?.applyFailed?.length ? { apply_failed: sim.applyFailed.slice(0, 10) } : {}),
        ...(sim?.tracked ? { tracked_note: '문서에 처리하지 않은 변경 추적이 있어 지운 글도 쪽 수에 든다' } : {}),
      });
      // 마지막 쪽이 거의 찼으면 한/글에서 한 쪽 넘칠 수 있다(2026-11-17 — artifacts/mcp-round3-20261117/codex/REPORT.md 문제 2: X08 은 엔진 5쪽·마지막 쪽 0.99 인데
      // 한/글 2022 는 6쪽(참고문헌 마지막 한 줄). 맞은 P1 은 엔진 0.52 / 한/글 0.60쯤 — 한/글 쪽이 0.1 가까이 더 차는 일이 있어 문턱 0.9).
      // 반대쪽(마지막 쪽이 아주 적게 참 → 한/글에서 한 쪽 줄어듦)은 아직 근거가 없어 알리지 않는다
      if (shown.lastFill != null && shown.lastFill >= FULL_LAST_PAGE) out.note = [out.note, FULL_NOTE].filter(Boolean).join(' · ');
      // 거의 빈 쪽(쪽 번호는 1부터 — now·all_applied 와 같은 셈)
      const sparse = (shown.fills || []).filter(([, f]) => f < SPARSE_FILL).map(([p, f]) => ({ page: p + 1, fill: f }));
      if (sparse.length) { out.sparse = sparse.slice(0, 10); out.note = [out.note, SPARSE_NOTE(out.sparse)].filter(Boolean).join(' · '); }
      return result(out);
    } catch (e) {
      // 어림은 덤이다 — 실패가 쓰기·읽기 응답을 깨지 않게
      console.error('[쪽 수 어림]', e?.stack || e);
      return result({ skipped: `쪽 수 어림 실패: ${String(e?.message || e).slice(0, 120)}` });
    }
  },

  /**
   * 사본 흉내(동기 부분 앞에 그림만 비동기로 그린다) → { after(바이트)|null, made, failed, skippedOps, applied, applyFailed, tracked, abort? }.
   * 실제 반영 경로(_proposeCore·_orderedApplier·_applyCore)를 사본 ctx(preview — 되돌리기 사본 파일을 쓰지 않는다)에 그대로 돌린다
   */
  async _simulateAll(id, { bytes, meta, rid, pids, steps, author, deadline, createOnly = false }) {
    const extra = new Map(); let n = 0;
    const out = { after: null, made: 0, failed: [], skippedOps: [], applied: 0, applyFailed: [], tracked: false };
    // 그림(svg·svg 첨부): 첨부를 만들지 않고 사본 meta 에 임시 첨부로 그린다(보일 폭·비율만 쓰이므로 낮은 dpi)
    const figures = new Map();
    for (const step of steps || []) {
      if (step.kind !== 'figure') continue;
      const b = step.input;
      try {
        let svg = b.svg ?? null; let aid = b.aid != null && b.aid !== '' ? String(b.aid) : null;
        if (aid) { const a = this._att(meta, aid); if (/\.svg$/i.test(a.name || '') || /\.svg$/i.test(a.file || '')) { svg = this.attach.bytes(id, a).toString('utf8'); aid = null; } }
        let widthMm = b.widthMm;
        if (!aid) {
          if (svg == null) throw new ServiceError('BAD_FIGURE', '그림은 첨부(attachment_id)·svg 중 하나로 주세요');
          const r = await this._renderFigure(id, { svg, widthMm: b.widthMm, afterRef: b.afterRef, replaceRef: b.replaceRef }, { dpi: 72 });
          if (b.widthMm != null || !b.replaceRef) widthMm = r.widthMm;
          aid = `estimate-${++n}`; extra.set(aid, r.png);
          meta.attachments.push({ aid, name: `${aid}.png`, file: `${aid}.png`, mime: 'image/png', size: r.png.length, kind: 'image' });
        }
        figures.set(step, { aid, widthMm });
      } catch (e) { if (!isolated(e)) throw e; figures.set(step, { error: e }); }
    }
    const sim = sandbox(this, extra);
    await new Promise((r) => setImmediate(r));   // 직렬화(대기열 안)와 사본 읽기를 한 덩어리로 잡지 않게
    const doc = new HwpxDoc(containerFromBytesSync(bytes));
    const ctx = sim._ctx(id, doc, meta, author); ctx.preview = true; ctx.estimate = true;
    const late = () => Date.now() > deadline;
    // 서버 스레드를 오래 잡지 않게 30ms 마다 한 번 물러난다 — 사본만 고치므로 그 사이 다른 요청이 문서를 바꿔도 이 흉내와 섞이지 않는다
    // (P1 논문 대기 제안 54건 반영 흉내 1.7초가 한 덩어리였다 — 2026-11-17 측정)
    let slice = Date.now();
    const tick = async () => { if (Date.now() - slice > 30) { await new Promise((r) => setImmediate(r)); slice = Date.now(); } };
    const ABORT = (why) => ({ ...out, after: null, abort: why });
    const made = new Map();   // 사본 pid → op 차례
    const create = (index, input, opts) => {
      try { const p = sim._proposeCore(ctx, { ...input, rid }, author, opts); made.set(p.pid, index); out.made++; return p; }
      catch (e) { if (!isolated(e)) throw e; out.failed.push({ op: index, error: errText(e) }); return null; }
    };
    for (const step of steps || []) {
      await tick();
      if (late()) return ABORT('시간 한도를 넘어 반영 흉내를 멈췄다');
      if (step.kind === 'proposals') {
        for (const x of step.items) for (const input of (x.input?.fieldFill ? expandFieldFill(doc, x.input) : [x.input])) { const { applyNow, ...rest } = input; create(x.index, rest); await tick(); }
      } else if (step.kind === 'structure') create(step.indexes[0], { type: 'page_layout', pageLayout: { ops: step.ops } });
      else if (step.kind === 'alternatives') {
        // 비교안(둘 이상)은 [모두 반영]에 들지 않는다 — 만들어 보기만(gid). 하나면 보통 바꿈처럼
        const { ref, find, occurrence, options } = step.input;
        const many = (options || []).length > 1;
        for (const o of options || []) create(step.index, { type: 'replace', ref, find: find ?? '', occurrence, replace: o.text, reason: o.reason, format: o.format, runs: o.runs, memo: false }, many ? { gid: 'estimate', option: 1 } : {});
        if (many) out.skippedOps.push({ op: step.index, why: '비교안은 모두 반영에 들지 않는다' });
      } else if (step.kind === 'chart') {
        const b = step.input;
        if (!b.chart || typeof b.chart !== 'object' || (b.sourceTable && (b.chart.categories !== undefined || b.chart.series !== undefined))) out.failed.push({ op: step.index, error: '오류(BAD_CHART): chart 명세를 확인하세요(source_table 과 직접 자료는 함께 쓰지 않는다)' });
        // proposeChart(server/service.js)와 같은 꼴 — caption·notes 는 2026-11-17 나-8(다른 갈래)이 더한 인자
        else create(step.index, { type: 'figure', afterRef: b.afterRef, figure: { nativeChart: b.chart, ...(b.sourceTable ? { sourceTable: b.sourceTable } : {}), widthMm: b.widthMm, heightMm: b.heightMm,
          ...(b.caption != null && b.caption !== '' ? { caption: b.caption } : {}), ...(b.notes != null ? { notes: b.notes } : {}) }, reason: b.reason });
      } else if (step.kind === 'figure') {
        const f = figures.get(step);
        if (f?.error) out.failed.push({ op: step.index, error: errText(f.error) });
        else create(step.index, { type: 'figure', afterRef: step.input.afterRef, figure: { aid: f.aid, caption: step.input.caption ?? '', widthMm: f.widthMm, ...(step.input.replaceRef ? { replaceRef: String(step.input.replaceRef) } : {}), ...(step.input.notes != null ? { notes: step.input.notes } : {}) }, reason: step.input.reason });
      }
      else if (step.kind === 'withdraw') {
        // 거두기(2026-11-17 §10.4 나-4 — server/proposal-withdraw.js): 사본 meta 에서 대기 제안을 거둔다(맨 앞 단계라 뒤의 만들기·반영 흉내에서 빠진다)
        for (const pid of sim._withdrawTargets(meta, rid, author, { pids: step.pids, all: step.all }).pids) sim._withdrawCore(ctx, meta.proposals.find((p) => p.pid === pid), author);
      }
      else if (!['memo', 'reply'].includes(step.kind)) out.skippedOps.push({ op: step.index ?? step.indexes?.[0] ?? step.items?.[0]?.index, why: `${step.kind} 단계는 반영 흉내에 넣지 않았다` });
      // memo·reply 는 조판에 들지 않는다(만들지 않는다). 새 단계 종류가 생기면 위 갈래에 더한다(모르는 종류는 skipped_ops 로 알린다)
    }
    // createOnly: 만들기만 해 본다(저장 전 검사 — server/mcp2/service.js agentEdit 가 한 호출을 통째로 저장하기 전에 저장해도 실패할 op 를 찾는다, 2026-11-17 §10.4 나-4)
    if (createOnly) return out;
    // 반영: [모두 반영](resolveRequest apply 'rest')과 같은 고르기 — 열린 항목의 비교안 아닌 대기 제안, 제안 번호 차례. 차례 새로 고침은 맨 뒤(다른 반영 뒤의 쪽 번호로)
    const r = rid != null ? meta.requests.find((x) => x.rid === rid) : null;
    let todo = r ? MT.requestItems(sim._reqProposals(meta, r)).filter((x) => x.state === 'open' && x.gid == null).flatMap((x) => x.list.filter((p) => p.status === 'pending'))
      : meta.proposals.filter((p) => p.status === 'pending' && p.gid == null && (made.has(p.pid) || pids.includes(p.pid)));
    todo = todo.sort((a, b) => Number(a.type === 'toc') - Number(b.type === 'toc') || a.pid - b.pid);
    out.tracked = doc.changes().length > 0;
    const before = new Set(doc.changes().map((c) => c.id));
    const ordered = sim._orderedApplier(ctx, todo, author);
    for (const p of todo) {
      await tick();
      if (late()) return ABORT('시간 한도를 넘어 반영 흉내를 멈췄다');
      const sig = docSig(doc); const st = p.status;
      try { ordered.apply(p); out.applied++; }
      catch (e) {
        // [모두 반영]과 같은 규칙: 문서를 건드리기 전 오류는 그 제안만 실패, 반쯤 바꾼 뒤 오류면 실제 반영도 통째로 되돌린다 — 흉내를 멈춘다
        // 그 제안은 실제 [모두 반영]에서도 실패한다(반영 전체가 되돌려진다) — apply_failed 에도 싣는다(완료 막기 — server/mcp2/service.js agentEdit, 2026-11-17 REPORT.md 문제 1)
        out.applyFailed.push({ ...(made.has(p.pid) ? { op: made.get(p.pid) } : { pid: p.pid }), error: errText(e) });
        if (!isolated(e) || p.status !== st || !sameDoc(doc, sig)) return ABORT(`제안 ${made.has(p.pid) ? `(op ${made.get(p.pid)})` : `#${p.pid}`} 반영이 문서를 반쯤 바꾼 채 실패해 쪽 수를 빼었다(${errText(e).slice(0, 120)})`);
      }
    }
    await tick();
    if (late()) return ABORT('시간 한도를 넘어 반영 흉내를 멈췄다');
    // 반영이 만든 변경 추적은 수락한다(최종 글 기준 — rhwp 는 지운 글도 조판한다). 원래 있던 변경 추적은 그대로
    const fresh = doc.changes().map((c) => c.id).filter((x) => !before.has(x));
    if (fresh.length) { try { doc.resolveChanges(fresh, 'accept', { tolerant: true }); } catch { /* 수락하지 못하면 변경 추적이 보이는 채로 잰다 */ } }
    out.after = docBytesSync(doc);
    return out;
  },
};
