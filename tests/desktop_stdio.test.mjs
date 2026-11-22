import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DesktopHost } from '../deploy/desktop/host.mjs';
import { personalTransport, savePersonalTransport } from '../deploy/desktop/mode.mjs';
import { pipeFetch, sessionFile } from '../server/desktop-pipe.js';
import { createApiWorker } from '../server/worker.js';
import { CodexProposer } from '../server/codex-ai.js';
import { checkWorkerConnection } from '../scripts/ai-worker.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { root, fixture } from './helpers/server.mjs';

const node = process.env.HWPX_DESKTOP_TEST_NODE || process.execPath;
const payload = process.env.HWPX_DESKTOP_TEST_PAYLOAD || root;
async function client(host, version, scope) {
  const c = new Client({ name: 'cowork-parity', version: '1' });
  const transport = host.portless ? new StdioClientTransport({ command: node, args: [path.join(payload, 'server/personal-stdio.js'),
    '--profile', host.userdata, '--mcp', version, '--tools', scope], stderr: 'pipe' })
    : new StreamableHTTPClientTransport(new URL('/mcp?v=' + version + '&tools=' + scope, host.origin),
      { requestInit: { headers: { Authorization: 'Bearer ' + host.token } } });
  await c.connect(transport);
  return c;
}
async function call(c, name, args) {
  const result = await c.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.content[0].text;
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stdio-test-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  return dir;
}

test('개인 문서함 전환, HTTP와 stdio의 도구·검토·저장 결과, 동시 연결', { timeout: 120000 }, async t => {
  const dir = scratch(t);
  const profile = path.join(dir, '개인 설정'), docs = path.join(dir, '문서');
  fs.mkdirSync(docs);
  const linked = path.join(docs, '검토.hwpx');
  fs.copyFileSync(fixture('tool_memo_tracked.hwpx'), linked);
  assert.equal(personalTransport(profile), 'stdio');
  const legacy = path.join(dir, '기존 설치');
  fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  assert.equal(personalTransport(legacy), 'loopback');
  const catalog = new Map();
  let previousId;
  for (const transport of ['loopback', 'stdio']) {
    savePersonalTransport(profile, transport);
    const host = new DesktopHost({ payload, node, userdata: profile, transport: personalTransport(profile) });
    try {
      await host.start();
      if (transport === 'loopback') await host.linkFolder(docs);
      else {
        assert.equal(host.port, null);
        const denied = await pipeFetch({ ...host.pipe, key: 'incorrect' })(host.origin + '/api/me', { headers: { Authorization: 'Bearer ' + host.token } });
        assert.equal(denied.status, 403);
        const secondOwner = new DesktopHost({ payload, node, userdata: profile, transport: 'stdio' });
        try { await assert.rejects(secondOwner.start()); } finally { await secondOwner.stop(); }
        assert.equal((await host.api('/api/me')).role, 'admin');
      }
      const id = (await host.api('/api/library')).docs.find(d => d.fileName === '검토.hwpx').id;
      if (previousId) assert.equal(id, previousId);
      previousId = id;
      const api = (suffix, body, method = 'POST') => host.api('/api/docs/' + id + suffix, body ? { method, body } : {});
      for (const [version, scope] of [['1', 'all'], ['2', 'core'], ['3', 'core'], ['3', 'all']]) {
        const c = await client(host, version, scope);
        try {
          const key = version + scope;
          const defs = { tools: (await c.listTools()).tools, instructions: c.getInstructions() };
          if (host.portless) assert.deepEqual(defs, catalog.get(key));
          else catalog.set(key, defs);
          if (key !== '3all') continue;
          const p = (await api('/paragraphs')).find(row => row.ref === 's0/p1');
          const read = () => call(c, 'read', { doc_id: id, at: p.ref });
          const before = p.text, proposed = '수동 검토 ' + transport, automatic = '자동 검토 ' + transport;
          const edit = async (find, value) => JSON.parse(await call(c, 'edit', { doc_id: id, ops: [{ op: 'replace', at: p.ref, find, with: value }] })).saved[0];
          const opts = { aiApply: 'manual', editMode: 'realtime', aiQuick: 'compose' };
          await api('/settings', opts, 'PATCH');
          const r = await edit(before, proposed);
          assert.equal((await api('/proposals')).find(row => row.pid === r.pid)?.status, 'pending');
          assert.ok((await read()).includes(before));
          await api('/proposals/' + r.pid + '/apply', {});
          assert.ok((await read()).includes(proposed));
          await api('/settings', { ...opts, aiApply: 'auto' }, 'PATCH');
          const peer = await client(host, '3', 'all');
          try {
            const applied = await edit(proposed, automatic);
            assert.equal((await api('/proposals')).find(row => row.pid === applied.pid)?.status, 'applied');
            assert.ok((await call(peer, 'read', { doc_id: id, at: p.ref })).includes(automatic));
            const labels = ['첫째 의견 ' + transport, '둘째 의견 ' + transport];
            await Promise.all([c, peer].map((session, i) => call(session, 'edit', {
              doc_id: id, ops: [{ op: 'memo', at: p.ref, text: labels[i] }],
            })));
            const memos = JSON.stringify(await api('/memos'));
            for (const label of labels) assert.ok(memos.includes(label));
          } finally { await peer.close(); }
        } finally { await c.close(); }
      }
    } finally { await host.stop(); }
    assert.equal(fs.existsSync(path.join(profile, sessionFile)), false);
    assert.match((await HwpxDoc.load(fs.readFileSync(linked))).text('s0/p1', 'final'), new RegExp('자동 검토 ' + transport));
  }
});

test('포트 없는 개인 실행기에서 Codex 검토 요청을 MCP로 끝까지 처리 (모의 CLI)', { timeout: 75000 }, async t => {
  const dir = scratch(t), docs = path.join(dir, 'docs');
  fs.mkdirSync(docs); fs.copyFileSync(fixture('tool_memo_tracked.hwpx'), path.join(docs, '검토.hwpx'));
  const host = new DesktopHost({ payload, node, userdata: path.join(dir, 'profile'), transport: 'stdio' });
  let worker;
  try {
    await host.start(); await host.linkFolder(docs);
    const doc = (await host.api('/api/library')).docs.find(d => d.fileName === '검토.hwpx');
    const launch = await fakeCodex(dir, { mode: 'v3' });
    const env = { ...process.env, HWPX_COWORK_DESKTOP_PIPE: JSON.stringify(host.pipe), HWPX_COWORK_TOKEN: host.token };
    const ai = new CodexProposer({ model: 'fake-approved-model', effort: 'xhigh', mcp: 'v3' }, { tempRoot: dir, env, resolveCommand: async () => launch });
    worker = createApiWorker({ url: host.localTarget().mcpUrl, token: host.token, ai, fetchImpl: host.fetch, agent: 'ChatGPT (Codex)', clientName: 'hwpx-codex-worker',
      timing: { pollMs: 100, connectTimeoutMs: 3000, callTimeoutMs: 15000, backoffMs: 50 }, log() {} });
    assert.ok((await checkWorkerConnection(worker, { fetchImpl: host.fetch })).toolsReady);
    worker.start();
    const route = '/api/docs/' + doc.id;
    await host.api(route + '/settings', { method: 'PATCH', body: { aiApply: 'manual' } });
    const { request } = await host.api(route + '/requests', { method: 'POST', body: { kind: 'instruct', instruction: '문장을 검토해 주세요.',
      target: { scope: 'document', ref: 's0/p1' }, route: 'queue' } });
    const deadline = Date.now() + 40000;
    while (!worker.stats().completed && !worker.stats().failed && Date.now() < deadline) await delay(100);
    const done = await host.api(route + '/requests/' + request.rid);
    assert.equal(done.status, 'done', JSON.stringify({ status: done.status, error: done.error }));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
    assert.equal(JSON.parse(receipt.config.model_reasoning_effort), 'xhigh');
    assert.equal(done.model, 'fake-approved-model');
    assert.ok((await host.api(route + '/proposals')).some(p => p.status === 'pending'));
  } finally { await worker?.stop(); await host.stop(); }
});
