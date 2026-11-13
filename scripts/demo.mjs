// 체험(점검)용 실행: 내 문서의 '복사본' + 모의 AI 로 서버를 띄운다. data/ 의 원본은 건드리지 않는다.
//   npm run demo            → http://localhost:8788 (처음이면 data/docs 를 demo-data/ 로 복사)
//   npm run demo -- --reset → demo-data/ 를 지우고 다시 복사
// 모의 AI 는 네트워크 없이 정해진 규칙으로 고친 글을 돌려준다(요약이 "(모의 AI)" 로 시작). 실제 Claude 는 부르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const demo = path.join(root, 'demo-data');
const port = process.env.HWPX_COWORK_PORT || '8788';

if (process.argv.includes('--reset')) fs.rmSync(demo, { recursive: true, force: true });
if (!fs.existsSync(path.join(demo, 'docs'))) {
  fs.mkdirSync(path.join(demo, 'docs'), { recursive: true });
  const src = path.join(root, 'data', 'docs');
  const ids = fs.existsSync(src) ? fs.readdirSync(src).filter((d) => fs.existsSync(path.join(src, d, 'meta.json'))) : [];
  for (const id of ids) fs.cpSync(path.join(src, id), path.join(demo, 'docs', id), { recursive: true });
  console.log(`[demo] data/docs 의 문서 ${ids.length}건을 demo-data/ 로 복사했습니다(원본은 그대로).`);
}

const cfg = JSON.parse(fs.readFileSync(path.join(root, fs.existsSync(path.join(root, 'config.json')) ? 'config.json' : 'config.example.json'), 'utf-8'));
const user = (cfg.users || []).find((u) => u.role !== 'admin') || (cfg.users || [])[0];
console.log(`[demo] 체험 주소: http://localhost:${port}/#/t/${encodeURIComponent(user?.token || '')}  (${user?.name}, 모의 AI)`);
console.log('[demo] 끝내려면 이 창에서 Ctrl+C');

const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, HWPX_COWORK_DATA_DIR: demo, HWPX_COWORK_AI_MOCK: '1', HWPX_COWORK_PORT: port, HWPX_COWORK_HOST: process.env.HWPX_COWORK_HOST || '127.0.0.1' },
});
const stop = () => { try { child.kill(); } catch { /* ignore */ } };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
child.on('exit', (code) => process.exit(code ?? 0));
