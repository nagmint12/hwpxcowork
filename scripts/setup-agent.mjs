#!/usr/bin/env node
// 개인 에이전트 작업 공간 준비(docs/V3_SPEC.md §2.4, 사용자 안내: docs/AGENT_SETUP.md)
//   node scripts/setup-agent.mjs [--dir agent] [--url http://localhost:8787/mcp] [--user 이름] [--v2|--v1] [--no-claude] [--no-server] [--no-registry]
//   · --v2: 새 MCP 연결(작업 도구 넷 task·read·edit·finish — docs/MCP_REDESIGN_2026-11-16.md)로 준비한다 — 브리지 인자 --v2, CLAUDE.md 는 agent/v2/CLAUDE.md
//     (예전 본보기 CLAUDE.md 는 CLAUDE.v1.md 로 남긴다). --v1 은 예전 연결(--lean)로 되돌린다. 둘 다 없으면 지금 .mcp.json 의 방식을 지킨다(처음이면 예전 연결)
//   · <dir>/.mcp.json 에 hwpx 항목을 쓴다(이 PC 의 절대 경로로 브리지 실행, --channel, 토큰은 ${HWPX_COWORK_TOKEN} 참조) — 다른 항목은 그대로 둔다
//   · <dir> 가 이 프로젝트의 agent/ 가 아니면 CLAUDE.md·.claude/settings.json 본보기를 복사한다(이미 있으면 그대로)
//   · 위 폴더들의 CLAUDE.md(개발 메모)를 에이전트 세션이 읽지 않게 <dir>/.claude/settings.local.json 의 claudeMdExcludes 에 넣는다
//   · 토큰은 어떤 파일에도 쓰지 않는다 — setx HWPX_COWORK_TOKEN 안내만 한다
//     (Windows: 이 창에 없어도 setx 로 저장돼 있으면(HKCU\Environment) '새 터미널을 열면 보임'으로 알린다. --no-registry 면 그 확인을 건너뛴다 —
//      시험이 이 PC 에 저장된 토큰과 상관없이 같은 결과를 보게. 값은 읽어 보여 주지 않고 있는지만 본다)
//   · claude --version 확인(채널은 2.1.80 이상, Windows 에서 세션을 닫을 때 깨끗이 끝나려면 2.1.296 이상 권장)
//   · --url 은 MCP 주소(…/mcp)여야 한다 — 서버 주소만 주면(http://서버:8787) 끝에 /mcp 를 붙인다(브리지는 이 주소로 도구를 부른다)
//   · 서버 확인(/api/config, MCP 주소에 initialize 를 보내 보기, 토큰이 있으면 /api/me·/api/agent/status) 뒤 실행 명령을 알려 준다
//     MCP 주소가 MCP 로 답하지 않으면 ✗ 와 종료 코드 1
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiBaseFrom, redactUrl, DEFAULT_URL } from '../server/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_NAME = 'hwpx';
export const LAUNCH = `claude --dangerously-load-development-channels server:${SERVER_NAME}`;
export const MIN_CHANNELS = '2.1.80';           // 채널 기능이 처음 들어간 판
export const MIN_WINDOWS_SHUTDOWN = '2.1.296';  // Windows 에서 세션을 닫을 때 stdio MCP 서버를 깨끗하게 끝내는 판
const TOKEN_REF = '${HWPX_COWORK_TOKEN}';       // .mcp.json 은 환경 변수 참조만 담는다
/** agent/guides/ — 자주 하지 않는 일의 절차(agent/CLAUDE.md 가 그 일을 할 때만 읽게 한다) */
export const AGENT_GUIDES = Object.freeze(['figure-files.md', 'orchestration.md', 'change-requests.md']);

/** '2.1.143 (Claude Code)' → [2, 1, 143] */
export function parseVersion(s) {
  const m = String(s ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** a < b (판 번호) */
export function versionLess(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a); const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
/** claude --version 결과에 대한 조언: { level: 'ok'|'warn'|'error'|'missing', message } */
export function claudeAdvice(versionText, platform = process.platform) {
  const v = parseVersion(versionText);
  if (!versionText || !v) return { level: 'missing', message: 'claude 명령을 찾지 못했습니다 — Claude Code 를 설치한 뒤(https://code.claude.com/docs) 다시 실행하세요' };
  const shown = v.join('.');
  if (versionLess(v, MIN_CHANNELS)) return { level: 'error', message: `Claude Code ${shown} — 채널은 ${MIN_CHANNELS} 이상이 필요합니다. 'claude update' 로 올리세요` };
  if (platform === 'win32' && versionLess(v, MIN_WINDOWS_SHUTDOWN)) {
    return { level: 'warn', message: `Claude Code ${shown} — Windows 에서 세션을 닫을 때 브리지(MCP 서버)가 깨끗하게 끝나려면 ${MIN_WINDOWS_SHUTDOWN} 이상을 권장합니다('claude update'). 낮은 판에서도 브리지가 stdin 이 닫히면 스스로 끝납니다` };
  }
  return { level: 'ok', message: `Claude Code ${shown}` };
}
/**
 * .mcp.json 의 hwpx 항목(토큰은 환경 변수 참조). filesDir 를 주면 로컬 파일 도구(--files-dir — 첨부 원본 내려받기·결과 파일 올리기)를 켠다.
 * --lean = 얇은 흐름(요청 내용·도구 응답을 모델용으로 짧게 — docs/MCP_LEAN_FLOW_2026-11-10.md). 예전 서버에 붙으면 예전 꼴 그대로 온다
 */
export function mcpEntry(bridgePath, url, filesDir = null, { v2 = false } = {}) {
  return { command: 'node', args: [bridgePath, '--channel', v2 ? '--v2' : '--lean', '--url', url, ...(filesDir ? ['--files-dir', filesDir] : [])], env: { HWPX_COWORK_TOKEN: TOKEN_REF } };
}
/** 새 MCP 연결(--v2)의 작업 도구 — 에이전트 설정(.claude/settings.json)의 허용 목록에 넣는다 */
export const V2_PERMISSIONS = Object.freeze(['task', 'read', 'edit', 'finish'].map((name) => `mcp__${SERVER_NAME}__${name}`));
/** 항목에 토큰이 글자 그대로 적혀 있는가(예전에 손으로 쓴 .mcp.json) */
export function entryHasLiteralToken(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const envTok = entry.env?.HWPX_COWORK_TOKEN;
  if (typeof envTok === 'string' && envTok && !/^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(envTok)) return true;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return args.some((a) => a === '--token' || a.startsWith('--token=') || /\/mcp\/t\/[^/]+/.test(a));
}
/**
 * claudeMdExcludes 무늬: 절대 경로(/ 구분) + 드라이브 글자·구분자 표기와 상관없는 '**\/<폴더>/<이름>'
 * (Claude Code 가 Windows 경로를 어떻게 맞추는지 몰라 둘 다 넣는다 — 둘 다 그 폴더 바로 아래 파일만 가리킨다)
 */
export function excludePatterns(files) {
  const out = [];
  for (const f of files) {
    out.push(f);
    const parts = f.split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (folder && !folder.includes(':')) out.push(`**/${folder}/${parts[parts.length - 1]}`);
  }
  return [...new Set(out)];
}
/**
 * MCP 주소 다듬기 → { url, note } 또는 { error }. 경로는 …/mcp 로 끝나야 한다(브리지는 이 주소로 도구를 부르고, 알림 주소는 그 앞부분에서 만든다).
 * 서버 주소만 주면(http://서버:8787, https://서버/hwpx) 끝에 /mcp 를 붙이고, …/mcp/ 의 끝 / 는 뗀다. /mcp/ 뒤에 다른 경로가 붙은 꼴은 거절.
 */
export function normalizeMcpUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { error: `주소가 올바르지 않습니다: ${url}` }; }
  if (!/^https?:$/.test(u.protocol)) return { error: `http(s):// 주소가 아닙니다: ${url}` };
  const p = u.pathname;
  if (/\/mcp$/.test(p)) return { url, note: null };
  if (/\/mcp\/+$/.test(p)) { u.pathname = p.replace(/\/+$/, ''); return { url: u.toString(), note: '주소 끝의 / 를 뗐습니다' }; }
  if (/\/mcp\//.test(p)) return { error: `MCP 주소는 …/mcp 로 끝나야 합니다(지금 경로 ${p})` };
  u.pathname = `${p.replace(/\/+$/, '')}/mcp`;
  return { url: u.toString(), note: '서버 주소만 있어 끝에 /mcp 를 붙였습니다' };
}
/**
 * MCP 주소 확인: initialize 를 POST 해 본다. → { level, status, server }
 *   ok(200 + JSON-RPC 결과: 주소·토큰 모두 맞음) · reachable(토큰 없이 401 + JSON-RPC 오류: 주소는 맞음) ·
 *   token(토큰을 줬는데 401: 주소는 맞고 토큰이 틀림) · bad(404·HTML 등: MCP 주소가 아님)
 */
export async function checkMcp(url, token, { timeoutMs = 5000 } = {}) {
  const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hwpx-setup-agent', version: '0.3' } } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let msg = null;
  try {
    if (String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const line = text.split(/\r?\n/).find((l) => l.startsWith('data:'));
      msg = line ? JSON.parse(line.slice(5).trim()) : null;
    } else msg = JSON.parse(text);
  } catch { msg = null; }
  const rpc = !!msg && typeof msg === 'object' && msg.jsonrpc === '2.0';
  if (res.status === 200 && rpc && msg.result) return { level: 'ok', status: 200, server: msg.result.serverInfo || null };
  if (res.status === 401 && rpc) return { level: token ? 'token' : 'reachable', status: 401, server: null };
  return { level: 'bad', status: res.status, server: null };
}
/** dir 위 폴더들의 CLAUDE.md·CLAUDE.local.md(절대 경로, / 구분) */
export function ancestorMemoryFiles(dir) {
  const out = [];
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const f = path.join(cur, name);
      if (fs.existsSync(f)) out.push(f.split(path.sep).join('/'));
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

function parseArgs(argv) {
  const o = { dir: null, url: null, user: null, claude: true, server: true, registry: true, v2: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--dir': o.dir = val(); break;
      case '--url': o.url = val(); break;
      case '--user': o.user = val(); break;
      case '--no-claude': o.claude = false; break;
      case '--no-server': o.server = false; break;
      case '--no-registry': o.registry = false; break;
      case '--v2': o.v2 = true; break;
      case '--v1': o.v2 = false; break;
      case '-h': case '--help': o.help = true; break;
      default: o.unknown.push(a);
    }
  }
  return o;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return undefined; } };
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
function claudeVersionText() {
  // 고정 명령(사용자 입력 없음) — Windows 의 claude.cmd 를 찾으려고 셸로 부른다
  const r = spawnSync('claude --version', { shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}
function tokenSavedForNewTerminals() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'HWPX_COWORK_TOKEN'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0;
}
// fetch 실패 이유(소켓 오류 코드·시간 초과)
const fetchWhy = (e) => e?.cause?.code || e?.cause?.errors?.[0]?.code || (e?.name === 'TimeoutError' ? '몇 초 안에 답 없음' : e?.cause?.message || e?.message);
async function getJson(url, token) {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(4000) });
  let body = null;
  try { body = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, body };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  const out = (s = '') => console.log(s);
  if (o.help) {
    out('node scripts/setup-agent.mjs [--dir agent] [--url http://localhost:8787/mcp] [--user 이름] [--v2|--v1] [--no-claude] [--no-server] [--no-registry]');
    out('  --v2: 새 MCP 연결(작업 도구 넷 — task·read·edit·finish), --v1: 예전 연결. 생략하면 지금 방식을 지킵니다');
    out('  개인 에이전트(Claude Code 채널) 작업 공간을 준비합니다. 자세한 안내: docs/AGENT_SETUP.md');
    return 0;
  }
  if (o.unknown.length) out(`! 모르는 인자는 무시합니다: ${o.unknown.join(' ')}`);
  const given = o.url || env.HWPX_COWORK_URL || DEFAULT_URL;
  try { const u = new URL(given); if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) 아님'); } catch {
    out(`✗ 서버 주소가 올바르지 않습니다: ${given}  (예: http://localhost:8787/mcp)`);
    return 2;
  }
  if (/\/mcp\/t\/[^/]+/.test(new URL(given).pathname)) {
    out('✗ 주소에 토큰을 넣지 마세요(/mcp/t/<토큰> 꼴). 토큰은 환경 변수 HWPX_COWORK_TOKEN 으로만 줍니다');
    return 2;
  }
  // MCP 주소(…/mcp)로 맞춘다 — 서버 주소만 적으면 알림은 오는데 도구가 모두 실패하는 설정이 된다
  const fixed = normalizeMcpUrl(given);
  if (fixed.error) { out(`✗ ${fixed.error}  (예: http://localhost:8787/mcp)`); return 2; }
  const url = fixed.url;
  const apiBase = apiBaseFrom(url);
  const templateDir = path.join(root, 'agent');
  const dir = path.resolve(o.dir || templateDir);
  const bridgePath = path.join(root, 'server', 'mcp-stdio.js').split(path.sep).join('/');
  // 소스 폴더(시험과 묶음 스크립트가 함께 있는 곳)의 agent/ 는 배포 묶음·공개 저장소·시험이 읽는 '예전 연결' 본보기다. 그 자리에서 새 연결로 바꾸면
  // 본보기 CLAUDE.md 가 새 연결용 글로 바뀌어 묶음과 시험이 어긋난다 — 새 연결 작업 공간은 다른 폴더에 만든다(설치본의 agent/ 는 그 자리에서 바꿔도 된다)
  const sourceTree = fs.existsSync(path.join(root, 'tests', 'channel_bridge.mjs')) && fs.existsSync(path.join(root, 'scripts', 'package-portable.mjs'));
  if (o.v2 === true && sourceTree && dir === path.resolve(templateDir)) {
    out('✗ 이 폴더(소스)의 agent/ 는 배포 묶음과 시험이 읽는 본보기라 그 자리에서 새 연결(--v2)로 바꾸지 않습니다');
    out('  새 연결 작업 공간은 다른 폴더에 만드세요:  node scripts/setup-agent.mjs --dir agent-v2 --v2');
    return 2;
  }
  out('hwpx-cowork 개인 에이전트(Claude Code 채널) 준비');
  out(`  작업 공간: ${dir}`);
  if (fixed.note) out(`  ! ${fixed.note}: ${redactUrl(url)}`);

  // 1) .mcp.json — hwpx 항목만 바꾸고 나머지는 그대로
  const mcpFile = path.join(dir, '.mcp.json');
  let cfg = fs.existsSync(mcpFile) ? readJson(mcpFile) : {};
  if (cfg === undefined || cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    const bak = `${mcpFile}.bak-${Date.now()}`;
    fs.copyFileSync(mcpFile, bak);
    out(`! 기존 .mcp.json 을 읽지 못해 ${path.basename(bak)} 로 남기고 새로 씁니다`);
    cfg = {};
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) cfg.mcpServers = {};
  const old = cfg.mcpServers[SERVER_NAME];
  if (entryHasLiteralToken(old)) out('! 예전 hwpx 항목에 토큰이 글자 그대로 적혀 있어 지웠습니다(환경 변수 참조로 바꿈). 그 파일이 다른 곳에 퍼졌다면 관리자에게 새 토큰을 받으세요');
  const filesDir = path.join(dir, 'work').split(path.sep).join('/');   // 에이전트의 로컬 파일 작업 폴더(.claude/settings.json 이 이 폴더만 쓰기·실행을 허용)
  // 연결 방식: --v2/--v1 을 주면 그대로, 아니면 지금 .mcp.json 의 방식(처음이면 예전 연결)
  const v2 = o.v2 ?? (Array.isArray(old?.args) && old.args.map(String).includes('--v2'));
  const entry = mcpEntry(bridgePath, url, filesDir, { v2 });
  const same = JSON.stringify(old ?? null) === JSON.stringify(entry);
  cfg.mcpServers[SERVER_NAME] = entry;
  fs.mkdirSync(dir, { recursive: true });
  writeJson(mcpFile, cfg);
  out(`  ✓ .mcp.json ${same ? '그대로(이미 같음)' : '저장'} — 브리지 ${bridgePath} · 서버 ${redactUrl(url)} · ${v2 ? '새 연결(--v2, 작업 도구 넷)' : '예전 연결(--lean)'} · 토큰은 환경 변수 참조만`);

  // 1-1) 새 연결이면 지침(CLAUDE.md)도 새 연결용으로: 없으면 본보기를 쓰고, 예전 본보기(예전 도구 이름이 든 것)면 CLAUDE.v1.md 로 남기고 바꾼다.
  //      사용자가 고쳐 쓴 지침은 건드리지 않는다. --v1 로 되돌릴 때는 남겨 둔 CLAUDE.v1.md 를 되살린다
  const claudeMd = path.join(dir, 'CLAUDE.md'); const v1Backup = path.join(dir, 'CLAUDE.v1.md'); const v2Template = path.join(templateDir, 'v2', 'CLAUDE.md');
  if (v2 && fs.existsSync(v2Template)) {
    const want = fs.readFileSync(v2Template, 'utf8'); const have = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : null;
    if (have == null) { fs.writeFileSync(claudeMd, want); out('  ✓ CLAUDE.md — 새 연결용 지침을 썼습니다'); }
    else if (have !== want) {
      if (/start_request|propose_changes/.test(have) && !/task\(doc_id, request_id\)/.test(have)) {
        if (!fs.existsSync(v1Backup)) fs.writeFileSync(v1Backup, have);
        fs.writeFileSync(claudeMd, want); out('  ✓ CLAUDE.md — 새 연결용 지침으로 바꿨습니다(예전 지침은 CLAUDE.v1.md)');
      } else out('  ! CLAUDE.md 가 본보기와 달라 그대로 둡니다 — 새 연결 도구(task·read·edit·finish) 안내는 agent/v2/CLAUDE.md 를 참고하세요');
    }
  } else if (o.v2 === false && fs.existsSync(v1Backup) && fs.existsSync(claudeMd) && fs.existsSync(v2Template) && fs.readFileSync(claudeMd, 'utf8') === fs.readFileSync(v2Template, 'utf8')) {
    fs.writeFileSync(claudeMd, fs.readFileSync(v1Backup, 'utf8')); out('  ✓ CLAUDE.md — 예전 연결용 지침(CLAUDE.v1.md)을 되살렸습니다');
  }

  // 2) 본보기(CLAUDE.md·.claude/settings.json·guides/ — 그림 파일·멀티에이전트·변경 요청 절차) — agent/ 가 아닌 곳이면 없는 것만 복사
  for (const rel of ['CLAUDE.md', path.join('.claude', 'settings.json'), path.join('.claude', 'ai-debug-hook.mjs'), ...AGENT_GUIDES.map((name) => path.join('guides', name))]) {
    const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) { out(`  ✓ ${rel.split(path.sep).join('/')} 있음`); continue; }
    const src = path.join(templateDir, rel);
    if (path.resolve(dir) !== path.resolve(templateDir) && fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (rel === path.join('.claude', 'ai-debug-hook.mjs')) {
        const source = fs.readFileSync(src, 'utf8').replace("'../../server/ai-debug.js'", JSON.stringify(pathToFileURL(path.join(root, 'server/ai-debug.js')).href));
        fs.writeFileSync(dst, source, { encoding: 'utf8', mode: 0o600 });
      } else fs.copyFileSync(src, dst);
      out(`  ✓ ${rel.split(path.sep).join('/')} 본보기를 복사했습니다`);
    } else out(`  ! ${rel.split(path.sep).join('/')} 가 없습니다 — ${path.join(templateDir, rel)} 를 참고하세요`);
  }

  // 기존 권한/deny와 사용자 hook은 보존한다. 이미 hwpx 도구를 허용한 작업 폴더에는 새 사본 도구만 더한다.
  const agentSettings = path.join(dir, '.claude', 'settings.json');
  if (fs.existsSync(agentSettings)) {
    const settings = readJson(agentSettings), template = readJson(path.join(templateDir, '.claude', 'settings.json'));
    if (settings && typeof settings === 'object' && !Array.isArray(settings) && (settings.hooks == null || (typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)))) {
      settings.hooks ||= {}; let changed = false;
      const allowed = settings.permissions?.allow;
      if (Array.isArray(allowed) && allowed.some(name => /^mcp__hwpx__(?:read_document|get_request|propose_changes)$/.test(name))) {
        for (const name of ['get_edit_capabilities', 'get_edit_workspace', 'edit_workspace', 'publish_edit_workspace', 'record_edit_stage']) {
          const permission = `mcp__hwpx__${name}`;
          if (!allowed.includes(permission)) { allowed.push(permission); changed = true; }
        }
        // 새 MCP 연결의 작업 도구 넷(예전 연결에는 없는 이름이라 미리 허용해도 달라지는 것이 없다)
        for (const permission of V2_PERMISSIONS) if (!allowed.includes(permission)) { allowed.push(permission); changed = true; }
      }
      for (const [event, groups] of Object.entries(template.hooks || {})) {
        const current = settings.hooks[event];
        if (current != null && !Array.isArray(current)) continue;
        const installed = (current || []).some(group => group.hooks?.some(hook => /ai-debug-hook\.mjs/.test([hook.command, ...(hook.args || [])].join(' '))));
        if (!installed) { settings.hooks[event] = [...(current || []), ...groups]; changed = true; }
      }
      if (changed) { writeJson(agentSettings, settings); out('  ✓ 진단 hook·기존 hwpx 연결의 사본 편집 도구를 병합했습니다(기존 설정·deny·다른 hook 보존)'); }
    }
  }

  // 3) 위 폴더의 CLAUDE.md(개발 메모)는 에이전트 세션에 필요 없다 — claudeMdExcludes(이 PC 전용 settings.local.json)
  const ancestors = ancestorMemoryFiles(dir);
  if (ancestors.length) {
    const localFile = path.join(dir, '.claude', 'settings.local.json');
    const local = fs.existsSync(localFile) ? readJson(localFile) : {};
    if (local && typeof local === 'object' && !Array.isArray(local)) {
      const prev = Array.isArray(local.claudeMdExcludes) ? local.claudeMdExcludes.map(String) : [];
      const merged = [...new Set([...prev, ...excludePatterns(ancestors)])];
      if (merged.length !== prev.length) { local.claudeMdExcludes = merged; writeJson(localFile, local); }
      out(`  ✓ 위 폴더의 CLAUDE.md ${ancestors.length}개는 이 세션에서 읽지 않게 했습니다(.claude/settings.local.json)`);
    } else out('  ! .claude/settings.local.json 을 읽지 못해 claudeMdExcludes 를 건너뜁니다');
  }

  // 4) 토큰 — 파일에 쓰지 않는다
  const token = env.HWPX_COWORK_TOKEN || '';
  if (token) out('  ✓ 토큰: 환경 변수 HWPX_COWORK_TOKEN 이 있습니다(값은 보여 주지 않습니다)');
  else {
    const saved = o.registry && tokenSavedForNewTerminals();
    out(saved
      ? '  · 토큰: setx 로 저장돼 있지만 이 창에는 아직 없습니다 — 새 터미널을 열면 보입니다'
      : `  · 토큰: 환경 변수 HWPX_COWORK_TOKEN 이 없습니다. 관리자에게 받은 ${o.user ? `${o.user} 의 ` : '내 '}토큰으로 한 번만 실행하세요:`);
    if (!saved) {
      out(process.platform === 'win32' ? '        setx HWPX_COWORK_TOKEN "내-토큰"' : '        echo \'export HWPX_COWORK_TOKEN="내-토큰"\' >> ~/.bashrc   (zsh 면 ~/.zshrc)');
      out('      그다음 새 터미널을 여세요(setx 는 지금 창에는 반영되지 않습니다). 토큰은 .mcp.json 같은 파일에 적지 않습니다');
    }
  }

  // 5) Claude Code 판
  let claudeLevel = 'skip';
  if (o.claude) {
    const advice = claudeAdvice(claudeVersionText());
    claudeLevel = advice.level;
    out(`  ${advice.level === 'ok' ? '✓' : advice.level === 'warn' ? '!' : '✗'} ${advice.message}`);
  }

  // 6) 서버·MCP 주소·토큰 확인
  let mcpBad = false;
  if (o.server) {
    let reachable = true;
    try {
      const c = await getJson(`${apiBase}/api/config`);
      if (c.status !== 200 || !c.body) out(`  ! 서버 ${apiBase} 가 /api/config 에 ${c.status} 로 답했습니다`);
      else {
        const parts = [`서버 ${apiBase} — ${c.body.name || 'hwpx-cowork'} ${c.body.version || ''}`.trim()];
        if (token) {
          const me = await getJson(`${apiBase}/api/me`, token);
          if (me.status === 401) parts.push('토큰이 이 서버에 맞지 않습니다(401)');
          else if (me.status === 200 && me.body?.name) {
            parts.push(`내 토큰 = ${me.body.name}${me.body.role ? `(${me.body.role})` : ''}`);
            if (o.user && o.user !== me.body.name) parts.push(`--user ${o.user} 와 다릅니다`);
          }
          const st = await getJson(`${apiBase}/api/agent/status`, token);
          parts.push(st.status === 200 ? '채널 연결 지원' : st.status === 404 ? '이 서버는 채널 연결을 모릅니다(v0.3 이상 필요)' : `채널 상태 ${st.status}`);
        }
        out(`  ✓ ${parts.join(' · ')}`);
        // 새 연결(--v2)은 서버가 그 연결을 알아야 한다(/api/config features.mcp2). 옛 서버는 예전 도구로 답해 새 연결용 지침(CLAUDE.md)과 맞지 않는다
        if (v2 && !c.body.features?.mcp2) out('  ✗ 이 서버는 새 연결(--v2)을 모릅니다 — 서버를 최신 버전으로 올린 뒤 쓰세요. 지금 띄우면 예전 도구로 답해 지침과 맞지 않습니다(되돌리기: node scripts/setup-agent.mjs --v1)');
      }
    } catch (e) {
      reachable = false;
      out(`  ! 서버 ${apiBase} 에 닿지 않습니다(${fetchWhy(e)}) — 서버를 켠 뒤 Claude Code 를 띄우세요`);
    }
    // 브리지가 도구를 부를 주소 그 자체를 본다(/api/config 만 보면 /mcp 가 빠진 주소도 ✓ 가 된다)
    if (reachable) {
      try {
        const m = await checkMcp(url, token);
        if (m.level === 'ok') out(`  ✓ MCP 주소 ${redactUrl(url)} — ${[m.server?.name, m.server?.version].filter(Boolean).join(' ') || '응답 확인'}`);
        else if (m.level === 'reachable') out(`  ✓ MCP 주소 ${redactUrl(url)} 가 답합니다(토큰이 있어야 도구를 씁니다)`);
        else if (m.level === 'token') out(`  ! MCP 주소 ${redactUrl(url)} 는 맞지만 토큰을 받지 않습니다(401) — 그 서버의 내 토큰인지 확인하세요`);
        else {
          mcpBad = true;
          out(`  ✗ ${redactUrl(url)} 는 MCP 주소가 아닙니다(HTTP ${m.status}) — 서버의 MCP 주소는 보통 http://서버:8787/mcp 입니다. --url 을 고쳐 다시 실행하세요`);
        }
      } catch (e) {
        out(`  ! MCP 주소 ${redactUrl(url)} 를 확인하지 못했습니다(${fetchWhy(e)})`);
      }
    }
  }

  out('');
  out('다음 단계');
  out('  1. (Team·Enterprise 조직) Owner 가 claude.ai 조직 설정 > Claude Code > Channels 를 켜야 알림이 옵니다(Pro·Max 개인은 필요 없음).');
  out('  2. 터미널에서(VS Code 패널 말고):');
  out(`        cd "${dir}"`);
  out(`        ${LAUNCH}`);
  out('     처음 한 번: 경고 화면에서 "I am using this for local development", 새 MCP 서버 확인에서 "Use this MCP server" 를 고릅니다.');
  out('  3. 웹 편집기 상단의 내 에이전트가 ● 로 바뀌면 연결된 것입니다. Claude Code 에서 /mcp 로도 확인할 수 있습니다.');
  out('  자세한 안내: docs/AGENT_SETUP.md');
  return claudeLevel === 'error' || mcpBad ? 1 : 0;
}

// node scripts/setup-agent.mjs 로 실행할 때만 main(시험은 도우미 함수만 불러 쓴다)
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`setup-agent 오류: ${e?.stack || e}`); process.exitCode = 1; });
}
