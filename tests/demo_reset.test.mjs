import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { demoResetPlan, DEMO_TOKENS } from '../scripts/reset-demo-accounts.mjs';

function fixture(t, users) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-demo-reset-'));
  t.after(() => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'data/docs'), { recursive: true });
  const config = { dataDir: 'data', users: [{ name: 'admin', role: 'admin', token: 'fake-admin' }, ...users] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const doc = (id, meta) => { const dir = path.join(root, 'data/docs', id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ...meta })); };
  return { root, config, doc };
}

test('초기화 범위는 정확히 test1~test100이며 다른 토큰·사용자·문서는 보존 대상으로 분리한다', t => {
  const f = fixture(t, [{ name: 'demo-first', token: 'test1' }, { name: 'demo-last', token: 'test100' }, { name: 'other', token: 'test101' }]);
  f.doc('demo-doc', { createdBy: 'demo-first', tutorial: true });
  f.doc('private-demo', { createdBy: 'admin', space: 'private', spaceOwner: 'demo-last' });
  f.doc('other-doc', { createdBy: 'other' });
  const original = fs.readFileSync(path.join(f.root, 'config.json'));
  const plan = demoResetPlan({ root: f.root });
  assert.equal(DEMO_TOKENS.length, 100);
  assert.deepEqual(plan.existing.map(u => u.token), ['test1', 'test100']);
  assert.equal(plan.missing.length, 98);
  assert.deepEqual(plan.documents.filter(d => d.owned).map(d => d.id).sort(), ['demo-doc', 'private-demo']);
  assert.deepEqual(plan.documents.filter(d => !d.owned).map(d => d.id), ['other-doc']);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'config.json')), original, '점검 단계는 config와 데이터를 바꾸지 않는다');
  assert.ok(!plan.targets.some(u => u.token === 'test101' || u.token === 'test0' || u.token === 'test01'));
});

test('관리자·중복 이름·기존 다른 계정과 충돌하는 대상은 변경 전에 중단한다', t => {
  for (const users of [[{ name: 'demo', token: 'test1', role: 'admin' }], [{ name: 'same', token: 'test1' }, { name: 'same', token: 'private-other' }], [{ name: 'test2', token: 'private-other' }]]) {
    const f = fixture(t, users);
    assert.throws(() => demoResetPlan({ root: f.root }));
  }
});

test('처리 중인 AI나 다른 사용자 문서의 체험 요청은 초기화 전에 확인한다', t => {
  const f = fixture(t, [{ name: 'demo', token: 'test1' }]);
  f.doc('working', { createdBy: 'demo', requests: [{ status: 'working' }] });
  assert.throws(() => demoResetPlan({ root: f.root }), /AI 처리/);
  fs.writeFileSync(path.join(f.root, 'data/docs/working/meta.json'), JSON.stringify({ id: 'working', createdBy: 'admin', requests: [{ by: 'demo' }] }));
  assert.throws(() => demoResetPlan({ root: f.root }), /다른 사용자/);
});

test('연결·폴더 같은 추가 기록은 조용히 남기거나 다른 기록과 함께 지우지 않는다', t => {
  const f = fixture(t, [{ name: 'demo', token: 'test1' }]);
  fs.writeFileSync(path.join(f.root, 'data/folders.json'), JSON.stringify({ folders: { f1: { owner: 'demo' } } }));
  assert.throws(() => demoResetPlan({ root: f.root }), /별도 백업/);
});
