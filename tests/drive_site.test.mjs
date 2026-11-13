import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { doorayUrl, doorayOrigin } from '../extensions/drive-bridge/shared.js';
import { runDooray } from '../extensions/drive-bridge/runner.js';
import { doorayAction } from '../extensions/drive-bridge/dooray.js';

test('두레이 주소는 기관에 관계없이 HTTPS 기본 주소만 받는다', () => {
  for (const site of ['https://team.dooray.com', 'https://office.gov-dooray.com']) {
    assert.equal(doorayUrl(site + '/drive/'), site);
  }
  for (const site of ['http://team.dooray.com', 'https://dooray.com.evil.test', 'https://team.dooray.com.evil.test', 'https://user:pass@team.dooray.com', 'https://team.dooray.com:8443', 'https://team.dooray.com/drive/123', 'https://team.dooray.com/?key=secret']) {
    assert.throws(() => doorayUrl(site));
  }
});

test('사용자가 저장한 사이트와 허용한 권한만 로그인 작업에 사용한다', async () => {
  const sites = [], permissions = [];
  const api = {
    storage: { local: { get: async () => ({ doorayOrigin: 'https://office.dooray.com' }) } },
    permissions: { contains: async ({ origins }) => { permissions.push(...origins); return true; } },
    tabs: { create: async options => { sites.push(options.url); } },
  };
  await runDooray({ action: 'login', origin: 'https://wrong.dooray.com', target: { provider: 'dooray', projectId: 'personal' } }, null, api);
  assert.deepEqual(sites, ['https://office.dooray.com/drive/']);
  assert.deepEqual(permissions, ['https://office.dooray.com/*']);
  api.permissions.contains = async () => false;
  await assert.rejects(runDooray({ action: 'login', target: { projectId: 'personal' } }, null, api), /접근을 허용/);
  assert.equal(sites.length, 1);
  api.storage.local.get = async () => ({});
  await assert.rejects(doorayOrigin(api), /주소를 먼저 저장/);
});

test('주입한 작업은 선택한 사이트와 다른 출처에서 API를 호출하지 않는다', async () => {
  let called = false;
  const context = vm.createContext({ location: { origin: 'https://other.dooray.com', pathname: '/drive/123' }, fetch: () => { called = true; } });
  const job = { action: 'list', origin: 'https://office.dooray.com', target: { projectId: '123', folderId: 'root' }, transport: true };
  const result = await vm.runInContext(`(${doorayAction.toString()})(${JSON.stringify(job)})`, context);
  assert.equal(result.ok, false);
  assert.match(result.error, /선택한 두레이 사이트/);
  assert.equal(called, false);
});
