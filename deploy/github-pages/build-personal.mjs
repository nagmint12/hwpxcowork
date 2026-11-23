import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './build-seed.mjs';
import { buildWorker } from './build-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
export async function buildPersonal(out, base) {
  const from = (...parts) => path.join(root, ...parts);
  const dest = (...parts) => path.join(out, ...parts);
  const prefix = base.slice(0, -1);
  const staticNames = /(["'`(=]|\$\{location\.origin\})\/(?=(?:api|studio|vendor|icons|teaser3?|tutorial-assets|tutorial-media|onboarding-assets|manual-resources|help-assets|rhwp-fonts|cowork-[\w.-]+)(?:[/?#'"`])|[\w.-]+\.(?:html|css|js|ico)(?:[?#'"`])|\?teaser=)/g;
  // Installers are served by the download site, including OS anchors and package URLs.
  function rebase(s) {
    return s.replace(staticNames, (_, left) => left + base)
      .replace(/(["'`])\/download(?=[/#?"'`])/g, '$1https://asmint.duckdns.org/download');
  }
  const jsStyles = /\.(?:js|mjs|css|html)$/i;
  function copyWeb(src, dst) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const child of fs.readdirSync(src)) copyWeb(path.join(src, child), path.join(dst, child));
    } else if (jsStyles.test(src)) {
      const text = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(dst, rebase(text));
    } else fs.copyFileSync(src,dst);
  }
  const web = from('web');
  const allowedDirs = new Set(['icons','teaser','teaser3','help-assets','onboarding-assets','tutorial-assets','tutorial-modules']);
  const index = fs.readFileSync(path.join(web,'index.html'),'utf8');
  const entry = /import\(['"](\/[^'"]*app\.js)['"]\)/.exec(index)?.[1];
  if (!entry) throw Error('개인용 앱 시작 모듈을 찾지 못했습니다.');
  if (entry.split('/').length > 2) allowedDirs.add(entry.split('/')[1]);
  for (const item of fs.readdirSync(web, { withFileTypes: true })) {
    if (item.isDirectory() ? !allowedDirs.has(item.name) : !/\.(js|css|ico)$/.test(item.name) && !['onboarding.html','help.html'].includes(item.name)) continue;
    copyWeb(path.join(web,item.name), dest(item.name));
  }
  fs.mkdirSync(dest('vendor'), { recursive: true });
  fs.copyFileSync(require.resolve('vue/dist/vue.esm-browser.prod.js'), dest('vendor/vue.esm-browser.prod.js'));
  fs.cpSync(from('vendor/rhwp/npm/editor'), dest('vendor/rhwp-editor'), { recursive: true, filter: p => fs.statSync(p).isDirectory() ? path.basename(p) !== 'tests' : /(?:\.js|LICENSE)$/.test(p) });
  fs.mkdirSync(dest('manual-resources'),{recursive:true});
  for (const name of ['AGENT_SETUP.md','MCP_EVENTS_GUIDE.md','CHATGPT_WORK_FILES.md','AUTOMATIC_AI_GUIDE.md']) if(fs.existsSync(from('docs',name))) fs.copyFileSync(from('docs',name),dest('manual-resources', name));
  fs.copyFileSync(path.join(here,'browser/start.js'), dest('personal-start.js'));
  fs.copyFileSync(path.join(here,'browser/personal.css'), dest('personal.css'));
  const html = index.replace(/<script src="\/intro\.js"><\/script>/,'')
    .replace('</head>', '<link rel="stylesheet" href="./personal.css"></head>')
    .replace(/<script type="module">[\s\S]*?<\/script>/, '<meta name="hwpx-personal-app" content="' + prefix + entry + '"><script type="module" src="./personal-start.js"></script>')
    .replace('<div id="app"></div>', '<div id="app"><p role="status" style="padding:1rem">개인 문서함을 여는 중…</p></div>');
  fs.writeFileSync(dest('index.html'), rebase(html));
  await buildWorker(dest('personal-worker.js'));
  await buildSeed(root, dest('personal-seed.zip'));
}
