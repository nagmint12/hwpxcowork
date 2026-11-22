#!/usr/bin/env node
// GitHub Pages 사이트 만들기(2026-11-18 사용자 요청): 서버 없이 도는 공개 체험 페이지 — 운영 서버와 연결하지 않는다.
//   index.html(체험 고르기) · teaser/와 teaser3/(기존 재생기·장면) · tutorial/(예시 검토)
//   · studio/(브라우저 편집기, studio/dist) · samples/report-sample.hwpx(견본 보고서 = tutorial/결과보고서.hwpx)
//   node deploy/github-pages/build-site.mjs <출력 폴더>      (저장소 맨 위에서 — .github/workflows/pages.yml 이 부른다)
// Node 기본 모듈만 쓴다(Actions 에서 npm 설치 없이).
//
// - 편집기 빌드는 /studio/ 에 놓이도록 만든 것이다(scripts/build-studio.mjs 의 vite base). Pages 주소는 /<저장소>/studio/ 이므로
//   html·js·css 의 '/studio/' 를 그 주소로 바꾸고, 바뀌지 않은 것이 남으면 멈춘다(PAGES_BASE 로 다른 주소를 줄 수 있다).
// - 이 사이트는 누구나 여는 공개 주소다(비공개 저장소라도 Pages 는 공개). AI 도우미의 API 키를 저장하지 않게
//   편집기 index.html 에 <meta name="hwpx-ai-key-storage" content="off"> 를 넣고, 그 막음 코드(studio/build/ai-key-storage-patches.mjs)가
//   든 편집기 빌드인지 확인한다 — 없으면 만들지 않는다. *.github.io 주소는 그 코드가 주소만으로도 막는다.
// - 편집기 예시 문서와 서버용 내장 편집기 시작 페이지는 싣지 않는다.
// - 공개 체험 페이지의 편집기에서는 AI 도우미를 올리지 않는다(<meta name="hwpx-ai-assistant" content="off"> — 사용자 결정, 패치 ai-assistant-hidden-on-public-page).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.resolve(process.argv[2] || '_site');
const repo = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || 'hwpxcowork';
const base = process.env.PAGES_BASE || `/${repo}/studio/`;
const fail = (msg) => { console.error(`[pages] ${msg}`); process.exit(1); };
if (!/^\/([\w.-]+\/)*studio\/$/.test(base)) fail(`편집기 주소(base)가 올바르지 않습니다: ${base}`);

const dist = path.join(root, 'studio/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) fail('studio/dist/index.html 이 없습니다');
if (fs.existsSync(out) && fs.readdirSync(out).length) fail(`출력 폴더가 비어 있지 않습니다: ${out}`);
fs.mkdirSync(out, { recursive: true });

// ── 첫 화면(체험 고르기) ──
fs.copyFileSync(path.join(here, 'index.html'), path.join(out, 'index.html'));
// HWPX_SERVER_URL(저장소 변수)을 주면 app/ 에 그 서버 화면을 그대로 보여 주는 입구(app.html)를 더 만든다(별도 시험 서버를 둘 때 — 지금은 쓰지 않음,
// 2026-11-18 사용자 결정: 공개 페이지는 운영 서버와 연결하지 않는다). 첫 화면을 바꾸지는 않는다. 서버 주소는 저장소 글에 적지 않는다.
const serverUrl = (process.env.HWPX_SERVER_URL || '').trim();
if (serverUrl) {
  let u; try { u = new URL(serverUrl); } catch { fail(`HWPX_SERVER_URL 이 주소가 아닙니다: ${serverUrl}`); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) fail('HWPX_SERVER_URL 은 경로·쿼리 없는 https 서버 주소여야 합니다');
  const shell = fs.readFileSync(path.join(here, 'app.html'), 'utf8');
  if (shell.split('__HWPX_SERVER__').length !== 2) fail('app.html 의 __HWPX_SERVER__ 자리가 하나가 아닙니다');
  fs.mkdirSync(path.join(out, 'app'));
  fs.writeFileSync(path.join(out, 'app', 'index.html'), shell.replace('__HWPX_SERVER__', () => JSON.stringify(u.origin + '/')).replaceAll('href="favicon.ico"', 'href="../favicon.ico"').replaceAll('href="icon.png"', 'href="../icon.png"'));
}
// 두 영상은 각 재생기의 상대 경로를 유지하고 같은 Pages용 화면을 사용한다.
const intro = fs.readFileSync(path.join(here, 'intro.html'), 'utf8');
for (const [film, title] of [['teaser', '기능 소개'], ['teaser3', '여백의 손글씨']]) {
  const destination = path.join(out, film);
  fs.mkdirSync(destination);
  for (const name of ['player.js', 'film', 'assets']) {
    fs.cpSync(path.join(root, 'web', film, name), path.join(destination, name), { recursive: true });
  }
  fs.writeFileSync(path.join(destination, 'index.html'), intro.replaceAll('__FILM__', film).replaceAll('__TITLE__', title));
}
fs.mkdirSync(path.join(out, 'intro'));
fs.writeFileSync(path.join(out, 'intro', 'index.html'), '<!doctype html><html lang="ko"><meta charset="utf-8"><title>Hwpx Cowork 소개 영상</title><meta http-equiv="refresh" content="0;url=../teaser/"><a href="../teaser/">소개 영상 보러가기</a></html>');
fs.mkdirSync(path.join(out, 'tutorial'));
for (const name of ['tutorial.html', 'tutorial.js']) {
  fs.copyFileSync(path.join(here, name), path.join(out, 'tutorial', name === 'tutorial.html' ? 'index.html' : name));
}
// 견본 보고서(가상 자료로 만든 튜토리얼 문서)
fs.mkdirSync(path.join(out, 'samples'));
fs.copyFileSync(path.join(root, 'tutorial', '결과보고서.hwpx'), path.join(out, 'samples', 'report-sample.hwpx'));
fs.copyFileSync(path.join(here, 'site.css'), path.join(out, 'site.css'));
fs.copyFileSync(path.join(root, 'web/icons/icon-128.png'), path.join(out, 'brand.png'));
fs.copyFileSync(path.join(root, 'web/icons/icon-256.png'), path.join(out, 'icon.png'));
fs.copyFileSync(path.join(root, 'web/favicon.ico'), path.join(out, 'favicon.ico'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// ── 편집기 ──
const studio = path.join(out, 'studio');
const excludedStudioEntries = new Set(['samples', 'cowork-embed.html']);
fs.cpSync(dist, studio, { recursive: true, filter: (src) => !excludedStudioEntries.has(path.relative(dist, src).split(path.sep)[0]) });
const texts = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(html|js|mjs|css)$/i.test(e.name)) texts.push(p);
  }
})(studio);
let replaced = 0; let marker = false;
const left = new RegExp(`(?<!${base.slice(0, -'/studio/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/studio/`, 'g');
for (const f of texts) {
  const before = fs.readFileSync(f, 'utf8');
  if (before.includes('hwpx-ai-key-storage')) marker = true;
  const n = before.split('/studio/').length - 1;
  if (!n) continue;
  const after = before.split('/studio/').join(base);
  if (base !== '/studio/' && left.test(after)) fail(`바꾸지 못한 /studio/ 가 남았습니다: ${path.relative(out, f)}`);
  left.lastIndex = 0;
  fs.writeFileSync(f, after); replaced += n;
}
if (!marker) fail('AI 도우미 키 저장 막음이 든 편집기 빌드가 아닙니다(studio/build/ai-key-storage-patches.mjs 로 다시 빌드하세요)');
const index = path.join(studio, 'index.html');
const html = fs.readFileSync(index, 'utf8');
if (!/<head>/i.test(html)) fail('편집기 index.html 에 <head> 가 없습니다');
fs.writeFileSync(index, html.replace(/<head>/i, '<head>\n  <meta name="hwpx-ai-key-storage" content="off">\n  <meta name="hwpx-ai-assistant" content="off">'));
if (!fs.readdirSync(path.join(studio, 'assets')).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(studio, 'assets', f), 'utf8').includes('hwpx-ai-assistant'))) fail('AI 도우미 숨김 패치가 든 편집기 빌드가 아닙니다');
for (const name of excludedStudioEntries) if (fs.existsSync(path.join(studio, name))) fail(`공개 체험에 포함하지 않는 편집기 항목이 남았습니다: ${name}`);
console.log(`[pages] ${out} — 편집기 경로 ${replaced}곳을 ${base} 로, AI 키 저장 막음·AI 도우미 숨김 확인, 소개 영상 2편·튜토리얼·견본 보고서${serverUrl ? ', app/ 입구' : ''}`);
