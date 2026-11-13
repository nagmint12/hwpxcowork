// 화면 오류 기록(관리자만, server/client-log.js): 이 창과 같은 출처 iframe(편집기)의 오류·경고, 편집기 단계 기록,
// 문서를 여는 동안의 편집기 상태를 모아 2초마다 서버로 보낸다. 폰처럼 개발자 도구를 못 여는 곳의 문제를 서버에서 읽으려는 것.
import { state } from './util.js';

const KEEP_LOG = /^\[(initDoc|WasmBridge|CanvasView|editor|validation|main)\]/;
const MAX_BUFFER = 500;
const MAX_SENT = 5000;
let started = false;
let buffer = [];
let sent = 0;
const session = Math.random().toString(36).slice(2, 10);

function text(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 2000);
}

function push(level, src, msg) {
  if (sent + buffer.length >= MAX_SENT) return;
  buffer.push({ at: new Date().toISOString(), level, src, msg });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

/** 한 창(window)의 console·오류 이벤트를 가로챈다(같은 창은 한 번만) */
function hook(win, src) {
  try {
    if (!win || win.__coworkClientLog) return;
    win.__coworkClientLog = true;
    const c = win.console;
    for (const level of ['error', 'warn', 'log', 'info']) {
      const orig = c[level];
      if (typeof orig !== 'function') continue;
      c[level] = function (...args) {
        try {
          if (level === 'error' || level === 'warn') push(level, src, text(args));
          else if (typeof args[0] === 'string' && KEEP_LOG.test(args[0])) push(level, src, text(args));
        } catch { /* 기록 실패는 무시 */ }
        return orig.apply(this, args);
      };
    }
    win.addEventListener('error', (e) => push('pageerror', src, e.error ? text([e.error]) : `${e.message} @ ${e.filename}:${e.lineno}`));
    win.addEventListener('unhandledrejection', (e) => push('rejection', src, text([e.reason])));
    push('info', src, `기록 시작 ${win.location.pathname}${win.location.search}`);
    if (src === 'studio') probeStudio(win);
  } catch { /* 다른 출처 iframe */ }
}

/** 편집기 창: 문서 화면 알림과 플러그인 'ready' 를 그때의 화면 계산 조건(플러그인 geometry.ready 와 같은 것)과 함께 남긴다 */
function probeStudio(win) {
  const geo = () => JSON.stringify({ content: !!win.document.getElementById('scroll-content'),
    canvases: win.document.querySelectorAll('canvas.document-page-canvas').length, cover: !!win.document.querySelector('[data-cowork-progressive-preview]') });
  // 편집기 안 단계 알림(cowork-*)과 쪽 그리기 상태를 함께 본다
  win.addEventListener('cowork-document-preview', () => push('info', 'studio-ev', `preview ${geo()}`));
  win.addEventListener('cowork-document-pagination', () => push('info', 'studio-ev', `pagination ${geo()}`));
  const watchReady = (n = 0) => {
    if (win.rhwpCowork?.on) { try { win.rhwpCowork.on('ready', () => push('info', 'studio-ev', `plugin ready ${geo()}`)); } catch { /* 없음 */ } return; }
    if (n < 200) setTimeout(() => watchReady(n + 1), 50);
  };
  watchReady();
}

function editorState() {
  const e = window.__doc?.editor;
  if (!e) return null;
  return { doc: window.__doc?.id, ready: !!e.ready, loading: !!e.loading, previewReady: !!e.previewReady, previewPageCount: e.previewPageCount ?? null, phase: e.openPhase || '', error: e.error || '' };
}

async function flush(keepalive = false) {
  if (!buffer.length || !state.token) return;
  const entries = buffer.splice(0, keepalive ? 40 : 200);
  sent += entries.length;
  const env = { ua: navigator.userAgent, dpr: window.devicePixelRatio, screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}`,
    memory: navigator.deviceMemory ?? null, cpus: navigator.hardwareConcurrency ?? null };
  try {
    await fetch('/api/client-log', { method: 'POST', keepalive, headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, page: location.hash, env, entries }) });
  } catch { /* 다음에 다시 보내지 않는다(서버가 없으면 쌓이기만 한다) */ }
}

/** 로그인 뒤 한 번. 관리자일 때만 켠다 */
export function startClientLog(me) {
  if (started || me?.role !== 'admin') return;
  started = true;
  hook(window, 'app');
  addEventListener('message', (e) => {
    if (e.origin === location.origin && typeof e.data?.type === 'string' && e.data.type.startsWith('cowork-document-')) push('info', 'studio-msg', text([e.data]));
  });
  addEventListener('hashchange', () => push('info', 'app', `이동 ${location.hash}`));
  // 편집기 iframe 은 새로 열 때마다 창이 바뀐다 — 초기화 오류를 놓치지 않게 자주 본다(이미 건 창은 건너뛴다)
  setInterval(() => { for (const f of document.querySelectorAll('iframe')) hook(f.contentWindow, 'studio'); }, 100);
  let last = '';
  setInterval(() => {
    const st = editorState();
    const key = st ? JSON.stringify(st) : '';
    // 문서를 여는 동안·상태가 바뀔 때만 남긴다
    if (st && (st.loading || key !== last)) push('state', 'editor', key);
    last = key;
  }, 1000);
  setInterval(() => flush(), 2000);
  addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
}
