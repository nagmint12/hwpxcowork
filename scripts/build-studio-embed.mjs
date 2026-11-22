import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildStudioEmbed(studioDist) {
  const index = fs.readFileSync(path.join(studioDist, 'index.html'), 'utf8');
  const startup = fs.readFileSync(path.join(root, 'studio/embedded-settings.js'), 'utf8');
  const head = /<head\b[^>]*>/i;
  if (!head.test(index)) throw Error('편집기 시작 페이지를 확인할 수 없습니다.');
  const bootstrap = startup.replace(/<\/script/gi, '<\\/script');
  const wrapper = index.replace(head, tag => `${tag}\n  <script>\n${bootstrap}  </script>\n`);
  const output = path.join(studioDist, 'cowork-embed.html');
  fs.writeFileSync(output, wrapper);
  return output;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3) throw Error('사용법: node scripts/build-studio-embed.mjs <Studio dist 폴더>');
  console.log(buildStudioEmbed(path.resolve(process.argv[2])));
}
