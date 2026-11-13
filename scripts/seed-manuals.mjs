#!/usr/bin/env node
// 켜져 있는 서버에 사용 설명서(docs/manuals)를 넣는다 — 공용 문서함 '따라하기 설명서' 폴더 + 'AI 작업 맡기기' 설명서의 실제 요청·메모 기록.
//   node scripts/seed-manuals.mjs --url http://localhost:8787 --token <관리자 토큰>   (토큰은 HWPX_COWORK_TOKEN 으로도)
//   --replace : 이미 넣은 설명서를 새 판으로 바꾼다(쓴 흔적이 없는 옛 판은 지우고, 있는 것은 관리자 개인 문서함으로 옮김 — replaceManuals)
// 포터블 서버는 첫 실행 때 스스로 넣는다(config.manuals.seed). 이 명령은 개발 서버·이미 쓰던 서버에 넣을 때 쓴다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedManuals, replaceManuals } from '../server/manual-seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes('--help')) {
  console.log('사용법: node scripts/seed-manuals.mjs --url http://localhost:8787 --token <관리자 토큰> [--dir docs/manuals] [--replace]');
} else {
  const base = (arg('--url') || process.env.HWPX_COWORK_URL || 'http://localhost:8787').replace(/\/mcp\/?$/, '');
  const token = arg('--token') || process.env.HWPX_COWORK_TOKEN;
  if (!token) { console.error('관리자 토큰이 필요합니다(--token 또는 HWPX_COWORK_TOKEN)'); process.exitCode = 2; }
  else {
    try {
      const run = process.argv.includes('--replace') ? replaceManuals : seedManuals;
      const out = await run({ base, token, dir: path.resolve(arg('--dir') || path.join(root, 'docs', 'manuals')), log: (m) => console.log(m) });
      console.log(`완료: 문서 ${out.docs.length}건 (폴더 ${out.folderId})`);
    } catch (error) {
      console.error(`사용 설명서를 넣지 못했습니다: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
