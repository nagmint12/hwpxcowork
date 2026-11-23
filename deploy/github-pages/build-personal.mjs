import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './build-seed.mjs';
import { buildWorker } from './build-worker.mjs';
import { pagesDownloads } from './downloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
export async function buildPersonal(out, base) {
  const from = (...parts) => path.join(root, ...parts);
  const dest = (...parts) => path.join(out, ...parts);
  const prefix = base.slice(0, -1);
  const staticNames = /(["'`(=]|\$\{location\.origin\})\/(?=(?:api|studio|vendor|icons|teaser3?|tutorial-assets|tutorial-media|onboarding-assets|manual-resources|help-assets|rhwp-fonts|cowork-[\w.-]+)(?:[/?#'"`])|(?:manual\.md|[\w.-]+\.(?:html|css|js|ico))(?:\$\{|[?#'"`])|\?teaser=)/g;
  const release = process.env.PAGES_RELEASE_JSON ? JSON.parse(fs.readFileSync(process.env.PAGES_RELEASE_JSON, 'utf8')) : null;
  const { links, packages } = pagesDownloads(release, base);
  fs.writeFileSync(dest('personal-downloads.json'), JSON.stringify({ packages }));
  function rebase(s) {
    return s.replace(staticNames, (_, left) => left + base)
      // The server generates a custom ZIP. Pages distributes the published Windows installer.
      .replace(/`\/download\/windows-setup\.zip\?[^`]*`/g, () => JSON.stringify(links.get('/download#windows')))
      .replace(/(["'`])(\/download(?:[#/][\w./-]*)?)\1/g, (_, quote, url) => {
        if (!links.has(url)) throw Error(`Pages 다운로드 경로를 지정하세요: ${url}`);
        return quote + links.get(url) + quote;
      });
  }
  const jsStyles = /\.(?:js|mjs|css|html)$/i;
  function copyWeb(src, dst) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const child of fs.readdirSync(src)) copyWeb(path.join(src, child), path.join(dst, child));
    } else if (jsStyles.test(src)) {
      const text = fs.readFileSync(src, 'utf8');
      const output = path.basename(src) === 'help.html'
        ? text.replace('<html lang="ko">', '<html lang="ko" data-browser-personal>') : text;
      fs.writeFileSync(dst, rebase(output));
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
  for (const name of ['AGENT_SETUP.md', 'MCP_EVENTS_GUIDE.md', 'CHATGPT_WORK_FILES.md', 'AUTOMATIC_AI_GUIDE.md', 'SERVER_MIGRATION.md']) {
    const markdown = fs.readFileSync(from('docs', name), 'utf8');
    const repoDocs = 'https://github.com/nagmint12/hwpxcowork/blob/main/docs/';
    const linked = markdown.replace(/\]\((?:\.\/)?([\w.-]+\.md)(#[^)]+)?\)/g,
      (_, file, hash = '') => '](' + repoDocs + file + hash + ')');
    fs.writeFileSync(dest('manual-resources', name), linked);
  }
  fs.copyFileSync(from('deploy', 'Caddyfile.example'), dest('manual-resources', 'Caddyfile.example'));
  // Relative links work in both the rendered help and the downloadable Markdown.
  const manual = fs.readFileSync(from('docs', 'DEPLOYMENT_AND_AI_GUIDE.md'), 'utf8')
    .replace(/\]\(\/manual-resources\//g, '](./manual-resources/')
    .replace(/\]\((AGENT_SETUP\.md|SERVER_MIGRATION\.md|\.\.\/deploy\/Caddyfile\.example)\)/g,
      (_, file) => '](./manual-resources/' + path.posix.basename(file) + ')');
  fs.writeFileSync(dest('manual.md'), manual);
  fs.copyFileSync(path.join(here,'browser/start.js'), dest('personal-start.js'));
  fs.copyFileSync(path.join(here,'browser/personal.css'), dest('personal.css'));
  for (const name of ['about.html', 'privacy.html', 'terms.html', 'site.css', 'hwpx-cowork-logo-purple.png', 'google9ca4ee124be68f95.html']) {
    fs.copyFileSync(path.join(here, name), dest(name));
  }
  const html = index.replace(/<script src="\/intro\.js"><\/script>/,'')
    .replace('</head>', '<link rel="stylesheet" href="./personal.css"><link rel="help" href="./about.html"><link rel="privacy-policy" href="./privacy.html"><link rel="terms-of-service" href="./terms.html"></head>')
    .replace(/<script type="module">[\s\S]*?<\/script>/, '<meta name="hwpx-personal-app" content="' + prefix + entry + '"><script type="module" src="./personal-start.js"></script>')
    .replace('<div id="app"></div>', '<noscript><a href="./about.html">HWPX Cowork 앱 소개와 이용 안내</a></noscript><div id="app"><p role="status" style="padding:1rem">개인 문서함을 여는 중…</p></div>');
  fs.writeFileSync(dest('index.html'), rebase(html));
  await buildWorker(dest('personal-worker.js'));
  await buildSeed(root, dest('personal-seed.zip'));
}
