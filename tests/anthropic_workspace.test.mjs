// Claude API 워크스페이스 ID(2026-11-10): 계정·서비스 계정 연결형 키(sk-ant-usr-·sk-ant-svc…)는 anthropic-workspace-id 머리글이 있어야 생성이 된다.
// 실제 API 는 부르지 않는다(가짜 fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiProposer } from '../server/ai.js';
import { createPersonalAi } from '../server/personal-ai.js';

const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
const input = { kind: 'instruct', preset: null, label: '지시', instruction: '다듬어 줘', target: { ref: 's0/p0', start: 0, end: 1, text: '가' }, context: [], tables: [], attachments: [], options: { count: 1 } };
const final = { proposals: [], alternatives: [], comments: [{ ref: 's0/p0', text: '의견' }], inserts: [], formats: [], tables: [], summary: '완료', instructionSummary: '' };

test('워크스페이스 ID 가 있으면 생성·모델 조회에 머리글을 붙인다', async () => {
  const seen = [];
  const ai = new AiProposer({ ai: { provider: 'anthropic', model: 'claude-opus-5-5', enabled: true, anthropicWorkspaceId: 'wrkspc_01TestWorkspace' } }, { key: 'sk-ant-svc01-fake-key', fetch: async (url, init) => {
    seen.push(init.headers);
    if (String(url).includes('/v1/models/')) return ok({ id: 'claude-opus-5-5' });
    return ok({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(final) }], usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  await ai.checkModel();
  await ai.run(input).catch(() => {});   // 결과 모양은 이 시험의 관심이 아니다 — 보낸 머리글만 본다
  assert.ok(seen.length >= 2);
  for (const h of seen) { assert.equal(h['anthropic-workspace-id'], 'wrkspc_01TestWorkspace'); assert.equal(h['anthropic-version'], '2023-06-01'); }
});

test('계정·서비스 계정 연결형 키에 워크스페이스 ID 가 없으면 연결 확인과 400 을 그 이유로 알린다', async () => {
  const ai = new AiProposer({ ai: { provider: 'anthropic', model: 'claude-opus-5-5', enabled: true } }, { key: 'sk-ant-usr01-fake-key', fetch: async () => new Response('{"type":"error"}', { status: 400 }) });
  assert.equal(ai.needsAnthropicWorkspace, true);
  await assert.rejects(ai.checkModel(), /워크스페이스 ID/);
  await assert.rejects(ai.run(input), (e) => e.code === 'API_WORKSPACE_REQUIRED');
  // 일반 키(sk-ant-api…)는 해당 없음
  assert.equal(new AiProposer({ ai: { provider: 'anthropic', enabled: true } }, { key: 'sk-ant-api03-fake' }).needsAnthropicWorkspace, false);
});

test('내 AI 키: Claude 직접 연결에만 워크스페이스 ID 를 저장하고 형식을 검사한다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-ws-'));
  try {
    const config = { dataDir: tmp, configFile: path.join(tmp, 'config.json'), ai: {} };
    const p = createPersonalAi({ config, secretFile: path.join(tmp, 'secret') });
    const u = { name: '갑' };
    assert.throws(() => p.save(u, { provider: 'anthropic', gateway: 'direct', model: 'claude-opus-5-5', key: 'sk-ant-svc01-fake-key', anthropicWorkspaceId: 'ws-1' }), /wrkspc_/);
    let st = p.save(u, { provider: 'anthropic', gateway: 'direct', model: 'claude-opus-5-5', key: 'sk-ant-svc01-fake-key', anthropicWorkspaceId: 'wrkspc_01TestWorkspace' });
    assert.equal(st.anthropicWorkspaceId, 'wrkspc_01TestWorkspace');
    assert.equal(p.forUser('갑').cfg.anthropicWorkspaceId, 'wrkspc_01TestWorkspace');
    // 키·워크스페이스를 안 보내면 그대로, 빈 값이면 지운다
    st = p.save(u, { provider: 'anthropic', gateway: 'direct', model: 'claude-opus-5-5' });
    assert.equal(st.anthropicWorkspaceId, 'wrkspc_01TestWorkspace');
    st = p.save(u, { provider: 'anthropic', gateway: 'direct', model: 'claude-opus-5-5', anthropicWorkspaceId: '' });
    assert.equal(st.anthropicWorkspaceId, undefined);
    // 다른 연결에는 저장하지 않는다
    st = p.save(u, { provider: 'openai', gateway: 'baze', model: 'gpt-6.1-sol', key: 'fake-baze-key', anthropicWorkspaceId: 'wrkspc_01TestWorkspace' });
    assert.equal(st.anthropicWorkspaceId, undefined);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
