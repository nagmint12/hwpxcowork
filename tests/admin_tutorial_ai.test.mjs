// 관리자 '튜토리얼 AI' 설정(server/admin-tutorial-ai.js): 선택지 상태·저장(파일 + 실행 중 설정)·판 검사. 실제 AI 를 부르지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminTutorialAi } from '../server/admin-tutorial-ai.js';
import { tutorialConfig } from '../server/tutorial.js';

test('모르는 튜토리얼 연결 ID(예전 ID 포함)는 고르지 않은 것으로 보고 원본 설정은 보존한다', () => {
  const config = { tutorial: { provider: 'old-provider-id', shareFrom: ['관리자'] } };
  const normalized = tutorialConfig(config);
  assert.equal(normalized.provider, null);
  assert.equal(config.tutorial.provider, 'old-provider-id');
  assert.equal(tutorialConfig({ tutorial: { provider: 'api', shareFrom: ['관리자'] } }).provider, 'api');
});

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-admin-tutorial-ai-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const configFile = path.join(tmp, 'config.json');
  const raw = { port: 1, users: [{ name: '관리자', token: 'admin-token', role: 'admin' }], tutorial: { shareFrom: ['관리자'], shareAgent: 'hwpx-api-worker' } };
  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2));
  const config = { configFile, users: raw.users, tutorial: { ...raw.tutorial } };
  let sessions = [];
  const service = {
    personalAi: { status: ({ name }) => name === '관리자' ? { configured: true, active: true, gateway: 'local', model: 'qwen', baseUrl: 'http://localhost:1234/v1' } : { configured: false } },
    agents: { sessions: () => sessions },
    tutorialChatGPTReady: () => false,
  };
  return { configFile, config, service, setSessions: (v) => { sessions = v; }, admin: createAdminTutorialAi({ config, service }) };
}

test('선택지마다 지금 쓸 수 있는지 보여 주고, 고르면 파일과 실행 중 설정에 바로 반영한다', async (t) => {
  const s = setup(t);
  let snap = s.admin.snapshot();
  assert.equal(snap.provider, null);
  assert.equal(snap.legacy.shareAgent, 'hwpx-api-worker');
  const by = (id) => snap.options.find((o) => o.id === id);
  assert.deepEqual(snap.options.map((o) => o.id), ['api', 'local', 'chatgpt', 'codex', 'claude-code']);
  assert.equal(by('local').ready, true); assert.equal(by('api').ready, false);
  assert.equal(by('claude-code').ready, false); assert.equal(by('chatgpt').ready, false);
  s.setSessions([{ session: 'cc', agent: 'Claude Code', client: 'claude-code/2.1.319', channel: true }]);
  snap = s.admin.snapshot();
  assert.equal(by('claude-code').ready, true); assert.equal(by('codex').ready, false);

  snap = s.admin.save('claude-code', snap.revision);
  assert.equal(snap.provider, 'claude-code');
  assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).tutorial.provider, 'claude-code');
  assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).tutorial.shareAgent, 'hwpx-api-worker');   // 예전 값은 남긴다
  const live = tutorialConfig(s.config);
  assert.deepEqual([live.provider, live.providerKind, live.shareApi, live.shareAgent, live.shareChatGPT.size], ['claude-code', 'agent', 'none', ['claude-code'], 0]);

  assert.throws(() => s.admin.save('local', 'f'.repeat(64)), { code: 'CONFIG_CHANGED' });
  assert.throws(() => s.admin.save('gpt', snap.revision), { code: 'INVALID_TUTORIAL_AI' });
  snap = s.admin.save(null, snap.revision);
  assert.equal(snap.provider, null);
  assert.equal('provider' in JSON.parse(fs.readFileSync(s.configFile, 'utf8')).tutorial, false);
  assert.equal(tutorialConfig(s.config).shareAgent, 'hwpx-api-worker');
});
