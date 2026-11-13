// PC 폴더 연결(docs/LOCAL_FOLDER_APP_2026-11-10.md): 이 서버가 도는 PC 의 폴더를 주인의 개인 문서함에 비춘다.
//   · 그 폴더(와 하위 폴더)의 HWPX 가 문서 목록에 보이고, 처음 열 때 문서로 등록된다(그 전에는 파일만 — 훑기만 한다).
//   · 문서를 고치면(커밋) 그 파일에 다시 쓴다(잠깐 모아서, 임시 파일 → 이름 바꿔 끼우기). PC 파일 = 문서의 지금 기록(current.hwpx)과 같은 바이트.
//   · 파일이 밖에서 바뀌면(한/글에서 저장) 그 파일을 새 기록으로 통째로 읽는다 — PC 파일이 기준이다. 앱에서 고친 것은 이력(기록 파일)에 남는다.
//   · 탐색기에서 옮기거나 이름을 바꾼 파일은 내용(크기·SHA-256)이 같으면 같은 문서로 잇는다. 지운 파일의 문서는 목록에서 숨는다(기록은 남는다).
//   · 함께 검토: 문서를 다른 hwpx-cowork 서버(중앙 서버)에 토큰으로 올리고, 검토가 끝나면 그 서버의 문서를 통째로 가져온다.
// 저장: <dataDir>/local-folders.json { links: [{ id, path, name, owner, folderId }], remotes: [{ id, name, url, user, token(암호문) }] }.
//   문서의 연결은 meta.local = { link, rel, size, mtimeMs, hash, version(파일에 쓴 기록 번호), state }, 보낸 곳은 meta.review.
// 이 기능은 config.local.enabled 일 때만 켠다(개인용 앱) — 서버 PC 의 폴더를 여는 일이라 연결·끊기는 관리자가 이 PC 에서 보낸 요청만 받는다(routes/local.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { HwpxDoc } from '../engine/doc.js';
import { ServiceError } from './service.js';
import { writeFileAtomic } from './store.js';
import { folderLabel } from './library.js';
import { removeFile } from './fs-safe.js';

const MAX_LINKS = 20;
const MAX_DEPTH = 7;          // 연결 뿌리 아래 폴더 깊이(문서함 폴더는 8단계까지)
const MAX_ENTRIES = 20000;    // 연결 하나에서 훑는 항목 수 상한(넘으면 나머지는 보이지 않는다 — view().truncated)
const MAX_HASH_PER_SCAN = 200;
const SCAN_MIN_MS = 1500;
const WATCH_MS = 4000;
const RETRY_MS = 5000;
const PSEUDO_RE = /^L[0-9a-f]{20}$/;
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SKIP_DIR = new Set(['node_modules', '$recycle.bin', 'system volume information']);
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const nowIso = () => new Date().toISOString();
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, status = 400) => new ServiceError(code, message, status);
const relDir = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const stem = (name) => String(name).replace(/\.hwpx$/i, '');
const skipName = (name) => name.startsWith('.') || name.startsWith('~$') || name.startsWith('$') || /\.tmp$/i.test(name) || SKIP_DIR.has(name.toLowerCase());
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 파일·폴더 이름으로 쓸 수 있게: 못 쓰는 글자는 _, 끝의 점·공백을 떼고, 예약 이름·빈 이름이면 fallback. 120자까지 */
export function safeName(name, fallback) {
  let n = [...String(name ?? '').replace(BAD_NAME, '_').replace(/\s+/g, ' ')].slice(0, 120).join('').replace(/[. ]+$/g, '').trim();
  if (!n || RESERVED.test(n)) n = fallback;
  return n;
}

/**
 * 폴더 훑기 → { dirs: [rel](위 폴더가 먼저), files: [{ rel, size, mtimeMs, birthMs }], truncated }. HWPX 가 (아래에) 있는 폴더와 빈 폴더만 싣는다.
 * skip(abs) 가 참인 하위 폴더는 들어가지 않는다(이 앱의 프로그램·데이터 폴더 — 그 안의 기록 파일이 문서로 보이지 않게)
 */
export function walkFolder(root, { skip = () => false } = {}) {
  const dirs = []; const files = [];
  let count = 0; let truncated = false;
  const visit = (abs, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return false; }
    let show = entries.length === 0;
    const sub = [];
    for (const e of entries) {
      if (++count > MAX_ENTRIES) { truncated = true; break; }
      if (skipName(e.name) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (depth < MAX_DEPTH && !skip(path.join(abs, e.name))) sub.push(e.name); continue; }
      if (!e.isFile() || !/\.hwpx$/i.test(e.name)) continue;
      let st;
      try { st = fs.statSync(path.join(abs, e.name)); } catch { continue; }
      files.push({ rel: rel ? `${rel}/${e.name}` : e.name, size: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.mtimeMs });
      show = true;
    }
    for (const name of sub) {
      const r = rel ? `${rel}/${name}` : name;
      const at = dirs.length;
      dirs.push(r);
      if (visit(path.join(abs, name), r, depth + 1)) show = true;
      else dirs.splice(at);   // HWPX 도 없고 비어 있지도 않은 폴더(와 그 아래)는 싣지 않는다
    }
    return show;
  };
  visit(root, '', 0);
  return { dirs, files, truncated };
}

/** instanceId: 이 서버 프로세스의 표식(/api/config 의 nonce) — 검토 서버로 자기 자신을 등록하지 못하게 */
export function createLocalFolders({ config, service, instanceId = '', log = (m) => console.error(m), fetchImpl = null, platform = process.platform }) {
  const store = service.store;
  const file = path.join(config.dataDir, 'local-folders.json');
  const keyPath = path.join(path.dirname(config.configFile || path.join(config.root || process.cwd(), 'config.json')), '.hwpx-cowork-secret');
  const opt = config.local && typeof config.local === 'object' ? config.local : {};
  const writeDelay = Number.isFinite(Number(opt.writeDelayMs)) ? Math.max(0, Number(opt.writeDelayMs)) : 1500;
  const trashDir = process.env.HWPX_COWORK_LOCAL_TRASH || (opt.trash === 'folder' ? path.join(config.dataDir, 'local-trash') : null);
  const caseFold = platform === 'win32' || platform === 'darwin';
  const keyOf = (s) => (caseFold ? String(s).toLowerCase() : String(s));
  const hid = (s, n) => sha(Buffer.from(s, 'utf8')).slice(0, n);
  const linkIdOf = (p) => `k${hid(keyOf(p), 16)}`;
  const folderIdOf = (link, rel) => `f${hid(`${link}\n${keyOf(rel)}`, 20)}`;
  const docIdOf = (link, rel, salt = 0) => `L${hid(`${link}\n${keyOf(rel)}\n${salt || ''}`, 20)}`;
  const absOf = (link, rel) => path.join(link.path, ...String(rel).split('/').filter(Boolean));
  const pathKey = (link, rel) => `${link}\n${keyOf(rel)}`;
  const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
  // 이 앱의 폴더: 프로그램(app)·데이터·설정 폴더 — 그 안의 HWPX(문서 기록·틀·체험 문서)는 PC 폴더 문서로 보이지 않는다
  const OWN = [...new Set([config.dataDir, config.root, config.configFile ? path.dirname(config.configFile) : null].filter(Boolean).map((p) => path.resolve(p)))];
  const ownFolder = (abs) => OWN.some((own) => keyOf(path.resolve(abs)) === keyOf(own));

  // ───────── 저장 ─────────
  let state = null;
  const cleanList = (v, ok) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && ok(x)) : []);
  function data() {
    if (state) return state;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        version: 1,
        links: cleanList(j.links, (l) => /^k[0-9a-f]{8,40}$/.test(l.id) && typeof l.path === 'string' && typeof l.owner === 'string' && /^f[0-9a-z]{6,40}$/.test(l.folderId)),
        remotes: cleanList(j.remotes, (r) => /^r[0-9a-f]{6,40}$/.test(r.id) && typeof r.url === 'string' && typeof r.token === 'string'),
      };
    } catch (e) {
      if (e.code !== 'ENOENT') throw fail('LOCAL_STORAGE', 'PC 폴더 연결 파일(local-folders.json)을 읽지 못했습니다', 500);
      state = { version: 1, links: [], remotes: [] };
    }
    return state;
  }
  function save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(data(), null, 1));
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 는 사용자 폴더 권한을 따른다 */ }
  }
  const linkOf = (id) => data().links.find((l) => l.id === id) || null;
  const assertOwner = (user) => { if (user?.role !== 'admin') throw fail('FORBIDDEN', 'PC 폴더 연결은 이 앱의 관리자만 바꿀 수 있습니다', 403); };
  const gone = () => fail('LOCAL_GONE', '연결이 끊긴 PC 폴더입니다', 409);
  const busy = (what) => fail('LOCAL_BUSY', `${what} — 한/글 등 다른 프로그램에서 그 파일을 닫은 뒤 다시 해 주세요`, 409);

  // ───────── 파일 다루기 ─────────
  let seq = 0;
  function renameOver(from, to) {
    for (let i = 0; ; i++) {
      try { fs.renameSync(from, to); return; } catch (e) {
        if (i >= 2 || !BUSY.has(e.code)) throw e;
        wait(40 * (i + 1));
      }
    }
  }
  /** 같은 폴더의 임시 파일에 쓰고 바꿔 끼운다(쓰다 멈춰도 PC 파일이 반쯤 쓰인 채 남지 않는다) */
  function writeLocal(abs, bytes) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.~cowork-${process.pid}-${++seq}.tmp`);
    try { fs.writeFileSync(tmp, bytes); renameOver(tmp, abs); } catch (e) { try { removeFile(tmp); } catch { /* 남으면 다음 훑기가 건너뛴다 */ } throw e; }
  }
  /** 지금 그 파일에 쓸 수 있는가: 다른 프로그램이 쓰기를 막고 열어 두었으면(한/글) 열기부터 실패한다. 다른 까닭의 실패는 쓰기에서 알린다 */
  function writable(abs) {
    try { fs.closeSync(fs.openSync(abs, 'r+')); return true; } catch (e) { return !BUSY.has(e.code); }
  }
  function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { renameOver(from, to); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); removeFile(from);   // 다른 디스크로
    }
  }
  function uniqueName(dirAbs, base, ext) {
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
      if (!fs.existsSync(path.join(dirAbs, name))) return name;
    }
    throw fail('NAME_TAKEN', `같은 이름의 파일이 너무 많습니다: ${base}`, 409);
  }
  /** PC 파일 지우기: Windows 는 휴지통으로, 그 밖(또는 실패)에는 앱 데이터의 local-trash 폴더로 옮긴다 — 완전히 지우지 않는다 */
  function trash(abs) {
    if (!fs.existsSync(abs)) return 'missing';
    if (!trashDir && platform === 'win32') {
      try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:HWPX_TRASH_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')"],
        { env: { ...process.env, HWPX_TRASH_FILE: abs }, windowsHide: true, timeout: 15000, stdio: 'ignore' });
        if (!fs.existsSync(abs)) return 'recycle';
      } catch { /* 아래 폴더로 */ }
    }
    const dir = trashDir || path.join(config.dataDir, 'local-trash');
    fs.mkdirSync(dir, { recursive: true });
    const to = path.join(dir, `${Date.now().toString(36)}-${path.basename(abs)}`);
    try { moveFile(abs, to); } catch (e) { if (BUSY.has(e.code)) throw busy('파일을 지우지 못했습니다'); throw e; }
    return 'folder';
  }

  // ───────── 훑기 ─────────
  let index = { at: 0, files: new Map(), pseudo: new Map(), present: new Set(), linkOk: new Map(), truncated: new Set() };
  let stale = true;
  let chain = Promise.resolve();
  const hints = [];                 // 앱에서 폴더를 옮김: { link, from, to } — 그 아래 문서를 내용 비교 없이 잇는다
  const watch = new Map();          // 문서 id → { abs, size, mtimeMs }(열린 문서의 PC 파일이 밖에서 바뀌는지 본다)
  const timers = new Map();         // 문서 id → 파일 맞춤 예약

  /** 문서 목록을 내기 전에 부른다. 방금 훑었으면(1.5초 안) 다시 훑지 않는다. 훑기는 차례로(겹치지 않게) */
  function scan({ force = false } = {}) {
    // 훑기가 실패해도 문서 목록은 지난 결과로 낸다(던지지 않는다)
    const run = chain.then(() => (!force && !stale && Date.now() - index.at < SCAN_MIN_MS ? index : doScan()))
      .catch((e) => { log(`[PC 폴더] 훑기 실패: ${e.message}`); return index; });
    chain = run;
    return run;
  }

  async function doScan() {
    stale = false;
    const st = data();
    // 주인 이름이 바뀌었으면(관리자 화면에서 사용자 이름을 바꿈) 연결을 지금 관리자에게 잇는다 — 문서의 자리는 파일 맞춤이 따라 고친다
    const names = new Set((config.users || []).map((u) => u.name));
    const admin = (config.users || []).find((u) => u.role === 'admin');
    let renamed = false;
    for (const link of st.links) if (!names.has(link.owner) && admin) { link.owner = admin.name; renamed = true; }
    if (renamed) save();
    const next = { at: Date.now(), files: new Map(), pseudo: new Map(), present: new Set(), linkOk: new Map(), truncated: new Set() };
    const desired = [];
    for (const link of st.links) {
      const ok = isDir(link.path);
      next.linkOk.set(link.id, ok);
      desired.push({ id: link.folderId, name: folderLabel(link.name), parentId: null, owner: link.owner, local: { link: link.id, rel: '' } });
      const map = new Map();
      if (ok) {
        const w = walkFolder(link.path, { skip: ownFolder });
        if (w.truncated) next.truncated.add(link.id);
        for (const rel of w.dirs) desired.push({ id: folderIdOf(link.id, rel), name: folderLabel(baseOf(rel)), parentId: relDir(rel) ? folderIdOf(link.id, relDir(rel)) : link.folderId, owner: link.owner, local: { link: link.id, rel } });
        for (const f of w.files) map.set(keyOf(f.rel), f);
      } else {
        // 폴더가 잠깐 안 보이는 동안(외장 디스크·네트워크 폴더)에는 비친 폴더와 그 권한을 그대로 둔다
        for (const f of service.library.data.folders) if (f.local?.link === link.id && f.local.rel !== '') desired.push({ id: f.id, name: f.name, parentId: f.parentId, owner: f.owner, local: f.local });
      }
      next.files.set(link.id, map);
    }
    try { service.library.mirrorLocal(desired); } catch (e) { log(`[PC 폴더] 폴더 목록을 맞추지 못했습니다: ${e.message}`); }

    const metas = store.list();
    const taken = new Set(metas.map((m) => m.id));
    const claimed = new Map();
    const orphans = [];
    for (const m of metas) {
      const l = m.local;
      if (!l || !next.files.has(l.link)) continue;
      const f = next.files.get(l.link).get(keyOf(l.rel));
      const key = pathKey(l.link, l.rel);
      if (f && !claimed.has(key)) { claimed.set(key, m.id); next.present.add(m.id); noteFile(m, f); } else if (next.linkOk.get(l.link)) orphans.push(m);
    }
    // 파일이 제자리에 없는 문서: 앱에서 옮긴 폴더(hints) 또는 내용이 같은 새 파일로 잇는다
    let hashed = 0;
    const hashOf = (link, f) => {
      if (f.hash === undefined) {
        if (hashed >= MAX_HASH_PER_SCAN) return null;
        hashed++;
        try { f.hash = sha(fs.readFileSync(absOf(link, f.rel))); } catch { f.hash = null; }
      }
      return f.hash;
    };
    for (const m of orphans) {
      const l = m.local;
      let hit = null;
      for (const h of hints) {
        if (h.link !== l.link || !keyOf(l.rel).startsWith(`${keyOf(h.from)}/`)) continue;
        const f = next.files.get(h.link)?.get(keyOf(`${h.to}${l.rel.slice(h.from.length)}`));
        if (f && !claimed.has(pathKey(h.link, f.rel))) { hit = { link: h.link, f }; break; }
      }
      if (!hit && l.hash) {
        const order = [l.link, ...st.links.map((x) => x.id).filter((id) => id !== l.link)];
        for (const id of order) {
          const link = linkOf(id); const map = next.files.get(id);
          if (!link || !map) continue;
          const same = [...map.values()].filter((f) => f.size === l.size && !claimed.has(pathKey(id, f.rel)) && hashOf(link, f) === l.hash);
          const f = same.find((x) => keyOf(baseOf(x.rel)) === keyOf(baseOf(l.rel))) || same[0];
          if (f) { hit = { link: id, f }; break; }
        }
      }
      if (hit && await relink(m.id, hit.link, hit.f)) { claimed.set(pathKey(hit.link, hit.f.rel), m.id); next.present.add(m.id); }
    }
    hints.length = 0;
    // 아직 문서로 등록하지 않은 파일(열 때 등록한다)
    for (const link of st.links) {
      for (const f of next.files.get(link.id).values()) {
        if (claimed.has(pathKey(link.id, f.rel))) continue;
        let id;
        for (let salt = 0; ; salt++) { id = docIdOf(link.id, f.rel, salt); if (!taken.has(id)) break; }
        taken.add(id);
        next.pseudo.set(id, { link: link.id, rel: f.rel, f });
      }
    }
    for (const id of [...watch.keys()]) if (!next.present.has(id)) watch.delete(id);
    index = next;
    return index;
  }

  /** 등록된 문서의 PC 파일이 기록과 다르거나(밖에서 바뀜) 아직 쓰지 않은 기록이 있으면 맞춤을 예약한다 */
  function noteFile(m, f) {
    const l = m.local; const link = linkOf(l.link);
    const touched = f.size !== l.size || Math.abs(f.mtimeMs - l.mtimeMs) > 2;
    const dir = relDir(l.rel);
    const misplaced = m.folderId !== (dir ? folderIdOf(l.link, dir) : link.folderId) || m.space !== 'private' || m.spaceOwner !== link.owner;
    if (!watch.has(m.id)) watch.set(m.id, { abs: absOf(link, l.rel), size: l.size, mtimeMs: l.mtimeMs });
    if (touched || misplaced || m.version !== l.version) queueSync(m.id, 0);
  }

  function placeMeta(meta, link, rel) {
    const dir = relDir(rel);
    meta.space = 'private'; meta.spaceOwner = link.owner;
    meta.folderId = dir ? folderIdOf(link.id, dir) : link.folderId;
    meta.fileName = baseOf(rel);
  }

  /** 옮기거나 이름을 바꾼 파일에 문서를 잇는다(문서 큐 안에서 — 진행 중인 저장과 겹치지 않게). 제목이 옛 파일 이름이었으면 새 이름으로 */
  function relink(id, linkId, f) {
    return store.withDoc(id, async () => {
      const meta = store.readMeta(id); const link = linkOf(linkId);
      if (!meta?.local || !link) return false;
      const retitle = meta.title === stem(baseOf(meta.local.rel));
      meta.local = { ...meta.local, link: linkId, rel: f.rel, size: f.size, mtimeMs: f.mtimeMs };
      placeMeta(meta, link, f.rel);
      if (retitle) meta.title = stem(baseOf(f.rel));
      store.saveMetaQuiet(meta);
      watch.set(id, { abs: absOf(link, f.rel), size: f.size, mtimeMs: f.mtimeMs });
      return true;
    }).catch((e) => { log(`[PC 폴더] 문서를 옮긴 파일에 잇지 못했습니다(${id}): ${e.message}`); return false; });
  }

  // ───────── 파일 맞춤(쓰기·다시 읽기) ─────────
  /** 맞춤 예약. 이미 예약이 있으면 더 이른 쪽만 남긴다(다시 해 보기를 기다리는 중에 목록을 다시 읽으면 곧바로 해 본다) */
  function queueSync(id, delay = writeDelay) {
    const at = Date.now() + delay;
    const had = timers.get(id);
    if (had) { if (had.at <= at) return; clearTimeout(had.t); }
    const t = setTimeout(() => { timers.delete(id); syncDoc(id).catch((e) => log(`[PC 폴더] 파일을 맞추지 못했습니다(${id}): ${e.message}`)); }, delay);
    t.unref?.();
    timers.set(id, { t, at });
  }
  const cancelSync = (id) => { const had = timers.get(id); if (had) { clearTimeout(had.t); timers.delete(id); } return !!had; };

  const notify = (id, st) => { try { service.hub?.broadcast(id, { type: 'doc', action: 'local', state: st }); } catch { /* 알림만 */ } };

  /**
   * 문서와 PC 파일을 맞춘다(문서 큐 안에서). PC 파일이 밖에서 바뀌었으면 그 파일을 새 기록으로 읽고(PC 파일이 기준), 아니면서
   * 아직 쓰지 않은 기록이 있으면 PC 파일에 쓴다. 다른 프로그램이 잡고 있어 못 쓰면 state 'locked' 로 두고 5초 뒤 다시 해 본다
   */
  function syncDoc(id) {
    return store.withDoc(id, async () => {
      const meta = store.readMeta(id);
      const link = meta?.local ? linkOf(meta.local.link) : null;
      if (!link) return;
      const l = meta.local;
      const abs = absOf(link, l.rel);
      const dir = relDir(l.rel);
      // 자리(문서함·폴더)가 어긋나 있으면 바로잡는다(연결을 다시 맺음, 옛 자료)
      const folderId = dir ? folderIdOf(link.id, dir) : link.folderId;
      let quiet = false;
      if (meta.folderId !== folderId || meta.space !== 'private' || meta.spaceOwner !== link.owner) { placeMeta(meta, link, l.rel); quiet = true; }
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { if (e.code !== 'ENOENT') { setState(meta, 'locked', e.code); return; } }
      const dirty = meta.version !== l.version;
      if (st) {
        watch.set(id, { abs, size: st.size, mtimeMs: st.mtimeMs });
        if (st.size !== l.size || Math.abs(st.mtimeMs - l.mtimeMs) > 2) {
          let bytes;
          try { bytes = fs.readFileSync(abs); } catch (e) { setState(meta, 'locked', e.code); queueSync(id, RETRY_MS); return; }
          const hash = sha(bytes);
          if (hash !== l.hash) {
            if (hash === l.badHash) { if (quiet) store.saveMetaQuiet(meta); return; }   // 지난번에 못 읽은 그 파일 그대로
            await importExternal(id, meta, bytes, st, hash);
            return;
          }
          l.size = st.size; l.mtimeMs = st.mtimeMs; quiet = true;   // 내용은 같고 시각만 바뀜
        }
      } else if (!dirty) { watch.delete(id); if (quiet) store.saveMetaQuiet(meta); return; }   // 탐색기에서 지운 파일 — 다음 훑기부터 목록에서 숨는다
      if (!dirty) { if (l.state !== 'ok') { l.state = 'ok'; delete l.error; quiet = true; notify(id, 'ok'); } if (quiet) store.saveMetaQuiet(meta); return; }
      // 다른 프로그램(한/글)이 잡고 있는 동안에는 임시 파일을 써 보지도 않는다(5초마다 큰 파일을 썼다 지우지 않게)
      if (st && !writable(abs)) { setState(meta, 'locked', 'EBUSY'); queueSync(id, RETRY_MS); return; }
      const bytes = store.currentBytes(id);
      try { writeLocal(abs, bytes); } catch (e) {
        if (!BUSY.has(e.code)) log(`[PC 폴더] ${abs} 에 쓰지 못했습니다: ${e.message}`);
        setState(meta, 'locked', e.code);
        queueSync(id, RETRY_MS);
        return;
      }
      const now = fs.statSync(abs);
      const was = l.state;
      meta.local = { link: l.link, rel: l.rel, size: now.size, mtimeMs: now.mtimeMs, hash: sha(bytes), version: meta.version, state: 'ok', syncedAt: nowIso() };
      store.saveMetaQuiet(meta);
      watch.set(id, { abs, size: now.size, mtimeMs: now.mtimeMs });
      index.present.add(id);
      if (was !== 'ok') notify(id, 'ok');
    });
  }

  function setState(meta, st, error = null) {
    const before = meta.local.state;
    meta.local.state = st;
    if (error) meta.local.error = String(error); else delete meta.local.error;
    store.saveMetaQuiet(meta);
    if (before !== st) notify(meta.id, st);
  }

  /** (문서 큐 안) 밖에서 바뀐 PC 파일을 새 기록으로 읽는다. 읽을 수 없는 파일이면 표시만 하고(state 'unreadable') 문서는 그대로 둔다 */
  async function importExternal(id, meta, bytes, st, hash) {
    const link = linkOf(meta.local.link);
    try {
      await service._replaceContent(id, bytes, {
        by: link.owner, note: 'PC 파일에서 다시 읽음',
        after: (m) => { m.local = { link: m.local.link, rel: m.local.rel, size: st.size, mtimeMs: st.mtimeMs, hash, version: m.version, state: 'ok', syncedAt: nowIso() }; },
      });
    } catch (e) {
      store.cache.delete(id);
      if (service._wc?.id === id) service._wc = null;
      if (!(e instanceof ServiceError)) throw e;
      const cur = store.readMeta(id);
      if (cur?.local) { cur.local.badHash = hash; setState(cur, 'unreadable', e.message); }
    }
  }

  /** 등록된 PC 폴더 문서를 부를 때: PC 파일이 그사이 밖에서 바뀌었으면(크기·시각) 먼저 맞춘다 — 열면 늘 지금 파일 내용이다 */
  async function fresh(id) {
    const w = watch.get(id);
    if (!w) return;
    let st;
    try { st = fs.statSync(w.abs); } catch { return; }
    if (st.size === w.size && Math.abs(st.mtimeMs - w.mtimeMs) <= 2) return;
    w.size = st.size; w.mtimeMs = st.mtimeMs;
    cancelSync(id);
    await syncDoc(id).catch((e) => log(`[PC 폴더] 파일을 맞추지 못했습니다(${id}): ${e.message}`));
  }

  // 열려 있는 문서의 PC 파일이 밖에서 바뀌었는지 4초마다 본다(목록을 다시 읽지 않아도 편집기에 반영되게)
  const watcher = setInterval(() => {
    for (const id of service.hub?.rooms?.keys?.() || []) {
      const w = watch.get(id);
      if (!w || timers.has(id)) continue;
      let st = null;
      try { st = fs.statSync(w.abs); } catch { continue; }
      if (st.size !== w.size || Math.abs(st.mtimeMs - w.mtimeMs) > 2) { w.size = st.size; w.mtimeMs = st.mtimeMs; queueSync(id, 0); }
    }
  }, WATCH_MS);
  watcher.unref?.();

  // 커밋할 때마다(실시간 편집은 1~3초마다) 곧바로 쓰지 않고 잠깐 모았다가 쓴다
  store.afterCommit = (id, meta) => { if (meta?.local && linkOf(meta.local.link)) queueSync(id, writeDelay); };

  /** 예약된 파일 맞춤을 지금 모두 마친다(서버를 끄기 전) */
  async function flush() {
    const ids = [...timers.keys()];
    for (const id of ids) cancelSync(id);
    await Promise.allSettled(ids.map((id) => syncDoc(id)));
    // 잠겨 있어 다시 예약된 것은 기다리지 않는다(다음에 켤 때 마저 쓴다) — 끄는 동안 되풀이하지 않게 그 예약만 지운다
    for (const id of ids) cancelSync(id);
  }

  // ───────── 문서 목록에 싣는 것 ─────────
  function pseudoMeta(id, link, f) {
    const dir = relDir(f.rel);
    return {
      id, title: stem(baseOf(f.rel)), fileName: baseOf(f.rel), createdAt: new Date(f.birthMs || f.mtimeMs).toISOString(), createdBy: link.owner, updatedAt: new Date(f.mtimeMs).toISOString(),
      version: 0, versions: [], milestones: [], proposals: [], requests: [], attachments: [], locks: {}, activity: [], changeRequests: [], memoThreads: {},
      seq: { proposal: 0, request: 0, attachment: 0, cr: 0 }, breakView: 1,
      space: 'private', spaceOwner: link.owner, folderId: dir ? folderIdOf(link.id, dir) : link.folderId,
      local: { link: link.id, rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, state: 'file' },
    };
  }
  /** 아직 등록하지 않은 PC 파일을 문서 꼴로(목록용 — 저장소에는 없다) */
  function pseudoMetas() {
    const out = [];
    for (const [id, p] of index.pseudo) { const link = linkOf(p.link); if (link) out.push(pseudoMeta(id, link, p.f)); }
    return out;
  }
  const isPseudo = (id) => index.pseudo.has(String(id ?? ''));
  /** 등록된 PC 폴더 문서가 목록에 보이는가: 연결이 살아 있고 파일이 제자리에 있을 때 */
  const visible = (meta) => !meta?.local || index.present.has(meta.id);
  const linked = (meta) => !!(meta?.local && linkOf(meta.local.link));

  /** 문서 요약에 싣는 표시 { state, path?(주인·관리자만), syncedAt }. state: file(아직 열지 않은 파일)·ok·saving(쓸 것 있음)·locked·unreadable */
  function docView(meta, user) {
    const l = meta.local; const link = linkOf(l.link);
    const mine = !!user && !!link && (user.role === 'admin' || user.name === link.owner);
    const st = l.state === 'file' ? 'file' : (l.state || 'ok') === 'ok' && meta.version !== l.version ? 'saving' : l.state || 'ok';
    return { state: link ? st : 'unlinked', ...(mine ? { path: absOf(link, l.rel) } : {}), syncedAt: l.syncedAt || null };
  }

  // ───────── 처음 열 때 등록 ─────────
  const ensuring = new Map();
  /** 아직 등록하지 않은 PC 파일의 id 로 문서를 부르면 그때 등록한다(REST·MCP 접근 문에서 부른다). 볼 수 없는 사람이 부르면 아무것도 하지 않는다 */
  async function ensure(id, user) {
    id = String(id ?? '');
    if (watch.has(id)) { await fresh(id); return null; }
    if (!PSEUDO_RE.test(id) || store.has(id)) return null;
    let p = index.pseudo.get(id);
    if (!p) { await scan({ force: true }); p = index.pseudo.get(id); }
    const link = p ? linkOf(p.link) : null;
    if (!link) return null;
    if (user && !service.canRead(user, pseudoMeta(id, link, p.f))) return null;
    if (!ensuring.has(id)) ensuring.set(id, register(id, link, p.f.rel).finally(() => ensuring.delete(id)));
    return ensuring.get(id);
  }
  async function register(id, link, rel) {
    const abs = absOf(link, rel);
    let bytes; let st;
    try { bytes = fs.readFileSync(abs); st = fs.statSync(abs); } catch (e) { throw fail('LOCAL_READ', `PC 파일을 읽지 못했습니다: ${baseOf(rel)} (${e.code || e.message})`, e.code === 'ENOENT' ? 404 : 409); }
    let doc;
    try { doc = await HwpxDoc.load(bytes); } catch (e) { throw fail('BAD_FILE', `HWPX 를 읽지 못했습니다: ${baseOf(rel)} — ${e.message}`); }
    if (!doc.sections.length) throw fail('BAD_FILE', `구역(section)이 없는 파일입니다: ${baseOf(rel)}`);
    if (store.has(id)) return store.readMeta(id);
    const dir = relDir(rel);
    const meta = store.create({
      id, fileName: baseOf(rel), title: stem(baseOf(rel)), bytes, by: link.owner, settings: service._normSettings(null), note: 'PC 파일',
      location: { space: 'private', spaceOwner: link.owner, folderId: dir ? folderIdOf(link.id, dir) : link.folderId },
      extra: { local: { link: link.id, rel, size: st.size, mtimeMs: st.mtimeMs, hash: sha(bytes), version: 1, state: 'ok', syncedAt: nowIso() } },
    });
    store.cache.set(meta.id, { version: 1, doc });
    adopted(meta);
    return meta;
  }
  /** 방금 등록·연결한 문서를 훑기 결과에 넣는다(다음 훑기 전에도 목록에 보이게) */
  function adopted(meta) {
    const link = linkOf(meta.local.link);
    for (const [pid, p] of index.pseudo) if (p.link === meta.local.link && keyOf(p.rel) === keyOf(meta.local.rel)) index.pseudo.delete(pid);
    index.present.add(meta.id);
    if (link) watch.set(meta.id, { abs: absOf(link, meta.local.rel), size: meta.local.size, mtimeMs: meta.local.mtimeMs });
    stale = true;
  }
  function forget(id) {
    index.present.delete(id); watch.delete(id);
    cancelSync(id);
    stale = true;
  }

  // ───────── 문서·폴더 동작(서비스·문서함이 부른다) ─────────
  /** PC 폴더 안에 새 파일을 만든다 → store.create 에 넘길 { id, fileName, title, local }. 같은 이름이 있으면 '이름 (2)' */
  function createFile(folder, fileName, bytes, version = 1) {
    const link = linkOf(folder.local.link);
    if (!link) throw gone();
    const dirAbs = absOf(link, folder.local.rel);
    let name; let abs;
    try {
      fs.mkdirSync(dirAbs, { recursive: true });
      name = uniqueName(dirAbs, safeName(stem(fileName), '문서'), '.hwpx');
      abs = path.join(dirAbs, name);
      writeLocal(abs, bytes);
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw fail('LOCAL_WRITE', `PC 폴더에 파일을 만들지 못했습니다: ${e.code || e.message}`, 409);
    }
    const st = fs.statSync(abs);
    const rel = folder.local.rel ? `${folder.local.rel}/${name}` : name;
    let id;
    for (let salt = 0; ; salt++) { id = docIdOf(link.id, rel, salt); if (!store.has(id)) break; }
    return { id, fileName: name, title: stem(name), local: { link: link.id, rel, size: st.size, mtimeMs: st.mtimeMs, hash: sha(bytes), version, state: 'ok', syncedAt: nowIso() } };
  }

  /** 문서함의 문서를 PC 폴더로 옮긴다: 지금 기록을 그 폴더의 새 파일로 쓰고 연결한다(meta 를 고친다 — 부르는 쪽이 저장) */
  function attach(meta, folder, bytes) {
    const made = createFile(folder, `${meta.title || '문서'}.hwpx`, bytes, meta.version);
    meta.local = made.local; meta.fileName = made.fileName;
    adopted(meta);
  }

  /** 문서 이름 바꾸기 = PC 파일 이름 바꾸기 → 실제로 쓰인 제목(파일 이름에 못 쓰는 글자는 _). meta.local·fileName 을 고친다 */
  function renameFile(meta, title) {
    const link = linkOf(meta.local.link);
    if (!link) throw gone();
    const base = safeName(title, null);
    if (!base) throw fail('BAD_TITLE', '파일 이름으로 쓸 수 없는 이름입니다');
    const dir = relDir(meta.local.rel);
    const name = `${base}.hwpx`;
    const rel = dir ? `${dir}/${name}` : name;
    if (rel === meta.local.rel) return base;
    const from = absOf(link, meta.local.rel); const to = absOf(link, rel);
    if (keyOf(rel) !== keyOf(meta.local.rel) && fs.existsSync(to)) throw fail('NAME_TAKEN', `같은 이름의 파일이 이미 있습니다: ${name}`, 409);
    if (fs.existsSync(from)) {
      try { moveFile(from, to); } catch (e) { if (BUSY.has(e.code)) throw busy('파일 이름을 바꾸지 못했습니다'); throw fail('LOCAL_WRITE', `파일 이름을 바꾸지 못했습니다: ${e.code || e.message}`, 409); }
      const st = fs.statSync(to);
      meta.local.size = st.size; meta.local.mtimeMs = st.mtimeMs;
    }
    meta.local.rel = rel; meta.fileName = name;
    watch.set(meta.id, { abs: to, size: meta.local.size, mtimeMs: meta.local.mtimeMs });
    stale = true;
    return base;
  }

  /** PC 폴더 문서를 다른 PC 폴더(같은·다른 연결)로 옮긴다 = 파일 옮기기. meta.local·fileName 을 고친다(자리는 부르는 쪽이) */
  function moveDocFile(meta, folder) {
    const from = linkOf(meta.local.link); const link = linkOf(folder.local.link);
    if (!from || !link) throw gone();
    const dirAbs = absOf(link, folder.local.rel);
    const src = absOf(from, meta.local.rel);
    let name = baseOf(meta.local.rel);
    try {
      fs.mkdirSync(dirAbs, { recursive: true });
      if (fs.existsSync(path.join(dirAbs, name))) name = uniqueName(dirAbs, stem(name), '.hwpx');
      if (fs.existsSync(src)) moveFile(src, path.join(dirAbs, name));
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      if (BUSY.has(e.code)) throw busy('파일을 옮기지 못했습니다');
      throw fail('LOCAL_WRITE', `파일을 옮기지 못했습니다: ${e.code || e.message}`, 409);
    }
    const rel = folder.local.rel ? `${folder.local.rel}/${name}` : name;
    const to = path.join(dirAbs, name);
    let st = null; try { st = fs.statSync(to); } catch { st = null; }
    meta.local = { ...meta.local, link: link.id, rel, ...(st ? { size: st.size, mtimeMs: st.mtimeMs } : {}) };
    meta.fileName = name;
    watch.set(meta.id, { abs: to, size: meta.local.size, mtimeMs: meta.local.mtimeMs });
    stale = true;
  }

  /** 문서를 지울 때 PC 파일도 지운다(휴지통·local-trash 로 — 완전히 지우지 않는다) */
  function trashDocFile(meta) {
    const link = linkOf(meta.local.link);
    if (link) trash(absOf(link, meta.local.rel));
    forget(meta.id);
  }
  /** 아직 등록하지 않은 PC 파일 지우기(문서 '삭제' 권한 — 폴더 권한을 따른다) */
  function removePseudo(id, user) {
    const p = index.pseudo.get(String(id)); const link = p ? linkOf(p.link) : null;
    if (!link) throw fail('NO_DOC', `문서가 없습니다: ${String(id).slice(0, 64)}`, 404);
    if (!service.docPerms(user, pseudoMeta(id, link, p.f)).includes('delete')) throw fail('FORBIDDEN', '이 문서를 지울 권한이 없습니다(폴더의 삭제 권한)', 403);
    trash(absOf(link, p.rel));
    index.pseudo.delete(String(id)); stale = true;
    return true;
  }

  const folderHooks = {
    /** 문서함에서 PC 폴더 안에 폴더를 만들 때: PC 에 실제 폴더를 만든다 → { id, local } */
    createFolder(parent, name) {
      const link = linkOf(parent.local.link);
      if (!link) throw gone();
      const dirName = safeName(name, null);
      if (!dirName) throw fail('BAD_NAME', '폴더 이름으로 쓸 수 없는 이름입니다');
      const rel = parent.local.rel ? `${parent.local.rel}/${dirName}` : dirName;
      const abs = absOf(link, rel);
      if (fs.existsSync(abs)) throw fail('NAME_TAKEN', `같은 이름의 폴더가 이미 있습니다: ${dirName}`, 409);
      try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { throw fail('LOCAL_WRITE', `PC 에 폴더를 만들지 못했습니다: ${e.code || e.message}`, 409); }
      stale = true;
      return { id: folderIdOf(link.id, rel), local: { link: link.id, rel } };
    },
    /** 연결한 폴더의 이름표 바꾸기(PC 폴더 이름은 그대로) */
    renameLink(folder, name) {
      const link = linkOf(folder.local.link);
      if (link) { link.name = name; save(); }
    },
    /** PC 폴더 이름 바꾸기·옮기기(같은 연결 안): 실제 폴더를 옮기고, 그 아래 비친 폴더(권한 포함)와 문서를 새 길로 잇는다 → 새 폴더 항목 */
    moveFolder(folder, name, parent) {
      const link = linkOf(folder.local.link);
      if (!link || !parent?.local) throw gone();
      const dirName = safeName(name, null);
      if (!dirName) throw fail('BAD_NAME', '폴더 이름으로 쓸 수 없는 이름입니다');
      const from = folder.local.rel;
      const to = parent.local.rel ? `${parent.local.rel}/${dirName}` : dirName;
      if (to === from) return folder;
      if (keyOf(to).startsWith(`${keyOf(from)}/`)) throw fail('BAD_MOVE', '폴더를 자기 안으로 옮길 수 없습니다');
      const src = absOf(link, from); const dst = absOf(link, to);
      if (keyOf(to) !== keyOf(from) && fs.existsSync(dst)) throw fail('NAME_TAKEN', `같은 이름의 폴더가 이미 있습니다: ${dirName}`, 409);
      try { renameOver(src, dst); } catch (e) {
        if (BUSY.has(e.code)) throw busy('폴더를 옮기지 못했습니다(안의 파일이 열려 있습니다)');
        throw fail('LOCAL_WRITE', `폴더를 옮기지 못했습니다: ${e.code || e.message}`, 409);
      }
      // 그 폴더와 아래 비친 폴더: 새 길·새 id 로(권한은 그대로 가져간다)
      const lib = service.library;
      const under = lib.data.folders.filter((f) => f.local?.link === link.id && (f.local.rel === from || keyOf(f.local.rel).startsWith(`${keyOf(from)}/`)));
      for (const f of under) {
        const rel = `${to}${f.local.rel.slice(from.length)}`;
        f.id = folderIdOf(link.id, rel); f.local = { link: link.id, rel };
        f.name = folderLabel(baseOf(rel));
        f.parentId = relDir(rel) ? folderIdOf(link.id, relDir(rel)) : link.folderId;
        f.updatedAt = nowIso();
      }
      lib._save();
      hints.push({ link: link.id, from, to });
      stale = true;
      return lib.folder(folderIdOf(link.id, to)) || folder;
    },
    /** 빈 PC 폴더 지우기(HWPX 가 아닌 파일이 남아 있으면 지우지 않는다) */
    removeFolder(folder) {
      const link = linkOf(folder.local.link);
      if (!link) return;
      try { fs.rmdirSync(absOf(link, folder.local.rel)); } catch (e) {
        if (e.code === 'ENOENT') return;
        if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw fail('NOT_EMPTY', 'PC 폴더에 파일이 남아 있습니다(HWPX 가 아닌 파일 포함) — 탐색기에서 비운 뒤 지우세요', 409);
        throw fail('LOCAL_WRITE', `PC 폴더를 지우지 못했습니다: ${e.code || e.message}`, 409);
      }
      stale = true;
    },
  };
  service.library.localHooks = folderHooks;

  // ───────── 연결 ─────────
  function normDir(raw) {
    const text = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1');
    if (!text || !path.isAbsolute(text)) throw fail('BAD_PATH', '폴더의 전체 경로를 넣어 주세요(예: C:\\Users\\이름\\Documents\\보고서)');
    const p = path.resolve(text);
    if (!isDir(p)) throw fail('BAD_PATH', `폴더가 없습니다: ${p}`, 404);
    if (path.parse(p).root === p) throw fail('BAD_PATH', '드라이브 전체는 연결하지 않습니다 — 그 안의 폴더를 고르세요');
    // 이 앱의 프로그램·데이터 폴더 자체(와 그 안)는 연결하지 않는다. 그것을 품은 폴더(예: 앱을 풀어 둔 '문서' 폴더)는 연결하되 훑을 때 그 폴더만 건너뛴다(ownFolder)
    if (OWN.some((own) => inside(p, own))) throw fail('BAD_PATH', '이 앱의 프로그램·데이터 폴더는 연결하지 않습니다');
    return p;
  }
  /** PC 폴더를 주인의 개인 문서함에 연결한다 { path, name? } → 연결 */
  function link(user, { path: raw, name } = {}) {
    assertOwner(user);
    const p = normDir(raw);
    const st = data();
    const id = linkIdOf(p);
    if (st.links.some((l) => l.id === id)) throw fail('LINKED', '이미 연결한 폴더입니다', 409);
    for (const l of st.links) if (inside(p, l.path) || inside(l.path, p)) throw fail('LINK_OVERLAP', `이미 연결한 폴더와 겹칩니다: ${l.path}`, 409);
    if (st.links.length >= MAX_LINKS) throw fail('TOO_MANY', `PC 폴더는 ${MAX_LINKS}개까지 연결합니다`);
    // 개인 문서함 맨 위에서 이름이 겹치지 않게
    const tops = new Set(service.library.data.folders.filter((f) => f.space === 'private' && f.owner === user.name && !f.parentId).map((f) => f.name));
    const base = folderLabel(name || path.basename(p) || p);
    let label = base;
    for (let i = 2; tops.has(label); i++) label = `${base} (${i})`;
    const entry = { id, path: p, name: label, owner: user.name, folderId: folderIdOf(id, ''), addedAt: nowIso() };
    st.links.push(entry);
    save();
    stale = true;
    return entry;
  }
  /** 연결 끊기: 문서함에서 비친 폴더를 뺀다. PC 의 파일과 앱의 문서 기록은 그대로 둔다(같은 폴더를 다시 연결하면 이어진다) */
  function unlink(user, id) {
    assertOwner(user);
    const st = data();
    const entry = st.links.find((l) => l.id === id);
    if (!entry) throw fail('NO_LINK', '연결한 폴더가 아닙니다', 404);
    st.links = st.links.filter((l) => l !== entry);
    save();
    service.library.dropFolders(service.library.data.folders.filter((f) => f.local?.link === id).map((f) => f.id));
    stale = true;
    return true;
  }
  /** 문서함 화면에 싣는 것: canLink(관리자가 이 PC 에서 연 화면), 연결 목록(주인·관리자만 경로까지), 검토 서버 목록 */
  function view(user, { sameMachine = false } = {}) {
    const admin = user?.role === 'admin';
    return {
      enabled: true, canLink: admin && sameMachine,
      links: data().links.filter((l) => admin || l.owner === user?.name).map((l) => ({ id: l.id, folderId: l.folderId, name: l.name, path: l.path, owner: l.owner, ok: index.linkOk.get(l.id) !== false, truncated: index.truncated.has(l.id) })),
      remotes: admin ? remotesView() : [],
    };
  }

  /** 이 PC 의 폴더 고르기 창(Windows: 폴더 찾아보기, macOS: choose folder, Linux: zenity) → 경로 | null(취소) */
  function pick({ dryRun = false } = {}) {
    return new Promise((resolve, reject) => {
      const done = (error, stdout) => {
        const out = String(stdout || '').replace(/^\uFEFF/, '').trim();
        if (out) return resolve(out.split(/\r?\n/).pop().trim());
        if (error && error.code !== 1 && !error.killed) return reject(fail('PICK_UNAVAILABLE', '폴더 고르기 창을 열지 못했습니다 — 경로를 직접 넣어 주세요', 501));
        return resolve(null);
      };
      const options = { windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8', env: { ...process.env, HWPX_PICK_DRYRUN: dryRun ? '1' : '' } };
      if (platform === 'win32') {
        const script = [
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          '$owner = New-Object System.Windows.Forms.Form',
          "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1",
          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$dialog.Description = 'hwpx-cowork 에 연결할 폴더를 고르세요 (그 폴더의 HWPX 를 열어 고치면 그 파일에 저장됩니다)'",
          '$dialog.ShowNewFolderButton = $true',
          "if ($env:HWPX_PICK_DRYRUN -eq '1') { Write-Output 'DRYRUN'; exit 0 }",
          '$owner.Show(); $owner.Activate()',
          "if ($dialog.ShowDialog($owner) -eq 'OK') { Write-Output $dialog.SelectedPath }",
          '$owner.Close()',
        ].join('\n');
        execFile('powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options, done);
      } else if (platform === 'darwin') {
        execFile('osascript', ['-e', dryRun ? 'return "DRYRUN"' : 'POSIX path of (choose folder with prompt "hwpx-cowork 에 연결할 폴더")'], options, done);
      } else {
        execFile(dryRun ? 'echo' : 'zenity', dryRun ? ['DRYRUN'] : ['--file-selection', '--directory', '--title=hwpx-cowork 에 연결할 폴더'], options, done);
      }
    });
  }

  // ───────── 함께 검토(다른 hwpx-cowork 서버) ─────────
  let master = null;
  function masterKey() {
    for (let attempt = 0; attempt < 2 && !master; attempt++) {
      try {
        const bytes = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
        if (bytes.length !== 32) throw fail('LOCAL_SECRET', '암호 열쇠 파일(.hwpx-cowork-secret)이 손상되었습니다', 500);
        master = bytes;
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        if (e.code !== 'ENOENT') throw fail('LOCAL_SECRET', '암호 열쇠 파일을 읽지 못했습니다', 500);
        try { fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' }); } catch (w) { if (w.code !== 'EEXIST') throw fail('LOCAL_SECRET', '암호 열쇠 파일을 만들지 못했습니다', 500); }
      }
    }
    return master;
  }
  const aad = (id) => Buffer.from(`hwpx-local-remote:${id}`, 'utf8');
  function seal(text, id) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv); cipher.setAAD(aad(id));
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
  }
  function unseal(sealed, id) {
    try {
      const [v, iv, tag, body] = String(sealed).split(':');
      if (v !== 'v1') throw new Error('version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64')); decipher.setAAD(aad(id)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw fail('REMOTE_TOKEN', '저장한 서버 토큰을 읽지 못했습니다 — 검토 서버를 다시 등록하세요', 409);
    }
  }
  const remoteOf = (id) => { const r = data().remotes.find((x) => x.id === id); if (!r) throw fail('NO_REMOTE', '등록한 검토 서버가 아닙니다', 404); return r; };
  const remotesView = () => data().remotes.map((r) => ({ id: r.id, name: r.name, url: r.url, user: r.user || null }));
  function cleanUrl(raw) {
    let u;
    try { u = new URL(String(raw ?? '').trim()); } catch { throw fail('BAD_URL', '서버 주소를 확인하세요(예: https://example.org)'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fail('BAD_URL', '서버 주소는 http(s):// 로 시작하는 주소여야 합니다');
    return `${u.origin}${u.pathname.replace(/\/(mcp\/?)?$/, '').replace(/\/$/, '')}`;
  }
  async function call(base, token, p, init = {}) {
    let res;
    try {
      res = await (fetchImpl || fetch)(`${base}${p}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
    } catch (e) { throw fail('REMOTE_UNREACHABLE', `서버에 닿지 못했습니다(${base}): ${e.cause?.code || e.message}`, 502); }
    if (res.status === 401) throw fail('REMOTE_AUTH', '서버가 토큰을 받지 않았습니다 — 토큰을 확인하세요', 502);
    if (!res.ok) {
      let message = '';
      try { message = (await res.json()).message || ''; } catch { /* JSON 아님 */ }
      throw fail('REMOTE_ERROR', `서버가 요청을 받지 않았습니다(${res.status})${message ? ` — ${message}` : ''}`, 502);
    }
    return res;
  }
  const rcall = (r, p, init) => call(r.url, unseal(r.token, r.id), p, init);

  /** 검토 서버 등록 { url, token, name? }: 그 서버에 토큰으로 로그인되는지 확인한 뒤 저장한다(토큰은 암호문으로) */
  async function addRemote(user, { url, token, name } = {}) {
    assertOwner(user);
    const base = cleanUrl(url);
    const tk = String(token ?? '').trim();
    if (!tk) throw fail('BAD_TOKEN', '그 서버의 내 토큰을 넣어 주세요');
    if (!/^[\x21-\x7e]{1,300}$/.test(tk)) throw fail('BAD_TOKEN', '토큰 형식이 아닙니다(영문·숫자·기호만, 공백·한글 없음)');
    let conf;
    try { conf = await (await call(base, null, '/api/config')).json(); } catch (e) { if (e.code === 'REMOTE_UNREACHABLE') throw e; conf = null; }
    if (conf?.name !== 'hwpx-cowork') throw fail('BAD_URL', 'hwpx-cowork 서버 주소가 아닙니다', 502);
    if (conf.nonce && instanceId && conf.nonce === instanceId) throw fail('BAD_URL', '이 앱 자신의 주소입니다 — 함께 검토할 다른 서버의 주소를 넣으세요');
    const me = await (await call(base, tk, '/api/me')).json();
    const id = `r${hid(`${base}\n${me.name}`, 12)}`;
    const st = data();
    const entry = { id, name: folderLabel(name || new URL(base).host), url: base, user: me.name, token: seal(tk, id), addedAt: nowIso() };
    st.remotes = [...st.remotes.filter((r) => r.id !== id), entry].slice(-20);
    save();
    return remotesView().find((r) => r.id === id);
  }
  function removeRemote(user, id) {
    assertOwner(user);
    const st = data();
    remoteOf(id);
    st.remotes = st.remotes.filter((r) => r.id !== id);
    save();
    return true;
  }
  /** 그 서버를 내 토큰으로 여는 주소(#/t/<토큰>/… — 토큰은 주소의 # 뒤라 서버로 가지 않는다) */
  function openUrl(user, id, docId = null) {
    assertOwner(user);
    const r = remoteOf(id);
    return `${r.url}/#/t/${encodeURIComponent(unseal(r.token, r.id))}${docId ? `/doc/${encodeURIComponent(docId)}` : ''}`;
  }
  const reviewOf = (meta) => (meta.review && typeof meta.review === 'object' ? meta.review : null);
  /** 문서 요약에 싣는 '보낸 곳' */
  function reviewView(meta) {
    const v = reviewOf(meta);
    return v ? { remote: v.remote, server: v.server, url: v.url, docId: v.docId, sentAt: v.sentAt, sentVersion: v.sentVersion ?? null, fetchedAt: v.fetchedAt || null } : null;
  }

  /** 함께 검토하러 보내기 { remote, space: 'private'|'public' }: 지금 문서(변경 추적·메모 포함)를 그 서버에 새 문서로 올린다 → { review, openUrl } */
  async function send(user, docId, { remote, space = 'private' } = {}) {
    assertOwner(user);
    const r = remoteOf(remote);
    const { bytes, meta } = await store.withDoc(docId, async () => ({ meta: service._meta(docId), bytes: store.currentBytes(docId) }));
    const name = `${safeName(meta.title, '문서')}.hwpx`;
    const res = await rcall(r, '/api/docs', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-space': space === 'public' ? 'public' : 'private' } });
    const doc = await res.json();
    const review = { remote: r.id, server: r.name, url: r.url, docId: doc.id, title: doc.title, space: doc.space || space, sentAt: nowIso(), sentVersion: meta.version, by: user.name };
    await store.withDoc(docId, async () => {
      const m = store.readMeta(docId);
      if (!m) return;
      m.review = review;
      store.log(m, user.name, 'review.send', `${r.name} 에 보냄`);
      store.saveMetaQuiet(m);
    });
    service.hub?.broadcast(docId, { type: 'doc', action: 'local', state: 'review' });
    return { review: reviewView({ review }), openUrl: openUrl(user, r.id, doc.id) };
  }

  /** 보낸 서버의 지금 상태 → { review, remote: { title, version, updatedAt, proposals, requests, changed } | null, error? } */
  async function reviewStatus(user, docId) {
    assertOwner(user);
    const meta = service._meta(docId);
    const v = reviewOf(meta);
    if (!v) return { review: null, remote: null };
    try {
      const r = remoteOf(v.remote);
      const d = await (await rcall(r, `/api/docs/${encodeURIComponent(v.docId)}`)).json();
      const seen = Number(v.fetchedVersion ?? 1);
      return { review: reviewView(meta), remote: { title: d.title, version: d.version, updatedAt: d.updatedAt, proposals: d.proposals?.pending ?? 0, requests: d.requests ?? 0, memos: d.memos ?? 0, changes: d.changes ?? 0, changed: Number(d.version) > seen }, openUrl: openUrl(user, r.id, v.docId) };
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      return { review: reviewView(meta), remote: null, error: e.message };
    }
  }

  /**
   * 검토본 가져오기 { kind: 'tracked'(기본 — 서버 문서 그대로: 변경 추적·메모 포함) | 'final'(변경을 모두 받아들인 최종본 + 메모) }:
   * 보낸 서버의 문서로 이 문서를 통째로 바꾼다(새 기록 — 그 전 내용은 이력에 남는다). PC 폴더 문서면 곧 PC 파일에도 쓴다
   */
  async function fetchBack(user, docId, { kind = 'tracked' } = {}) {
    assertOwner(user);
    const v = reviewOf(service._meta(docId));
    if (!v) throw fail('NO_REVIEW', '서버에 보낸 적이 없는 문서입니다', 409);
    const r = remoteOf(v.remote);
    const query = kind === 'final' ? 'kind=final&reviews=1' : 'kind=tracked';
    const res = await rcall(r, `/api/docs/${encodeURIComponent(v.docId)}/file?${query}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const info = await (await rcall(r, `/api/docs/${encodeURIComponent(v.docId)}`)).json().catch(() => null);
    const version = Number(res.headers.get('x-doc-version')) || Number(info?.version) || null;
    const out = await service.replaceContent(docId, bytes, {
      by: user.name, note: `검토본 가져옴 — ${r.name}`,
      after: (m) => { m.review = { ...(m.review || v), fetchedAt: nowIso(), fetchedVersion: version, fetchedKind: kind === 'final' ? 'final' : 'tracked' }; },
    });
    return { version: out.version, review: reviewView(service._meta(docId)) };
  }

  function close() { clearInterval(watcher); for (const id of [...timers.keys()]) cancelSync(id); }

  return {
    enabled: true, scan, flush, close, view, link, unlink, pick,
    pseudoMetas, isPseudo, visible, linked, docView, ensure, adopted, forget,
    createFile, attach, renameFile, moveDocFile, trashDocFile, removePseudo,
    remotesView, addRemote, removeRemote, openUrl, send, reviewStatus, fetchBack, reviewView,
    links: () => data().links.map((l) => ({ ...l })),
  };
}
