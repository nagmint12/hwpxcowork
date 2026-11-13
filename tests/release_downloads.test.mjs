import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { installReleaseDownloads } from '../server/release-downloads.js';

test('download: latest release manifest only, file size check and no private/artifact traversal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-download-'));
  const dir = path.join(root, 'artifacts/release-20261031');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'hwpx-ai-worker-0.4.0-20261031-install.zip';
  const bytes = Buffer.from('release package');
  fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"private":true}');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'private');
  const p = { file: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.4.0', packages: [p, { ...p, file: 'config.json' }] }));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${p.sha256}  ${name}\n`);
  const app = express();
  installReleaseDownloads(app, { root });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/download`;
  try {
    const index = await fetch(base);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes(`/download/${name}`));
    assert.ok(!html.includes('config.json'));
    const download = await fetch(`${base}/${name}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(await download.text(), bytes.toString());
    for (const file of ['config.json', '.hwpx-cowork-secret', '..%2fsecret.txt', 'missing.zip']) assert.equal((await fetch(`${base}/${file}`)).status, 404, file);
    assert.equal((await fetch(`${base}/release.json`)).status, 200);
    assert.equal((await fetch(`${base}/SHA256SUMS.txt`)).status, 200);
    fs.appendFileSync(path.join(dir, name), 'corrupt');
    assert.equal((await fetch(`${base}/${name}`)).status, 404, '목록과 다른 파일 크기는 내려주지 않음');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download: 통합 묶음 하나만 보이고, 지난 릴리즈 파일 주소는 안내 페이지로 보냄', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-download-'));
  const old = path.join(root, 'artifacts/release-20261031');
  const dir = path.join(root, 'artifacts/release-20261104');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(old, 'hwpx-ai-worker-0.4.0-20261031-install.zip'), 'old');
  fs.writeFileSync(path.join(old, 'release.json'), JSON.stringify({ version: '0.4.0', packages: [] }));
  const name = 'hwpx-cowork-0.4.0-20261104.zip';
  const bytes = Buffer.from('bundle package');
  fs.writeFileSync(path.join(dir, name), bytes);
  const p = { file: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), title: '서버·개인 AI 실행기·참여자 앱' };
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.4.0', releasedOn: '2026-11-04', notes: ['<b>안내</b> 한 줄'], packages: [p] }));
  const app = express();
  installReleaseDownloads(app, { root });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/download`;
  try {
    const html = await (await fetch(base)).text();
    assert.equal((html.match(/class="btn"/g) || []).length, 1, '내려받기 단추는 하나');
    assert.ok(html.includes(`/download/${name}`) && html.includes('2026-11-04') && html.includes('&lt;b&gt;안내'), '명세의 안내 문장은 글로만');
    assert.ok(!html.includes('20261031'), '지난 릴리즈 파일은 목록에 없음');
    for (const oldName of ['hwpx-ai-worker-0.4.0-20261031-install.zip', 'hwpx-cowork-server-0.4.0-20261031-lite.tar.gz', 'hwpx-cowork-user-app-0.4.0-20261031.zip']) {
      const r = await fetch(`${base}/${oldName}`, { redirect: 'manual' });
      assert.equal(r.status, 302, oldName);
      assert.equal(r.headers.get('location'), '/download');
    }
    const download = await fetch(`${base}/${name}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), bytes.toString());
    for (const file of ['config.json', 'missing.zip', 'hwpx-cowork-0.4.0.zip']) assert.equal((await fetch(`${base}/${file}`, { redirect: 'manual' })).status, 404, file);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download: unpublished release returns a clear 503 without filesystem details', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-download-'));
  const app = express();
  installReleaseDownloads(app, { root });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/download`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'RELEASE_NOT_PUBLISHED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download: Android APK appears with the PC bundle and supports a correctly typed download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-download-apk-'));
  const dir = path.join(root, 'artifacts/release-20261104');
  fs.mkdirSync(dir, { recursive: true });
  const fixtures = [
    { file: 'hwpx-cowork-0.5.0-20261104.zip', title: 'PC용 통합 묶음', data: Buffer.from('PC bundle') },
    { file: 'hwp-document-lite-1.0.0.apk', title: '한글 문서 Lite · Android 8 이상', data: Buffer.from('APK release bytes') },
    { file: 'rhwp-editor-1.0.0.apk', title: 'rhwp 원래 편집기 · Android 8 이상', data: Buffer.from('rhwp editor APK bytes') },
    { file: 'hwpx-cowork-1.0.3.apk', title: 'Hwpx-Cowork · Android 8 이상', data: Buffer.from('renamed cowork APK bytes') },
  ];
  const packages = fixtures.map(({ file, title, data }) => {
    fs.writeFileSync(path.join(dir, file), data);
    return { file, title, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
  fs.writeFileSync(path.join(dir, 'private.apk'), 'not a release');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.5.0', packages: [...packages, { ...packages[1], file: 'private.apk' }] }));
  const app = express();
  installReleaseDownloads(app, { root });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/download`;
  try {
    const html = await (await fetch(base)).text();
    assert.ok(html.includes('한글 문서 Lite'));
    for (const p of packages) assert.ok(html.includes(`/download/${p.file}`));
    assert.ok(!html.includes('private.apk'));
    const response = await fetch(`${base}/${packages[1].file}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/vnd\.android\.package-archive/);
    assert.match(response.headers.get('content-disposition'), /attachment;.*hwp-document-lite-1\.0\.0\.apk/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtures[1].data);
    const rhwp = await fetch(`${base}/${packages[2].file}`);
    assert.equal(rhwp.status, 200);
    assert.match(rhwp.headers.get('content-type'), /^application\/vnd\.android\.package-archive/);
    assert.deepEqual(Buffer.from(await rhwp.arrayBuffer()), fixtures[2].data);
    const cowork = await fetch(`${base}/${packages[3].file}`);
    assert.equal(cowork.status, 200);
    assert.match(cowork.headers.get('content-type'), /^application\/vnd\.android\.package-archive/);
    assert.deepEqual(Buffer.from(await cowork.arrayBuffer()), fixtures[3].data);
    const part = await fetch(`${base}/${packages[1].file}`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'APK');
    for (const file of ['private.apk', 'hwp-document-lite-latest.apk', 'rhwp-editor-latest.apk', 'hwpx-cowork-latest.apk', 'hwpx-cowork-1.0.apk', '..%2fprivate.apk']) {
      assert.equal((await fetch(`${base}/${file}`, { redirect: 'manual' })).status, 404);
    }
    const old = await fetch(`${base}/hwp-document-lite-0.9.0.apk`, { redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/download');
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
