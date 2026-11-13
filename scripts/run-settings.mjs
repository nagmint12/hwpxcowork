#!/usr/bin/env node
// 웹에서 정한 연결별 모델·추론 강도(server/ai-run.js)를 실행 인자로 찍는다 — start-agent.bat 이 claude 를 띄울 때 붙인다.
//   node scripts/run-settings.mjs claude-code [--port 8787 | --url http://서버]   → 예: --model claude-opus-5-5 --effort high
// 토큰은 HWPX_COWORK_TOKEN 에서만 읽는다. 서버에 닿지 못하거나 정한 값이 없으면 아무것도 찍지 않는다(그 AI 의 기본값으로 뜸).
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SAFE = /^[A-Za-z0-9._:/@-]{1,200}$/;   // server/ai-run.js RUN_MODEL_RE 와 같음 — 배치 파일에 그대로 붙어도 안전한 글자만

/** 설정 → 실행 인자 문자열(모르는 글자가 든 값은 빼고) */
export function runArgs(setting = {}) {
  const out = [];
  if (setting.model && SAFE.test(setting.model)) out.push('--model', setting.model);
  if (setting.effort && /^[a-z]{2,10}$/.test(setting.effort)) out.push('--effort', setting.effort);
  return out.join(' ');
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const kind = argv[0] || 'claude-code';
  const arg = (name) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
  const port = Number(arg('--port') || env.HWPX_COWORK_PORT || 8787);
  const base = String(arg('--url') || `http://localhost:${port}`).replace(/\/mcp\/?$/, '').replace(/\/$/, '');
  const token = String(env.HWPX_COWORK_TOKEN || '').trim();
  if (!token) return '';
  try {
    const res = await fetchImpl(`${base}/api/me/ai-run`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    return runArgs((await res.json())?.settings?.[kind]);
  } catch { return ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const line = await main();
  if (line) process.stdout.write(`${line}\n`);
}
