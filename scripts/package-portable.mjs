#!/usr/bin/env node
// 포터블 배포물 만들기(2026-10-30). 개발 폴더를 통째로 묶지 않고, 실행에 필요한 파일만 허용 목록으로 골라 Node 런타임과 함께 묶는다.
//   node scripts/package-portable.mjs [--target all|server-lite|worker-lite|server-win|server-linux|worker-win] [--out <폴더>]
//                                     [--node-version <x.y.z>] [--node-cache <폴더>] [--keep-staging]
//   · 서버: server·engine·web·studio/dist(샘플 제외)·vendor/rhwp/pkg·editor·운영 의존성(실제 import 닫힘만, .map·.d.ts·원본 .ts 제외)
//   · 개인 실행기: server/worker-package.js 목록 + Claude Code 채널 브리지 + 의존성 3개의 닫힘
//   · 설정(config.json)·문서(data/)·비밀 파일·시험·빌드 캐시는 넣지 않는다. 묶은 뒤 이 PC 의 실제 토큰·비밀 값이 들어갔는지 바이트로 다시 검사한다
//     (값은 메모리에서만 견주고 출력하지 않는다).
//   · Node 런타임은 nodejs.org 공식 압축본을 받아 SHASUMS256.txt 로 확인한다(기본 판 = 이 스크립트를 돌린 Node 판 — 개발 PC 에서 시험한 판).
//   · 시작 도우미·안내는 deploy/portable/ 에 있다. 결과: <out>/*.zip|*.tar.gz, SHA256SUMS.txt, release.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { WORKER_PACKAGE_FILES } from '../server/worker-package.js';
import { removeFile } from '../server/fs-safe.js';
import { findNpmCli } from '../deploy/portable/common/npm-location.mjs';
import { assertFontDistributionBundle } from './rhwp-original-font-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = new Map();
function sourceFile(relative) {
  for (const [prefix, directory] of sourceRoots) {
    if (relative === prefix || relative.startsWith(prefix + '/')) return path.join(directory, relative.slice(prefix.length));
  }
  return path.join(root, relative);
}
const templates = path.join(root, 'deploy', 'portable');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// lite = 런타임 없는 판(설치된 Node 22+ 사용, 없으면 install-node 로 공식 Node 를 받음). win·linux = Node 런타임 포함판(폐쇄망용)
// personal-lite = 개인용 앱(내 PC 폴더의 HWPX 를 여는 1인용 — deploy/portable/personal.mjs, docs/LOCAL_FOLDER_APP_2026-11-10.md): 서버 묶음과 같은 app/ 에 시작 파일만 다르다
// windows = Windows 설치 묶음 두 개(개인용·공동 작업용, 2026-11-16): 프로그램만 담고 Node·npm 모듈은 받는 PC 에서 처음 실행할 때 인터넷으로 받는다
const TARGETS = ['windows', 'server-install', 'worker-install', 'user-app', 'server-lite', 'worker-lite', 'server-win', 'server-linux', 'worker-win', 'personal-lite'];
const TARGET_ALIASES = { 'worker-node': 'worker-lite' };
// 묶거나 install-node 로 받을 Node 판. 24.11.1 은 Windows 에서 한글 경로의 fs.rmSync 가 프로세스를 죽여 24.22.2(LTS)로 올렸다(server/fs-safe.js)
const DEFAULT_NODE_VERSION = '24.22.2';
// Node 24의 최소 macOS 13.5보다 오래된 Mac(11~13.4)은 공식 Node 22 바이너리를 쓴다.
const MACOS_COMPAT_NODE_VERSION = '22.23.5';

// ── 허용 목록 ──────────────────────────────────────────────────────────────
// 서버가 실제로 import 하는 외부 패키지(server/launcher.js·index.js 부터 따라간 결과). vue 는 브라우저용 파일 하나만 내보낸다.
const SERVER_DEPENDENCIES = ['@modelcontextprotocol/sdk', '@resvg/resvg-wasm', 'diff', 'exceljs', 'express', 'ipaddr.js', 'jszip', 'standardwebhooks', 'unpdf', 'ws', 'zod'];
const WORKER_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'zod'];   // Claude API 는 SDK 없이 fetch(api-messages-agent)
// 2026-11-16 사용자 지시: 배포물에 기관 자료·개인정보를 넣지 않는다. 첫 실행 설명서(docs/manuals)·튜토리얼 연습 문서(tutorial/)·
// 체험 소개 화면(web/teaser*)은 묶지 않는다. 설명서는 manuals.seed=false 라 읽지 않고, 튜토리얼은 설치 도우미 설정에서 꺼져 있으며
// (tutorial.enabled=false) 연습 파일이 없으면 메뉴에서 빠진다. 묶은 뒤 auditPrivate 가 글·압축 문서 안·로고 해시를 다시 검사한다.
const SERVER_TREES = ['server', 'engine', 'web', 'extensions/drive-bridge', 'studio/dist'];
const SERVER_FILES = [
  // 웹 설명서(/manual.md·/manual-resources)·실행기 ZIP 이 읽는 안내
  'docs/DEPLOYMENT_AND_AI_GUIDE.md', 'docs/AGENT_SETUP.md', 'docs/MCP_EVENTS_GUIDE.md', 'docs/CHATGPT_WORK_FILES.md', 'docs/AUTOMATIC_AI_GUIDE.md', 'docs/MULTI_AGENT_ORCHESTRATION.md',
  // 표준서식 작성 지침(get_writing_guide) — 기관 이름은 묶을 때 지운다(TEXT_TRANSFORMS)
  'skill/hwpx-standard-report/reference/AI_작성지침.md', 'skill/hwpx-standard-report/reference/서식명세.md',
  'deploy/Caddyfile.example',
  'scripts/ai-debug.mjs',
  // 웹에서 내려 주는 개인 실행기 ZIP·연결 점검·임시 터널·한글 클립보드 도우미·Claude Code 채널 준비
  'scripts/ai-worker.mjs', 'scripts/orchestration-worker.mjs', 'scripts/codex-agent.mjs', 'scripts/setup-agent.mjs', 'scripts/setup-personal.mjs', 'scripts/setup-worker.mjs', 'scripts/setup-user.bat', 'scripts/setup-user.ps1', 'scripts/run-settings.mjs', 'scripts/connection-info.mjs', 'scripts/quick-tunnel.mjs', 'scripts/native-clipboard.py',
  // agent/CLAUDE.md = 새 MCP 연결(기본 — 2026-11-17)의 채널 에이전트 지침, agent/v1/CLAUDE.md = 예전 연결(setup-agent.mjs --v1)의 지침 — 없으면 --v1 로 준비할 때 지침을 쓰지 못한다
  'agent/CLAUDE.md', 'agent/v1/CLAUDE.md', 'agent/.claude/settings.json', 'agent/.claude/ai-debug-hook.mjs', 'agent/guides/figure-files.md', 'agent/guides/orchestration.md', 'agent/guides/change-requests.md',
  // 편집기 엔진(서버 차례 새로 고침 + /vendor/rhwp-core)과 편집기 연결 모듈(/vendor/rhwp-editor)
  'vendor/rhwp/pkg/rhwp.js', 'vendor/rhwp/pkg/rhwp_bg.wasm', 'vendor/rhwp/pkg/cowork-engine.json',
  'vendor/rhwp/npm/editor/index.js', 'vendor/rhwp/npm/editor/transport.js', 'vendor/rhwp/npm/editor/document-agent-contract.js', 'vendor/rhwp/npm/editor/package.json',
  'node_modules/vue/dist/vue.esm-browser.prod.js', 'node_modules/vue/LICENSE', 'node_modules/vue/package.json',
  // 관리자 MCP(server/admin-mcp.js)가 불러오는 실험 게이트웨이 — 없으면 서버가 시작하지 못한다(2026-11-10 개인용 앱 묶음을 풀어 켜 보다 발견: 11-05 에 생긴 import 가 목록에 없었다)
  'experiments/mcp-lab/gateway.mjs', 'experiments/mcp-lab/instructions.mjs', 'experiments/mcp-lab/metrics.mjs', 'experiments/mcp-lab/local-files.mjs',
  'experiments/mcp-lab/figures.mjs', 'experiments/mcp-lab/formatting.mjs',
];
// 서버 app 의 시작 파일 — 여기서부터 상대 import 를 따라가 빠진 파일이 없는지 묶기 전에 확인한다(checkRelativeImports)
const SERVER_ENTRIES = ['server/launcher.js', 'server/index.js', 'server/control-cli.js', 'server/mcp-stdio.js', 'scripts/ai-worker.mjs', 'scripts/orchestration-worker.mjs',
  'scripts/codex-agent.mjs', 'scripts/setup-agent.mjs', 'scripts/setup-personal.mjs', 'scripts/setup-worker.mjs', 'scripts/connection-info.mjs', 'scripts/quick-tunnel.mjs', 'portable/portable.mjs', 'portable/manager.mjs', 'portable/personal.mjs'];
const WORKER_FILES = [...WORKER_PACKAGE_FILES, 'server/mcp-stdio.js', 'scripts/setup-agent.mjs', 'scripts/run-settings.mjs', 'docs/AGENT_SETUP.md', 'agent/CLAUDE.md', 'agent/v1/CLAUDE.md', 'agent/.claude/settings.json',
  'agent/guides/figure-files.md', 'agent/guides/orchestration.md', 'agent/guides/change-requests.md'];
// 트리 안에서 빼는 것: 편집기 빌드의 rhwp 예제 문서·쓰지 않는 옛 사본, 파이썬 캐시
// web/quick/ = 운영 주소에 올리는 조사 보고 페이지(2026-11-12 한/글 2022 기능 대조 등) — 제품 묶음에는 넣지 않는다.
// web/tutorial-media/ = 예전 복사 튜토리얼 촬영 영상 — 2026-11-12 웹 그림 장면(web/tutorial-scenes.js)으로 바뀌어 부르지 않는다(원본은 개발 폴더에만 보관)
// web/teaser·teaser3 = 공모전 소개 화면(연습 문서 화면 포함) — 없으면 서버가 /teaser/ 를 바로 다음 주소로 넘긴다(server/index.js).
// server/run-watchdog-silent.vbs·install-watchdog.js = 개발 PC 전용 감시 도우미(이 PC 경로가 들어 있다), server/templates/README.md = 개발 메모
const TREE_EXCLUDE = [/^web\/quick\//, /^web\/tutorial-media\//, /^web\/teaser3?\//, /^server\/run-watchdog-silent\.vbs$/, /^server\/install-watchdog\.js$/, /^server\/templates\/README\.md$/,/^studio\/dist\/samples\//, /^studio\/dist\/rhwp(\.js|\.d\.ts|_bg\.wasm\.d\.ts)$/, /(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.DS_Store$/];
// 운영 의존성에서 빼는 것: 소스맵·타입 선언·TypeScript 원본·설명서(라이선스 고지는 남김), exceljs 의 브라우저 묶음(서버는 lib/)
const STRIP_FILE = /\.(map|d\.ts|d\.mts|d\.cts|ts|mts|cts|tsbuildinfo|md|markdown)$/i;
const KEEP_NOTICE = /^(licen[cs]e|notice|copying|authors|patents)/i;
const STRIP_DIRS = new Set(['__tests__', '.github', '.vscode']);
const STRIP_PACKAGE_DIRS = { exceljs: ['dist'] };
// 들어가면 안 되는 이름(어느 폴더든)
const FORBIDDEN = [/(^|\/)config\.json$/, /(^|\/)\.hwpx-cowork-secret$/, /(^|\/)\.env(\..*)?$/, /(^|\/)\.mcp\.json$/, /(^|\/)personal-ai\.json$/, /(^|\/)settings\.local\.json$/];

// ── 인자 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { targets: ['server-install', 'worker-install', 'user-app'], out: null, nodeVersion: DEFAULT_NODE_VERSION, nodeCache: path.join(os.tmpdir(), 'hwpx-cowork-node-runtime'), keepStaging: false, help: false, serverUrl: '', downloadBase: 'https://cowork.example.com/download' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${a} 뒤에 값이 필요합니다`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--target') { const t = value(); o.targets = t === 'all' ? TARGETS : t.split(',').map((x) => TARGET_ALIASES[x] || x); }
    else if (a === '--out') o.out = path.resolve(value());
    else if (a === '--studio-dir') o.studioDir = path.resolve(value());
    else if (a === '--engine-pkg') o.enginePkg = path.resolve(value());
    else if (a === '--node-version') o.nodeVersion = value().replace(/^v/, '');
    else if (a === '--node-cache') o.nodeCache = path.resolve(value());
    else if (a === '--download-base') { const url = new URL(value()); if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new Error('다운로드 주소는 인증·쿼리 없는 HTTP(S) 주소여야 합니다'); o.downloadBase = url.href.replace(/\/$/, ''); }
    else if (a === '--keep-staging') o.keepStaging = true;
    else if (a === '--server-url') { o.serverUrl = value(); if (!/^https?:\/\/[^\s"'<>]+$/.test(o.serverUrl)) throw new Error(`서버 주소 형식이 아닙니다: ${o.serverUrl}`); }
    else throw new Error(`모르는 인자: ${a}`);
  }
  for (const t of o.targets) if (!TARGETS.includes(t)) throw new Error(`target 은 all 또는 ${TARGETS.join('|')} 입니다: ${t}`);
  if (!/^\d+\.\d+\.\d+$/.test(o.nodeVersion)) throw new Error(`Node 판 형식이 아닙니다: ${o.nodeVersion}`);
  for (const [field, prefix, required] of [['studioDir', 'studio/dist', 'cowork-build.json'], ['enginePkg', 'vendor/rhwp/pkg', 'rhwp_bg.wasm']]) {
    if (!o[field]) continue;
    if (!o[field].startsWith(path.join(root, 'artifacts') + path.sep) || !fs.existsSync(path.join(o[field], required))) throw new Error(`잘못된 후보 입력: ${field}`);
    sourceRoots.set(prefix, o[field]);
  }
  return o;
}

// ── 파일 모으기 ────────────────────────────────────────────────────────────
const posix = (p) => p.split(path.sep).join('/');
const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`심볼릭 링크는 묶지 않습니다: ${posix(path.relative(root, file))}`);
    if (entry.isDirectory()) walk(file, base, out);
    else if (entry.isFile()) out.push(posix(path.relative(base, file)));
  }
  return out;
}

// 묶을 때 고쳐 넣는 글(개발 폴더의 원본은 그대로 둔다)
const dropInstitution = (b) => Buffer.from(b.toString('utf8').replaceAll('대학혁신센터 ', ''), 'utf8');
const TEXT_TRANSFORMS = { 'skill/hwpx-standard-report/reference/AI_작성지침.md': dropInstitution, 'skill/hwpx-standard-report/reference/서식명세.md': dropInstitution };
function copyInto(stage, relative, transform = TEXT_TRANSFORMS[relative]) {
  const src = sourceFile(relative);
  if (!fs.statSync(src).isFile()) throw new Error(`일반 파일이 아닙니다: ${relative}`);
  const dst = path.join(stage, relative);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (transform) fs.writeFileSync(dst, transform(fs.readFileSync(src)));
  else fs.copyFileSync(src, dst);
}

function copyTrees(stage, trees, files) {
  for (const tree of trees) {
    for (const rel of walk(sourceFile(tree))) {
      const relative = `${tree}/${rel}`;
      if (!relative.startsWith('web/reports/hft-native-20261106/') && !TREE_EXCLUDE.some((re) => re.test(relative))) copyInto(stage, relative);
    }
  }
  for (const relative of files) copyInto(stage, relative);
}

/** 루트 node_modules 에서 Node 해석 규칙대로 운영 의존성 닫힘을 찾는다 → 맨 위 패키지 폴더(node_modules/<이름>) 목록 */
function dependencyClosure(names) {
  const nm = path.join(root, 'node_modules');
  const tops = new Set();
  const seen = new Set();
  const resolve = (name, fromDir) => {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      if (path.basename(dir) === 'node_modules') continue;
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.resolve(dir) === root) return null;
    }
  };
  const visit = (name, fromDir, optional) => {
    const dir = resolve(name, fromDir);
    if (!dir) { if (optional) return; throw new Error(`운영 의존성을 찾지 못했습니다: ${name} (${posix(path.relative(root, fromDir))})`); }
    if (seen.has(dir)) return;
    seen.add(dir);
    const parts = posix(path.relative(nm, dir)).split('/');
    tops.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies || {})) visit(dep, dir, false);
    for (const dep of Object.keys(manifest.optionalDependencies || {})) visit(dep, dir, true);
    for (const dep of Object.keys(manifest.peerDependencies || {})) visit(dep, dir, true);
  };
  for (const name of names) visit(name, root, false);
  return [...tops].sort();
}

function copyDependencies(stage, names) {
  const tops = dependencyClosure(names);
  let stripped = 0;
  for (const top of tops) {
    const pruneDirs = (STRIP_PACKAGE_DIRS[top] || []).map((d) => path.join(root, 'node_modules', top, d));
    fs.cpSync(path.join(root, 'node_modules', top), path.join(stage, 'node_modules', top), {
      recursive: true,
      filter(src) {
        const name = path.basename(src);
        const stat = fs.statSync(src);
        if (stat.isDirectory()) return !STRIP_DIRS.has(name) && !pruneDirs.includes(src);
        if (STRIP_FILE.test(name) && !KEEP_NOTICE.test(name)) { stripped += stat.size; return false; }
        return true;
      },
    });
  }
  return { packages: tops.length, stripped };
}

/** 묶은 node_modules 의 패키지 이름·판·라이선스 목록(고지) */
function nodeModuleNotices(stage) {
  const rows = [];
  const nm = path.join(stage, 'node_modules');
  for (const rel of walk(nm)) {
    if (!rel.endsWith('/package.json')) continue;
    const dir = rel.slice(0, -'/package.json'.length);
    const parts = dir.split('/');
    const n = parts.length;
    // 패키지 맨 위 폴더만: <이름>, @범위/<이름>, …/node_modules/<이름>, …/node_modules/@범위/<이름> (패키지 안의 하위 package.json 은 건너뜀)
    const top = n === 1 || (n === 2 && parts[0].startsWith('@'));
    const nested = (n >= 2 && parts[n - 2] === 'node_modules') || (n >= 3 && parts[n - 3] === 'node_modules' && parts[n - 2].startsWith('@'));
    if (!top && !nested) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(nm, rel), 'utf8'));
      if (!m.name || !m.version) continue;
      const license = typeof m.license === 'string' ? m.license : (m.license?.type || (Array.isArray(m.licenses) ? m.licenses.map((l) => l.type || l).join(' OR ') : 'UNKNOWN'));
      rows.push(`${m.name}@${m.version}\t${license}\tnode_modules/${dir}`);
    } catch { /* 패키지 메타가 아닌 JSON */ }
  }
  return [...new Set(rows)].sort();
}

/** 묶은 코드가 쓰는 외부 모듈 지정자(예: '@modelcontextprotocol/sdk/server/mcp.js')가 묶은 폴더에서 실제로 불러와지는지 확인 */
function checkImports(stage, names) {
  const specifiers = new Set();
  const re = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"./][^'"]*)['"]|import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
  for (const dir of ['server', 'engine', 'scripts', 'portable']) {
    if (!fs.existsSync(path.join(stage, dir))) continue;
    for (const rel of walk(path.join(stage, dir))) {
      if (!/\.m?js$/.test(rel)) continue;
      for (const m of fs.readFileSync(path.join(stage, dir, rel), 'utf8').matchAll(re)) {
        const spec = m[1] || m[2];
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (names.includes(name)) specifiers.add(spec);
      }
    }
  }
  for (const name of names) if (![...specifiers].some((s) => s === name || s.startsWith(`${name}/`))) throw new Error(`묶은 코드에서 ${name} 을 쓰는 곳을 찾지 못했습니다(목록 점검 필요)`);
  const probe = path.join(stage, `.import-check-${process.pid}.mjs`);
  fs.writeFileSync(probe, `for (const n of ${JSON.stringify([...specifiers].sort())}) await import(n);\nconsole.log('ok');\n`);
  try {
    const r = spawnSync(process.execPath, [probe], { cwd: stage, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !r.stdout.includes('ok')) throw new Error(`묶은 의존성을 불러오지 못했습니다:\n${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  } finally { removeFile(probe); }
}

/**
 * 묶은 코드의 상대 import(정적 · 문자열 동적 import)를 시작 파일부터 따라가, 묶음에 없는 파일을 가리키면 멈춘다.
 * 허용 목록으로 골라 담다 보니 새로 생긴 import 가 빠져도 묶기는 성공하고 풀어서 켤 때에야 ERR_MODULE_NOT_FOUND 로 드러났다.
 */
function checkRelativeImports(stage, entries) {
  const re = /(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const seen = new Set(); const missing = [];
  const visit = (rel, from) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const file = path.join(stage, rel);
    if (!fs.existsSync(file)) { missing.push(`${rel} (← ${from})`); return; }
    if (!/\.m?js$/.test(rel)) return;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1] || m[2]));
      if (!next.startsWith('..')) visit(next, rel);
    }
  };
  for (const entry of entries) visit(entry, '시작 파일');
  if (missing.length) throw new Error(`묶은 코드가 묶음에 없는 파일을 불러옵니다(허용 목록에 더하세요):\n  ${missing.join('\n  ')}`);
  return seen.size;
}

// ── 비밀 검사 ──────────────────────────────────────────────────────────────
/** 이 PC 의 실제 토큰·비밀 값(설정 파일·비밀 파일·환경 변수). 예제 토큰(change-me)은 뺀다.
 *  12자 이상은 모든 파일의 바이트로, 짧은 값(4~11자)은 우연히 겹치기 쉬워 글 파일에서 낱말 단위로만 찾는다 */
function localSecrets() {
  const found = new Set();
  // test1~test100 are intentionally published demo credentials, not private keys.
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 4 && !/^change-me/.test(v.trim()) && !/^test(?:[1-9]|[1-9]\d|100)$/.test(v.trim())) found.add(v.trim()); };
  const collect = (value, key = '') => {
    if (Array.isArray(value)) value.forEach((v) => collect(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
    else if (/token|secret|password|apikey|api_key|clientsecret/i.test(key)) add(value);
  };
  try { collect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^﻿/, ''))); } catch { /* 없거나 못 읽음 */ }
  try { add(fs.readFileSync(path.join(root, '.hwpx-cowork-secret'), 'utf8')); } catch { /* 없음 */ }
  for (const name of ['HWPX_COWORK_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BAZE_API_KEY']) add(process.env[name]);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    long: [...found].filter((s) => s.length >= 12).map((s) => Buffer.from(s, 'utf8')),
    short: [...found].filter((s) => s.length < 12).map((s) => new RegExp(`(^|[^A-Za-z0-9_-])${escape(s)}($|[^A-Za-z0-9_-])`)),
    count: found.size,
  };
}

const TEXT_FILE = /\.(m?js|cjs|json|md|txt|html|css|bat|cmd|sh|py|service|example|ya?ml)$/i;
function auditEntries(entries, secrets) {
  for (const e of entries) {
    if (FORBIDDEN.some((re) => re.test(e.path))) throw new Error(`배포물에 들어가면 안 되는 파일: ${e.path}`);
    const bytes = e.data || fs.readFileSync(e.src);
    for (const secret of secrets.long) if (bytes.includes(secret)) throw new Error(`배포물에 이 PC 의 토큰·비밀 값이 들어 있습니다: ${e.path} (값은 출력하지 않음)`);
    // 짧은 값은 우리 코드·안내·설정 파일에서만(의존성 코드는 우연히 겹친다)
    if (secrets.short.length && TEXT_FILE.test(e.path) && !e.path.includes('node_modules/')) {
      // The requested public release origin can coincide with a legacy short token.
      // Exempt that exact URL only; a standalone private token still fails this audit.
      const text = bytes.toString('utf8').replace(/https?:\/\/cowork\.example\.com(?=[:/?#\s"'<]|$)/g, 'PUBLIC_DEMO_ORIGIN');
      for (const re of secrets.short) if (re.test(text)) throw new Error(`배포물에 이 PC 의 짧은 토큰과 같은 낱말이 있습니다: ${e.path} (값은 출력하지 않음 — 우연이면 토큰을 길게 바꾸세요)`);
    }
  }
}

// ── 기관·개인 흔적 검사(2026-11-16) ─────────────────────────────────────────
// 글 파일과 압축 문서(HWPX·XLSX·DOCX·.skill·ZIP) 안의 글, 그림의 기관 로고 해시를 본다. 의존성(node_modules)·편집기 빌드 산출물은
// 남의 코드라 우연히 겹치는 낱말이 많아 글 검사에서 뺀다(그래도 로고 해시·압축 문서는 본다). 짧은 영문 약자는 대소문자를 가려야
// XML 속성(hasNumRef 등)과 겹치지 않는다.
const PRIVATE_TERMS = [
  ['기관 이름', /대학혁신센터/],
  ['기관 구독 이름', /ChatGPT\s*\(?Edu\)?/],
  // (공개 저장소: 원 개발 PC 의 개인 이름·계정 목록은 뺐습니다 — 배포 전에 자기 이름·계정을 여기에 더하세요)
  ['개발 PC 경로', /[A-Za-z]:[\\/]+Users[\\/]+Nag(?![A-Za-z])|[Dd]:[\\/]+claude[\\/]/],
];
const PRIVATE_LOGOS = new Set(['2a2d146d0f5d9d7dc4e3edf23a78a6479c5ae120d4aa95b2057520bd3aaa8424', 'c170f8e50309621f2195c71dc16e7deea2d9ad2cdff23f5b254ea9a162a1ccea']);
const ARCHIVE_DOC = /\.(hwpx|xlsx|docx|pptx|skill|zip)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PRIVATE_TEXT_SKIP = /(^|\/)node_modules\/|(^|\/)studio\/dist\/assets\/|(^|\/)vendor\/rhwp\/pkg\//;
async function auditPrivateBytes(where, bytes, depth = 0) {
  if (IMAGE_FILE.test(where)) {
    if (PRIVATE_LOGOS.has(crypto.createHash('sha256').update(bytes).digest('hex'))) throw new Error(`배포물에 기관 로고가 들어 있습니다: ${where}`);
    return;
  }
  if (ARCHIVE_DOC.test(where) && depth < 3) {
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(zip.files)) if (!entry.dir) await auditPrivateBytes(`${where}!${entry.name}`, await entry.async('nodebuffer'), depth + 1);
    return;
  }
  if (!(TEXT_FILE.test(where) || /\.(xml|hpf|vbs|ps1|svg|csv)$/i.test(where)) || (depth === 0 && PRIVATE_TEXT_SKIP.test(where))) return;
  const text = bytes.toString('utf8');
  for (const [label, re] of PRIVATE_TERMS) if (re.test(text)) throw new Error(`배포물에 ${label} 흔적이 있습니다: ${where} (${re.exec(text)[0]})`);
}
async function auditPrivate(entries) {
  for (const e of entries) await auditPrivateBytes(e.path, e.data || fs.readFileSync(e.src));
}

// ── Node 런타임 ────────────────────────────────────────────────────────────
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`내려받기 실패 ${res.status}: ${url}`);
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
}

async function nodeArchive(version, kind, cacheDir) {
  const name = kind === 'win' ? `node-v${version}-win-x64.zip` : `node-v${version}-linux-x64.tar.gz`;
  const base = `https://nodejs.org/dist/v${version}/`;
  fs.mkdirSync(cacheDir, { recursive: true });
  const sums = path.join(cacheDir, `SHASUMS256-v${version}.txt`);
  if (!fs.existsSync(sums)) await download(`${base}SHASUMS256.txt`, sums);
  const expected = fs.readFileSync(sums, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt 에 ${name} 이 없습니다`);
  const file = path.join(cacheDir, name);
  if (!fs.existsSync(file)) { console.log(`  Node 런타임 내려받기: ${base}${name}`); await download(`${base}${name}`, file); }
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) { removeFile(file); throw new Error(`${name} 의 SHA-256 이 공식 값과 다릅니다(캐시를 지웠습니다 — 다시 실행)`); }
  return bytes;
}

function* tarEntries(buf) {
  let offset = 0; let longName = null; let paxPath = null;
  const text = (h, a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
  while (offset + 512 <= buf.length) {
    const h = buf.subarray(offset, offset + 512);
    if (h[0] === 0 && h.subarray(0, 512).every((b) => b === 0)) break;
    const prefix = text(h, 345, 500);
    const name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100);
    const size = parseInt(text(h, 124, 136).trim() || '0', 8);
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const data = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'x') { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] || null; continue; }
    if (type === 'g') continue;
    yield { name: paxPath || longName || name, type, data };
    longName = null; paxPath = null;
  }
}

/** → [{ path, data, mode }] (runtime/ 아래에 놓을 파일) */
async function nodeRuntime(version, kind, cacheDir) {
  const archive = await nodeArchive(version, kind, cacheDir);
  const top = kind === 'win' ? `node-v${version}-win-x64/` : `node-v${version}-linux-x64/`;
  const want = kind === 'win' ? { 'node.exe': 'node.exe', LICENSE: 'LICENSE' } : { 'bin/node': 'bin/node', LICENSE: 'LICENSE' };
  const out = [];
  if (kind === 'win') {
    const zip = await JSZip.loadAsync(archive);
    for (const [inner, target] of Object.entries(want)) {
      const entry = zip.file(top + inner);
      if (!entry) throw new Error(`Node 압축본에 ${inner} 가 없습니다`);
      out.push({ path: `runtime/${target}`, data: await entry.async('nodebuffer'), mode: 0o755 });
    }
  } else {
    for (const e of tarEntries(zlib.gunzipSync(archive))) {
      const inner = e.name.startsWith(top) ? e.name.slice(top.length) : null;
      if (inner && want[inner] && e.type === '0') out.push({ path: `runtime/${want[inner]}`, data: Buffer.from(e.data), mode: inner === 'bin/node' ? 0o755 : 0o644 });
    }
    if (out.length !== 2) throw new Error('Node 압축본에서 bin/node·LICENSE 를 찾지 못했습니다');
  }
  return out;
}

// ── 묶기 ──────────────────────────────────────────────────────────────────
const isExecutable = (p) => /\.sh$/.test(p) || p.endsWith('runtime/bin/node');
const crlf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
const lf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');

/** 폴더 → 묶음 항목 */
function dirEntries(dir, prefix) {
  return walk(dir).map((rel) => ({ path: `${prefix}${rel}`, src: path.join(dir, rel) }));
}
/** deploy/portable 의 시작 도우미·안내 → 묶음 항목. 배치·안내는 CRLF, 셸은 LF·실행 권한,
 *  .ps1 은 CRLF + UTF-8 BOM(Windows PowerShell 5.1 은 BOM 없는 파일을 ANSI 로 읽어 한글이 깨진다). __NODE_VERSION__ 은 묶는 Node 판으로 */
function templateEntry(relative, target, nodeVersion) {
  const bytes = Buffer.from(fs.readFileSync(path.join(templates, relative), 'utf8')
    .replaceAll('__NODE_VERSION__', nodeVersion).replaceAll('__MACOS_COMPAT_NODE_VERSION__', MACOS_COMPAT_NODE_VERSION), 'utf8');
  if (/\.ps1$/i.test(relative)) return { path: target, data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), crlf(bytes)]) };
  return { path: target, data: /\.(bat|cmd|txt)$/i.test(relative) ? crlf(bytes) : lf(bytes) };
}

async function writeZip(entries, file, top, unix) {
  const zip = new JSZip();
  const date = new Date();
  for (const e of entries) {
    zip.file(`${top}/${e.path}`, e.data || fs.readFileSync(e.src), { date, createFolders: true, ...(unix ? { unixPermissions: isExecutable(e.path) || e.mode === 0o755 ? 0o100755 : 0o100644 } : {}) });
  }
  const out = fs.createWriteStream(file);
  zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: unix ? 'UNIX' : 'DOS' }).pipe(out);
  await finished(out);
}

function tarHeader(name, size, mode, type) {
  const h = Buffer.alloc(512);
  const put = (value, offset, length) => h.write(value, offset, length, 'utf8');
  const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function paxRecord(key, value) {
  // 레코드 길이는 자기 자릿수까지 포함한 바이트 수
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let length = n + 1;
  while (String(length).length + n !== length) length = String(length).length + n;
  return Buffer.from(`${length}${body}`, 'utf8');
}

async function writeTarGz(entries, file, top) {
  const gzip = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(file);
  gzip.pipe(out);
  const write = async (buf) => { if (!gzip.write(buf)) await once(gzip, 'drain'); };
  const pad = async (size) => { if (size % 512) await write(Buffer.alloc(512 - (size % 512))); };
  const dirs = new Set();
  const writeEntry = async (name, data, mode, type) => {
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord('path', name);
      await write(tarHeader(`PaxHeaders/${crypto.createHash('sha1').update(name).digest('hex')}`, pax.length, 0o644, 'x'));
      await write(pax); await pad(pax.length);
    }
    await write(tarHeader(Buffer.byteLength(name) > 100 ? Buffer.from(name).subarray(0, 100).toString('utf8').replace(/�+$/, '') : name, data.length, mode, type));
    if (data.length) { await write(data); await pad(data.length); }
  };
  for (const e of entries) {
    const full = `${top}/${e.path}`;
    const parts = full.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(dir)) { dirs.add(dir); await writeEntry(dir, Buffer.alloc(0), 0o755, '5'); }
    }
    const data = e.data || fs.readFileSync(e.src);
    await writeEntry(full, data, isExecutable(e.path) || e.mode === 0o755 ? 0o755 : 0o644, '0');
  }
  await write(Buffer.alloc(1024));
  gzip.end();
  await finished(out);
}

// ── 대상별 구성 ────────────────────────────────────────────────────────────
function appManifest(name, description, dependencies, scripts) {
  const deps = {};
  for (const dep of dependencies) {
    const version = rootPackage.dependencies?.[dep];
    if (!version) throw new Error(`package.json 에 ${dep} 판이 없습니다`);
    deps[dep] = version;
  }
  return `${JSON.stringify({ name, version: rootPackage.version, private: true, type: 'module', description, engines: { node: '>=22' }, scripts, dependencies: deps }, null, 2)}\n`;
}

function buildInfo(kind, nodeVersion) {
  const read = (rel) => { try { return JSON.parse(fs.readFileSync(sourceFile(rel), 'utf8')); } catch { return null; } };
  const engine = read('vendor/rhwp/pkg/cowork-engine.json');
  const studio = read('studio/dist/cowork-build.json');
  return `${JSON.stringify({
    package: kind, version: rootPackage.version, builtAt: new Date().toISOString(), node: nodeVersion,
    engine: engine && { builtAt: engine.builtAt, profile: engine.profile, base: engine.base },
    studio: studio && { builtAt: studio.builtAt, upstream: studio.upstream },
  }, null, 2)}\n`;
}

/** 서버 app/ 폴더를 staging 에 만든다 → 통계 */
function stageServerApp(stage, install = false) {
  copyTrees(stage, SERVER_TREES, install ? SERVER_FILES.filter((f) => !f.startsWith('node_modules/')) : SERVER_FILES);
  const deps = install ? { packages: 0, stripped: 0 } : copyDependencies(stage, SERVER_DEPENDENCIES);
  fs.writeFileSync(path.join(stage, 'package.json'), appManifest('hwpx-cowork', 'HWPX 공동 검토·편집 서버(포터블)', [...SERVER_DEPENDENCIES, 'vue'], {
    start: 'node server/launcher.js', setup: 'node scripts/setup-personal.mjs', 'setup:personal': 'node scripts/setup-personal.mjs', worker: 'node scripts/ai-worker.mjs', orchestrator: 'node scripts/orchestration-worker.mjs',
    connections: 'node scripts/connection-info.mjs', tunnel: 'node scripts/quick-tunnel.mjs', 'mcp-stdio': 'node server/mcp-stdio.js',
  }));
  // 직접 실행해도(포터블 도우미 없이) 예제 토큰·모든 주소 듣기로 켜지지 않는 안전한 예제
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const ai = { ...example.ai, enabled: false, mock: false };
  delete ai.keyFile;
  // 설명서는 튜토리얼 메뉴에서 시작하며 문서함에 미리 배포하지 않는다.
  const safe = { ...example, host: '127.0.0.1', ai, users: [], manuals: { seed: false } };
  delete safe.studioUrl;   // 포터블은 늘 자체 편집기(/studio/) — 원격 편집기 주소 안내가 시작 로그에 섞이지 않게
  fs.writeFileSync(path.join(stage, 'config.example.json'), `${JSON.stringify(safe, null, 2)}\n`);
  fs.mkdirSync(path.join(stage, 'portable'), { recursive: true });
  // 첫 실행 준비(portable.mjs)·관리자 앱(manager.mjs·manager.html)·공통(portable-lib.mjs)
  // + 개인용 앱(personal.mjs — 이 PC 만, PC 폴더 연결)
  for (const name of ['portable-lib.mjs', 'portable.mjs', 'manager.mjs', 'manager.html', 'personal.mjs']) fs.copyFileSync(path.join(templates, name), path.join(stage, 'portable', name));
  checkRelativeImports(stage, SERVER_ENTRIES);
  if (install) stageInstallDependencies(stage); else checkImports(stage, SERVER_DEPENDENCIES);
  return deps;
}

function stageWorkerApp(stage, install = false) {
  for (const relative of WORKER_FILES) copyInto(stage, relative);
  const deps = install ? { packages: 0, stripped: 0 } : copyDependencies(stage, WORKER_DEPENDENCIES);
  fs.writeFileSync(path.join(stage, 'package.json'), appManifest('hwpx-ai-worker', '중앙 HWPX 서버의 내 검토 요청을 ChatGPT 로그인·개인 API 로 자동 처리하는 실행기(포터블)', WORKER_DEPENDENCIES, {
    worker: 'node scripts/ai-worker.mjs', orchestrator: 'node scripts/orchestration-worker.mjs', 'agent:codex': 'node scripts/codex-agent.mjs', 'setup-agent': 'node scripts/setup-agent.mjs',
  }));
  if (install) stageInstallDependencies(stage); else checkImports(stage, WORKER_DEPENDENCIES);
  return deps;
}

// 설치형은 npm 모듈을 넣지 않고 같은 판을 재현하는 잠금 파일만 포함한다.
function stageInstallDependencies(stage) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  lock.name = manifest.name; lock.version = manifest.version;
  lock.packages[''] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, engines: manifest.engines };
  fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const npmCli = findNpmCli();
  if (!npmCli) throw new Error('설치형 잠금 파일 생성에는 npm이 필요합니다');
  const r = spawnSync(process.execPath, [npmCli, 'install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`설치형 잠금 파일 생성 실패: ${(r.stderr || r.stdout || '').slice(0, 1000)}`);
  fs.mkdirSync(path.join(stage, 'portable'), { recursive: true });
  for (const name of ['install-dependencies.mjs', 'npm-location.mjs']) fs.copyFileSync(path.join(templates, 'common', name), path.join(stage, 'portable', name));
  if (fs.existsSync(path.join(stage, 'node_modules'))) throw new Error('설치형에 node_modules가 포함되었습니다');
}

function noticeEntries(stage, extra = []) {
  const list = nodeModuleNotices(stage);
  const header = 'hwpx-cowork 포터블 배포물에 포함된 Node 패키지(이름@판, 라이선스, 위치). 각 패키지 폴더에 원래 라이선스 파일이 들어 있습니다.\n\n';
  return [{ path: 'NOTICES/node_modules.txt', data: Buffer.from(header + list.join('\n') + '\n', 'utf8') }, ...extra];
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(`사용법: node scripts/package-portable.mjs [--target all|${TARGETS.join(',')}] [--out <폴더>] [--node-version x.y.z] [--node-cache <폴더>] [--keep-staging]`);
    console.log('  기본: server-install·worker-install·user-app. 설치형은 Node·npm 모듈을 제외하고 실제 PC에서 install-dependencies.bat/sh로 설치합니다.');
    console.log('  server-lite: 서버(ZIP·tar.gz, 런타임 없음 — 설치된 Node 22+ 를 쓰고, 없으면 처음 켤 때 공식 Node 를 받음) — 기본 권장');
    console.log('  worker-lite: 개인 AI 실행기(ZIP, 런타임 없음, 같은 방식)  (옛 이름 worker-node 도 됨)');
    console.log('  personal-lite: 개인용 앱(ZIP, 런타임 없음) — 내 PC 폴더의 HWPX 를 여는 1인용. personal-app.bat 로 켠다');
    console.log('  server-win·server-linux·worker-win: Node 런타임 포함판 — 인터넷이 막힌 PC·폐쇄망용');
    return;
  }
  const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
  const outDir = o.out || path.join(root, 'artifacts', `release-${stamp}`);
  const staging = path.join(outDir, '.staging');
  await fs.promises.rm(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const secrets = localSecrets();
  const results = [];
  const version = rootPackage.version;
  const wantServer = o.targets.some((t) => (t.startsWith('server-') && t !== 'server-install') || t === 'personal-lite');
  const wantWorker = o.targets.some((t) => t.startsWith('worker-') && t !== 'worker-install');

  let serverApp = null; let workerApp = null;
  let serverInstall = null; let workerInstall = null;
  if (o.targets.includes('server-install') || o.targets.includes('windows')) { const stage = path.join(staging, 'server-install'); stageServerApp(stage, true); serverInstall = { stage }; }
  if (o.targets.includes('worker-install')) { const stage = path.join(staging, 'worker-install'); stageWorkerApp(stage, true); workerInstall = { stage }; }
  if (wantServer) {
    const stage = path.join(staging, 'server-app');
    const deps = stageServerApp(stage);
    serverApp = { stage, deps };
    console.log(`서버 app 준비: 의존성 ${deps.packages}개(소스맵·타입 등 ${mib(deps.stripped)} 제외)`);
  }
  if (wantWorker) {
    const stage = path.join(staging, 'worker-app');
    const deps = stageWorkerApp(stage);
    workerApp = { stage, deps };
    console.log(`실행기 app 준비: 의존성 ${deps.packages}개(소스맵·타입 등 ${mib(deps.stripped)} 제외)`);
  }
  const rhwpNotices = [
    { path: 'NOTICES/rhwp-LICENSE.txt', src: path.join(root, 'vendor/rhwp/LICENSE') },
    { path: 'NOTICES/rhwp-THIRD_PARTY_LICENSES.md', src: path.join(root, 'vendor/rhwp/THIRD_PARTY_LICENSES.md') },
    { path: 'NOTICES/FONTS.md', src: path.join(root, 'studio/dist/fonts/FONTS.md') },
  ];

  // 설치된 Node(22 이상)를 먼저 쓰고, 없으면 공식 Node 를 runtime/ 에 받는 도우미 — 모든 묶음에 같이 넣는다
  const t = (relative, target) => templateEntry(relative, target, o.nodeVersion);
  const nodeHelpers = [
    t('common/find-node.cmd', 'app/portable/find-node.cmd'), t('common/ensure-node.cmd', 'app/portable/ensure-node.cmd'), t('common/install-node.ps1', 'app/portable/install-node.ps1'),
    t('common/find-node.sh', 'app/portable/find-node.sh'), t('common/install-node.bat', 'install-node.bat'), t('common/install-node.sh', 'install-node.sh'),
  ];
  // 참여자용 사용자 앱(설치 없는 앱 창 바로 가기) — 서버 묶음에는 관리자 앱이 주소를 채워 내려 주도록 원본을, user-app 대상은 따로 묶는다
  const userAppFiles = fs.readdirSync(path.join(templates, 'user-app'));
  const userAppInServer = userAppFiles.map((name) => t(`user-app/${name}`, `app/portable/user-app/${name}`));
  const serverWin = [
    t('server-win/admin-app.bat', 'admin-app.bat'), t('server-win/user-app.bat', 'user-app.bat'), t('server-win/start-server.bat', 'start-server.bat'),
    t('server-win/stop-server.bat', 'stop-server.bat'), t('server-win/README.txt', 'README.txt'), ...userAppInServer,
  ];
  const serverLinux = [t('server-linux/start-server.sh', 'start-server.sh'), t('server-linux/README.md', 'README.md'), t('server-linux/hwpx-cowork.service', 'deploy/hwpx-cowork.service'), { path: 'deploy/Caddyfile.example', src: path.join(root, 'deploy/Caddyfile.example') }];
  const workerLaunch = [
    t('worker/README.txt', 'README.txt'), t('worker/start-worker.bat', 'start-worker.bat'), t('worker/check-worker.bat', 'check-worker.bat'),
    t('worker/start-claude-agent.bat', 'start-claude-agent.bat'), t('worker/worker-settings.txt', 'worker-settings.txt'), t('worker/start-worker.sh', 'start-worker.sh'),
  ];
  if (o.serverUrl) {
    const settings = workerLaunch.find((e) => e.path === 'worker-settings.txt');
    const base = o.serverUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
    settings.data = Buffer.from(settings.data.toString('utf8').replace(/^HWPX_COWORK_URL=.*$/m, `HWPX_COWORK_URL=${base}/mcp\r`), 'utf8');
  }
  const builds = [];   // { target, entries, file, top, format, unix }
  for (const target of o.targets) {
    if (target === 'server-install' || target === 'worker-install') {
      const server = target === 'server-install';
      const staged = server ? serverInstall : workerInstall;
      const entries = [...(server ? [...serverWin, ...serverLinux] : workerLaunch).map((e) => ({ ...e })), ...nodeHelpers,
        t('common/install-dependencies.bat', 'install-dependencies.bat'), t('common/install-dependencies.sh', 'install-dependencies.sh'),
        t('common/install.bat', 'install.bat'), t('common/install.sh', 'install.sh'),
        ...dirEntries(staged.stage, 'app/'), ...(server ? rhwpNotices : []),
        t('common/INSTALL.txt', 'INSTALL.txt'), { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(target, `system >=22 또는 install-node(${o.nodeVersion}); npm ci 필요`)) }];
      const installReadme = entries.find((e) => e.path === 'INSTALL.txt').data;
      const readme = entries.find((e) => e.path === 'README.txt');
      const usage = readme.data.toString('utf8').replace('npm·Rust·한글 프로그램을 설치하지 않아도 됩니다.', 'Rust·한글 프로그램은 필요 없습니다. Node와 npm 모듈은 설치 도우미가 준비합니다.');
      readme.data = Buffer.concat([installReadme, Buffer.from('\r\n--- 아래는 설치 후 사용 안내입니다 ---\r\n' + usage)]);
      if (server) {
        const linux = entries.find((e) => e.path === 'README.md');
        linux.data = Buffer.from(linux.data.toString('utf8')
          .replace('npm 설치·빌드가 필요 없습니다.', '편집기 빌드는 필요 없습니다. 이 설치형의 npm 모듈은 `sh install.sh`로 설치합니다.')
          .replace('tar -xzf hwpx-cowork-server-*-lite.tar.gz           # 또는 *-linux-x64.tar.gz → hwpx-cowork-server/', 'unzip hwpx-cowork-server-*-install.zip')
          .replace('./install-node.sh                                   # Node 22+ 가 없을 때만(curl 또는 wget 필요)', 'sh install.sh                                      # Node와 npm 모듈 설치(인터넷 필요)')
          .replace('sudo tar -xzf hwpx-cowork-server-*-lite.tar.gz -C /opt', 'sudo unzip hwpx-cowork-server-*-install.zip -d /opt')
          .replace('sudo /opt/hwpx-cowork-server/install-node.sh                         # Node 22+ 가 없을 때만', 'sudo sh /opt/hwpx-cowork-server/install.sh                           # Node와 npm 모듈 설치')
          .replace('새 tar 를 풀어', '새 ZIP을 풀어'));
      }
      builds.push({ target, entries, top: server ? 'hwpx-cowork-server' : 'hwpx-ai-worker', format: 'zip', unix: true, file: `${server ? 'hwpx-cowork-server' : 'hwpx-ai-worker'}-${version}-${stamp}-install.zip` });
    } else if (target === 'server-win' || target === 'server-linux') {
      const win = target === 'server-win';
      const runtime = await nodeRuntime(o.nodeVersion, win ? 'win' : 'linux', o.nodeCache);
      const entries = [...(win ? serverWin : serverLinux), ...nodeHelpers, ...runtime, ...dirEntries(serverApp.stage, 'app/'), ...noticeEntries(serverApp.stage, rhwpNotices), { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(target, o.nodeVersion)) }];
      builds.push({ target, entries, top: 'hwpx-cowork-server', format: win ? 'zip' : 'tar.gz', unix: false, file: `hwpx-cowork-server-${version}-${stamp}-${win ? 'win-x64.zip' : 'linux-x64.tar.gz'}` });
    } else if (target === 'windows') {
      // 개인용(이 PC 만, PC 폴더의 파일을 바로 고침)·공동 작업용(이 PC 를 서버로, 참여자는 브라우저) — 같은 app/ 에 방식과 안내만 다르다
      const bat = (action, tail) => ({ data: Buffer.from(['@echo off', 'chcp 65001 >nul', `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\\portable\\hwpx-windows.ps1" -Action ${action}`, tail, ''].join('\r\n'), 'utf8') });
      const bom = (buf) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), crlf(buf)]);
      for (const mode of ['personal', 'shared']) {
        const guide = fs.readFileSync(path.join(templates, 'windows', `guide-${mode}.txt`));
        const entries = [
          { path: '시작.bat', ...bat('Start', 'if errorlevel 1 pause') },
          { path: '종료.bat', ...bat('Stop', 'if errorlevel 1 pause') },
          { path: 'AI 연결.bat', ...bat('Ai', 'pause') },
          ...(mode === 'shared' ? [{ path: '외부 접속 열기.bat', ...bat('Share', 'pause') }] : []),
          { path: '설치 안내.txt', data: bom(guide) },
          { path: 'install-options.json', data: Buffer.from(`${JSON.stringify({ schema: 1, mode }, null, 2)}\n`) },
          t('windows/hwpx-windows.ps1', 'app/portable/hwpx-windows.ps1'), t('common/install-node.ps1', 'app/portable/install-node.ps1'),
          ...dirEntries(serverInstall.stage, 'app/'), ...rhwpNotices,
          { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(`windows-${mode}`, `${o.nodeVersion}(처음 실행할 때 nodejs.org 에서 받음); npm ci`)) },
        ];
        builds.push({ target: `windows-${mode}`, mode, entries, top: `hwpx-cowork-${mode}`, format: 'zip', unix: false, file: `hwpx-cowork-windows-${mode}-${version}-${stamp}.zip` });
      }
    } else if (target === 'user-app') {
      // Node·서버 없음. 서버 주소는 --server-url 로 미리 채우거나, 서버의 관리자 앱이 채워 내려 준다
      const entries = userAppFiles.map((name) => {
        const e = t(`user-app/${name}`, name);
        return name === 'server-url.txt' ? { ...e, data: Buffer.from(e.data.toString('utf8').replace('__SERVER_URL__', o.serverUrl), 'utf8') } : e;
      });
      entries.push({ path: 'hwpx-cowork.ico', src: path.join(root, 'web/favicon.ico') });
      builds.push({ target, entries, top: 'hwpx-cowork-user-app', format: 'zip', unix: false, file: `hwpx-cowork-user-app-${version}-${stamp}.zip` });
    } else if (target === 'server-lite') {
      // 런타임 없는 한 묶음(Windows·Linux·macOS 공용) — 설치된 Node 를 쓰거나 처음 켤 때 받는다. Linux 는 unzip 이 없을 수 있어 tar.gz 도 만든다
      const entries = [...serverWin, ...serverLinux, ...nodeHelpers, ...dirEntries(serverApp.stage, 'app/'), ...noticeEntries(serverApp.stage, rhwpNotices), { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(target, `system >=22 또는 install-node(${o.nodeVersion})`)) }];
      builds.push({ target, entries, top: 'hwpx-cowork-server', format: 'zip', unix: true, file: `hwpx-cowork-server-${version}-${stamp}-lite.zip` });
      builds.push({ target, entries, top: 'hwpx-cowork-server', format: 'tar.gz', unix: true, file: `hwpx-cowork-server-${version}-${stamp}-lite.tar.gz` });
    } else if (target === 'personal-lite') {
      // 개인용 앱: 서버 묶음과 같은 app/(편집기·엔진·의존성) + 개인용 시작 파일. 런타임 없음(설치된 Node 를 쓰거나 처음 켤 때 받는다)
      const entries = [t('personal/personal-app.bat', 'personal-app.bat'), t('personal/personal-app.sh', 'personal-app.sh'), t('personal/README.txt', 'README.txt'),
        ...nodeHelpers, ...dirEntries(serverApp.stage, 'app/'), ...noticeEntries(serverApp.stage, rhwpNotices), { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(target, `system >=22 또는 install-node(${o.nodeVersion})`)) }];
      builds.push({ target, entries, top: 'hwpx-cowork-personal', format: 'zip', unix: true, file: `hwpx-cowork-personal-${version}-${stamp}-lite.zip` });
    } else {
      const win = target === 'worker-win';
      const runtime = win ? await nodeRuntime(o.nodeVersion, 'win', o.nodeCache) : [];
      const entries = [...workerLaunch, ...nodeHelpers, ...runtime, ...dirEntries(workerApp.stage, 'app/'), ...noticeEntries(workerApp.stage), { path: 'BUILD-INFO.json', data: Buffer.from(buildInfo(target, win ? o.nodeVersion : `system >=22 또는 install-node(${o.nodeVersion})`)) }];
      builds.push({ target, entries, top: 'hwpx-ai-worker', format: 'zip', unix: !win, file: `hwpx-ai-worker-${version}-${stamp}-${win ? 'win-x64' : 'lite'}.zip` });
    }
  }
  for (const { target, mode, entries, top, format, unix, file: name } of builds) {
    const file = path.join(outDir, name);
    auditEntries(entries, secrets);
    await auditPrivate(entries);
    for (const entry of entries) await assertFontDistributionBundle(entry.path, entry.data || fs.readFileSync(entry.src));
    const extractedBytes = entries.reduce((n, e) => n + (e.data ? e.data.length : fs.statSync(e.src).size), 0);
    console.log(`${name} 묶는 중… (파일 ${entries.length}개, 풀면 ${mib(extractedBytes)})`);
    if (format === 'zip') await writeZip(entries, file, top, unix);
    else await writeTarGz(entries, file, top);
    const bytes = fs.statSync(file).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    results.push({ target, ...(mode ? { mode, platform: 'windows', node: o.nodeVersion } : {}), file: name, bytes, sha256, files: entries.length, extractedBytes, topFolder: top, downloadUrl: `${o.downloadBase}/${encodeURIComponent(name)}`, attachmentEligible: bytes < 30000000, installRequired: target.endsWith('-install') });
    console.log(`  → ${mib(bytes)}  sha256 ${sha256.slice(0, 16)}…`);
  }

  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), results.map((r) => `${r.sha256}  ${r.file}`).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify({ version, builtAt: new Date().toISOString(), node: o.nodeVersion, downloadBase: o.downloadBase, attachmentLimitBytes: 30000000, secretsChecked: secrets.count, packages: results }, null, 2)}\n`);
  if (!o.keepStaging) await fs.promises.rm(staging, { recursive: true, force: true });
  console.log(`완료: ${outDir}`);
}

main().catch((error) => {
  console.error(`[package-portable] ${error.message}`);
  process.exitCode = 1;
});
