import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { createWorkerPackage, WORKER_PACKAGE_PREFIX, WORKER_PACKAGE_FILES } from '../server/worker-package.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function cleanup(tmp) {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}

test('개인 실행기 ZIP은 지정 코드와 최소 package/안내만 담고 설정·문서·토큰을 제외한다', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-worker-package-source-'));
  try {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const relative of WORKER_PACKAGE_FILES) {
      fs.mkdirSync(path.dirname(path.join(tmp, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(tmp, relative));
    }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ ...rootPackage, privateSetting: 'NEVER-PACKAGE-SECRET' }));
    fs.mkdirSync(path.join(tmp, 'data')); fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'config.json'), '{"token":"NEVER-CONFIG-TOKEN"}');
    fs.writeFileSync(path.join(tmp, 'data', 'private.txt'), 'NEVER-DOCUMENT');
    fs.writeFileSync(path.join(tmp, '.env'), 'NEVER-API-KEY');
    const zip = await JSZip.loadAsync(await createWorkerPackage(tmp));
    const files = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
    assert.deepEqual(files, [...WORKER_PACKAGE_FILES, 'package.json', 'README.md'].map((file) => WORKER_PACKAGE_PREFIX + file).sort());
    const manifest = JSON.parse(await zip.file(`${WORKER_PACKAGE_PREFIX}package.json`).async('string'));
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, rootPackage.version);
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@modelcontextprotocol/sdk', 'zod']);
    for (const [name, version] of Object.entries(manifest.dependencies)) assert.equal(version, rootPackage.dependencies[name]);
    assert.deepEqual(manifest.scripts, { worker: 'node scripts/ai-worker.mjs', orchestrator: 'node scripts/orchestration-worker.mjs', 'agent:codex': 'node scripts/codex-agent.mjs' });
    for (const entry of Object.values(zip.files).filter((item) => !item.dir)) assert.ok(!(await entry.async('string')).includes('NEVER-'));
    const guide = await zip.file(`${WORKER_PACKAGE_PREFIX}README.md`).async('string');
    assert.match(guide, /본문에 자동 적용하지 않습니다/);
    assert.match(guide, /npm install/);
    assert.match(guide, /--model/);
    assert.match(guide, /서버를 시작할 필요가 없습니다/);
    assert.match(guide, /npm run orchestrator/);
    assert.match(await zip.file(`${WORKER_PACKAGE_PREFIX}docs/MULTI_AGENT_ORCHESTRATION.md`).async('string'), /claim_orchestration_task/);
  } finally { cleanup(tmp); }
});

test('생성한 ZIP을 실제 추출하면 코드 구문과 키·서버 없는 --help가 동작한다', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-worker-package-extract-'));
  const packageRoot = path.join(tmp, 'hwpx-ai-worker');
  const dependencies = path.join(packageRoot, 'node_modules');
  try {
    const zip = await JSZip.loadAsync(await createWorkerPackage(root));
    for (const entry of Object.values(zip.files)) {
      const destination = path.resolve(tmp, entry.name);
      assert.ok(destination.startsWith(path.resolve(tmp) + path.sep));
      if (entry.dir) fs.mkdirSync(destination, { recursive: true });
      else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, await entry.async('nodebuffer')); }
    }
    for (const relative of WORKER_PACKAGE_FILES.filter(file => /\.m?js$/.test(file))) execFileSync(process.execPath, ['--check', path.join(packageRoot, relative)], { encoding: 'utf8', windowsHide: true });
    // npm install 없이 오프라인 import를 시험한다. ZIP에는 의존성 디렉터리가 없음을 먼저 확인한다.
    assert.equal(fs.existsSync(dependencies), false);
    fs.symlinkSync(path.join(root, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HWPX_COWORK_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|GEMINI_API_KEY$|GOOGLE_API_KEY$)/i.test(key)));
    const output = execFileSync(process.execPath, ['scripts/ai-worker.mjs', '--help'], { cwd: packageRoot, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.match(output, /개인 AI 자동 처리 실행기/);
    assert.match(output, /--provider openai\|anthropic\|gemini/);
    assert.match(output, /--model/);
    const orchestrationHelp = execFileSync(process.execPath, ['scripts/orchestration-worker.mjs', '--help'], { cwd: packageRoot, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.match(orchestrationHelp, /--agent-id/);
    assert.match(orchestrationHelp, /--gateway baze/);
  } finally {
    // 시험용 의존성 junction만 해제한다. 원본 node_modules에 대한 삭제·이동은 하지 않는다.
    if (fs.existsSync(dependencies)) fs.unlinkSync(dependencies);
    cleanup(tmp);
  }
});

test('CLI --out은 지정한 ZIP만 만들고 생성한 내용은 동일한 allowlist를 따른다', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-worker-package-cli-'));
  try {
    const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'package-worker.mjs'), '--out', 'download.zip'], { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.match(output, /ZIP 생성/);
    assert.deepEqual(fs.readdirSync(tmp), ['download.zip']);
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(tmp, 'download.zip')));
    assert.equal(Object.values(zip.files).filter((entry) => !entry.dir).length, WORKER_PACKAGE_FILES.length + 2);
  } finally { cleanup(tmp); }
});
