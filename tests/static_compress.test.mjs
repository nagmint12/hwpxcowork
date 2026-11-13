// 정적 파일 압축 전달·캐시 정책(server/static-compress.js) — 임시 편집기 폴더로 서버를 띄워 원시 응답을 본다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer } from './helpers/server.mjs';
import { pickEncoding } from '../server/static-compress.js';

function get(base, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(new URL(p, base), { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('pickEncoding: br > gzip, q=0 은 거절', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('편집기 파일: 압축 전달 + 해시 파일 1년·글꼴 30일·나머지 no-cache', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-static-'));
  const studio = path.join(tmp, 'studio');
  const big = 'console.log("한글 편집기");\n'.repeat(4000);
  fs.mkdirSync(path.join(studio, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(studio, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(studio, 'index.html'), `<!doctype html><script src="/studio/assets/index-abc.js"></script>${'<!-- pad -->'.repeat(200)}`);
  fs.writeFileSync(path.join(studio, 'assets', 'index-abc.js'), big);
  fs.writeFileSync(path.join(studio, 'assets', 'engine-abc.wasm'), Buffer.alloc(50000, 7));
  fs.writeFileSync(path.join(studio, 'fonts', 'Test.ttf'), Buffer.alloc(30000, 3));
  fs.writeFileSync(path.join(studio, 'fonts', 'Test.woff2'), Buffer.alloc(30000, 3));
  const srv = await startServer({ env: { HWPX_COWORK_STUDIO_DIR: studio, HWPX_COWORK_STATIC_CACHE: path.join(tmp, 'cache') } });
  t.after(async () => { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const js = await get(srv.base, '/studio/assets/index-abc.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-encoding'], 'br');
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(js.headers.vary, /Accept-Encoding/i);
  assert.equal(zlib.brotliDecompressSync(js.body).toString(), big);
  assert.ok(js.body.length < big.length / 10);

  // 같은 ETag 로 다시 물으면 304
  const again = await get(srv.base, '/studio/assets/index-abc.js', { 'accept-encoding': 'br', 'if-none-match': js.headers.etag });
  assert.equal(again.status, 304);

  const gz = await get(srv.base, '/studio/assets/index-abc.js', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString(), big);
  assert.notEqual(gz.headers.etag, js.headers.etag);

  const plain = await get(srv.base, '/studio/assets/index-abc.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), big);
  assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');

  const wasm = await get(srv.base, '/studio/assets/engine-abc.wasm', { 'accept-encoding': 'br' });
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  assert.equal(wasm.headers['content-encoding'], 'br');
  assert.equal(zlib.brotliDecompressSync(wasm.body).length, 50000);

  const ttf = await get(srv.base, '/studio/fonts/Test.ttf', { 'accept-encoding': 'br' });
  assert.equal(ttf.headers['content-encoding'], 'br');
  assert.equal(ttf.headers['cache-control'], 'public, max-age=2592000');
  const woff2 = await get(srv.base, '/studio/fonts/Test.woff2', { 'accept-encoding': 'br' });
  assert.equal(woff2.headers['content-encoding'], undefined);
  assert.equal(woff2.headers['cache-control'], 'public, max-age=2592000');

  for (const p of ['/studio/', '/studio/index.html']) {
    const html = await get(srv.base, p, { 'accept-encoding': 'br' });
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-encoding'], 'br');
    assert.equal(html.headers['cache-control'], 'no-cache');
    assert.match(zlib.brotliDecompressSync(html.body).toString(), /index-abc\.js/);
  }

  // 범위 요청·폴더 밖·없는 파일은 압축하지 않는다
  const range = await get(srv.base, '/studio/assets/index-abc.js', { 'accept-encoding': 'br', range: 'bytes=0-9' });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-encoding'], undefined);
  assert.equal((await get(srv.base, '/studio/assets/none.js', { 'accept-encoding': 'br' })).status, 404);
  assert.notEqual((await get(srv.base, '/studio/..%2f..%2fpackage.json', { 'accept-encoding': 'br' })).status, 200);

  // 웹 화면 파일도 압축(캐시는 예전대로 매번 확인)
  const app = await get(srv.base, '/app.js', { 'accept-encoding': 'br' });
  assert.equal(app.headers['content-encoding'], 'br');
  assert.equal(app.headers['cache-control'], 'public, max-age=0');
});
