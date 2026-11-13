import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

test('alternate engine and studio are served together from an isolated server', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-engine-preview-'));
  let server;
  try {
    const pkg = path.join(tmp, 'engine-pkg');
    const studio = path.join(tmp, 'studio-dist');
    fs.mkdirSync(pkg); fs.mkdirSync(studio);
    fs.writeFileSync(path.join(pkg, 'preview-marker.txt'), 'selected-engine-package');
    fs.writeFileSync(path.join(studio, 'index.html'), '<!doctype html><title>selected studio</title>');
    server = await startServer({ env: { HWPX_COWORK_ENGINE_PKG: pkg, HWPX_COWORK_STUDIO_DIR: studio } });
    assert.notEqual(server.port, 8787);
    assert.equal(await (await fetch(`${server.base}/vendor/rhwp-core/preview-marker.txt`)).text(), 'selected-engine-package');
    assert.match(await (await fetch(`${server.base}/studio/`)).text(), /selected studio/);
    assert.equal((await fetch(`${server.base}/vendor/rhwp-core/rhwp_bg.wasm`)).status, 404);
    assert.notEqual(path.resolve(server.dataDir), path.resolve('data'));
    assert.notEqual(path.resolve(server.configPath), path.resolve('config.json'));
  } finally {
    await server?.stop();
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('cowork-engine-preview-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
