// node --test tests/login_tutorial_hint.test.mjs — 로그인 화면 체험 토큰 안내(2026-11-17, docs/UI_TERMS.md §2).
// 예전에는 화면이 'test1 ~ test100' 을 늘 보였다 — 체험 계정이 없는 설치에서도 없는 토큰을 안내했다.
// 이제 공개 /api/config 의 tutorialLogin 이 그 글을 준다: 체험이 켜져 있고 이름이 곧 토큰인 testN 계정의 범위, 없으면 null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const config = async (srv) => (await fetch(`${srv.base}/api/config`)).json();

test('체험 계정이 없으면 tutorialLogin 은 null(로그인 화면에 안내 없음)', { timeout: 60000 }, async () => {
  const srv = await startServer();
  try {
    const c = await config(srv);
    assert.ok(Object.hasOwn(c, 'tutorialLogin'), '칸은 있다(화면이 새 서버인지 안다)');
    assert.equal(c.tutorialLogin, null);
  } finally { await srv.stop(); }
});

test('체험이 켜져 있으면 이름이 곧 토큰인 testN 계정의 범위만 — 다른 토큰은 내보내지 않는다', { timeout: 60000 }, async () => {
  const users = [
    { name: '관리자', role: 'admin' }, { name: '홍길동', role: 'editor' }, { name: '김검토', role: 'editor' },
    { name: 'test2', token: 'test2' }, { name: 'test3', token: 'test3' }, { name: 'test7', token: 'test7' },
    { name: 'test9', token: 'test9-secret-token' },   // 이름과 토큰이 다르다 — 안내에 넣지 않는다
  ];
  const srv = await startServer({ users, config: { tutorial: { enabled: true, users: ['test2', 'test3', 'test7', 'test9'] } } });
  try {
    const c = await config(srv);
    assert.equal(c.tutorialLogin, 'test2 ~ test7');
    assert.ok(!JSON.stringify(c).includes('test9-secret-token'), '토큰을 내보내지 않는다');
  } finally { await srv.stop(); }
  const off = await startServer({ users, config: { tutorial: { enabled: false, users: ['test2', 'test3'] } } });
  try { assert.equal((await config(off)).tutorialLogin, null, '체험을 끄면 안내 없음'); } finally { await off.stop(); }
});
