// 포터블 배치의 실제 Windows 인자 전달을 모델·서버 호출 없이 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('포터블 Claude 시작은 채널 등록 없이 구독 실행기를 고정하고 점검 옵션·주소·종료 코드를 보존한다', { skip: process.platform !== 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-claude launcher-'));
  try {
    fs.mkdirSync(path.join(temp, 'app', 'portable'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'app', 'scripts'), { recursive: true });
    fs.copyFileSync(new URL('../deploy/portable/worker/start-claude-agent.bat', import.meta.url), path.join(temp, 'start-claude-agent.bat'));
    fs.writeFileSync(path.join(temp, 'app', 'portable', 'ensure-node.cmd'), `@echo off\r\nset "NODE=${process.execPath}"\r\nexit /b 0\r\n`);
    fs.writeFileSync(path.join(temp, 'worker-settings.txt'), 'HWPX_COWORK_URL=https://central.invalid/mcp\r\nWORKER_ARGS=--provider openai\r\nWORKER_KEY_ENV=OPENAI_API_KEY\r\n');
    fs.writeFileSync(path.join(temp, 'app', 'scripts', 'ai-worker.mjs'), `import fs from 'node:fs'; fs.writeFileSync(process.env.TEST_RECEIPT, JSON.stringify({args: process.argv.slice(2), url: process.env.HWPX_COWORK_URL})); process.exit(7);`);
    const receipt = path.join(temp, 'receipt.json');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(temp, 'start-claude-agent.bat')}" --check --model sonnet --provider openai"`], {
      encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
      env: { ...process.env, HWPX_COWORK_TOKEN: 'fake-own-token', HWPX_COWORK_URL: 'https://stale.invalid/mcp', TEST_RECEIPT: receipt },
    });
    assert.equal(result.status, 7, result.stdout + result.stderr);
    const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(saved.args, ['--check', '--model', 'sonnet', '--provider', 'openai', '--provider', 'claude-code']);
    assert.equal(saved.url, 'https://central.invalid/mcp');
    assert.equal(fs.existsSync(path.join(temp, 'claude-agent')), false, '개발 채널 작업공간을 만들지 않는다');
    assert.ok(!result.stdout.includes('fake-own-token'));
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.match(path.basename(temp), /^hwpx-claude launcher-/);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
