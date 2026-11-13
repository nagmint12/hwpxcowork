// 편집 뒤 조판 검사(V3, 2026-11-12 — research/edit-preservation-20261112/verify/ledger.md §10). 쓰기 응답을 기다리게 하지 않는다:
// _finish 가 V1 을 통과해 저장한 AI 커밋(사람 편집 ctx.skipVerify 는 V1 부터 빠진다)을 여기 큐에 넣고 바로 돌아오며,
// 작업자 스레드 하나(server/layout-worker.js — 우리 fork WASM, 읽기 전용)가 편집 전후 기록 파일을 조판해 견준다.
//   · 큐: 문서마다 최신 작업 하나로 합친다(편집 전 = 합친 첫 작업의 앞 기록, 편집 뒤 = 마지막 기록). 한 번에 하나만 돈다(작업자 1개 — CPU 한 코어)
//   · 상한: 기록 파일이 maxBytes 보다 크면 건너뛴다. 한 작업이 timeoutMs 를 넘거나 작업자가 죽으면 작업자를 끝내고 다음 작업 때 다시 띄운다
//   · 결과(문서 글 없이 쪽 번호·개수·ref 만): 요청 작업 기록 한 줄(편집기 AI 작업 카드) + 새 칸 넘침이 있으면 같은 요청의 다음 lean 쓰기 영수증 경고 한 줄
//     (takeLayoutNote — 요청이 이미 끝났으면 작업 기록에만)
// 끄기: 환경 HWPX_COWORK_LAYOUT_CHECK=0 또는 config.verify.layout === false
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { physicalParas } from '../engine/toc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = { timeoutMs: 30000, maxBytes: 16 * 1024 * 1024, maxOldGenerationSizeMb: 512 };

export class LayoutChecker {
  constructor({ pkgDir = path.resolve(root, process.env.HWPX_COWORK_ENGINE_PKG || path.join('vendor', 'rhwp', 'pkg')), workerFile = path.join(root, 'server', 'layout-worker.js'), ...opts } = {}) {
    this.pkgDir = pkgDir; this.workerFile = workerFile; this.opts = { ...DEFAULTS, ...opts };
    this.pending = new Map();   // 작업 열쇠(문서 열쇠 + 첫 편집 전 기록) → 합친 작업
    this.order = [];            // 기다리는 작업 열쇠 차례
    this.lastOf = new Map();    // 문서 열쇠 → 그 문서의 아직 기다리는 마지막 작업 열쇠(합칠 후보)
    this.running = null; this.worker = null; this.seq = 0;
    this.stats = { done: 0, failed: 0, skipped: 0, timeouts: 0, restarts: 0, lastMs: null, lastRss: null };
    this.idle = [];             // 큐가 빌 때 부를 함수(시험)
  }

  /** 작업 넣기(바로 돌아온다). job = { key, id, file, beforeFile, version, beforeVersion, positions, deliver(result) } */
  enqueue(job) {
    // 합치기는 기록이 이어질 때만(앞 작업의 편집 뒤 = 새 작업의 편집 전). 사이에 검사 밖 커밋(사람 편집 등)이 끼면 따로 처리한다 —
    // 2026-11-12 2차 검토: 처음 편집 전을 그대로 두고 합쳐 사람이 만든 넘침을 AI 작업 경고로 전했다
    const lastKey = this.lastOf.get(job.key); const prev = lastKey != null ? this.pending.get(lastKey) : null;
    if (prev && prev.version === job.beforeVersion) { Object.assign(prev, { ...job, beforeFile: prev.beforeFile, beforeVersion: prev.beforeVersion, delivers: [...prev.delivers, job.deliver] }); }
    else { const k = `${job.key}${job.beforeVersion}`; this.pending.set(k, { ...job, delivers: [job.deliver] }); this.order.push(k); this.lastOf.set(job.key, k); }
    setImmediate(() => this._pump());
  }

  _spawn() {
    const w = new Worker(this.workerFile, { workerData: { pkgDir: this.pkgDir }, resourceLimits: { maxOldGenerationSizeMb: this.opts.maxOldGenerationSizeMb } });
    w.on('message', (m) => this._onMessage(w, m));
    w.on('error', (e) => this._onDead(w, e));
    w.on('exit', (code) => this._onDead(w, new Error(`작업자 종료(${code})`)));
    w.unref();   // 서버·시험 프로세스가 끝나는 것을 막지 않는다(듣는 함수를 단 뒤에 — 그 전에 부르면 다시 묶인다)
    this.worker = w; return w;
  }

  _pump() {
    if (this.running || !this.order.length) { if (!this.running && !this.order.length) this._idle(); return; }
    const key = this.order.shift(); const job = this.pending.get(key); this.pending.delete(key);
    if (this.lastOf.get(job.key) === key) this.lastOf.delete(job.key);
    let size = 0; try { size = fs.statSync(job.file).size; } catch { size = -1; }
    if (size < 0 || size > this.opts.maxBytes) { this.stats.skipped++; this._deliver(job, { ok: false, skipped: true, reason: size < 0 ? 'no-file' : 'too-big', bytes: size }); return setImmediate(() => this._pump()); }
    const w = this.worker || this._spawn();
    const n = ++this.seq;
    this.running = { n, job, w, timer: setTimeout(() => this._timeout(n), this.opts.timeoutMs) };
    this.running.timer.unref?.();
    w.postMessage({ job: n, id: job.key, file: job.file, beforeFile: job.beforeFile, version: job.version, beforeVersion: job.beforeVersion, positions: job.positions || [] });
  }

  _onMessage(w, m) {
    if (m?.ready || !this.running || this.running.w !== w || m.job !== this.running.n) return;
    const { job, timer } = this.running; clearTimeout(timer); this.running = null;
    if (m.ok) { this.stats.done++; this.stats.lastMs = Math.round(m.ms); this.stats.lastRss = m.rss; } else this.stats.failed++;
    this._deliver(job, m);
    setImmediate(() => this._pump());
  }

  _timeout(n) {
    if (!this.running || this.running.n !== n) return;
    const { job, w } = this.running; this.running = null; this.stats.timeouts++;
    this.worker = null; w.terminate().catch(() => {});
    this._deliver(job, { ok: false, timeout: true, reason: 'timeout' });
    setImmediate(() => this._pump());
  }

  _onDead(w, e) {
    if (this.worker === w) { this.worker = null; this.stats.restarts++; }
    if (this.running?.w === w) {
      const { job, timer } = this.running; clearTimeout(timer); this.running = null; this.stats.failed++;
      this._deliver(job, { ok: false, reason: 'worker', error: String(e?.message || e).slice(0, 200) });
      setImmediate(() => this._pump());
    }
  }

  _deliver(job, result) { for (const f of job.delivers || []) { try { f(result); } catch (e) { console.error('[조판 검사] 전달:', e.message); } } }
  _idle() { const list = this.idle.splice(0); for (const f of list) f(); }
  /** 큐가 비고 도는 작업이 없을 때까지 기다린다(시험·측정) */
  // 기다리는 동안은 프로세스를 붙잡는다(작업자·시간 제한 타이머는 unref — 서버 밖 스크립트가 기다리다 끝나지 않게)
  drain() { return new Promise((r) => { if (!this.running && !this.order.length) return r(); const hold = setInterval(() => {}, 1000); this.idle.push(() => { clearInterval(hold); r(); }); }); }
  async stop() { const w = this.worker; this.worker = null; if (w) await w.terminate().catch(() => {}); }
}

let shared = null;
/** 프로세스에 하나(작업자 1개) */
export function layoutChecker() { return (shared ||= new LayoutChecker()); }
export function layoutCheckEnabled(cfg) { return process.env.HWPX_COWORK_LAYOUT_CHECK !== '0' && cfg?.verify?.layout !== false; }

// 같은 요청의 다음 lean 쓰기 영수증에 실을 경고(저장소·문서·요청별 한 줄, 한 번 실으면 지운다)
const notes = new WeakMap();
const noteMap = (store) => { let m = notes.get(store); if (!m) { m = new Map(); notes.set(store, m); } return m; };
/** 영수증에 실을 조판 경고를 꺼낸다(없으면 null) — server/mcp.js lean 길 */
export function takeLayoutNote(store, id, rid) {
  if (!store || id == null || rid == null) return null;
  const m = noteMap(store); const k = `${id}\u0000${Number(rid)}`; const v = m.get(k); m.delete(k); return v || null;
}

const pagesText = (list) => {
  const xs = [...new Set(list)].sort((a, b) => a - b).map((p) => p + 1);
  if (!xs.length) return '';
  if (xs.length > 3 && xs.at(-1) - xs[0] === xs.length - 1) return `${xs[0]}~${xs.at(-1)}쪽`;
  return `${xs.slice(0, 5).join('·')}${xs.length > 5 ? ` 외 ${xs.length - 5}` : ''}쪽`;
};
/** 결과 → { label(작업 기록 한 줄), warning(새 칸 넘침이 있을 때만) } — 문서 글 없이 쪽·개수·ref 만 */
export function layoutSummary(r) {
  if (!r?.ok) return { label: `조판 확인 · ${r?.skipped ? '건너뜀(파일이 큼)' : r?.timeout ? '시간 초과' : '안 됨'}`, warning: null };
  const parts = [`조판 확인 · ${r.before.pages === r.after.pages ? `${r.after.pages}쪽` : `${r.before.pages}→${r.after.pages}쪽`}`];
  if (r.changedPages?.length) parts.push(`바뀐 쪽 ${pagesText(r.changedPages)}`);
  const refs = (r.refPages || []).slice(0, 3).map((x) => `${x.ref}=${x.page + 1}쪽`);
  if (refs.length) parts.push(refs.join(' '));
  let warning = null;
  if (r.overflow?.length) {
    const clip = r.overflow.filter((x) => x.kind === 'clip'); const wrap = r.overflow.filter((x) => x.kind === 'wrap');
    const bits = [];
    if (clip.length) bits.push(`표 칸 ${clip.length}곳 글이 칸 밖으로 넘침(${pagesText(clip.map((x) => x.page))})`);
    if (wrap.length) bits.push(`한 줄이던 표 칸 ${wrap.length}곳이 여러 줄이 됨(${pagesText(wrap.map((x) => x.page))})`);
    parts.push(bits.join(' · '));
    warning = `조판 경고: ${bits.join(' / ')} — 칸 글을 줄이거나 표를 확인하세요`;
  }
  return { label: parts.join(' · '), warning };
}

/**
 * _finish 가 V1 을 통과해 커밋한 뒤 부른다(server/service.js). 큐에 넣고 바로 돌아온다 — 결과는 나중에 작업 기록·다음 lean 영수증으로.
 * 요청이 없는 커밋(직접 고침 등)은 결과를 전할 곳이 없어 넣지 않는다
 */
export function enqueueLayoutCheck(service, ctx) {
  if (!layoutCheckEnabled(service.cfg)) return false;
  const meta = ctx.meta; const version = meta.version;
  const applied = (meta.proposals || []).filter((p) => p.status === 'applied' && p.appliedVersion === version);
  const rids = [...new Set([...ctx.reqs, ...applied.map((p) => p.rid)].filter((x) => x != null).map(Number))];
  if (!rids.length || version < 2) return false;
  const dir = path.join(service.store.dir, String(ctx.id), 'versions');
  // 바뀐 본문 문단 → 엔진 문단 번호(물리 — 지운 나눔으로 이어진 문단은 첫 물리 문단)
  const positions = [];
  for (const ref of [...ctx.changed].slice(0, 20)) {
    const m = /^s(\d+)\/p(\d+)$/.exec(String(ref)); if (!m) continue;
    const sec = ctx.doc.sections[Number(m[1])]; const rec = sec?.bodyParas[Number(m[2])]; if (!rec) continue;
    const phys = physicalParas(sec).findIndex((x) => x.rec === rec); if (phys >= 0) positions.push({ ref, sec: Number(m[1]), para: phys });
  }
  const { store, hub } = service; const id = ctx.id;
  layoutChecker().enqueue({
    key: `${store.dir}\u0000${id}`, id, version, beforeVersion: version - 1,
    file: path.join(dir, `${version}.hwpx`), beforeFile: path.join(dir, `${version - 1}.hwpx`), positions,
    deliver: (result) => {
      const { label, warning } = layoutSummary(result);
      let meta2 = null; try { meta2 = store.readMeta(id); } catch { meta2 = null; }
      for (const rid of rids) {
        const r = meta2?.requests?.find((x) => x.rid === rid); if (!r) continue;
        const row = service.activity?.add(id, rid, { tool: 'layout_check', label, ok: !!result?.ok && !warning });
        if (row) hub?.broadcast(id, { type: 'activity', rid, item: row });
        if (warning && r.status !== 'done' && r.status !== 'cancelled') noteMap(store).set(`${id}\u0000${rid}`, warning);
      }
      service.onLayoutChecked?.(id, result);
    },
  });
  return true;
}
