import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoveryPaths, setIntent, requestControl, readJson } from './recovery-state.js';

export async function stopManagedServer({ root, env = process.env, waitMs = 20000 } = {}) {
  const paths = recoveryPaths(root, env);
  setIntent(paths, false, 'stop-command'); // Survives a crash or an unavailable control pipe.
  const state = readJson(paths.stateFile);
  if (!state) throw new Error('관리 실행기 상태가 없습니다. 자동 복구는 중지했지만 실행 중인 서버의 종료 여부는 확인하지 못했습니다.');
  if (state.phase === 'stopped') return { ok: true, alreadyStopped: true };
  let response;
  try { response = await requestControl(paths, 'stop'); }
  catch (error) {
    if (readJson(paths.stateFile)?.phase === 'stopped') return { ok: true, stopped: true };
    throw error;
  }
  if (!response.ok) throw new Error(response.code || '서버 종료 요청 거부');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (readJson(paths.stateFile)?.phase === 'stopped') return { ok: true, stopped: true };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { ok: true, stopping: true, message: '기존 저장 작업을 기다리는 중입니다. 자동 복구는 중지되었습니다.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  try {
    const result = process.argv[2] === 'stop' ? await stopManagedServer({ root }) : await requestControl(recoveryPaths(root), 'status');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
