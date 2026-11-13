// 브라우저 없이 실제 Vue 템플릿 렌더링과 자동/수동 선택의 저장 요청을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSSRApp, compile } from 'vue';
import { renderToString } from '@vue/server-renderer';

const source = fs.readFileSync(new URL('../web/personal-ai.js', import.meta.url), 'utf8');
const moduleSource = source
  .replace("from '/vendor/vue.esm-browser.prod.js'", `from '${import.meta.resolve('vue')}'`)
  .replace("import { state, api, toast, toastError, fmt } from './util.js';", `
    export const harness = { response: null, calls: [] };
    const state = {}; const toast = () => {}; const toastError = e => { throw e; }; const fmt = v => v || '';
    const api = async (url, options = {}) => {
      harness.calls.push({ url, ...options });
      if (options.body) { const { kind, ...settings } = options.body; harness.response.settings[kind] = settings; }
      return structuredClone(harness.response);
    };`)
  .replace("import { AdminCreditsPanel } from './admin-credits.js';", 'const AdminCreditsPanel = {};');
const ui = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const view = admin => ({ kinds: [{ id: 'codex', label: 'Codex (ChatGPT 로그인)', efforts: ['low', 'high'],
  applies: 'request', start: 'start-codex-agent.bat', models: [{ id: 'judge-model', efforts: ['low', 'high'] }],
  ...(admin ? { canSelectModel: true } : {}) }], settings: { codex: { model: 'judge-model', effort: 'high', ...(admin ? { modelSelection: 'auto' } : {}) } } });

async function renderPanel(response) {
  let state;
  const component = { ...ui.AiRunPanel, setup() {
    state = ui.AiRunPanel.setup(); state.view.value = structuredClone(response);
    for (const kind of response.kinds) state.form[kind.id] = { model: response.settings[kind.id]?.model || '',
      effort: response.settings[kind.id]?.effort || '', modelSelection: response.settings[kind.id]?.modelSelection || 'manual' };
    return state;
  } };
  const html = await renderToString(createSSRApp(component));
  return { state, html };
}

test('관리자 자동 선택을 표시하고 수동 전환·모델 변경 저장 때 선택 방식을 함께 보낸다', async () => {
  assert.doesNotThrow(() => compile(ui.AiRunPanel.template, { onError: e => { throw e; } }));
  ui.harness.response = view(true); ui.harness.calls.length = 0;
  const { state, html } = await renderPanel(ui.harness.response);
  assert.match(html, /Codex 자동 선택/); assert.match(html, /Codex가 자동 선택/); assert.match(html, /checked/);
  assert.match(html, /판단 단계도 Codex 사용량에 포함/);
  state.form.codex.modelSelection = 'manual'; await state.save(state.view.value.kinds[0]);
  assert.deepEqual(ui.harness.calls[0], { url: '/api/me/ai-run', method: 'PUT', body: { kind: 'codex', model: 'judge-model', effort: 'high', modelSelection: 'manual' } });
  assert.equal(state.form.codex.modelSelection, 'manual'); assert.match(state.summary.value, /judge-model·high/);
  assert.doesNotMatch((await renderPanel(ui.harness.response)).html, /checked/);
});

test('일반 참여자는 기존 모델 선택 화면과 저장 형식을 유지한다', async () => {
  ui.harness.response = view(false); ui.harness.calls.length = 0;
  const { state, html } = await renderPanel(ui.harness.response);
  assert.doesNotMatch(html, /Codex가 자동 선택|판단 단계도 Codex 사용량/);
  await state.save(state.view.value.kinds[0]);
  assert.deepEqual(ui.harness.calls[0].body, { kind: 'codex', model: 'judge-model', effort: 'high' });
});
