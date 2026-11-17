// 개인 서버의 기존 실행 경로를 앱 창에서 관리한다. 운영 설정·다른 설치의 프로세스는 다루지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { desktopAiSupport } from './cli-versions.mjs';
import { shareSupported, shareUrlFromLine } from './share.mjs';

// 안내 글의 '내 Mac'·'이 PC'
export const placeName = (platform = process.platform) => platform === 'darwin' ? '내 Mac' : '이 PC';

export function desktopEnvironment(env, userdata, node, mode = 'personal') {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(HWPX_|ANTHROPIC_|OPENAI_|GEMINI_API_KEY|GOOGLE_API_KEY|BAZE_API_KEY|ELECTRON_|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_)/i.test(key)));
  const oldPath = Object.entries(clean).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(clean)) if (key.toLowerCase() === 'path') delete clean[key];
  clean.PATH = [path.dirname(node), path.join(userdata, 'tools', process.platform === 'win32' ? '' : 'bin'), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', oldPath].join(path.delimiter);
  // 공동 작업용(shared)은 PC 폴더 연결을 켜지 않는다
  return { ...clean, HWPX_COWORK_USERDATA: userdata, HWPX_COWORK_CONFIG: path.join(userdata, 'config.json'), HWPX_COWORK_AI: 'off', ...(mode === 'shared' ? {} : { HWPX_COWORK_LOCAL: '1' }), HWPX_COWORK_DESKTOP_MANAGED: '1' };
}

export class DesktopHost extends EventEmitter {
  constructor({ payload, node, userdata, mode = 'personal', env = process.env, spawnImpl = spawn, platform = process.platform }) {
    super(); Object.assign(this, { payload, node, userdata, spawnImpl, mode: mode === 'shared' ? 'shared' : 'personal', place: placeName(platform) });
    this.env = desktopEnvironment(env, userdata, node, this.mode);
    this.server = null; this.worker = null; this.tunnel = null; this.operations = new Set(); this.stopping = false;
    this.state = { phase: 'starting', message: `${this.place}의 편집기를 준비하고 있습니다.`, mode: this.mode, ai: 'none', aiPhase: 'off', share: 'off', shareUrl: null, shareSupported: this.mode === 'shared' && shareSupported(platform) };
    const support = desktopAiSupport(process.platform, os.release());
    this.state.aiSupported = support.available;
    this.state.aiSupportMessage = support.message;
    fs.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  }
  publish(update) { Object.assign(this.state, update); this.emit('state', this.snapshot()); }
  snapshot() { return { ...this.state }; }
  preferences() {
    try { const p = JSON.parse(fs.readFileSync(path.join(this.userdata, 'desktop.json'))); return ['codex', 'claude-code'].includes(p.ai) ? p : { ai: 'none' }; }
    catch { return { ai: 'none' }; }
  }
  savePreferences(ai) { fs.writeFileSync(path.join(this.userdata, 'desktop.json'), JSON.stringify({ ai }) + '\n', { mode: 0o600 }); }
  launch(script, args = [], { env = this.env, input = false, ipc = false } = {}) {
    return this.spawnImpl(this.node, [path.join(this.payload, script), ...args], { cwd: this.payload, env, shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  }
  async start() {
    const script = fs.existsSync(path.join(this.payload, 'portable/personal.mjs')) ? 'portable/personal.mjs' : 'deploy/portable/personal.mjs';
    const child = this.launch(script, ['--no-window', '--ai', '', ...(this.mode === 'shared' ? ['--shared'] : [])], { input: true, ipc: true });
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
        const match = /(?:^|\n)PERSONAL (\d+)\r?(?:\n|$)/.exec(out);
        if (!match) return;
        clearTimeout(timer); child.off('exit', fail); child.off('error', fail);
        this.port = Number(match[1]); resolve();
      });
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(this.userdata, 'config.json'), 'utf8'));
    this.token = cfg.users.find(u => u.role === 'admin').token;
    if (cfg.host !== '127.0.0.1' || cfg.port !== this.port) throw new Error('이 앱 전용 서버 설정을 확인하지 못했습니다.');
    const response = await this.api('/api/me');
    if (response.role !== 'admin') throw new Error('개인 문서함을 열지 못했습니다.');
    child.once('exit', code => { if (!this.stopping) this.publish({ phase: 'error', message: `개인 서버가 종료되었습니다(${code}). 앱을 다시 실행해 주세요.` }); });
    this.publish({ phase: 'ready', message: `${this.place}에서 편집기가 실행 중입니다.` });
    return `http://localhost:${this.port}/?teaser=0#/t/${encodeURIComponent(this.token)}`;
  }
  async api(endpoint, { method = 'GET', body } = {}) {
    const r = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, { method, headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const result = await r.json(); if (!r.ok) throw new Error(result.message || '요청을 처리하지 못했습니다.'); return result;
  }
  async linkFolder(folder) { return this.api('/api/local/links', { method: 'POST', body: { path: folder } }); }
  async run(script, args, { timeout = 60000, env = this.env } = {}) {
    const child = this.launch(script, args, { env, ipc: true }); this.operations.add(child);
    return new Promise((resolve, reject) => {
      let stdout = ''; let stderr = ''; let timeoutError = false;
      const timer = setTimeout(() => { timeoutError = true; if (child.connected) child.send('stop'); else child.kill(); }, timeout);
      const finish = () => { clearTimeout(timer); this.operations.delete(child); };
      child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-64000); });
      child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-64000); });
      child.once('error', e => { finish(); reject(e); });
      child.once('exit', code => { finish(); if (code || timeoutError) reject(new Error(timeoutError ? '로그인 시간이 지났습니다. 다시 로그인해 주세요.' : (stderr.slice(-1000) || 'AI 연결을 마치지 못했습니다.'))); else resolve(stdout); });
    });
  }
  async auth(provider) {
    const out = await this.run('scripts/desktop-ai.mjs', ['--provider', provider, '--action', 'status']);
    return JSON.parse(out);
  }
  async prepareAi(provider) {
    if (!['codex', 'claude-code'].includes(provider)) throw new Error('ChatGPT 또는 Claude를 선택해 주세요.');
    if (!this.state.aiSupported) throw new Error(this.state.aiSupportMessage);
    if (this.state.aiPhase === 'preparing' || this.state.aiPhase === 'login') throw new Error('AI 연결을 진행하고 있습니다. 잠시 기다려 주세요.');
    if (this.stopping) throw new Error('앱을 종료하고 있습니다.');
    const generation = this.aiGeneration = (this.aiGeneration || 0) + 1;
    const active = () => { if (this.stopping || generation !== this.aiGeneration) throw new Error('AI 연결을 취소했습니다.'); };
    await this.stopWorker(); active();
    this.publish({ ai: provider, aiPhase: 'preparing', message: 'AI 연결을 준비하고 있습니다.' });
    try {
      let auth = await this.auth(provider); active();
      if (!auth.installed) {
        this.publish({ message: '공식 AI 연결 프로그램을 준비하고 있습니다. 처음 한 번만 필요합니다.' });
        await this.run('scripts/desktop-ai.mjs', ['--provider', provider, '--action', 'install', '--prefix', path.join(this.userdata, 'tools')], { timeout: 10 * 60000 });
        active(); auth = await this.auth(provider); active();
      }
      if (!auth.ready) {
        this.publish({ aiPhase: 'login', message: '브라우저에서 본인 AI 계정에 로그인해 주세요.' });
        await this.run('scripts/desktop-ai.mjs', ['--provider', provider, '--action', 'login'], { timeout: 10 * 60000 });
        active(); auth = await this.auth(provider); active();
      }
      if (!auth.ready) throw new Error(auth.reason || 'AI 로그인을 확인하지 못했습니다.');
      const env = { ...this.env, HWPX_COWORK_TOKEN: this.token };
      await this.run('scripts/ai-worker.mjs', ['--provider', provider, '--url', `http://127.0.0.1:${this.port}/mcp`, '--check'], { env });
      active();
      const child = this.launch('scripts/setup-worker.mjs', ['--provider', provider, '--url', `http://127.0.0.1:${this.port}/mcp`], { env, ipc: true });
      this.worker = child;
      child.stdout.resume(); child.stderr.resume();
      child.once('error', () => { if (this.worker === child) { this.worker = null; this.publish({ aiPhase: 'error', message: 'AI 실행기를 켜지 못했습니다. 다시 연결해 주세요.' }); } });
      child.once('exit', () => { if (this.worker === child) { this.worker = null; if (!this.stopping) this.publish({ aiPhase: 'error', message: 'AI 연결이 종료되었습니다. 다시 연결해 주세요.' }); } });
      this.savePreferences(provider);
      this.publish({ aiPhase: 'connected', message: '내 AI가 연결되었습니다. 편집기에서 작업을 맡기실 수 있습니다.' });
    } catch (e) { if (!this.stopping && generation === this.aiGeneration) this.publish({ aiPhase: 'error', message: e.message }); throw e; }
  }
  async stopChild(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('저장 중인 작업이 끝나기를 기다리고 있습니다.')), 45000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('stop'); else if (child.stdin?.writable) child.stdin.write('quit\n'); else child.kill();
    });
  }
  async stopWorker() { const child = this.worker; this.worker = null; await this.stopChild(child); }
  async disconnectAi() {
    this.aiGeneration = (this.aiGeneration || 0) + 1;
    for (const operation of this.operations) await this.stopChild(operation);
    await this.stopWorker(); this.savePreferences('none');
    this.publish({ ai: 'none', aiPhase: 'off', message: 'AI 없이 문서 편집을 사용합니다.' });
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
  async stop() {
    this.stopping = true;
    this.aiGeneration = (this.aiGeneration || 0) + 1;
    const tunnel = this.tunnel; this.tunnel = null; await this.stopChild(tunnel);   // 공유 주소를 되돌린 뒤 서버를 끈다
    for (const operation of this.operations) await this.stopChild(operation);
    await this.stopWorker(); await this.stopChild(this.server); this.server = null;
  }
}
