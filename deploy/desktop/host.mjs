// 개인 서버의 기존 실행 경로를 앱 창에서 관리한다. 운영 설정·다른 설치의 프로세스는 다루지 않는다.
// AI 실행기(2026-11-17)는 runners.mjs 의 RunnerManager 가 맡는다 — 이 파일은 공식 CLI 준비(설치·로그인 — desktop-ai.mjs)와
// 실행기 프로세스 띄우기·앱 서버 주소를 넘겨준다. 운영 방식 'runner'(AI 실행기만)는 이 PC 에 서버를 두지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { desktopAiSupport } from './cli-versions.mjs';
import { shareSupported, shareUrlFromLine } from './share.mjs';
import { RunnerManager, RUNNER_AIS } from './runners.mjs';

// 안내 글의 '내 Mac'·'이 PC'
export const placeName = (platform = process.platform) => platform === 'darwin' ? '내 Mac' : '이 PC';
const toolsDir = (userdata) => path.join(userdata, 'tools', process.platform === 'win32' ? '' : 'bin');

/** 앱이 띄우는 프로세스의 환경. otherUserdata = 다른 운영 방식의 설정 폴더(그쪽에서 이미 받은 CLI 를 다시 받지 않게 PATH 에 더한다) */
export function desktopEnvironment(env, userdata, node, mode = 'personal', otherUserdata = []) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(HWPX_|ANTHROPIC_|OPENAI_|GEMINI_API_KEY|GOOGLE_API_KEY|BAZE_API_KEY|ELECTRON_|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_)/i.test(key)));
  const oldPath = Object.entries(clean).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(clean)) if (key.toLowerCase() === 'path') delete clean[key];
  clean.PATH = [path.dirname(node), toolsDir(userdata), ...otherUserdata.map(toolsDir), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', oldPath].join(path.delimiter);
  // 공동 작업용(shared)·AI 실행기만(runner)은 PC 폴더 연결을 켜지 않는다
  return { ...clean, HWPX_COWORK_USERDATA: userdata, HWPX_COWORK_CONFIG: path.join(userdata, 'config.json'), HWPX_COWORK_AI: 'off', ...(mode === 'personal' ? { HWPX_COWORK_LOCAL: '1' } : {}), HWPX_COWORK_DESKTOP_MANAGED: '1' };
}

/** 실행기 환경: 앱 서버 전용 값은 빼고, 토큰은 RunnerManager 가 HWPX_COWORK_TOKEN 으로만 더한다 */
export function runnerEnvironment(env) {
  const out = { ...env };
  for (const key of ['HWPX_COWORK_CONFIG', 'HWPX_COWORK_USERDATA', 'HWPX_COWORK_LOCAL', 'HWPX_COWORK_AI', 'HWPX_COWORK_TOKEN']) delete out[key];
  return { ...out, HWPX_COWORK_DESKTOP_MANAGED: '1' };
}

const halted = (message = '실행기 켜기를 취소했습니다.') => Object.assign(new Error(message), { code: 'CANCELLED' });

export class DesktopHost extends EventEmitter {
  constructor({ payload, node, userdata, mode = 'personal', transport = 'loopback', env = process.env, spawnImpl = spawn, platform = process.platform, vault = null, otherUserdata = [], runnerOptions = {} }) {
    super();
    Object.assign(this, { payload, node, userdata, spawnImpl, mode: ['shared', 'runner'].includes(mode) ? mode : 'personal', place: placeName(platform) });
    this.env = desktopEnvironment(env, userdata, node, this.mode, otherUserdata);
    this.portless = this.mode === 'personal' && transport === 'stdio';
    this.fetch = globalThis.fetch;
    this.server = null; this.tunnel = null; this.operations = new Set(); this.cliOperations = new Map(); this.cliLocks = new Map(); this.stopping = false;
    this.state = { phase: 'starting', message: this.mode === 'runner' ? `${this.place}의 AI 실행기를 준비하고 있습니다.` : `${this.place}의 편집기를 준비하고 있습니다.`,
      mode: this.mode, share: 'off', shareUrl: null, shareSupported: this.mode === 'shared' && shareSupported(platform) };
    const support = desktopAiSupport(process.platform, os.release());
    this.state.aiSupported = support.available;
    this.state.aiSupportMessage = support.message;
    fs.mkdirSync(userdata, { recursive: true, mode: 0o700 });
    this.runners = new RunnerManager({
      dir: userdata, vault, localSupported: this.mode !== 'runner',
      launch: (args, runEnv) => this.launch('scripts/setup-worker.mjs', args, { env: runEnv, ipc: true }),
      prepare: (ai, options) => this.prepareCli(ai, options),
      cancelPrepare: (ai) => this.cancelCli(ai),
      local: () => this.localTarget(),
      env: () => runnerEnvironment(this.env),
      support: () => ({ available: this.state.aiSupported, message: this.state.aiSupportMessage }),
      ...runnerOptions,
    });
  }
  publish(update) { Object.assign(this.state, update); this.emit('state', this.snapshot()); }
  snapshot() { return { ...this.state }; }
  launch(script, args = [], { env = this.env, input = false, ipc = false } = {}) {
    return this.spawnImpl(this.node, [path.join(this.payload, script), ...args], { cwd: this.payload, env, shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  }
  start() {
    if (this.stopping) return Promise.reject(Error('앱을 종료하고 있습니다.'));
    if (this.serviceStop) return this.serviceStop.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.server && this.state.phase === 'ready') return Promise.resolve(this.editorUrl);
    this.publish({ phase: 'starting' });
    this.starting = this.startOwned().catch(async error => {
      await this.stopChild(this.server);
      this.server = null;
      this.releasePipe();
      this.publish({ phase: 'error', message: error.message });
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startOwned() {
    if (this.mode === 'runner') {   // AI 실행기만: 이 PC 에 서버를 두지 않는다
      this.publish({ phase: 'ready', message: `${this.place}에서 AI 실행기를 관리합니다.` });
      return null;
    }
    const script = fs.existsSync(path.join(this.payload, 'portable/personal.mjs')) ? 'portable/personal.mjs' : 'deploy/portable/personal.mjs';
    let env = this.env;
    if (this.portless) {
      this.pipeIO = await import(pathToFileURL(path.join(this.payload, 'server/desktop-pipe.js')).href);
      this.pipe = this.pipeIO.createPipeSession();
      this.fetch = this.pipeIO.pipeFetch(this.pipe);
      env = { ...env, HWPX_COWORK_DESKTOP_PIPE: JSON.stringify(this.pipe), HWPX_COWORK_PUBLIC_URL: this.pipeIO.desktopOrigin };
    }
    const child = this.launch(script, ['--no-window', '--ai', '', ...(this.mode === 'shared' ? ['--shared'] : [])], { env, input: true, ipc: true });
    this.server = child;
    await new Promise((resolve, reject) => {
      let out = ''; let err = '';
      const timer = setTimeout(() => reject(new Error('편집기를 여는 데 시간이 걸리고 있습니다. 앱을 닫고 다시 실행해 주세요.')), 90000);
      const fail = () => { clearTimeout(timer); reject(new Error('개인 서버를 시작하지 못했습니다. ' + err.slice(-500))); };
      child.once('error', fail);
      child.once('exit', fail);
      child.stderr.on('data', bytes => { err = (err + bytes.toString()).slice(-2000); });
      child.stdout.on('data', bytes => {
        out = (out + bytes.toString()).slice(-10000);
        const match = /(?:^|\n)PERSONAL (\d+|STDIO)\r?(?:\n|$)/.exec(out);
        if (!match) return;
        clearTimeout(timer); child.off('exit', fail); child.off('error', fail);
        if ((match[1] === 'STDIO') !== this.portless) { reject(Error('앱의 연결 방식을 확인할 수 없습니다.')); return; }
        this.port = this.portless ? null : Number(match[1]); resolve();
      });
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(this.userdata, 'config.json'), 'utf8'));
    this.token = cfg.users.find(u => u.role === 'admin').token;
    if (cfg.host !== '127.0.0.1' || (!this.portless && cfg.port !== this.port)) throw new Error('이 앱 전용 서버 설정을 확인하지 못했습니다.');
    const response = await this.api('/api/me');
    if (response.role !== 'admin') throw new Error('개인 문서함을 열지 못했습니다.');
    child.once('exit', code => {
      if (this.server !== child) return;
      this.server = null; this.releasePipe(); this.port = null;
      if (this.state.phase === 'stop-error' && code === 0) this.publish({ phase: 'stopped', share: 'off', shareUrl: null });
      else if (!this.stopping && this.state.phase !== 'stopping') this.publish({ phase: 'error', message: '문서 서비스가 종료되었습니다 (' + code + ').' });
    });
    if (this.pipe) this.pipeIO.writePipeSession(this.userdata, this.pipe);
    this.editorUrl = this.origin + '/?teaser=0#/t/' + encodeURIComponent(this.token);
    this.publish({ phase: 'ready', message: `${this.place}에서 편집기가 실행 중입니다.` });
    return this.editorUrl;
  }
  get origin() { return this.portless ? this.pipeIO?.desktopOrigin : 'http://localhost:' + this.port; }
  releasePipe() {
    if (this.pipe) this.pipeIO.clearPipeSession(this.userdata, this.pipe);
    this.pipe = null; this.fetch = globalThis.fetch; this.editorUrl = null;
  }
  // 관리자가 화면(관리자 접속 토큰 안내·사용자 탭)에서 토큰을 바꾸면 서버가 설정 파일에 쓴다 — 앱도 그 값을 따라간다(2026-11-17)
  freshToken() {
    try { const t = JSON.parse(fs.readFileSync(path.join(this.userdata, 'config.json'), 'utf8')).users?.find(u => u.role === 'admin')?.token; if (t) this.token = t; } catch { /* 읽지 못하면 이전 값 */ }
    return this.token;
  }
  /** '이 앱의 서버'에 붙는 실행기의 주소·토큰(관리자) — 서버가 준비되기 전·AI 실행기만 방식에서는 없음 */
  localTarget() {
    if (this.mode === 'runner' || this.stopping || this.state.phase !== 'ready' || (!this.port && !this.pipe)) return null;
    const token = this.freshToken();
    return token ? { mcpUrl: this.pipe ? this.origin + '/mcp' : 'http://127.0.0.1:' + this.port + '/mcp', token, ...(this.pipe ? { pipe: this.pipe } : {}) } : null;
  }
  async api(endpoint, { method = 'GET', body } = {}) {
    const base = this.pipe ? this.origin : 'http://127.0.0.1:' + this.port;
    const r = await this.fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + this.freshToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const result = await r.json(); if (!r.ok) throw new Error(result.message || '요청을 처리하지 못했습니다.'); return result;
  }
  async linkFolder(folder) { return this.api('/api/local/links', { method: 'POST', body: { path: folder } }); }
  /** 짧게 도는 도우미(desktop-ai.mjs 등). provider 를 주면 그 AI 의 CLI 준비 작업으로 묶어 끌 수 있다(cancelCli) */
  async run(script, args, { timeout = 60000, env = this.env, provider = null, timeoutMessage = '시간이 지나 멈췄습니다. 다시 시도해 주세요.' } = {}) {
    const child = this.launch(script, args, { env, ipc: true }); this.operations.add(child);
    const group = provider ? (this.cliOperations.get(provider) || this.cliOperations.set(provider, new Set()).get(provider)) : null;
    group?.add(child);
    return new Promise((resolve, reject) => {
      let stdout = ''; let stderr = ''; let timeoutError = false;
      const timer = setTimeout(() => { timeoutError = true; if (child.connected) child.send('stop'); else child.kill(); }, timeout);
      const finish = () => { clearTimeout(timer); this.operations.delete(child); group?.delete(child); };
      child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-64000); });
      child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-64000); });
      child.once('error', e => { finish(); reject(e); });
      child.once('exit', code => { finish(); if (code || timeoutError) reject(new Error(timeoutError ? timeoutMessage : (stderr.trim().slice(-1000) || 'AI 연결을 마치지 못했습니다.'))); else resolve(stdout); });
    });
  }
  /** desktop-ai.mjs 자리: 묶음(payload/app/scripts) 또는 개발 폴더(deploy/desktop) */
  get aiScript() { return fs.existsSync(path.join(this.payload, 'scripts/desktop-ai.mjs')) ? 'scripts/desktop-ai.mjs' : 'deploy/desktop/desktop-ai.mjs'; }
  async auth(provider) {
    const out = await this.run(this.aiScript, ['--provider', provider, '--action', 'status'], { provider, timeout: 90000 });
    return JSON.parse(out);
  }
  /**
   * 실행기를 띄우기 전 공식 CLI 준비(모델 호출 없음). Codex·Claude Code: 없으면 설치(사용자 설정 폴더 tools), 로그인 안 됐으면 브라우저 로그인.
   * Gemini CLI·Antigravity: 설치만 확인한다(로그인 유효성은 첫 요청에서 확인된다 — server/google-cli-ai.js check). 없으면 안내 글로 오류.
   * interactive=false(앱 시작 때 자동 시작)는 설치·로그인을 띄우지 않고 오류로 돌려준다. 같은 AI 의 준비는 한 번에 하나씩(설치가 겹치지 않게).
   */
  async prepareCli(provider, { interactive = true, active = () => {}, note = () => {} } = {}) {
    const kind = RUNNER_AIS[provider];
    if (!kind) throw new Error('지원하지 않는 AI입니다.');
    if (!this.state.aiSupported) throw new Error(this.state.aiSupportMessage);
    const check = () => { if (this.stopping) throw halted('앱을 종료하고 있습니다.'); active(); };
    check();
    const previous = this.cliLocks.get(provider) || Promise.resolve();
    let release; const mine = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => mine);
    this.cliLocks.set(provider, chain);
    await previous;
    try {
      check();
      let auth = await this.auth(provider); check();
      if (!kind.managed) {
        if (!auth.installed) throw new Error(auth.reason || `${kind.label}를 찾지 못했습니다. 설치한 뒤 명령 창에서 ${kind.command}를 한 번 실행해 Google 계정으로 로그인해 주세요.`);
        if (!auth.ready) throw new Error(auth.reason || `${kind.label}를 업데이트해 주세요.`);
        return auth;
      }
      if (!auth.installed) {
        if (!interactive) throw new Error(`${kind.label} 연결 프로그램이 없습니다. [켜기]를 누르면 설치합니다.`);
        note('연결 프로그램을 설치하고 있습니다(처음 한 번)');
        await this.run(this.aiScript, ['--provider', provider, '--action', 'install', '--prefix', path.join(this.userdata, 'tools')], { provider, timeout: 10 * 60000, timeoutMessage: '설치 시간이 지났습니다. 인터넷 연결을 확인하고 다시 켜 주세요.' });
        check(); auth = await this.auth(provider); check();
      }
      if (!auth.ready && auth.installed) {
        if (!interactive) throw new Error(`${kind.account} 로그인이 필요합니다. [켜기]를 누르면 브라우저에서 로그인합니다.`);
        note('브라우저에서 본인 계정으로 로그인해 주세요');
        await this.run(this.aiScript, ['--provider', provider, '--action', 'login'], { provider, timeout: 10 * 60000, timeoutMessage: '로그인 시간이 지났습니다. 다시 켜서 로그인해 주세요.' });
        check(); auth = await this.auth(provider); check();
      }
      if (!auth.ready) throw new Error(auth.reason || 'AI 로그인을 확인하지 못했습니다.');
      return auth;
    } finally {
      release();
      if (this.cliLocks.get(provider) === chain) this.cliLocks.delete(provider);
    }
  }
  /** 그 AI 의 설치·로그인 도우미를 멈춘다(실행기 [끄기]를 준비 중에 눌렀을 때) */
  cancelCli(provider) {
    for (const child of this.cliOperations.get(provider) || []) void this.stopChild(child).catch(() => {});
  }
  async stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode || (!child.pid && child.spawnfile)) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('저장 중인 작업이 끝나기를 기다리고 있습니다.')), 45000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('stop', () => {}); else if (child.stdin?.writable) child.stdin.write('quit\n'); else child.kill();
    });
  }
  // ── 외부 접속(공동 작업용, Windows) ── scripts/quick-tunnel.mjs 를 띄워 임시 https 주소를 받는다.
  // 주소를 서버 공유 주소로 저장하고 서버를 다시 시작하는 일·끌 때 되돌리는 일은 quick-tunnel 이 한다(IPC 'stop' 으로 정상 종료).
  async openShare(cloudflared, { timeout = 150000 } = {}) {
    if (!this.state.shareSupported) throw new Error('외부 접속은 Windows의 공동 작업용 앱에서만 열 수 있습니다.');
    if (this.state.phase !== 'ready') throw new Error('편집기가 준비된 뒤에 외부 접속을 열 수 있습니다.');
    if (this.tunnel) throw new Error(this.state.share === 'on' ? '외부 접속이 이미 열려 있습니다.' : '외부 접속을 여는 중입니다.');
    if (this.stopping) throw new Error('앱을 종료하고 있습니다.');
    const child = this.launch('scripts/quick-tunnel.mjs', ['--cloudflared', cloudflared], { ipc: true });
    this.tunnel = child;
    this.publish({ share: 'opening', shareUrl: null, message: '외부 접속 주소를 만드는 중입니다(1분쯤 걸릴 수 있습니다).' });
    let err = '';
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-4000); });
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => { reject(new Error('외부 접속 주소를 만들지 못했습니다(시간 초과). 인터넷·방화벽을 확인해 주세요.')); void this.stopChild(child).catch(() => {}); }, timeout);
      child.stdout.on('data', (b) => {
        out = (out + b.toString()).slice(-20000);
        for (const line of out.split(/\r?\n/)) { const found = shareUrlFromLine(line); if (found) { clearTimeout(timer); resolve(found); return; } }
      });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`외부 접속을 열지 못했습니다. ${err.replace(/\[오류\]\s*/g, '').trim().slice(-400)}`.trim())); });
    }).catch((error) => {
      if (this.tunnel === child) { this.tunnel = null; this.publish({ share: 'error', shareUrl: null, message: error.message }); }
      throw error;
    });
    child.once('exit', () => {
      if (this.tunnel !== child) return;
      this.tunnel = null;
      if (!this.stopping) this.publish({ share: 'error', shareUrl: null, message: '외부 접속이 끊겼습니다. 다시 열면 새 주소가 나옵니다.' });
    });
    this.publish({ share: 'on', shareUrl: url, message: '외부 접속이 열려 있습니다. 앱을 끄거나 [외부 접속 닫기]를 누르면 닫힙니다.' });
    return url;
  }
  async closeShare() {
    const child = this.tunnel; this.tunnel = null;
    await this.stopChild(child);
    this.publish({ share: 'off', shareUrl: null, message: '외부 접속을 닫았습니다. 이 PC에서만 열립니다.' });
  }
  stopService() {
    if (!this.serviceStop) this.serviceStop = this.stopOwned().catch(error => {
      this.publish({ phase: this.server ? 'stop-error' : 'error', message: error.message });
      throw error;
    }).finally(() => { this.serviceStop = null; });
    return this.serviceStop;
  }
  async stopOwned() {
    if (this.starting) await this.starting.catch(() => {});
    this.publish({ phase: 'stopping' });
    if (!this.stopping) await this.runners.stopAll({ localOnly: true });
    const tunnel = this.tunnel; this.tunnel = null; await this.stopChild(tunnel);   // 공유 주소를 되돌린 뒤 서버를 끈다
    if (this.stopping) for (const operation of this.operations) await this.stopChild(operation);
    await this.stopChild(this.server); this.server = null;
    this.releasePipe(); this.port = null; this.token = null;
    this.publish({ phase: 'stopped', share: 'off', shareUrl: null, message: '서버를 중지했습니다.' });
  }
  async stop() {
    this.stopping = true;
    await this.runners.shutdown();
    await this.stopService();
  }
}
