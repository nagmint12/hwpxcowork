// 실제 Vue 템플릿과 저장 요청을 SSR로 검사한다. 브라우저·사용자 설정·실제 API는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSSRApp, compile } from 'vue';
import { renderToString } from '@vue/server-renderer';

const source = fs.readFileSync(new URL('../web/personal-ai.js', import.meta.url), 'utf8')
  .replace("from '/vendor/vue.esm-browser.prod.js'", `from '${import.meta.resolve('vue')}'`)
  .replace("import { state, api, toast, toastError, fmt } from './util.js';", `
    export const harness = { state: { me: { personalAi: { configured: false } } }, calls: [] };
    const state = harness.state, toast = () => {}, toastError = e => { throw e; }, fmt = v => v;
    const api = async (url, options = {}) => {
      harness.calls.push({ url, ...options });
      if (options.method === 'PUT') return { ...options.body, key: undefined, configured: true, active: true, keyHint: null };
      return {};
    };`)
  .replace("import { AdminCreditsPanel } from './admin-credits.js';", 'const AdminCreditsPanel = {};');
const ui = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
async function renderPanel(status = { configured: false }) {
  ui.harness.state.me.personalAi = status;
  let panel;
  const component = { ...ui.PersonalAiPanel, setup() { panel = ui.PersonalAiPanel.setup(); return panel; } };
  return { html: await renderToString(createSSRApp(component)), panel };
}

test('내 AI 패널: 로컬 연결 선택 후 주소·선택 키 표시와 저장 payload', async () => {
  assert.doesNotThrow(() => compile(ui.PersonalAiPanel.template, { onError: e => { throw e; } }));
  ui.harness.calls.length = 0;
  const { panel, html } = await renderPanel();
  assert.match(html, /로컬 AI · OpenAI 호환 API/);
  panel.f.key = 'cloud-key-should-clear';
  panel.f.choice = 'local-openai'; panel.pick();
  assert.equal(panel.f.baseUrl, 'http://localhost:1234/v1');
  assert.equal(panel.f.key, '');
  panel.f.model = 'qwen/qwen3.8-27b';
  await panel.save();
  assert.deepEqual(ui.harness.calls[0], { url: '/api/me/ai', method: 'PUT', body: { gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.8-27b', effort: null } });
  const saved = await renderPanel(ui.harness.state.me.personalAi);
  assert.match(saved.html, /aria-label="로컬 API 주소"/);
  assert.match(saved.html, /API 키\(선택\)/);
  assert.match(saved.html, /서버가 실행되는 PC/);
  assert.doesNotMatch(saved.html, /키 null/);
  assert.equal(saved.panel.f.model, 'qwen/qwen3.8-27b');
});

test('로컬에서 API 연결로 바꾸면 주소·키를 전송하지 않고 기존 형식 유지', async () => {
  const { panel } = await renderPanel({ gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:4321/v1', model: 'm', configured: true, keyHint: null });
  panel.f.choice = 'baze-openai'; panel.pick();
  ui.harness.calls.length = 0;
  await panel.save();
  assert.deepEqual(ui.harness.calls[0].body, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' });
});

test('튜토리얼 공유 로컬 API는 관리자 연결로 표시하며 설정 폼을 숨긴다', async () => {
  const { html } = await renderPanel({ configured: true, shared: true, active: true, gateway: 'local', provider: 'openai', model: 'qwen/qwen3.8-27b' });
  assert.match(html, /관리자가 공유한 API/); assert.match(html, /로컬 AI/);
  assert.doesNotMatch(html, /personal-ai-save/);
});

test('내 AI 키는 선택·사용료 별도로 접어 두고, 기본(내 PC의 Codex·Claude Code)을 먼저 말한다(2026-11-13)', async () => {
  const { html } = await renderPanel({ configured: false });
  const details = html.match(/<details[^>]*data-testid="personal-ai"[^>]*>/)?.[0] || '';
  assert.ok(details, html.slice(0, 200));
  assert.doesNotMatch(details, /\sopen/, '등록 전이어도 처음부터 펼치지 않는다');
  assert.match(html, /선택 · 사용료 별도/);
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(text.indexOf('Codex·Claude Code') >= 0 && text.indexOf('Codex·Claude Code') < text.indexOf('API 키'), '구독 AI 를 먼저 안내');
});
