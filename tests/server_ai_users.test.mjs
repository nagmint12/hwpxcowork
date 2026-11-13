// 공용 서버 AI(서버에 둔 API 키)의 계정별 허용(2026-11-10): config.users[].serverAi, config.ai.restrictUsers,
// 관리자 '사용자' 탭의 서버 AI 칸(PATCH /api/admin/users/:name { serverAi }), /api/me 의 serverAi, 요청 경로 결정.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serverAiRestricted, serverAiAllowed } from '../server/config.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { Service } from '../server/service.js';

test('제한 여부: restrictUsers 가 정하고, 없으면 실제 키가 있을 때만 제한', () => {
  const users = [{ name: '갑', serverAi: true }, { name: '을' }, { name: '관리자', role: 'admin' }];
  const real = { enabled: true, key: 'sk-test', mock: false };
  const mock = { enabled: true, mock: true };
  const keyless = { enabled: true, key: null, mock: false };   // 키 없는 로컬 모델(noAuth)
  assert.equal(serverAiRestricted({ ai: {}, users }, real), true);
  assert.equal(serverAiRestricted({ ai: {}, users }, mock), false);
  assert.equal(serverAiRestricted({ ai: {}, users }, keyless), false);
  assert.equal(serverAiRestricted({ ai: { restrictUsers: true }, users }, mock), true);
  assert.equal(serverAiRestricted({ ai: { restrictUsers: false }, users }, real), false);
  const cfg = { ai: {}, users };
  assert.equal(serverAiAllowed(cfg, real, '갑'), true);
  assert.equal(serverAiAllowed(cfg, real, '을'), false);
  assert.equal(serverAiAllowed(cfg, real, '관리자'), false, '관리자도 따로 허용해야 한다');
  assert.equal(serverAiAllowed(cfg, real, '없는 사람'), false);
  assert.equal(serverAiAllowed(cfg, real, ''), false);
  assert.equal(serverAiAllowed(cfg, mock, '을'), true, '제한하지 않으면 누구나');
});

test('서버: 허용한 계정만 서버 AI 로 처리, 관리자 칸으로 켜고 끄면 바로 적용', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-srvai-'));
  const srv = await startServer({
    ai: 'mock',
    users: [{ name: '관리자', role: 'admin' }, { name: '홍길동', role: 'editor', serverAi: true }, { name: '김검토', role: 'editor' }],
    config: { ai: { enabled: false, mock: false, keyFile: path.join(tmp, 'no-such-key.txt'), model: 'claude-opus-5-5', maxProposals: 10, restrictUsers: true } },
  });
  try {
    const bytes = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));
    const send = async (who) => {
      const up = await uploadDoc(srv.base, srv.tokens[who], bytes);
      return srv.api(who).res(`/api/docs/${up.id}/requests`, { method: 'POST', body: { kind: 'suggest', route: 'server', target: { ref: 's0/p1' } } });
    };
    const Adm = srv.api('admin');

    // /api/me
    assert.equal((await srv.api('a')('/api/me')).serverAi, true);
    assert.equal((await srv.api('b')('/api/me')).serverAi, false);
    assert.equal((await Adm('/api/me')).serverAi, false);

    // 허용한 홍길동 → 서버 AI, 김검토 → 대기열 + 허용 안내
    const ra = await send('a');
    assert.equal(ra.status, 200, JSON.stringify(ra.data)); assert.equal(ra.data.route, 'server');
    const rb = await send('b');
    assert.equal(rb.status, 200, JSON.stringify(rb.data)); assert.equal(rb.data.route, 'queue'); assert.equal(rb.data.queued, true);
    assert.match(rb.data.hint, /서버 AI 사용이 허용되지 않아/);

    // 관리자 목록: 칸 값과 상태
    let list = await Adm('/api/admin/users');
    assert.deepEqual(list.users.map((u) => [u.name, u.serverAi]), [['관리자', false], ['홍길동', true], ['김검토', false]]);
    assert.deepEqual(list.serverAi, { enabled: true, mock: true, restricted: true, useKeyOf: null, candidates: [] });
    // 편집자는 바꿀 수 없다
    assert.equal((await srv.api('a').res('/api/admin/users/%EA%B9%80%EA%B2%80%ED%86%A0', { method: 'PATCH', body: { user: { serverAi: true }, revision: list.revision } })).status, 403);
    // 잘못된 값
    const bad = await Adm.res(`/api/admin/users/${encodeURIComponent('김검토')}`, { method: 'PATCH', body: { user: { serverAi: 'yes' }, revision: list.revision } });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'BAD_SERVER_AI');

    // 김검토 켜기 → 재시작 없이 서버 AI, 역할은 그대로
    list = await Adm(`/api/admin/users/${encodeURIComponent('김검토')}`, { method: 'PATCH', body: { user: { serverAi: true }, revision: list.revision } });
    assert.deepEqual(list.users.find((u) => u.name === '김검토'), { ...list.users.find((u) => u.name === '김검토'), role: 'editor', serverAi: true });
    assert.equal((await srv.api('b')('/api/me')).serverAi, true);
    assert.equal((await send('b')).data.route, 'server');
    // 파일에도 남는다(끄면 항목을 지운다)
    assert.equal(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).users.find((u) => u.name === '김검토').serverAi, true);

    // 홍길동 끄기 → 대기열
    list = await Adm(`/api/admin/users/${encodeURIComponent('홍길동')}`, { method: 'PATCH', body: { user: { serverAi: false }, revision: list.revision } });
    assert.equal(list.users.find((u) => u.name === '홍길동').serverAi, false);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).users.find((u) => u.name === '홍길동'), 'serverAi'), false);
    assert.equal((await send('a')).data.route, 'queue');
    // 역할만 바꾸는 옛 호출은 서버 AI 칸을 건드리지 않는다
    list = await Adm(`/api/admin/users/${encodeURIComponent('김검토')}`, { method: 'PATCH', body: { user: { role: 'viewer' }, revision: list.revision } });
    assert.deepEqual([list.users.find((u) => u.name === '김검토').role, list.users.find((u) => u.name === '김검토').serverAi], ['viewer', true]);
  } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('서버: 제한하지 않는 설정(모의 AI 기본)은 예전처럼 누구나', async () => {
  const srv = await startServer({ ai: 'mock' });
  try {
    assert.equal((await srv.api('b')('/api/me')).serverAi, true);
    assert.deepEqual((await srv.api('admin')('/api/admin/users')).serverAi, { enabled: true, mock: true, restricted: false, useKeyOf: null, candidates: [] });
  } finally { await srv.stop(); }
});

test('서비스: 서버 AI 가 관리자의 내 AI 키를 쓰면(useKeyOf) 허용 계정만 그 키로', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-srvai-key-'));
  try {
    const own = { enabled: true, runKind: 'api', mock: false, key: 'k-admin', agentName: '관리자 키' };
    const config = { root: tmp, dataDir: tmp, tutorial: { enabled: false }, ai: { useKeyOf: '관리자' },
      users: [{ name: '관리자', role: 'admin' }, { name: '갑', role: 'editor', serverAi: true }, { name: '을', role: 'editor' }] };
    const svc = new Service({ store: { dir: tmp }, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
    svc.personalAi = { forUser: (n) => (n === '관리자' ? own : null), status: ({ name }) => ({ configured: name === '관리자' }) };
    assert.equal(svc.aiFor('갑'), own);
    assert.equal(svc.aiFor('을'), null, '허용하지 않은 계정은 관리자 키를 못 쓴다');
    assert.deepEqual(svc.serverAiStatus(), { enabled: true, mock: false, restricted: true, useKeyOf: '관리자', candidates: ['관리자'] });
    // 관리자가 키를 지우면 서버 AI 도 꺼진다
    svc.personalAi.forUser = () => null;
    assert.equal(svc.aiFor('갑'), null); assert.equal(svc.serverAiStatus().enabled, false);
    // useKeyOf 를 지우면 config.ai 의 키(여기서는 꺼짐)
    delete config.ai.useKeyOf; svc.personalAi.forUser = (n) => (n === '관리자' ? own : null);
    assert.equal(svc.aiFor('갑'), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('서버: 관리자 화면에서 서버 AI 키 주인을 고르고 되돌린다', async () => {
  const srv = await startServer({ ai: 'mock' });
  try {
    const Adm = srv.api('admin'); const name = srv.users.admin.name;
    let list = await Adm('/api/admin/users');
    assert.equal(list.serverAi.useKeyOf, null);
    const bad = await Adm.res('/api/admin/server-ai-key', { method: 'PUT', body: { useKeyOf: srv.users.a.name, revision: list.revision } });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'BAD_KEY_OWNER');
    assert.equal((await srv.api('a').res('/api/admin/server-ai-key', { method: 'PUT', body: { useKeyOf: name, revision: list.revision } })).status, 403);
    list = await Adm('/api/admin/server-ai-key', { method: 'PUT', body: { useKeyOf: name, revision: list.revision } });
    assert.equal(list.serverAi.useKeyOf, name);
    assert.equal(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).ai.useKeyOf, name);
    // 모의 실행에서는 개인 키를 부르지 않으므로 꺼짐으로 보인다
    assert.equal(list.serverAi.enabled, false);
    list = await Adm('/api/admin/server-ai-key', { method: 'PUT', body: { useKeyOf: null, revision: list.revision } });
    assert.equal(list.serverAi.useKeyOf, null);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).ai, 'useKeyOf'), false);
  } finally { await srv.stop(); }
});
