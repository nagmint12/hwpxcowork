// [hwpx-cowork 포터블] 시작 도우미·관리자 앱이 같이 쓰는 것: 설정 위치, 첫 실행 설정 만들기, 서버 응답 확인, 앱 창 열기.
// 배포물에서는 app/portable/ 에 놓인다. 설정·문서 위치는 HWPX_COWORK_USERDATA(없으면 포터블 폴더의 userdata/).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packaged = fs.existsSync(path.join(here, '..', 'server', 'launcher.js'));
// 소스 배포는 <repo>/deploy/portable, 포터블 배포는 <bundle>/app/portable 에 놓인다.
export const appDir = packaged ? path.resolve(here, '..') : path.resolve(here, '..', '..');
export const userDir = path.resolve(process.env.HWPX_COWORK_USERDATA || path.join(packaged ? path.resolve(appDir, '..') : appDir, 'userdata'));
export const configFile = path.join(userDir, 'config.json');

export function readConfig() {
  const text = fs.readFileSync(configFile, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
export const portOf = (cfg) => Number(process.env.HWPX_COWORK_PORT || cfg.port || 8787);

// 직접 정하는 토큰 규칙 — server/admin-accounts.js 의 TOKEN_RE 와 같게 둔다(서버 모듈을 불러오지 않으려고 따로 적음)
export const TOKEN_RE = /^[A-Za-z0-9._~!@$*+=:,-]{4,200}$/;
export const TOKEN_RULE = '4~200자, 영문·숫자와 . _ ~ ! @ $ * + = : , -';
export const randomToken = () => crypto.randomBytes(24).toString('base64url');

/** 없을 때만 새 설정을 만든다 → 관리자 토큰(이미 있으면 null). token 을 주면 그 토큰(직접 정함), 안 주면 HWPX_COWORK_ADMIN_TOKEN, 그것도 없으면 무작위.
 *  예제의 change-me 토큰·예시 사용자는 넣지 않는다 */
export function ensureConfig(chosen = process.env.HWPX_COWORK_ADMIN_TOKEN) {
  if (fs.existsSync(configFile)) return null;
  if (chosen && !TOKEN_RE.test(chosen)) throw new Error(`관리자 토큰 형식이 아닙니다(${TOKEN_RULE})`);
  const example = JSON.parse(fs.readFileSync(path.join(appDir, 'config.example.json'), 'utf8'));
  const token = chosen || randomToken();
  const ai = { ...example.ai, enabled: false, mock: false };
  delete ai.keyFile;   // 개발 PC 의 키 파일 경로는 쓰지 않는다
  const cfg = { ...example, host: '127.0.0.1', dataDir: './data', ai, users: [{ name: '관리자', token, role: 'admin' }] };
  fs.mkdirSync(userDir, { recursive: true });
  try {
    fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return null;   // 동시에 두 번 실행 — 먼저 만든 쪽을 쓴다
    throw error;
  }
  return token;
}

export function writeConfig(cfg) {
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, configFile);
}
export const adminToken = (cfg) => (cfg.users || []).find((u) => u.role === 'admin')?.token || null;

/** 이 PC 에서 누군가 이 포트로 듣고 있는지(연결이 되는지) */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 이 포트에서 hwpx-cowork 가 답하는지(어느 설치본인지는 모름) */
export async function answering(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.json())?.name === 'hwpx-cowork';
  } catch { return false; }
}

/** 포트 상태: free(비어 있음) | ours(이 폴더의 서버 — 관리자 토큰이 통함) | other(다른 hwpx-cowork, 예: 개발 서버) | busy(다른 프로그램) */
export async function portState(port, token) {
  if (!(await listening(port))) return 'free';
  if (!(await answering(port))) return 'busy';
  if (token) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
      if (res.ok) return 'ours';
    } catch { /* 답 없음 */ }
  }
  return 'other';
}

/** start 부터 비어 있는 포트 */
export async function freePort(start) {
  for (let port = start; port < start + 100; port++) if (!(await listening(port))) return port;
  throw new Error(`${start}~${start + 99} 에 빈 포트가 없습니다`);
}

/** 첫 실행 준비: 설정을 만들고, 처음 만든 설정의 포트가 이미 쓰이면(예: 개발 서버) 빈 포트로 바꾼다 → { token, cfg, moved } */
export async function prepareConfig(chosen) {
  const token = chosen === undefined ? ensureConfig() : ensureConfig(chosen);
  let cfg = readConfig();
  let moved = null;
  if (token && !process.env.HWPX_COWORK_PORT && await listening(portOf(cfg))) {
    const from = portOf(cfg);
    cfg = { ...cfg, port: await freePort(from + 1) };
    writeConfig(cfg);
    moved = { from, to: cfg.port };
  }
  return { token, cfg, moved };
}

export function windowsBrowsers() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const names = [path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join('Google', 'Chrome', 'Application', 'chrome.exe')];
  return names.flatMap((name) => roots.map((root) => path.join(root, name))).filter((file) => fs.existsSync(file));
}

/** 앱 창(Edge·Chrome --app) → 안 되면 기본 브라우저. 화면 없는 서버면 false */
export function openWindow(url, { width, height } = {}) {
  const detached = { detached: true, stdio: 'ignore', windowsHide: false };
  if (process.platform === 'win32') {
    const browser = process.env.HWPX_COWORK_BROWSER === 'default' ? null : windowsBrowsers()[0];
    if (browser) spawn(browser, [`--app=${url}`, ...(width && height ? [`--window-size=${width},${height}`] : [])], detached).unref();
    else spawn('explorer.exe', [url], detached).unref();
    return true;
  }
  if (process.platform === 'darwin') { spawn('open', [url], detached).unref(); return true; }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  spawn('xdg-open', [url], detached).unref();
  return true;
}
