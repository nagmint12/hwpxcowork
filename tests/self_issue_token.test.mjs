// 개인 토큰 스스로 발급(2026-11-18 사용자 요청): 관리자 [기능 설정](GET/PATCH /api/admin/features)에서 켜면
// 로그인 화면에서 누구나 이름을 넣고 자기 접속 토큰을 받는다(POST /api/self-token). 기본 끔 · 관리자 역할은 줄 수 없음 ·
// 토큰은 서버가 무작위로 · 이름 겹침(지운 사용자의 문서 기록 이름 포함)·발급 한도·서버 전체 속도 한도.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { createAdminAccounts, SELF_ISSUE_RATE } from '../server/admin-accounts.js';
import { normalizeSelfIssue } from '../server/config.js';

test('설정 정리: 기본 끔·편집자·50개, 관리자 역할과 범위 밖 한도는 기본값으로', () => {
  assert.deepEqual(normalizeSelfIssue(undefined), { enabled: false, role: 'editor', max: 50 });
  assert.deepEqual(normalizeSelfIssue({ enabled: 'true', role: 'admin', max: 0 }), { enabled: false, role: 'editor', max: 50 });
  assert.deepEqual(normalizeSelfIssue({ enabled: true, role: 'viewer', max: 3 }), { enabled: true, role: 'viewer', max: 3 });
});

test('서버: 꺼져 있으면 발급 안 함 → 관리자가 켜면 바로 발급, 받은 토큰으로 로그인', async () => {
  const srv = await startServer();
  try {
    const admin = srv.api('admin'); const anon = srv.api(null);
    // 기본 끔 — 로그인 화면은 단추를 숨기고, 서버는 거절한다
    assert.equal((await anon('/api/config')).selfIssue, false);
    assert.equal((await anon('/api/config')).features.adminFeatures, true);
    const off = await anon.res('/api/self-token', { method: 'POST', body: { name: '새사람' } });
    assert.equal(off.status, 403); assert.equal(off.data.error, 'SELF_ISSUE_OFF');
    // 기능 설정은 관리자만
    assert.equal((await srv.api('a').res('/api/admin/features')).status, 403);
    assert.equal((await srv.api('a').res('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: true } } } })).status, 403);
    const f0 = await admin('/api/admin/features');
    assert.deepEqual(f0.selfIssue, { enabled: false, role: 'editor', max: 50, issued: 0 });
    // 잘못된 값은 저장하지 않는다(관리자 역할·범위 밖 한도·모르는 칸)
    for (const bad of [{ role: 'admin' }, { max: 0 }, { max: 1001 }, { max: 2.5 }, { enabled: 'yes' }, { other: 1 }]) {
      const r = await admin.res('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: bad }, revision: f0.revision } });
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.data.error, 'INVALID_FEATURES');
    }
    // 옛 판(revision)으로는 저장하지 않는다
    assert.equal((await admin.res('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: true } }, revision: '0'.repeat(64) } })).data.error, 'CONFIG_CHANGED');
    const f1 = await admin('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: true, role: 'viewer', max: 2 } }, revision: f0.revision } });
    assert.deepEqual(f1.selfIssue, { enabled: true, role: 'viewer', max: 2, issued: 0 });
    assert.equal((await anon('/api/config')).selfIssue, true, '재시작 없이 로그인 화면에 보인다');
    // 설정 파일에도 남는다(다시 띄워도 그대로)
    assert.deepEqual(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).accounts.selfIssue, { enabled: true, role: 'viewer', max: 2 });

    // 발급: 이름만 보내면 서버가 무작위 토큰(32자)을 만든다. 역할은 관리자가 정한 것 — 보낸 role·token 은 무시
    const r1 = await anon('/api/self-token', { method: 'POST', body: { name: '  새  사람 ', role: 'admin', token: 'abcd' } });
    assert.equal(r1.issued.name, '새 사람'); assert.equal(r1.issued.role, 'viewer');
    assert.match(r1.issued.token, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(r1.issued.token, 'abcd');
    const me = await srv.api(null)('/api/me', { token: r1.issued.token });
    assert.equal(me.name, '새 사람'); assert.equal(me.role, 'viewer');
    // 관리자 사용자 목록에 '스스로 발급' 표시(발급 시각)
    const listed = (await admin('/api/admin/users')).users.find((u) => u.name === '새 사람');
    assert.ok(listed.selfIssued && !Number.isNaN(Date.parse(listed.selfIssued)));
    assert.equal(listed.tokenHint, `…${r1.issued.token.slice(-4)}`);
    assert.equal((await admin('/api/admin/features')).selfIssue.issued, 1);

    // 이름 겹침·빈 이름·기호만인 이름('*' = 문서함 '모든 사용자')
    for (const [name, code, status] of [['홍길동', 'NAME_TAKEN', 409], ['새 사람', 'NAME_TAKEN', 409], ['', 'BAD_NAME', 400], ['*', 'BAD_NAME', 400], ['가'.repeat(41), 'BAD_NAME', 400]]) {
      const r = await anon.res('/api/self-token', { method: 'POST', body: { name } });
      assert.equal(r.status, status, name); assert.equal(r.data.error, code, name);
    }
    // 한도(2개): 두 번째까지 받고 세 번째는 거절
    assert.equal((await anon('/api/self-token', { method: 'POST', body: { name: '둘째' } })).issued.name, '둘째');
    const full = await anon.res('/api/self-token', { method: 'POST', body: { name: '셋째' } });
    assert.equal(full.status, 409); assert.equal(full.data.error, 'SELF_ISSUE_FULL');
    // 관리자가 지우면 그 토큰은 바로 끊긴다(기존 사용자 관리 그대로)
    const users = await admin('/api/admin/users');
    await admin(`/api/admin/users/${encodeURIComponent('둘째')}`, { method: 'DELETE', body: { revision: users.revision } });
    // 끄면 다시 거절 — 이미 받은 계정은 그대로 쓴다
    const f2 = await admin('/api/admin/features');
    await admin('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: false } }, revision: f2.revision } });
    assert.equal((await anon.res('/api/self-token', { method: 'POST', body: { name: '넷째' } })).status, 403);
    assert.equal((await srv.api(null)('/api/me', { token: r1.issued.token })).name, '새 사람');
    assert.equal((await anon('/api/config')).selfIssue, false);
  } finally { await srv.stop(); }
});

test('서버: 지운 사용자의 문서 기록에 남은 이름은 발급하지 않는다(개인 문서함·권한이 이름으로 묶여 있다)', async () => {
  const srv = await startServer();
  try {
    const admin = srv.api('admin'); const anon = srv.api(null);
    // 홍길동이 개인 문서함에 문서를 올린 뒤 관리자가 홍길동을 지운다
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(fixture('tool_memo_tracked.hwpx')), '홍길동 문서.hwpx');
    const docId = doc.id || doc.doc?.id;
    assert.ok(docId);
    const users = await admin('/api/admin/users');
    await admin(`/api/admin/users/${encodeURIComponent('홍길동')}`, { method: 'DELETE', body: { revision: users.revision } });
    const f = await admin('/api/admin/features');
    await admin('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: true } }, revision: f.revision } });
    const r = await anon.res('/api/self-token', { method: 'POST', body: { name: '홍길동' } });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'NAME_TAKEN');
    assert.equal((await anon('/api/self-token', { method: 'POST', body: { name: '홍길순' } })).issued.role, 'editor');
  } finally { await srv.stop(); }
});

test('속도 한도: 서버 전체 10분에 10개(공개 주소는 IP 로 셀 수 없다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-selfissue-'));
  try {
    const configFile = path.join(dir, 'config.json');
    const raw = { users: [{ name: '관리자', role: 'admin', token: 'admin-token-1' }], accounts: { selfIssue: { enabled: true, max: 100 } } };
    fs.writeFileSync(configFile, JSON.stringify(raw));
    let t = 1_000_000;
    const config = { configFile, users: [...raw.users], accounts: { selfIssue: normalizeSelfIssue(raw.accounts.selfIssue) } };
    const acc = createAdminAccounts({ config, now: () => t });
    for (let i = 0; i < SELF_ISSUE_RATE.max; i++) acc.issueSelf({ name: `사람${i}` });
    assert.throws(() => acc.issueSelf({ name: '넘침' }), (e) => e.code === 'SELF_ISSUE_BUSY' && e.status === 429);
    t += SELF_ISSUE_RATE.windowMs + 1;
    assert.equal(acc.issueSelf({ name: '넘침' }).name, '넘침');
    // 실행 중 설정(config.users)에도 바로 들어가 다음 요청부터 로그인된다
    assert.equal(config.users.length, SELF_ISSUE_RATE.max + 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
