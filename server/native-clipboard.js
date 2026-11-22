// Windows clipboard bridge. Public-origin writes require a fresh physical clipboard marker.
// Reading the host clipboard remains limited to direct loopback requests.
import { execFile } from 'node:child_process';
import { localPeer } from './desktop-pipe.js';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/native-clipboard.py', import.meta.url));
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function isLocalClipboardRequest(req) {
  if (!req.socket?.[localPeer] && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (!localHosts.has(String(req.hostname).toLowerCase())) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded) return false;
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false; }
    catch { return false; }
  }
  return true;
}

export function isClipboardProofOrigin(req, publicUrl = '') {
  try {
    const origin = new URL(req.headers.origin);
    if (origin.protocol === 'https:') return origin.host === req.headers.host || (!!publicUrl && origin.origin === new URL(publicUrl).origin);
    return origin.protocol === 'http:' && origin.hostname.endsWith('.localhost') && origin.host === req.headers.host &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  } catch { return false; }
}

function runHelper(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.HWPX_COWORK_PYTHON || 'python', ['-I', helper, ...args],
      { windowsHide: true, timeout: 45000, maxBuffer: args.includes('--read') || args.includes('--import') ? 48 * 1024 * 1024 : 4096, encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(new Error('한글 원본 형식 복사를 완료하지 못했습니다'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('클립보드 응답을 읽지 못했습니다')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

export function createNativeClipboard({ platform = process.platform, run = runHelper } = {}) {
  let checked;
  let latest = '';
  let queue = Promise.resolve();
  let proving = false;
  let importing = null;
  return {
    async status() {
      if (platform !== 'win32') return { available: false, reason: 'WINDOWS_REQUIRED' };
      return checked ??= run(['--check']).catch(() => ({ available: false, reason: 'HANGUL_REQUIRED' }));
    },
    async write(body, { requireClipboardProof = false } = {}) {
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(body?.token || '') || typeof body?.hwpx !== 'string' ||
          body.hwpx.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.hwpx)) {
        return { ok: false, reason: 'INVALID_FRAGMENT' };
      }
      if (requireClipboardProof) {
        if (platform !== 'win32' || proving || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.token)) return { ok: false, reason: 'SAME_PC_REQUIRED' };
        proving = true;
        try {
          const proof = await run(['--proof'], { token: body.token }).catch(() => ({ ok: false }));
          if (proof.ok !== true) return { ok: false, reason: 'SAME_PC_REQUIRED' };
        } finally { proving = false; }
      }
      if (!(await this.status()).available) return { ok: false, reason: 'HANGUL_REQUIRED' };
      latest = body.token;
      const task = queue.catch(() => {}).then(() => latest === body.token
        ? run([], body) : { ok: false, reason: 'CLIPBOARD_CHANGED' });
      queue = task;
      return task;
    },
    async read(body) {
      if (!/^[0-9a-f]{64}$/.test(body?.textHash || '')) return { ok: false, reason: 'INVALID_REQUEST' };
      if (body.modelHash !== undefined && !/^[0-9a-f]{64}$/.test(body.modelHash)) return { ok: false, reason: 'INVALID_REQUEST' };
      if (platform !== 'win32') return { ok: false, reason: 'WINDOWS_REQUIRED' };
      return run(['--read'], { textHash: body.textHash, modelHash: body.modelHash });
    },
    async importFragment(body) {
      // Supplied document bytes only. This path never invokes --read or --proof.
      if (typeof body?.native !== 'string' || body.native.length > Math.ceil(32 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.native) ||
          !Buffer.from(body.native.slice(0, 12), 'base64').subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return { ok: false, reason: 'INVALID_FRAGMENT' };
      if (platform !== 'win32') return { ok: false, reason: 'HANGUL_REQUIRED' };
      if (importing) return { ok: false, reason: 'IMPORT_BUSY' };
      importing = run(['--import'], { native: body.native });
      try { return await importing; } finally { importing = null; }
    },
  };
}
