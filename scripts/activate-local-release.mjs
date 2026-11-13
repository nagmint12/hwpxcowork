// Activate this workspace's managed server through its supported graceful restart.
// Credentials stay in memory and are never written to the report or console.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'config.json');
const before = fs.readFileSync(configFile);
const config = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
const admin = config.users.find(user => user.role === 'admin' && user.token);
if (!admin) throw new Error('관리자 인증이 설정되어 있지 않습니다.');
const local = `http://127.0.0.1:${config.port || 8787}`;
const publicBase = 'https://cowork.example.com';
const headers = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const get = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...options });
const initial = await get(`${local}/api/admin/server`, { headers });
if (!initial.ok) throw new Error(`서버 관리 상태 확인 실패: ${initial.status}`);
const state = await initial.json();
if (!state.restart?.supported || state.restart?.busy) throw new Error('현재 서버의 정상 재시작을 사용할 수 없습니다.');
if (state.restartRequired) throw new Error('저장된 연결 설정이 실행 중 설정과 다릅니다. 이 스크립트는 연결 설정을 바꾸지 않습니다.');
const restart = await get(`${local}/api/admin/restart`, { method: 'POST', headers, body: JSON.stringify({ revision: state.revision }) });
if (restart.status !== 202) throw new Error(`정상 재시작 요청 실패: ${restart.status}`);
let active;
for (const started = Date.now(); Date.now() - started < 45000;) {
  try {
    const response = await get(`${local}/api/config`);
    const value = response.ok ? await response.json() : null;
    if (value?.nonce && value.nonce !== state.running.instanceId) { active = value; break; }
  } catch { /* graceful drain or child replacement */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!active) throw new Error('재시작한 서버의 준비 완료를 확인하지 못했습니다. 강제 종료는 하지 않습니다.');
if (sha256(before) !== sha256(fs.readFileSync(configFile))) throw new Error('갱신 도중 설정 파일이 변경되었습니다.');
const report = { checkedAt: new Date().toISOString(), gracefulRestart: true, configUnchanged: true, publicBase, oauthEnabled: active.oauth?.enabled, accounts: [], downloads: [] };
for (const token of ['test1', 'test2', 'test3', 'test4', 'test5']) {
  const response = await get(`${publicBase}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`공개 체험 계정 확인 실패: ${token}, ${response.status}`);
  const value = await response.json();
  if (!value.tutorialApiOnly || !value.personalAi?.apiOnly) throw new Error(`공개 체험의 API 전용 정책 미반영: ${token}`);
  report.accounts.push({ token, apiOnly: true, sharedApiActive: !!value.personalAi.active });
}
const manifestResponse = await get(`${publicBase}/download/release.json`);
if (!manifestResponse.ok) throw new Error(`외부 다운로드 명세 확인 실패: ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
for (const target of ['server-install', 'worker-install', 'user-app']) {
  const item = manifest.packages.find(p => p.target === target && p.file.endsWith('.zip'));
  if (!item || !item.downloadUrl.startsWith(publicBase + '/download/')) throw new Error(`HTTPS 다운로드 항목 누락: ${target}`);
  const response = await get(item.downloadUrl, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`외부 파일 다운로드 실패: ${target}, ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`외부 파일 무결성 확인 실패: ${target}`);
  report.downloads.push({ target, url: item.downloadUrl, bytes: bytes.length, sha256Matches: true });
}
const out = path.join(root, 'artifacts', 'review-final-20261031');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'activation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
