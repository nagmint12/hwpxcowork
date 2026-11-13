import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { DriveService } from '../server/drive.js';
import { doorayAction } from '../extensions/drive-bridge/dooray.js';
import { runDooray } from '../extensions/drive-bridge/runner.js';
import { createDrivePackage } from '../server/drive-package.js';
import { discover } from './helpers/drive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const alice = { name: 'alice' }, bob = { name: 'bob' };
const first = '1111111111111111111', second = '2222222222222222222';
const target = id => ({ provider: 'dooray', projectId: id, folderId: 'root' });

test('사용자별 프로젝트 확인·분리·서버 재시작·재연결 시 범위 초기화', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-dynamic-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const drive = new DriveService({ config: { dataDir } });
  const tokens = new Map();
  for (const [user, id] of [[alice, first], [bob, second]]) {
    const pair = drive.pair(drive.pairCode(user).code); tokens.set(user.name, pair.token);
    drive.bridge(pair.token, '0.6.0');
    assert.deepEqual(drive.status(user).writeProjects, []);
    assert.throws(() => drive.create(user, { ...target(id), action: 'list' }), e => e.code === 'DRIVE_SCOPE');
    discover(drive, user, id);
    assert.equal(drive.status(user).providers[0].projectId, id);
  }
  for (const [user, own, other] of [[alice, first, second], [bob, second, first]]) {
    assert.deepEqual(drive.status(user).writeProjects, [own]);
    for (const action of ['list','download','upload','delete','rename'])
      assert.throws(() => drive.create(user, { ...target(other), action }), e => e.code === 'DRIVE_SCOPE');
  }
  const pending = drive.create(alice, { ...target(first), action: 'list' });
  assert.equal(drive.claim(bob).job, null);
  const claimed = drive.claim(alice).job;
  drive.finish(alice, pending.id, claimed.claim, { result: { items: [] } });
  const restarted = new DriveService({ config: { dataDir } });
  restarted.bridge(tokens.get(alice.name), '0.6.0');
  assert.deepEqual(restarted.status(alice).writeProjects, [first]);
  restarted.pair(restarted.pairCode(alice).code);
  assert.deepEqual(restarted.status(alice).writeProjects, []);
  assert.deepEqual(restarted.status(bob).writeProjects, [second]);
});

test('공유·손상된 검색 결과와 구버전 확장으로는 프로젝트를 등록하지 않는다', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-discovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const drive = new DriveService({ config: { dataDir } });
  const pair = drive.pair(drive.pairCode(alice).code);
  drive.bridge(pair.token, '0.5.0');
  assert.throws(() => drive.create(alice, { ...target('personal'), action: 'projects' }), e => e.code === 'DRIVE_BRIDGE_OLD');
  drive.bridge(pair.token, '0.6.0');
  const j = drive.create(alice, { ...target('personal'), action: 'projects' });
  const { job } = drive.claim(alice);
  for (const projects of [[], [{id:first,type:'public',driveId:'999'}], [{id:first,type:'private'}], [{id:first,type:'private',driveId:'999'}, {id:second,type:'private',driveId:'998'}]]) {
    assert.throws(() => drive.finish(alice, j.id, job.claim, { result: { projects } }), e => e.code === 'DRIVE_SCOPE');
    assert.deepEqual(drive.status(alice).writeProjects, []);
  }
});

function adapter(id, type = 'private', action = 'projects', requested = 'personal', extra = {}) {
  const calls = [];
  const context = vm.createContext({
    location: { origin: 'https://team.gov-dooray.com', pathname: '/drive/' + id },
    AbortSignal, URLSearchParams, Map, Date,
    fetch: async route => { calls.push(route); return { ok: true, text: async () => JSON.stringify({ result: { content: { id: '999', projectId: id, type } } }) }; },
    ...extra,
  });
  return { calls, result: vm.runInContext(`(${doorayAction.toString()})(${JSON.stringify({action,target:target(requested)})})`, context) };
}

test('확장이 주소에서 ID를 읽고 API의 private 응답으로 확인하며 공유 프로젝트는 거절', async () => {
  for (const id of [first, second]) {
    const { result, calls } = adapter(id);
    const value = await result;
    assert.equal(value.projects[0].id, id);
    assert.equal(value.projects[0].driveId, '999');
    assert.equal(value.projects[0].type, 'private');
    assert.deepEqual(calls, ['/v2/wapi/drives/' + id]);
  }
  await assert.rejects(adapter(first, 'public').result, /개인 드라이브/);
  const mismatch = adapter(second, 'private', 'list', first);
  await assert.rejects(mismatch.result, /개인 프로젝트/); assert.deepEqual(mismatch.calls, []);
});

test('확장이 여러 탭에서 개인 프로젝트만 선택하고 모호한 계정은 자동 선택하지 않는다', async () => {
  const api = {
    storage: { local: { get: async () => ({ doorayOrigin: 'https://team.gov-dooray.com' }) } },
    permissions: { contains: async () => true },
    tabs: { query: async () => [{id:1,url:'https://team.gov-dooray.com/drive/'+first},{id:2,url:'https://team.gov-dooray.com/drive/'+second}] },
    scripting: { executeScript: async ({target: {tabId}}) => [{result: tabId===1 ? {ok:false,error:'공유 프로젝트'} : {ok:true,value:{projects:[{id:second,driveId:'999',type:'private'}]}}}] },
  };
  const job = {action:'projects',target:target('personal')};
  assert.equal((await runDooray(job,null,api)).projects[0].id, second);
  api.scripting.executeScript = async ({target: {tabId}}) => [{result:{ok:true,value:{projects:[{id:tabId===1?first:second,driveId:'999',type:'private'}]}}}];
  await assert.rejects(runDooray(job,null,api), /서로 다른 개인 프로젝트/);
});

test('다운로드 ZIP은 0.7.0이며 기존 계정 ID·고정 허용 목록을 포함하지 않는다', async () => {
  const zip = await JSZip.loadAsync(await createDrivePackage(root));
  assert.equal(JSON.parse(await zip.file('manifest.json').async('string')).version, '0.7.0');
  for (const entry of Object.values(zip.files)) {
    assert.doesNotMatch(await entry.async('string'), /3641283642401141655|DOORAY_PROJECT|WRITE_PROJECTS/);
  }
});
