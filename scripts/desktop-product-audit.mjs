import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { patchesForStudio } from '../studio/build/patches.mjs';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function auditDesktopProduct({ payload, studioDir, enginePkg, root }) {
  const build = JSON.parse(fs.readFileSync(path.join(payload, 'studio/dist/cowork-build.json'), 'utf8'));
  assert.equal(build.plugin?.id, 'cowork', 'Desktop must include the cowork plugin');
  const expected = patchesForStudio(path.join(root, 'vendor/rhwp/rhwp-studio')).map(p => p.id).sort();
  assert.deepEqual(build.patches.map(p => p.id).sort(), expected, 'Desktop must use the complete current web patch set');
  const files = [];
  const visit = (source, relative) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name), name = relative + '/' + entry.name;
      // package-portable과 같은 배포 범위: 철회된 HFT 실험 보고서는 제품 자산이 아니다.
      // web/teaser·teaser3(체험 소개 화면)도 2026-11-16 부터 package-portable 이 묶지 않는다(TREE_EXCLUDE)
      // web/icons/hwpx-cowork.icns(Mac 앱 아이콘, 2026-11-18)도 package-portable 이 서버·Windows 묶음에서 뺀다
      if (/^web\/(quick|tutorial-media|teaser3?|reports\/hft-native-20261106)(\/|$)/.test(name) || /^web\/icons\/hwpx-cowork\.icns$/.test(name) || /^studio\/dist\/samples(\/|$)/.test(name) || /(^|\/)__pycache__(\/|$)/.test(name)) continue;
      if (entry.isDirectory()) { visit(from, name); continue; }
      if (/\.(map|pyc)$/.test(name) || /(^|\/)\.DS_Store$/.test(name) || /^studio\/dist\/rhwp(\.js|\.d\.ts|_bg\.wasm\.d\.ts)$/.test(name)) continue;
      const to = path.join(payload, name);
      assert(fs.existsSync(to), 'Missing web product file: ' + name);
      const hash = sha(from); assert.equal(sha(to), hash, 'Different web product file: ' + name);
      files.push({ file: name, sha256: hash });
    }
  };
  visit(path.join(root, 'web'), 'web');
  visit(studioDir, 'studio/dist');
  const wasmSha256 = sha(path.join(enginePkg, 'rhwp_bg.wasm'));
  assert.equal(sha(path.join(payload, 'vendor/rhwp/pkg/rhwp_bg.wasm')), wasmSha256);
  assert.equal(sha(path.join(payload, 'studio/dist/rhwp_bg.wasm')), wasmSha256);
  for (const required of ['server/index.js', 'server/service.js', 'server/local-folders.js', 'engine/doc.js', 'web/app.js']) {
    assert(fs.existsSync(path.join(payload, required)), 'Missing cowork component: ' + required);
  }
  return { product: 'Hwpx Cowork', frontend: 'full-web-product', coworkPlugin: true,
    editorPatches: expected, wasmSha256, files, sourceFileCount: files.length,
    capabilities: ['document-library', 'local-folders', 'editor', 'comments', 'tracked-changes', 'review-proposals', 'collaboration', 'export'],
    realMacTested: false, published: false };
}
