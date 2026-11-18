// 두레이 드라이브 — 두레이 서비스 API(개인 API 인증 토큰) 방식(2026-11-17). 실제 두레이는 부르지 않는다(가짜 두레이 tests/helpers/fake-dooray.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriveService } from '../server/drive.js';
import { doorayEndpoint, normalizeDoorayToken } from '../server/dooray-api.js';
import { createFakeDooray, startFakeDoorayHttp, FAKE_TOKEN, FAKE_DRIVE, PROJECT_DRIVE, PUBLIC_DRIVE, NOT_MINE_DRIVE } from './helpers/fake-dooray.mjs';
import { startServer, fixture } from './helpers/server.mjs';

const a = { name: '가', role: 'editor' }, b = { name: '나', role: 'editor' };
const SITE = 'https://test.dooray.com';
function setup(t, { maxBytes = 1024 * 1024 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-dooray-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const fake = createFakeDooray({ apiOrigin: 'https://api.dooray.com', fileOrigin: 'https://file-api.dooray.com' });
  const secretFile = path.join(dataDir, 'secret');
  const make = (opts = {}) => new DriveService({ config: { dataDir, attachments: { maxBytes } }, fetchImpl: fake.fetchImpl, secretFile, apiOverride: null, ...opts });
  return { drive: make(), make, fake, dataDir, secretFile };
}
const connected = async (drive, user = a) => drive.connect(user, { site: SITE, token: FAKE_TOKEN });
const list = (drive, folderId = 'root', user = a) => drive.action(user, { action: 'list', folderId });

test('사이트 주소 → 클라우드 API 끝점: https 두레이 사이트만, API 주소·다른 도메인 거절', () => {
  assert.equal(doorayEndpoint('https://example.dooray.com').apiBase, 'https://api.dooray.com');
  assert.equal(doorayEndpoint('example.dooray.com/home').site, 'https://example.dooray.com');
  assert.equal(doorayEndpoint('https://x.gov-dooray.com').apiBase, 'https://api.gov-dooray.com');
  assert.equal(doorayEndpoint('https://x.gov-dooray.co.kr').apiBase, 'https://api.gov-dooray.co.kr');
  assert.equal(doorayEndpoint('https://x.dooray.co.kr').apiBase, 'https://api.dooray.co.kr');
  for (const bad of ['', 'http://example.dooray.com', 'https://evil.com', 'https://dooray.com.evil.com', 'https://api.dooray.com', 'https://file-api.dooray.com', 'https://dooray.com', 'https://u:p@example.dooray.com', 'https://example.dooray.com:8443'])
    assert.throws(() => doorayEndpoint(bad), (e) => e.code === 'DOORAY_SITE', bad);
  assert.throws(() => doorayEndpoint(SITE, 'http://example.com:9'), (e) => e.code === 'DOORAY_SITE', '시험 주소는 loopback 만');
});
test('토큰 다듬기: dooray-api 머리 떼기, 공백·한글·짧은 값 거절', () => {
  assert.equal(normalizeDoorayToken(`  dooray-api ${FAKE_TOKEN} `), FAKE_TOKEN);
  assert.equal(normalizeDoorayToken(`Authorization: dooray-api ${FAKE_TOKEN}`), FAKE_TOKEN);
  for (const bad of ['', 'short', 'has space token', '토큰토큰토큰토큰', null]) assert.throws(() => normalizeDoorayToken(bad), (e) => e.code === 'DOORAY_TOKEN');
});

test('연결: 계정·개인 드라이브·최상위 폴더 확인, 토큰은 암호문으로만 저장하고 응답에 싣지 않음, 사용자 분리', async (t) => {
  const { drive, make, fake, dataDir } = setup(t);
  assert.equal(drive.status(a).connected, false);
  await assert.rejects(drive.action(a, { action: 'list' }), (e) => e.code === 'DRIVE_OFFLINE');
  const s = await connected(drive);
  assert.equal(s.connected, true); assert.equal(s.account.name, '홍길동'); assert.equal(s.account.site, SITE); assert.equal(s.account.keyHint, '…' + FAKE_TOKEN.slice(-4));
  assert.ok(!JSON.stringify(s).includes(FAKE_TOKEN), '상태 응답에 토큰 원문 없음');
  const saved = fs.readFileSync(path.join(dataDir, 'drive', drive.owner(a), 'index.json'), 'utf8');
  assert.ok(!saved.includes(FAKE_TOKEN) && !saved.includes(FAKE_TOKEN.slice(0, 12)), '디스크에 토큰 원문 없음');
  assert.equal(JSON.parse(saved).dooray.driveId, FAKE_DRIVE, '19자리 드라이브 id 를 숫자 반올림 없이 보존');
  assert.ok(fake.state.calls.every((c) => c.auth === `dooray-api ${FAKE_TOKEN}`), '모든 호출에 dooray-api 인증');
  assert.equal(drive.status(b).connected, false, '다른 사용자는 연결 안 됨');
  // 서버를 다시 켜도(새 객체) 같은 열쇠면 쓰인다
  assert.equal((await list(make())).items.length, 2);
  // 해제: 토큰을 지우고 사이트는 다음 입력을 위해 남긴다
  drive.disconnect(a); const after = drive.status(a);
  assert.equal(after.connected, false); assert.equal(after.site, SITE);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'drive', drive.owner(a), 'index.json'), 'utf8').includes('"token"'));
});
test('연결 실패: 틀린 토큰(401)·두레이 사이트 아님은 저장하지 않음', async (t) => {
  const { drive } = setup(t);
  await assert.rejects(drive.connect(a, { site: SITE, token: 'wrong-token-123' }), (e) => e.code === 'DOORAY_AUTH' && e.status !== 401);
  await assert.rejects(drive.connect(a, { site: 'https://evil.com', token: FAKE_TOKEN }), (e) => e.code === 'DOORAY_SITE');
  assert.equal(drive.status(a).connected, false);
});
test('열쇠 파일이 바뀌면 저장한 토큰을 쓰지 않고 다시 등록을 안내', async (t) => {
  const { drive, make, dataDir } = setup(t);
  await connected(drive);
  const other = make({ secretFile: path.join(dataDir, 'other-secret') });
  await assert.rejects(list(other), (e) => e.code === 'DOORAY_TOKEN_LOST');
});
test('목록: 최상위 = root 폴더 id, 휴지통·root 빼기, 쪽 넘김', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  const root = await list(drive);
  assert.deepEqual(root.items.map((f) => [f.id, f.type]).sort(), [['A1', 'file'], ['F1', 'folder']]);
  assert.equal(root.items.find((f) => f.id === 'A1').revision.length > 0, true);
  assert.equal(root.nextPage, null);
  assert.equal(fake.state.calls.at(-1).query.parentId, 'R1');
  assert.deepEqual((await list(drive, 'F1')).items.map((f) => f.name), ['메모.txt']);
  await assert.rejects(list(drive, '../x'), (e) => e.code === 'DRIVE_TARGET');
});
test('내려받기: api → 307 → 파일 주소로 같은 인증을 다시 붙여 받기, 폴더·revision 확인', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  const r = await drive.action(a, { action: 'download', folderId: 'root', fileId: 'A1', expectedRevision: fake.files.get('A1').revision });
  assert.equal(drive.bytes(a, r.stagedId).bytes.toString(), 'PK-hwpx-bytes');
  const hop = fake.state.calls.filter((c) => c.path.endsWith('/A1') && c.query.media === 'raw');
  assert.deepEqual(hop.map((c) => c.origin), ['https://api.dooray.com', 'https://file-api.dooray.com']);
  assert.ok(hop.every((c) => c.auth === `dooray-api ${FAKE_TOKEN}`));
  assert.throws(() => drive.bytes(b, r.stagedId), '다른 사용자는 보관 사본을 못 읽음');
  await assert.rejects(drive.action(a, { action: 'download', folderId: 'F1', fileId: 'A1' }), (e) => e.code === 'DRIVE_SCOPE', '다른 폴더의 파일');
  await assert.rejects(drive.action(a, { action: 'download', folderId: 'root', fileId: 'A1', expectedRevision: '1' }), (e) => e.code === 'DRIVE_REVISION');
  await assert.rejects(drive.action(a, { action: 'download', folderId: 'root', fileId: 'X1' }), (e) => /DOORAY_NOT_FOUND|DRIVE_SCOPE/.test(e.code), '다른 드라이브 파일');
});
test('307 이 두레이 도메인 밖을 가리키면 토큰을 보내지 않고 멈춤', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  fake.state.badLocation = true;
  await assert.rejects(drive.action(a, { action: 'download', folderId: 'root', fileId: 'A1' }), (e) => e.code === 'DOORAY_REDIRECT');
  assert.ok(!fake.state.calls.some((c) => c.origin === 'https://evil.example.com'));
});
test('크기 한도: 메타 크기와 실제 받은 바이트 모두', async (t) => {
  const { drive, fake } = setup(t, { maxBytes: 8 });
  await connected(drive);
  await assert.rejects(drive.action(a, { action: 'download', folderId: 'root', fileId: 'A1' }), (e) => e.code === 'DRIVE_SIZE');
  assert.ok(!fake.state.calls.some((c) => c.query.media === 'raw'), '메타에서 먼저 막아 바이트를 받지 않음');
});
test('올리기: 같은 이름 거절, 새 파일은 multipart file 필드로 307 따라 올림, 교체는 revision·이름 확인', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  const dup = drive.stage(a, Buffer.from('new'), '보고서.hwpx');
  await assert.rejects(drive.action(a, { action: 'upload', folderId: 'root', stagedId: dup.id }), (e) => e.code === 'DRIVE_EXISTS');
  const fresh = drive.stage(a, Buffer.from('새 파일 내용'), '새 문서.hwpx', 'application/haansofthwpx');
  const up = await drive.action(a, { action: 'upload', folderId: 'F1', stagedId: fresh.id });
  const made = fake.files.get(up.id);
  assert.equal(made.name, '새 문서.hwpx'); assert.equal(made.parent, 'F1'); assert.equal(made.bytes.toString(), '새 파일 내용');
  assert.deepEqual(fake.state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/files')).map((c) => c.origin), ['https://api.dooray.com', 'https://file-api.dooray.com']);
  // 교체
  const rev = fake.files.get('A1').revision;
  await assert.rejects(drive.action(a, { action: 'upload', folderId: 'root', stagedId: dup.id, replaceId: 'A1' }), (e) => e.code === 'DRIVE_REVISION', 'revision 없이는 교체 안 함');
  await assert.rejects(drive.action(a, { action: 'upload', folderId: 'root', stagedId: dup.id, replaceId: 'A1', expectedRevision: '1' }), (e) => e.code === 'DRIVE_REVISION');
  await assert.rejects(drive.action(a, { action: 'upload', folderId: 'root', stagedId: dup.id, name: '다른 이름.hwpx', replaceId: 'A1', expectedRevision: rev }), (e) => e.code === 'DRIVE_NAME');
  const replaced = await drive.action(a, { action: 'upload', folderId: 'root', stagedId: dup.id, replaceId: 'A1', expectedRevision: rev });
  assert.equal(fake.files.get('A1').bytes.toString(), 'new'); assert.notEqual(replaced.revision, rev);
  await assert.rejects(drive.action(a, { action: 'upload', folderId: 'T1', stagedId: fresh.id }), (e) => e.code === 'DRIVE_SCOPE', '휴지통에 올리지 않음');
});
test('삭제 = 휴지통으로 옮김, 이름 바꾸기 = 같은 폴더에 같은 이름 없을 때, 둘 다 revision 필요', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  const b1 = () => fake.files.get('B1');
  await assert.rejects(drive.action(a, { action: 'delete', folderId: 'F1', fileId: 'B1' }), (e) => e.code === 'DRIVE_REVISION');
  await assert.rejects(drive.action(a, { action: 'rename', folderId: 'F1', fileId: 'B1', expectedRevision: b1().revision, name: '../x' }), (e) => e.code === 'DRIVE_NAME');
  const renamed = await drive.action(a, { action: 'rename', folderId: 'F1', fileId: 'B1', expectedRevision: b1().revision, name: '새 이름.txt' });
  assert.equal(renamed.name, '새 이름.txt'); assert.equal(b1().name, '새 이름.txt');
  const r = await drive.action(a, { action: 'delete', folderId: 'F1', fileId: 'B1', expectedRevision: b1().revision });
  assert.equal(r.deleted, true); assert.equal(b1().parent, 'T1');
  const move = fake.state.calls.find((c) => c.path.endsWith('/B1/move'));
  assert.equal(move.method, 'POST');
  assert.ok(!fake.state.calls.some((c) => c.method === 'DELETE'), '영구 삭제(DELETE)는 부르지 않는다');
});
test('429 는 잠시 뒤 한 번 다시, 403 은 권한·IP 제한 안내', async (t) => {
  const { drive, fake } = setup(t);
  await connected(drive);
  fake.state.rate429 = 1;
  assert.equal((await list(drive)).items.length, 2);
  fake.state.failStatus = 403;
  await assert.rejects(list(drive, 'F1'), (e) => e.code === 'DOORAY_FORBIDDEN' && /IP/.test(e.message));
});
test('예전 확장 방식의 흔적(bridge·context·proposals)은 읽을 때 지우고 보관 파일은 유지', (t) => {
  const { drive, dataDir } = setup(t);
  const dir = path.join(dataDir, 'drive', drive.owner(a)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ files: [{ id: 'k', name: '남은.txt', size: 1 }], bridge: { tokenHash: 'x'.repeat(64), user: a }, context: { items: [] }, proposals: [{}] }));
  const s = drive.status(a);
  assert.equal(s.connected, false); assert.deepEqual(s.files.map((f) => f.name), ['남은.txt']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(!('bridge' in saved) && !('context' in saved) && !('proposals' in saved));
});

test('HTTP: 토큰 등록 → 목록·올리기·내려받기·가져오기, 응답에 토큰 없음, 예전 확장 경로 없음, MCP 에 드라이브 도구 없음', async (t) => {
  const fake = await startFakeDoorayHttp(); t.after(() => fake.close());
  const srv = await startServer({ env: { HWPX_COWORK_DOORAY_API: fake.apiOrigin } }); t.after(() => srv.stop());
  const A = srv.api('a'), B = srv.api('b');
  assert.equal((await A('/api/drive')).connected, false);
  assert.equal((await A.res('/api/drive/actions', { method: 'POST', body: { action: 'list' } })).status, 409);
  const bad = await A.res('/api/drive/connection', { method: 'PUT', body: { site: SITE, token: 'wrong-token-123' } });
  assert.equal(bad.status, 409, '두레이 401 을 cowork 로그인 만료(401)로 돌려주지 않는다');
  const s = await A('/api/drive/connection', { method: 'PUT', body: { site: SITE, token: FAKE_TOKEN } });
  assert.equal(s.connected, true); assert.ok(!JSON.stringify(s).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(await A('/api/drive')).includes(FAKE_TOKEN));
  assert.equal((await B('/api/drive')).connected, false);
  const root = await A('/api/drive/actions', { method: 'POST', body: { action: 'list', folderId: 'root' } });
  assert.deepEqual(root.items.map((f) => f.name).sort(), ['보고서.hwpx', '자료']);
  // PC 파일 올리기: 보관 사본 → 두레이
  const staged = await A('/api/drive/files', { method: 'POST', raw: true, body: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), headers: { 'x-file-name': encodeURIComponent('검토본.hwpx') } });
  const up = await A('/api/drive/actions', { method: 'POST', body: { action: 'upload', folderId: 'root', stagedId: staged.id } });
  assert.equal(fake.files.get(up.id).bytes.length, fs.statSync(fixture('tool_memo_tracked.hwpx')).size);
  // 두레이 → 보관 사본 → 문서함 가져오기(기본은 내 개인 문서함)
  const listed = await A('/api/drive/actions', { method: 'POST', body: { action: 'list', folderId: 'root' } });
  const mine = listed.items.find((f) => f.name === '검토본.hwpx');
  const got = await A('/api/drive/actions', { method: 'POST', body: { action: 'download', folderId: 'root', fileId: mine.id, expectedRevision: mine.revision } });
  const doc = await A('/api/drive/files/' + got.stagedId + '/open', { method: 'POST' });
  assert.equal(doc.space, 'private'); assert.equal((await B.res('/api/docs/' + doc.id)).status, 404);
  assert.equal((await B.res('/api/drive/files/' + got.stagedId)).status, 404);
  // 프로젝트 드라이브: 볼 수 있는 목록 → 허용 → 그 드라이브 목록
  const projects = await A('/api/drive/projects');
  assert.deepEqual(projects.projects.map((d) => d.name), ['검토팀', '공개 자료']);
  assert.equal((await A.res('/api/drive/actions', { method: 'POST', body: { action: 'list', drive: PROJECT_DRIVE } })).status, 403);
  const withProject = await A('/api/drive/projects', { method: 'PUT', body: { driveIds: [PROJECT_DRIVE] } });
  assert.deepEqual(withProject.drives.map((d) => d.name), ['내 드라이브', '검토팀']);
  assert.deepEqual((await A('/api/drive/actions', { method: 'POST', body: { action: 'list', drive: PROJECT_DRIVE, folderId: 'root' } })).items.map((f) => f.name), ['팀 보고서.hwpx']);
  assert.equal((await B('/api/drive')).drives.length, 0, '다른 사용자에게는 보이지 않음');
  // 예전 확장 경로는 없다
  for (const [method, p] of [['POST', '/api/drive/pair'], ['GET', '/api/drive/extension.zip'], ['POST', '/api/drive/jobs'], ['GET', '/api/drive/bridge/jobs'], ['POST', '/api/drive/bridge/pair']])
    assert.equal((await A.res(p, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, 404, p);
  // 연결 확인·해제
  assert.equal((await A('/api/drive/connection/check', { method: 'POST' })).connected, true);
  await A('/api/drive/connection', { method: 'DELETE' });
  assert.equal((await A('/api/drive')).connected, false);
  // MCP 에 드라이브 도구를 등록하지 않는다(AI 는 드라이브를 쓰지 않는다)
  const mcp = fs.readFileSync(new URL('../server/mcp.js', import.meta.url), 'utf8');
  for (const name of ['get_drive_context', 'propose_drive_upload', 'prepare_drive_file']) assert.ok(!mcp.includes(`register('${name}'`), name);
});

test('프로젝트 드라이브(2026-11-18): 볼 수 있는 목록은 두레이에서 읽고, 허용한 것만 보이며 목록·내려받기·새 파일 올리기만', async (t) => {
  const { drive, make, fake, dataDir } = setup(t);
  await connected(drive);
  assert.deepEqual(drive.status(a).drives.map((d) => d.key), ['personal'], '처음엔 내 드라이브만');
  const avail = await drive.availableProjects(a);
  assert.deepEqual(avail.projects.map((d) => [d.name, d.scope, d.added]), [['검토팀', 'private', false], ['공개 자료', 'public', false]]);
  // 허용하지 않은 프로젝트 드라이브는 열 수 없다
  await assert.rejects(drive.action(a, { action: 'list', drive: PROJECT_DRIVE }), (e) => e.code === 'DRIVE_SCOPE');
  await assert.rejects(drive.setProjects(a, [NOT_MINE_DRIVE]), (e) => e.code === 'DRIVE_PROJECTS', '두레이에서 볼 수 없는 드라이브는 추가 안 됨');
  await assert.rejects(drive.setProjects(a, ['../x']), (e) => e.code === 'DRIVE_PROJECTS');
  const s = await drive.setProjects(a, [PROJECT_DRIVE]);
  assert.deepEqual(s.drives.map((d) => [d.key, d.kind, d.name]), [['personal', 'personal', '내 드라이브'], [PROJECT_DRIVE, 'project', '검토팀']]);
  assert.deepEqual(s.drives[1].can, ['list', 'download', 'upload']);
  assert.equal(drive.status(b).connected, false, '다른 사용자와 섞이지 않음');
  // 목록·내려받기(옛 화면처럼 projectId 로 보내도 같은 뜻)
  const list = await drive.action(a, { action: 'list', projectId: PROJECT_DRIVE, folderId: 'root' });
  assert.deepEqual(list.items.map((f) => f.name), ['팀 보고서.hwpx']);
  assert.equal(fake.state.calls.at(-1).query.parentId, 'PR1');
  const got = await drive.action(a, { action: 'download', drive: PROJECT_DRIVE, folderId: 'root', fileId: 'PA1', expectedRevision: list.items[0].revision });
  assert.equal(drive.bytes(a, got.stagedId).bytes.toString(), 'PK-team');
  assert.equal(drive.bytes(a, got.stagedId).entry.source.driveId, PROJECT_DRIVE);
  // 개인 드라이브 파일을 프로젝트 드라이브 주소로 부르면 거절
  await assert.rejects(drive.action(a, { action: 'download', drive: PROJECT_DRIVE, folderId: 'root', fileId: 'A1' }), (e) => /DOORAY_NOT_FOUND|DRIVE_SCOPE/.test(e.code));
  // 새 파일 올리기
  const st = drive.stage(a, Buffer.from('팀 공유본'), '검토 결과.hwpx');
  const up = await drive.action(a, { action: 'upload', drive: PROJECT_DRIVE, folderId: 'root', stagedId: st.id });
  assert.equal(fake.files.get(up.id).driveId, PROJECT_DRIVE); assert.equal(fake.files.get(up.id).parent, 'PR1');
  // 교체·이름 바꾸기·삭제는 프로젝트 드라이브에서 안 됨(두레이를 부르기 전에 막는다)
  const before = fake.state.calls.length;
  await assert.rejects(drive.action(a, { action: 'upload', drive: PROJECT_DRIVE, folderId: 'root', stagedId: st.id, replaceId: 'PA1', expectedRevision: '1' }), (e) => e.code === 'DRIVE_READONLY');
  await assert.rejects(drive.action(a, { action: 'rename', drive: PROJECT_DRIVE, folderId: 'root', fileId: 'PA1', expectedRevision: '1', name: 'x.hwpx' }), (e) => e.code === 'DRIVE_READONLY');
  await assert.rejects(drive.action(a, { action: 'delete', drive: PROJECT_DRIVE, folderId: 'root', fileId: 'PA1', expectedRevision: '1' }), (e) => e.code === 'DRIVE_READONLY');
  assert.equal(fake.state.calls.length, before);
  // 개인 드라이브는 그대로
  assert.deepEqual((await list_(drive)).items.map((f) => f.name).sort(), ['보고서.hwpx', '자료']);
  // 허용 목록은 서버를 다시 켜도 남고, 토큰만 바꿔 다시 등록해도 남는다. 빼면 다시 못 연다
  assert.equal(make().status(a).drives.length, 2);
  await connected(drive); assert.equal(drive.status(a).drives.length, 2);
  assert.equal((await drive.availableProjects(a)).projects.find((d) => d.driveId === PROJECT_DRIVE).added, true);
  await drive.setProjects(a, []);
  await assert.rejects(drive.action(a, { action: 'list', drive: PROJECT_DRIVE }), (e) => e.code === 'DRIVE_SCOPE');
  drive.deleteFile(a, got.stagedId);   // 내려받은 보관 사본(이름이 기록됨)을 지운 뒤 — 폴더 목록 자체는 저장하지 않는다
  assert.ok(!fs.readFileSync(path.join(dataDir, 'drive', drive.owner(a), 'index.json'), 'utf8').includes('팀 보고서'), '프로젝트 폴더 목록은 저장하지 않는다');
});
const list_ = (drive) => drive.action(a, { action: 'list', folderId: 'root' });
