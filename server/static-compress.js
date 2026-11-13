// 정적 파일 압축 전달 — 브라우저가 받는다고 하면 br(없으면 gzip) 사본을 보낸다.
// 사본은 처음 요청 때 한 번 만들어 임시 폴더에 두고(원본 경로·크기·수정 시각이 열쇠) 그 뒤로는 그대로 보낸다.
// 편집기 엔진 wasm 17MB → br 4.3MB(만드는 데 1.5초, 한 번). Range 요청·작은 파일·이미 압축된 형식(woff2·png 등)은 express.static 에 맡긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const EXTS = new Set(['.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.wasm', '.ttf', '.otf', '.txt', '.xml', '.map']);
const MIN_SIZE = 1024;
const PRUNE_AGE = 14 * 86400000;
const pending = new Map();
let cacheDir = null;

function dir() {
  if (cacheDir) return cacheDir;
  cacheDir = process.env.HWPX_COWORK_STATIC_CACHE || path.join(os.tmpdir(), 'hwpx-cowork-static');
  fs.mkdirSync(cacheDir, { recursive: true });
  // 오래된 사본(옛 빌드)은 켤 때 지운다 — 아직 쓰는 것이면 다음 요청 때 다시 만든다
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(cacheDir)) {
      const p = path.join(cacheDir, name);
      try { if (now - fs.statSync(p).mtimeMs > PRUNE_AGE) fs.unlinkSync(p); } catch {}
    }
  } catch {}
  return cacheDir;
}

// Accept-Encoding 에서 br > gzip 순으로 고른다(q=0 은 거절로 본다)
export function pickEncoding(header) {
  const ok = new Set();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    ok.add(name.trim());
  }
  return ok.has('br') ? 'br' : ok.has('gzip') ? 'gzip' : null;
}

async function compressedCopy(file, stat, enc) {
  const key = crypto.createHash('sha1').update(`${file}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
  const out = path.join(dir(), `${key}.${enc}`);
  try { return { path: out, size: (await fs.promises.stat(out)).size, key }; } catch {}
  if (!pending.has(out)) {
    const job = (async () => {
      const src = await fs.promises.readFile(file);
      const buf = enc === 'br'
        ? await brotli(src, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length } })
        : await gzip(src, { level: 9 });
      // 다른 서버(시험)와 같은 폴더를 써도 반쯤 쓴 사본을 읽지 않게 임시 이름으로 쓰고 바꾼다
      const tmp = `${out}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, out);
      return { path: out, size: buf.length, key };
    })().finally(() => pending.delete(out));
    pending.set(out, job);
  }
  return pending.get(out);
}

// rootDir 를 express.static 과 같은 자리에 건다. setHeaders(res, file) 는 express.static 에 주는 것과 같은 것(캐시 정책을 한곳에서)
export function compressedStatic(rootDir, { setHeaders } = {}) {
  const base = path.resolve(rootDir);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.includes('\0') || rel.split('/').some((s) => s.startsWith('.'))) return next();
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(base, rel);
    if (!file.startsWith(base + path.sep) || !EXTS.has(path.extname(file).toLowerCase())) return next();
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return next(); }
    if (!stat.isFile() || stat.size < MIN_SIZE) return next();
    res.vary('Accept-Encoding');
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc || req.headers.range) return next();
    let copy;
    try { copy = await compressedCopy(file, stat, enc); } catch { return next(); }
    setHeaders?.(res, file);
    if (!res.getHeader('Content-Type')) res.type(path.extname(file));
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0');
    const etag = `"${copy.key.slice(0, 20)}-${enc}"`;
    res.setHeader('Content-Encoding', enc);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      res.removeHeader('Content-Encoding');
      return res.status(304).end();
    }
    res.setHeader('Content-Length', copy.size);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(copy.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}
