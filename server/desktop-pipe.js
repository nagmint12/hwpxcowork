// Transport for the desktop owner's private HTTP streams. Only the app's virtual
// origin is mapped. Remote workers and AI providers keep their usual transport.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const desktopOrigin = 'http://localhost';
export const sessionFile = 'local-stdio-session.json';
export const pipeHeader = 'x-hwpx-local-key';
export const localPeer = Symbol('authenticated desktop pipe');

export function createPipeSession() {
  const id = crypto.randomBytes(18).toString('hex');
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\hwpx-cowork-' + id
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-ipc-')), 'app.sock');
  return { socketPath, key: crypto.randomBytes(32).toString('hex') };
}

export function readPipeSession(profile) {
  const value = JSON.parse(fs.readFileSync(path.join(profile, sessionFile), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(value.key) || typeof value.socketPath !== 'string' ||
      (process.platform === 'win32' ? !/^\\\\\.\\pipe\\hwpx-cowork-[a-f0-9]{36}$/.test(value.socketPath)
        : !path.isAbsolute(value.socketPath) || path.basename(value.socketPath) !== 'app.sock')) throw Error('개인 연결 정보를 확인할 수 없습니다.');
  return value;
}

export function writePipeSession(profile, session) {
  const file = path.join(profile, sessionFile);
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(session), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function clearPipeSession(profile, session) {
  try {
    if (readPipeSession(profile).key === session.key) fs.unlinkSync(path.join(profile, sessionFile));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform !== 'win32') {
    try { fs.rmdirSync(path.dirname(session.socketPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function pipeFetch(session) {
  if (!session) return globalThis.fetch;
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== desktopOrigin || url.username || url.password) throw Error('앱 내부의 개인 문서 주소만 사용할 수 있습니다.');
    const headers = Object.fromEntries(req.headers);
    for (const header of ['connection', 'transfer-encoding', 'upgrade', 'host']) delete headers[header];
    headers.host = 'localhost';
    headers['accept-encoding'] = 'identity';
    headers[pipeHeader] = session.key;
    return new Promise((resolve, reject) => {
      const out = http.request({ socketPath: session.socketPath, path: url.pathname + url.search, method: req.method, headers, signal: req.signal }, incoming => {
        const empty = req.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        const replyHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          const name = incoming.rawHeaders[i];
          if (!/^(connection|keep-alive|transfer-encoding)$/i.test(name)) replyHeaders.append(name, incoming.rawHeaders[i + 1]);
        }
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: replyHeaders }));
      });
      out.once('error', reject);
      if (req.body) pipeline(Readable.fromWeb(req.body), out).catch(reject);
      else out.end();
    });
  };
}
