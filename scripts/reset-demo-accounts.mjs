// 공개 체험 토큰 test1~test100만 초기화한다. 기본은 점검, --apply일 때 백업 후 관리자 API로 실행한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfigFile, writeConfigFile } from '../server/admin-settings.js';
import { writeFileAtomic } from '../server/store.js';

export const DEMO_TOKENS = Array.from({ length: 100 }, (_, i) => `test${i + 1}`);
const demoSet = new Set(DEMO_TOKENS);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function demoResetPlan({ root, configFile = path.join(root, 'config.json') }) {
  const config = read(configFile); const users = config.users || [];
  const existing = users.filter(u => demoSet.has(u.token));
  if (existing.some(u => u.role === 'admin' || users.filter(v => v.name === u.name).length !== 1)) throw new Error('체험 토큰은 고유한 일반 사용자 계정이어야 합니다');
  if (new Set(existing.map(u => u.token)).size !== existing.length) throw new Error('중복 체험 토큰을 먼저 확인해야 합니다');
  const missing = DEMO_TOKENS.filter(token => !existing.some(u => u.token === token)).map(token => {
    if (users.some(u => u.name === token)) throw new Error('추가할 체험 사용자 이름이 기존 계정과 겹칩니다');
    return { name: token, token, role: 'editor' };
  });
  const targets = [...existing, ...missing]; const names = new Set(targets.map(u => u.name));
  const dataDir = path.resolve(path.dirname(configFile), config.dataDir || 'data');
  const documents = [];
  for (const area of ['docs', 'tutorial-sessions/docs']) {
    const dir = path.join(dataDir, area); if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      if (!/^[\w-]{1,64}$/.test(id)) continue;
      const file = path.join(dir, id, 'meta.json'); if (!fs.existsSync(file)) continue;
      const meta = read(file);
      const owned = names.has(meta.createdBy) || (meta.space === 'private' && names.has(meta.spaceOwner));
      if (owned && (meta.requests || []).some(r => r.status === 'working')) throw new Error('체험 문서의 AI 처리가 끝난 뒤 초기화해야 합니다');
      if (!owned && (meta.requests || []).some(r => names.has(r.by || r.user || r.createdBy))) throw new Error('다른 사용자 문서에 체험 요청이 남아 있어 별도 확인이 필요합니다');
      documents.push({ id, area, owned, meta });
    }
  }
  const state = {};
  for (const name of ['ai-run.json', 'personal-ai.json', 'oauth-state.json', 'orchestration.json', 'folders.json', 'tutorial-seen.json', 'tutorial-state.json']) {
    const file = path.join(dataDir, name); if (fs.existsSync(file)) state[name] = read(file);
  }
  const hashes = new Set(DEMO_TOKENS.map(hash));
  const oauth = state['oauth-state.json'];
  const orchestration = state['orchestration.json'];
  const folders = state['folders.json'];
  if ([...Object.values(oauth?.access || {}), ...Object.values(oauth?.refresh || {})].some(v => hashes.has(v.userKey)) ||
      Object.keys(orchestration?.profiles || {}).some(n => names.has(n)) || Object.values(orchestration?.runs || {}).some(r => names.has(r.owner || r.user || r.createdBy)) ||
      Object.values(folders?.folders || {}).some(f => names.has(f.owner || f.createdBy)) || Object.keys(state['ai-run.json']?.catalogs || {}).some(n => names.has(n)))
    throw new Error('체험 계정의 추가 연결·폴더 기록은 별도 백업·정리가 필요합니다');
  return { configFile, config, root, dataDir, existing, missing, targets, names, hashes, documents, state };
}

export async function applyDemoReset(plan, { reportFile } = {}) {
  const { root, configFile, dataDir, targets, names, hashes } = plan;
  const admin = plan.config.users.find(u => u.role === 'admin' && u.token);
  if (!admin) throw new Error('관리자 계정을 찾지 못했습니다');
  const base = `http://127.0.0.1:${plan.config.port || 8787}`;
  const request = async (route, { method = 'GET', body, token = admin.token } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${result.error || ''}`);
    return result;
  };
  const beforeRuntime = await request('/api/admin/server');
  if (!beforeRuntime.restart.supported || beforeRuntime.restart.busy) throw new Error('안전한 서버 재시작을 준비할 수 없습니다');
  const backup = path.resolve(root, 'backups', `demo-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (!backup.startsWith(path.resolve(root, 'backups') + path.sep)) throw new Error('백업 경로 확인 실패');
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(configFile, path.join(backup, 'config.json'));
  for (const file of Object.keys(plan.state)) fs.copyFileSync(path.join(dataDir, file), path.join(backup, file));
  for (const doc of plan.documents.filter(d => d.owned)) {
    const destination = path.join(backup, 'documents', doc.area, doc.id);
    if (!path.resolve(destination).startsWith(backup + path.sep)) throw new Error('문서 백업 경로 확인 실패');
    fs.cpSync(path.join(dataDir, doc.area, doc.id), destination, { recursive: true, errorOnExist: true, force: false });
  }
  const users = await request('/api/admin/users'); let revision = users.revision;
  for (const user of plan.missing) revision = (await request('/api/admin/users', { method: 'POST', body: { user, revision } })).revision;
  for (const target of targets) {
    const settings = plan.state['ai-run.json']?.users?.[target.name];
    for (const kind of Object.keys(settings || {})) await request('/api/me/ai-run', { method: 'PUT', token: target.token, body: { kind, model: '', effort: '' } });
    if (plan.state['personal-ai.json']?.users?.[target.name]) await request('/api/me/ai', { method: 'DELETE', token: target.token });
  }
  let removed = 0;
  for (const doc of plan.documents.filter(d => d.owned)) {
    if (doc.meta.tutorialSession) {
      const target = targets.find(u => u.name === doc.meta.createdBy);
      await request(`/api/tutorial/${doc.id}`, { method: 'DELETE', token: target.token });
    } else await request(`/api/docs/${doc.id}`, { method: 'DELETE' });
    removed++;
  }
  let cleared = 0;
  for (const name of ['tutorial-seen.json', 'tutorial-state.json']) {
    const file = path.join(dataDir, name); if (!fs.existsSync(file)) continue;
    const current = read(file);
    for (const key of Object.keys(current)) if (names.has(key) || hashes.has(key)) { delete current[key]; cleared++; }
    writeFileAtomic(file, `${JSON.stringify(current, null, 1)}\n`);
  }
  const latest = readConfigFile(configFile);
  const tutorial = { ...latest.raw.tutorial, enabled: true, everyone: true, users: [...new Set([...(latest.raw.tutorial?.users || []), ...targets.map(u => u.name)])] };
  writeConfigFile(configFile, { ...latest.raw, tutorial }, latest.revision);
  const snapshot = await request('/api/admin/server');
  await request('/api/admin/restart', { method: 'POST', body: { revision: snapshot.revision } });
  const deadline = Date.now() + 45000; let restarted = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    try { const current = await request('/api/admin/server'); if (current.running.instanceId !== beforeRuntime.running.instanceId && !current.restart.busy) { restarted = true; break; } } catch { /* 정상 재시작 연결 대기 */ }
  }
  if (!restarted) throw new Error('서버 정상 재시작 확인이 필요합니다');
  let verified = 0;
  for (const target of targets) {
    const me = await request('/api/me', { token: target.token });
    const status = await request('/api/tutorial', { token: target.token });
    if (me.tutorialIntroRequired !== true || status.sessions.length !== 0) throw new Error('체험 토큰의 초기 상태 검증 실패');
    verified++;
  }
  const after = demoResetPlan({ root, configFile });
  if (after.missing.length || after.documents.some(d => d.owned)) throw new Error('초기화 뒤 남은 체험 기록 확인 필요');
  const otherIds = plan.documents.filter(d => !d.owned).map(d => d.id);
  if (!otherIds.every(id => after.documents.some(d => d.id === id && !d.owned))) throw new Error('기존 다른 사용자 문서 확인 필요');
  const result = { generated: plan.missing.length, demoTokens: targets.length, removedDocuments: removed, clearedTutorialRecords: cleared, verifiedCleanTokens: verified, preservedOtherDocuments: otherIds.length, restarted, backup, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(result, null, 2));
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plan = demoResetPlan({ root });
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', existing: plan.existing.length, create: plan.missing.length, documents: plan.documents.filter(d => d.owned).length, otherDocuments: plan.documents.filter(d => !d.owned).length }));
  if (process.argv.includes('--apply')) console.log(JSON.stringify(await applyDemoReset(plan, { reportFile: path.join(root, 'artifacts/onboarding-audit-20261101/reset-result.json') })));
}
