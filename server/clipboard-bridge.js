// Local copy transport. No network endpoint exposes this helper's clipboard.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../scripts/hancom-clipboard-bridge.py', import.meta.url));
export function createClipboardBridge({ enabled = false, platform = process.platform, launch = spawn, retryMs = 2000 } = {}) {
  let child = null, timer = null, stopped = false, attempts = 0;
  let state = { enabled: enabled && platform === 'win32', running: false, copies: 0, lastSourceVersion: null, lastCopyAt: null, reason: null };
  function start() {
    if (!state.enabled || stopped || child) return;
    attempts++;
    const current = launch(process.env.HWPX_COWORK_PYTHON || 'python', ['-I', entry, '--watch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = current;
    const lines = createInterface({ input: current.stdout });
    current.stdin.on('error', () => {});
    lines.on('line', line => {
      if (line.length > 4096 || current !== child) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'ready' && message.ok === true) state = { ...state, running: true, reason: null };
      if (message.event === 'enriched' && message.ok === true) state = { ...state, copies: state.copies + 1, lastSourceVersion: message.sourceVersion, lastCopyAt: new Date().toISOString() };
      if (message.ok === false) state = { ...state, reason: message.reason || 'BRIDGE_UNAVAILABLE' };
    });
    const exited = () => {
      lines.close();
      if (current !== child) return;
      child = null; state = { ...state, running: false };
      if (!stopped && state.reason !== 'ALREADY_RUNNING') {
        timer = setTimeout(() => { timer = null; start(); }, Math.min(30000, retryMs * 2 ** Math.min(attempts - 1, 4))); timer.unref?.();
      }
    };
    current.once('exit', exited); current.once('error', exited);
  }
  async function stop() {
    stopped = true; if (timer) clearTimeout(timer); timer = null;
    const current = child; if (!current) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => { current.kill(); resolve(); }, 2000);
      current.once('exit', () => { clearTimeout(timeout); resolve(); });
      current.stdin.end('stop\n');
    });
    state = { ...state, running: false };
  }
  return { start, stop, status: () => ({ ...state }) };
}
