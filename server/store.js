// 문서 저장소: data/docs/<id>/{current.hwpx, meta.json, versions/<n>.hwpx, drafts/c<cid>.hwpx}
// 파일은 원자적으로 쓴다: 같은 폴더의 임시 파일(<file>.tmp-<pid>-<n>)에 다 쓰고 renameSync 로 바꿔 끼운다
// (쓰다가 멈춰도 반쯤 쓴 meta.json·HWPX 가 남지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { removeFile, removeTree } from './fs-safe.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;            // 문서 id(만들 때: base36 시각 + hex) — 경로 조작 막기
const isPosInt = (n) => /^[1-9]\d{0,8}$/.test(String(n));   // 버전·변경 요청 번호: 양의 정수만
/** 문서마다 남기는 제안 되돌리기용 사본 수(writeUndo) */
const UNDO_KEEP = 20;
const TMP_RE = /\.tmp-\d+-\d+$/;
let tmpSeq = 0;
// 기록 파일 정리(V4 §2.6 — v0.4.x 에서 줄임: 실시간 문서는 밀어 넣기마다 기록 파일이 하나씩 생긴다).
// 최근 기록: 언제나 마지막 RECENT_MIN 개 + 지난 RECENT_MS 안의 기록은 VERSIONS_MAX 개까지(여럿이 한창 고칠 때 — 연결이 잠깐 끊긴 창의
// 기준 기록을 예전처럼 200개까지 지킨다). 그보다 오래된 것은 사람용 버전·기록 1 과 묶음마다 마지막 기록(되짚을 자리)만 — 묶음은
// 하루 안 10분, 7일 안 1시간, 그보다 오래되면 하루(UTC). 그런 옛 기록은 CHECKPOINTS_MAX 개까지
export const VERSIONS_MAX = 200;
export const RECENT_MIN = 30;
export const RECENT_MS = 10 * 60 * 1000;
export const CHECKPOINT_MS = 10 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const CHECKPOINTS_MAX = 400;

/** 나이(ms)에 따른 묶음 크기: 하루 안 10분, 7일 안 1시간, 그 밖 하루 — 큰 묶음이 작은 묶음을 품는다(묶음 끝 기록은 더 큰 묶음에서도 끝 후보) */
export function checkpointSpan(age) { return age < DAY_MS ? CHECKPOINT_MS : age < 7 * DAY_MS ? HOUR_MS : DAY_MS; }

/**
 * 기록 목록 자르기(V4 §2.6): 최근 기록(마지막 RECENT_MIN 개, 지난 RECENT_MS 안이면 VERSIONS_MAX 개까지)은 그대로, 그보다 오래된 것은
 * 사람용 버전(v)·기록 1·묶음(checkpointSpan — 나이에 따라 10분·1시간·하루)마다 마지막 기록만. 남긴 옛 기록(사람용 버전·기록 1 빼고)이
 * CHECKPOINTS_MAX 개를 넘으면 오래된 것부터 버린다. 목록을 제자리에서 고친다. now = 지금 시각(ms, 시험용)
 */
export function trimVersions(meta, now = Date.now()) {
  const list = Array.isArray(meta.versions) ? meta.versions : [];
  if (list.length <= RECENT_MIN) return;
  const atOf = (x) => Date.parse(x?.at) || 0;
  let keepRecent = RECENT_MIN;
  while (keepRecent < VERSIONS_MAX && keepRecent < list.length && atOf(list[list.length - keepRecent - 1]) >= now - RECENT_MS) keepRecent++;
  if (list.length <= keepRecent) return;
  const recent = list.slice(-keepRecent); const old = list.slice(0, list.length - keepRecent);
  const pinned = (x) => x.v != null || x.n === 1;
  // x 가 제 묶음(나이로 정한 크기)의 마지막 기록인가 — 다음 기록이 같은 묶음이면 버린다
  const lastOfBucket = (x, next) => { const span = checkpointSpan(now - atOf(x)); return Math.floor(atOf(x) / span) !== Math.floor(atOf(next) / span); };
  let keep = old.filter((x, i) => pinned(x) || lastOfBucket(x, i + 1 < old.length ? old[i + 1] : recent[0]));
  const loose = keep.filter((x) => !pinned(x));
  if (loose.length > CHECKPOINTS_MAX) { const drop = new Set(loose.slice(0, loose.length - CHECKPOINTS_MAX)); keep = keep.filter((x) => !drop.has(x)); }
  list.splice(0, list.length, ...keep, ...recent);
}

function badArg(message) { const e = new Error(message); e.code = 'BAD_ARG'; e.status = 400; return e; }

/** Windows 에서 백신·색인기가 파일을 잠깐 잡고 있으면 rename 이 EPERM/EACCES/EBUSY 로 실패한다 → 조금 쉬었다 다시 */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1));
    }
  }
}

/** 원자적 쓰기: 임시 파일에 쓰고(fsync) 이름을 바꿔 끼운다. 실패하면 임시 파일을 지우고 던진다 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    renameRetry(tmp, file);
  } catch (e) {
    try { removeFile(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;   // 문서함 폴더 목록(folders.json — server/library.js)도 여기
    this.dir = path.join(dataDir, 'docs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map(); // id -> { version, doc }
    this.queues = new Map(); // id -> Promise chain (문서별 직렬화)
    this._sweepTmp();
  }

  /** 문서 폴더. id 는 영문·숫자·_- 만(아니면 던진다 — 호출자는 먼저 readMeta 로 확인한다) */
  _docDir(id) {
    if (!ID_RE.test(String(id))) throw badArg(`문서 id 가 올바르지 않습니다: ${id}`);
    return path.join(this.dir, String(id));
  }

  /** 지난 실행이 쓰다 멈춘 임시 파일(10분 넘은 것)을 지운다 */
  _sweepTmp() {
    const old = Date.now() - 10 * 60 * 1000;
    let ids = [];
    try { ids = fs.readdirSync(this.dir); } catch { return; }
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      for (const sub of ['', 'versions', 'drafts', 'undo']) {
        const d = path.join(this.dir, id, sub);
        let names = [];
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const n of names) {
          if (!TMP_RE.test(n)) continue;
          try { const f = path.join(d, n); if (fs.statSync(f).mtimeMs < old) removeFile(f); } catch { /* ignore */ }
        }
      }
    }
  }

  /** 문서별로 작업을 직렬화한다(동시 편집 요청이 겹치지 않게). */
  async withDoc(id, fn) {
    const prev = this.queues.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    this.queues.set(id, run);
    try { return await run; } finally { if (this.queues.get(id) === run) this.queues.delete(id); }
  }

  list() {
    const out = [];
    for (const id of fs.readdirSync(this.dir)) {
      const m = this.readMeta(id); if (m) out.push(m);
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** 그 id 의 문서가 저장소에 있는가(meta 를 읽지 않고 파일만 본다) */
  has(id) {
    return ID_RE.test(String(id)) && fs.existsSync(path.join(this._docDir(id), 'meta.json'));
  }

  readMeta(id) {
    if (!ID_RE.test(String(id))) return null;
    const f = path.join(this.dir, String(id), 'meta.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  }

  saveMeta(meta) {
    meta.updatedAt = new Date().toISOString();
    writeFileAtomic(path.join(this._docDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 1));
    return meta;
  }

  /** meta 만 고쳐 쓴다(마지막 수정 시각은 그대로) — PC 파일 맞춤 기록처럼 문서 내용과 상관없는 표시(server/local-folders.js) */
  saveMetaQuiet(meta) {
    writeFileAtomic(path.join(this._docDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 1));
    return meta;
  }

  /** id: 정해 둔 문서 id(PC 폴더 문서 — 파일 자리에서 만든 id). 꼴이 틀리거나 이미 있으면 새로 뽑는다 */
  create({ id: given = null, fileName, title, bytes, by, settings = null, location = null, note = '올림', extra = null }) {
    const free = given != null && ID_RE.test(String(given)) && !fs.existsSync(path.join(this.dir, String(given)));
    const id = free ? String(given) : `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const d = this._docDir(id); fs.mkdirSync(path.join(d, 'versions'), { recursive: true });
    writeFileAtomic(path.join(d, 'current.hwpx'), bytes);
    writeFileAtomic(path.join(d, 'versions', '1.hwpx'), bytes);
    const now = new Date().toISOString();
    const meta = {
      id, title: title || fileName.replace(/\.hwpx$/i, ''), fileName, createdAt: now, createdBy: by, updatedAt: now,
      // version = 기록 n(내부 판 — 저장마다 +1), milestones = 사람용 버전 v(이정표, V3 §9.4): 올린 문서가 v1
      version: 1, versions: [{ n: 1, at: now, by, note, v: 1 }],
      milestones: [{ v: 1, n: 1, at: now, by, kind: 'upload', note }],
      proposals: [], requests: [], attachments: [], locks: {}, activity: [{ at: now, by, type: 'create', detail: fileName }],
      changeRequests: [], memoThreads: {},
      seq: { proposal: 0, request: 0, attachment: 0, cr: 0 },
      // 문단 주소가 처음부터 최종 보기 번호(지운 나눔으로 이은 문단 = 하나 — 2026-10-30, service._migrateBreakView 가 옮길 일 없음)
      breakView: 1,
      ...(settings ? { settings } : {}),   // v0.4 문서 설정(V4 §1 — 서비스가 기본값을 정해 넘긴다)
      // 문서함 자리(docs/LIBRARY_SPEC.md): { space, spaceOwner?, folderId? } — 없으면 공용 문서함 맨 위(옛 문서와 같음)
      ...(location || {}),
      ...(extra || {}),   // 서비스가 덧붙이는 표시(체험 문서 tutorial: true — server/tutorial.js)
    };
    return this.saveMeta(meta);
  }

  remove(id) { removeTree(this._docDir(id)); this.cache.delete(id); }

  currentBytes(id) { return fs.readFileSync(path.join(this._docDir(id), 'current.hwpx')); }
  /** n 은 양의 정수만(아니면 null) — '../' 같은 값으로 폴더 밖 파일을 읽지 못하게 */
  versionBytes(id, n) {
    if (!isPosInt(n)) return null;
    const f = path.join(this._docDir(id), 'versions', `${Number(n)}.hwpx`);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }

  /**
   * 제안 되돌리기용 문서 사본(2026-11-10 개체 지우기 제안 — 변경 추적 없이 지운 개체를 되돌릴 때 그 문단의 개체를 다시 옮겨 올 원본):
   * undo/p<pid>.hwpx. 문서마다 최근 UNDO_KEEP 개만 남긴다(그보다 오래된 제안은 되돌리기 대신 이력 복구). meta 에 넣지 않는다(문서 크기만큼 커진다)
   */
  writeUndo(id, pid, bytes) {
    if (!isPosInt(pid)) return false;
    const dir = path.join(this._docDir(id), 'undo'); fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, `p${Number(pid)}.hwpx`), bytes);
    try {
      const old = fs.readdirSync(dir).filter((n) => /^p[1-9]\d{0,8}\.hwpx$/.test(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t).slice(UNDO_KEEP);
      for (const x of old) removeFile(path.join(dir, x.n));
    } catch { /* 다음에 다시 */ }
    return true;
  }
  undoBytes(id, pid) {
    if (!isPosInt(pid)) return null;
    const f = path.join(this._docDir(id), 'undo', `p${Number(pid)}.hwpx`);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }

  async doc(id) {
    const meta = this.readMeta(id); if (!meta) return null;
    const c = this.cache.get(id);
    if (c && c.version === meta.version) return c.doc;
    const doc = await HwpxDoc.load(this.currentBytes(id));
    this.cache.set(id, { version: meta.version, doc });
    return doc;
  }

  /**
   * 수정된 doc 을 새 기록(내부 판 n)으로 저장. meta 를 주면 그 객체(호출자가 고친 것)에 판을 올린다.
   * milestone({ kind, note, by? })을 주면 새 기록에 사람용 버전(이정표, V3 §9.4)을 붙인다(addMilestone).
   * bytes 를 주면 doc.save() 대신 그 바이트를 그대로 기록한다(doc 은 그 바이트를 읽은 문서 — PC 파일·검토본으로 통째로 바꿀 때).
   * afterCommit(id, meta, bytes)(있으면): 기록을 쓴 뒤 부른다(PC 폴더 문서의 파일 맞춤 예약 — 던져도 커밋은 그대로)
   */
  async commit(id, doc, { by, note, meta, milestone = null, bytes: given = null }) {
    meta = meta || this.readMeta(id);
    const bytes = given ?? await doc.save();
    meta.version += 1;
    const d = this._docDir(id);
    // 버전 파일 먼저(중간에 멈추면 current 는 옛 버전 그대로 — 남은 버전 파일은 다음 커밋이 덮어쓴다)
    writeFileAtomic(path.join(d, 'versions', `${meta.version}.hwpx`), bytes);
    writeFileAtomic(path.join(d, 'current.hwpx'), bytes);
    const at = new Date().toISOString();
    // 기록 파일 정리가 손대도 되는 첫 기록(V4 §2.6): v0.4 전에 쌓인 기록 파일은 지우지 않는다 — 옛 문서는 처음 커밋한 기록부터
    if (!Number.isInteger(meta.gcFrom)) meta.gcFrom = meta.version;
    meta.versions.push({ n: meta.version, at, by, note });
    if (milestone) this.addMilestone(meta, { ...milestone, n: meta.version, at, by: milestone.by ?? by });
    // 기록 목록을 자르고(최근 30 — 10분 안이면 200까지 — + 사람용 버전·묶음 기록) 잘려 나간 기록의 파일을 지운다(실시간 문서는 기록이 빨리 쌓인다)
    if (meta.versions.length > RECENT_MIN) { trimVersions(meta); this.gcVersions(id, meta); }
    this.cache.set(id, { version: meta.version, doc });
    if (typeof this.afterCommit === 'function') { try { this.afterCommit(id, meta, bytes); } catch (e) { console.error('[저장소] afterCommit:', e.message); } }
    return meta; // 호출자가 saveMeta
  }

  /**
   * 기록 파일 정리(V4 §2.6): meta.versions 에 남지 않은 기록(trimVersions 가 자른 것)의 versions/<n>.hwpx 를 지운다 —
   * 단 기록 1, 사람용 버전(이정표)의 기록, 진행 중(draft·open)·닫힌(closed — 다시 열 수 있음) 변경 요청의 baseVersion,
   * v0.4 전에 쌓인 기록(n < meta.gcFrom)은 남긴다.
   * 폴더를 훑어 정하므로 지우다 실패한 파일은 다음 커밋이 다시 지워 본다(실패해도 커밋은 그대로 — 던지지 않는다). → 지운 파일 수
   */
  gcVersions(id, meta) {
    let removed = 0;
    try {
      const list = Array.isArray(meta.versions) ? meta.versions : [];
      const newest = list.length ? Math.max(...list.map((x) => Number(x.n)).filter(Number.isFinite)) : Number(meta.version);
      const from = Number.isInteger(meta.gcFrom) ? meta.gcFrom : Number(meta.version);
      const keep = new Set([1]);
      for (const x of list) if (Number.isInteger(x?.n)) keep.add(x.n);
      for (const m of meta.milestones || []) if (Number.isInteger(m?.n)) keep.add(m.n);
      // 진행 중(draft·open) 변경 요청의 기준 + 닫힌(closed) 것의 기준도 — 닫힌 변경 요청은 다시 열 수 있고(수정본 파일이 남음), 다시 연 뒤
      // 저장·다시 맞추기·반영이 모두 그 기준 기록 파일을 읽는다(지우면 다시 연 변경 요청이 404 NO_VERSION 으로 막힌다)
      for (const c of meta.changeRequests || []) if ((c?.status === 'draft' || c?.status === 'open' || c?.status === 'closed') && Number.isInteger(c.baseVersion)) keep.add(c.baseVersion);
      const dir = path.join(this._docDir(id), 'versions');
      for (const name of fs.readdirSync(dir)) {
        const m = /^([1-9]\d{0,8})\.hwpx$/.exec(name); if (!m) continue;
        const n = Number(m[1]);
        if (n < from || n > newest || keep.has(n)) continue;
        try { removeFile(path.join(dir, name)); removed++; } catch { /* 다음 커밋이 다시 해 본다 */ }
      }
    } catch { /* 폴더를 못 읽어도 커밋은 그대로 */ }
    return removed;
  }

  /**
   * 사람용 버전(이정표, V3 §9.4) 하나를 기록 n(기본: 지금 판 meta.version)에 붙인다 → 만든 이정표 { v, n, at, by, kind, note }.
   * 마지막 이정표가 이미 그 기록이면 만들지 않는다(null). v 는 늘기만 한다(마지막 v + 1). 500개 넘으면 오래된 것부터 버린다.
   * 그 기록(meta.versions 항목)에도 v 를 적는다. 문서를 바꾸지 않는 일(버전 저장 등)은 커밋 없이 이것만 부른다(호출자가 saveMeta)
   */
  addMilestone(meta, { kind = 'manual', note = '', by = null, at = null, n = null } = {}) {
    if (!Array.isArray(meta.milestones)) meta.milestones = [];
    const list = meta.milestones;
    const num = Number.isInteger(n) ? n : meta.version;
    const last = list[list.length - 1];
    if (last && last.n === num) return null;
    const ms = { v: (last ? Number(last.v) || 0 : 0) + 1, n: num, at: at || new Date().toISOString(), by: by ?? null, kind, note: String(note ?? '') };
    list.push(ms);
    if (list.length > 500) list.splice(0, list.length - 500);
    const rec = (meta.versions || []).find((x) => x.n === num);
    if (rec) rec.v = ms.v;
    return ms;
  }

  log(meta, by, type, detail) {
    meta.activity.push({ at: new Date().toISOString(), by, type, detail });
    if (meta.activity.length > 500) meta.activity.splice(0, meta.activity.length - 500);
  }

  // ───────── 수정본(변경 요청 cid 마다 하나) — docs/V3_SPEC.md §3.1. 덮어쓰기, 버전 만들지 않음 ─────────

  draftPath(id, cid) {
    if (!isPosInt(cid)) throw badArg(`변경 요청 번호가 올바르지 않습니다: ${cid}`);
    return path.join(this._docDir(id), 'drafts', `c${Number(cid)}.hwpx`);
  }

  writeDraft(id, cid, bytes) {
    const f = this.draftPath(id, cid);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeFileAtomic(f, bytes);
    return f;
  }

  /** 수정본 바이트(없으면 null) */
  readDraft(id, cid) {
    try { return fs.readFileSync(this.draftPath(id, cid)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  /** 지웠으면 true, 없었으면 false */
  deleteDraft(id, cid) {
    const f = this.draftPath(id, cid);
    if (!fs.existsSync(f)) return false;
    removeFile(f);
    return true;
  }

  /** [{ cid, size, updatedAt }] cid 순 */
  listDrafts(id) {
    const d = path.join(this._docDir(id), 'drafts');
    let names = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = /^c([1-9]\d{0,8})\.hwpx$/.exec(n); if (!m) continue;
      try { const st = fs.statSync(path.join(d, n)); out.push({ cid: Number(m[1]), size: st.size, updatedAt: st.mtime.toISOString() }); } catch { /* 방금 지워짐 */ }
    }
    return out.sort((a, b) => a.cid - b.cid);
  }
}
