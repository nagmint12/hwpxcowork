// 데스크톱 앱에서 공식 CLI 준비·구독 로그인만 담당한다. 모델 요청·문서 작업을 하지 않는다.
// Codex·Claude Code: status·install(사용자 설정 폴더 tools)·login. Gemini CLI·Antigravity: status 만(설치·로그인은 사용자가 직접 —
// 로그인 유효성은 첫 요청에서 확인된다, server/google-cli-ai.js GoogleCliProposer.check). 2026-11-17 AI 실행기 창.
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { desktopCliPackages, desktopAiSupport } from './cli-versions.mjs';
import { checkCodex, resolveCodexCommand } from '../../server/codex-ai.js';
import { checkClaudeCode, resolveClaudeCommand } from '../../server/claude-cli-ai.js';
const opt = key => process.argv[process.argv.indexOf(key) + 1];
const provider = opt('--provider'); const action = opt('--action');
const google = ['gemini-cli', 'antigravity'].includes(provider);
if (!['codex', 'claude-code', 'gemini-cli', 'antigravity'].includes(provider) || !['status', 'login', 'install'].includes(action)) throw new Error('지원하지 않는 AI 연결 작업입니다.');
if (google && action !== 'status') throw new Error('Gemini CLI·Antigravity는 설치와 로그인을 직접 해 주세요.');
const support = desktopAiSupport(process.platform, os.release());
if (!support.available) throw new Error(support.message);
const command = provider === 'codex' ? 'codex' : 'claude';
if (google) {
  // 모델을 부르지 않는 점검: 실행 파일을 찾고 --help 에 비대화형 실행 옵션이 있는지만 본다
  const { GoogleCliProposer } = await import('../../server/google-cli-ai.js');
  console.log(JSON.stringify(await new GoogleCliProposer({ provider }).check()));
} else if (action === 'status') {
  console.log(JSON.stringify(await (provider === 'codex' ? checkCodex : checkClaudeCode)({ command })));
} else {
  let file; let args;
  if (action === 'install') {
    const npm = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    file = process.execPath;
    args = [npm, 'install', '--global', '--prefix', opt('--prefix'), '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', desktopCliPackages(process.platform, os.release())[provider]];
  } else {
    const launch = await (provider === 'codex' ? resolveCodexCommand : resolveClaudeCommand)(command);
    file = launch.file; args = [...launch.args, ...(provider === 'codex' ? ['login'] : ['auth', 'login'])];
  }
  const child = spawn(file, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
  const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
  if (process.connected) { process.on('message', m => { if (m === 'stop') stop(); }); process.once('disconnect', stop); }
  process.on('SIGTERM', stop);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.once('error', () => { console.error('공식 AI 연결 프로그램을 시작하지 못했습니다.'); process.exitCode = 1; if (process.connected) process.disconnect(); });
  child.once('exit', code => { process.exitCode = code ?? 1; if (process.connected) process.disconnect(); });
}
if (action === 'status' && process.connected) process.disconnect();
