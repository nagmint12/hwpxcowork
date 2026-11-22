import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPersonal } from './build-personal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] || '_site');
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'hwpxcowork';
const studioBase = process.env.PAGES_BASE || `/${repo}/studio/`;
if (!/^\/([\w.-]+\/)*studio\/$/.test(studioBase)) throw Error('올바르지 않은 Pages 경로');
const base = studioBase.slice(0,-'studio/'.length);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw Error('비어 있는 출력 폴더를 지정하세요.');
fs.mkdirSync(out, { recursive: true });
const dist = path.join(root, 'studio/dist');
const studio = path.join(out,'studio');
fs.cpSync(dist,studio,{ recursive: true, filter: src => path.relative(dist,src).split(path.sep)[0] !== 'samples' });
let keyGuard = false, assistantGuard = false;
function patch(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir,entry.name);
    if (entry.isDirectory()) { patch(target); continue; }
    if (!/\.(?:html|js|mjs|css)$/.test(entry.name)) continue;
    let text = fs.readFileSync(target,'utf8');
    if (entry.name.endsWith('.js')) { keyGuard ||= text.includes('hwpx-ai-key-storage'); assistantGuard ||= text.includes('hwpx-ai-assistant'); }
    text = text.replaceAll('/studio/', studioBase).replace(/(["'`])\/api\//g, '$1' + base + 'api/');
    if (['index.html','cowork-embed.html'].includes(entry.name)) text = text.replace(/<head>/i, '<head>\n<meta name="hwpx-ai-key-storage" content="off"><meta name="hwpx-ai-assistant" content="off">');
    fs.writeFileSync(target,text);
  }
}
patch(studio);
if (!keyGuard || !assistantGuard) throw Error('공개용 AI 키 저장 및 도우미 차단이 포함된 편집기 빌드가 필요합니다.');
await buildPersonal(out,base);
fs.writeFileSync(path.join(out,'.nojekyll'),'');
console.log('[pages] 개인용 앱과 편집기 생성 완료', out);
