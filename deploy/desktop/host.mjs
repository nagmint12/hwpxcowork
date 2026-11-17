// 개인 서버의 기존 실행 경로를 앱 창에서 관리한다. 운영 설정·다른 설치의 프로세스는 다루지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { desktopAiSupport } from './cli-versions.mjs';

export function desktopEnvironment(env, userdata, node) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(HWPX_|ANTHROPIC_|OPENAI_|GEMINI_API_KEY|GOOGLE_API_KEY|BAZE_API_KEY|ELECTRON_|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_)/i.test(key)));
  const oldPath = Object.entries(clean).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(clean)) if (key.toLowerCase() === 'path') delete clean[key];
  clean.PATH = [path.dirname(node), path.join(userdata, 'tools', process.platform === 'win32' ? '' : 'bin'), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', oldPath].join(path.delimiter);
  return { ...clean, HWPX_COWORK_USERDATA: userdata, HWPX_COWORK_CONFIG: path.join(userdata, 'config.json'), HWPX_COWORK_AI: 'off', HWPX_COWORK_LOCAL: '1', HWPX_COWORK_DESKTOP_MANAGED: '1' };
}

export class DesktopHost extends EventEmitter {
  constructor({ payload, node, userdata, env = process.env, spawnImpl = spawn }) {
    super(); Object.assign(this, { payload, node, userdata, spawnImpl });
    this.env = desktopEnvironment(env, userdata, node);
    this.server = null; this.worker = null; this.operations = new Set(); this.stopping = false;
    this.state = { phase: 'starting', message: '내 Mac의 편집기를 준비하고 있습니다.', ai: 'none', aiPhase: 'off' };
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
    const child = this.launch(script, ['--no-window', '--ai', ''], { input: true, ipc: true });
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
    this.publish({ phase: 'ready', message: '내 Mac에서 편집기가 실행 중입니다.' });
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
  async stop() {
    this.stopping = true;
    this.aiGeneration = (this.aiGeneration || 0) + 1;
    for (const operation of this.operations) await this.stopChild(operation);
    await this.stopWorker(); await this.stopChild(this.server); this.server = null;
  }
}
