// /download: 지원 환경, 다운로드, 짧은 설치 순서를 보여 준다. 자세한 안내는 release.json의 guide를 사용한다.
import fs from 'node:fs';

const cssFile = new URL('./download-page.css', import.meta.url);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = bytes => `${(bytes / 1000000).toFixed(1)} MB`;
const version = p => p.version || /-(\d+\.\d+\.\d+)(?:-|\.)/.exec(p.file)?.[1] || '';
const icons = {
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const isArchive = p => p.archived === true || /previous|archive/.test(p.target || '');
const isUniversal = p => p.arch === 'universal' || /macos-(?:editor-\d|universal)/.test(p.file);
const archLabel = p => isUniversal(p) ? 'Intel·Apple Silicon 공용' : p.arch === 'arm64' || /arm64/.test(p.file) ? 'Apple Silicon' : 'Intel';
const download = (p, label) => `<a class="btn" href="/download/${encodeURIComponent(p.file)}" download data-file="${escape(p.file)}"><span>${escape(label)}</span>${icon('download')}</a>`;
const metadata = p => `<span class="file-meta">${version(p) ? 'v' + escape(version(p)) + ' · ' : ''}${size(p.bytes)}</span>`;
const integrity = packages => `<details class="integrity"><summary>파일 정보 · SHA-256</summary><div class="integrity-content">${packages.map(p => `<div><span>${escape(p.title || p.file)}</span><code>${escape(p.file)}</code><code>${p.sha256}</code></div>`).join('')}</div></details>`;
const guide = p => typeof p.guide === 'string' && p.guide.trim() ? `<details class="guide"><summary>설치 안내 전체</summary><pre class="guide-text">${escape(p.guide.trim())}</pre></details>` : '';

const PRODUCTS = {
  'windows-app': {
    platform: 'windows', title: 'Windows', name: 'Hwpx Cowork',
    description: 'HWPX 문서를 혼자 또는 여럿이 편집합니다.',
    requires: ['Windows 10·11 (64비트)', '관리자 권한 불필요'],
    button: '설치 파일 다운로드',
    steps: ['받은 .exe 파일 실행', '[다음] → [설치] → [마침]', '첫 실행에서 작업 방식 선택'],
    setupNote: 'AI 연결은 [AI → 실행기 관리]에서 설정합니다.',
  },
  'windows-personal': {
    platform: 'windows', title: '개인용', name: 'Hwpx Cowork',
    description: '내 PC의 HWPX 문서를 열어 고치고 원래 파일에 저장합니다.',
    requires: ['Windows 10·11 (64비트)', '첫 설치에 인터넷 필요', '관리자 권한 불필요'],
    button: '개인용 ZIP 다운로드',
    steps: ['ZIP 압축 풀기', '시작.bat 실행', '문서함에서 [PC 폴더 연결]'],
  },
  'windows-shared': {
    platform: 'windows', title: '공동 작업용', name: 'Hwpx Cowork',
    description: '이 PC를 서버로 사용합니다. 참여자는 브라우저에서 함께 편집합니다.',
    requires: ['Windows 10·11 (64비트)', '첫 설치와 외부 접속에 인터넷 필요'],
    button: '공동 작업용 ZIP 다운로드',
    steps: ['ZIP 압축 풀기', '시작.bat 실행', '[관리자 → 사용자]에서 참여자 추가', '외부 접속 주소와 토큰 전달'],
  },
  mac: {
    platform: 'mac', title: 'Mac', name: 'Hwpx Editor',
    description: 'HWP·HWPX·HML 문서를 열고 편집합니다.',
    requires: ['macOS 12.1 이상'],
    button: 'Mac용 ZIP 다운로드',
    steps: ['ZIP 압축 풀기', '앱을 응용 프로그램 폴더로 옮기기', 'Hwpx Editor 열기'],
  },
  android: {
    platform: 'android', title: 'Android', name: 'Hwpx Cowork',
    description: '휴대폰에서 HWP·HWPX 문서를 열고 편집합니다.',
    requires: ['Android 8.0 이상'],
    button: 'APK 다운로드',
    steps: ['받은 APK 파일 열기', '요청 시 이 출처의 앱 설치 허용', '설치 후 앱 열기'],
  },
};

function platformIcon(platform) {
  const base = `/icons/download/${platform}`;
  return `<picture class="product-icon">
    <source media="(prefers-reduced-motion: no-preference)" type="image/webp" srcset="${base}.webp">
    <img src="${base}.png" width="64" height="64" alt="" loading="lazy">
  </picture>`;
}

function productCard(kind, packages, heading = 'h2') {
  const d = PRODUCTS[kind];
  const isMac = kind === 'mac';
  const requires = [...d.requires];
  if (isMac) requires.push([...new Set(packages.map(archLabel))].join(' / '));
  return `<article class="product-card"${d.platform === 'windows' ? ` id="${kind}"` : ''}>
    <header class="product-head">${platformIcon(d.platform)}<div><${heading}>${d.title}</${heading}><p>${d.name}</p></div></header>
    <p class="product-description">${d.description}</p>
    <p class="compat-line">${requires.join(' · ')}</p>
    <div class="download-list">${packages.map(p => {
      const label = isMac && !isUniversal(p) ? `${archLabel(p)}용 ZIP 다운로드` : d.button;
      const name = packages.length > 1 && !isMac ? `<span class="file-name">${escape(p.title || p.file)}</span>` : '';
      return `<div class="download-option">${name}${download(p, label)}${metadata(p)}</div>`;
    }).join('')}</div>
    <div class="setup">
      <p class="setup-title">설치 방법</p>
      <ol class="steps">${d.steps.map(step => `<li>${step}</li>`).join('')}</ol>
      ${d.setupNote ? `<p class="setup-note">${d.setupNote}</p>` : ''}
      ${guide(packages[0])}
    </div>
    ${integrity(packages)}
  </article>`;
}

function archiveRow(p) {
  return `<div class="archive-row"><div><strong>${escape(p.title || p.file)}</strong>${metadata(p)}<code>${escape(p.file)}</code></div>${download(p, '이전 파일 받기')}</div>`;
}

const brand = `<a class="brand" href="/"><img src="/icons/icon-128.png?v=20261118" width="32" height="32" alt=""><span>hwpx<span class="brand-dot">.</span>cowork</span></a>`;

export function renderDownloadPage({ manifest, packages, notes = [] }) {
  const active = packages.filter(p => !isArchive(p));
  const byTarget = target => active.filter(p => p.target === target);
  const winApp = byTarget('windows-app');
  const personal = byTarget('windows-personal');
  const shared = byTarget('windows-shared');
  const mac = active.filter(p => /^(?:macos-editor|local-editor-macos)-/.test(p.target || ''));
  const android = active.filter(p => p.file.endsWith('.apk'));
  const known = new Set([...winApp, ...personal, ...shared, ...mac, ...android]);
  const tools = active.filter(p => !known.has(p));
  const archived = packages.filter(isArchive);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(manifest.releasedOn || '') ? manifest.releasedOn.replaceAll('-', '.') : '';
  const legacyWindows = personal.length || shared.length;
  const windows = winApp.length || legacyWindows;
  const nav = [windows && ['windows', 'Windows'], mac.length && ['mac', 'Mac'], android.length && ['android', 'Android']].filter(Boolean);
  const windowsSection = windows ? `<section class="platform-section${legacyWindows ? ' platform-wide' : ''}" id="windows">
    ${winApp.length ? productCard('windows-app', winApp) : '<h2 class="platform-title">Windows</h2>'}
    ${legacyWindows ? `<div class="pair-grid">
      ${personal.length ? productCard('windows-personal', personal, 'h3') : ''}
      ${shared.length ? productCard('windows-shared', shared, 'h3') : ''}
    </div>` : ''}
  </section>` : '';
  return `<!doctype html><html lang="ko"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="description" content="Hwpx Cowork 앱과 편집기를 다운로드합니다.">
    <title>다운로드 · hwpx-cowork</title><style>${fs.readFileSync(cssFile, 'utf8')}</style>
  </head><body>
    <a class="skip-link" href="#downloads">다운로드 목록으로 건너뛰기</a>
    <header class="site-header"><div class="container header-inner">${brand}<a class="web-link" href="/">웹 편집기 열기 ${icon('arrow')}</a></div></header>
    <main class="container">
      <div class="hero">
        <h1>다운로드</h1>
        ${nav.length ? '<p>사용하는 운영체제에 맞는 파일을 받으세요.</p>' : ''}
        ${date ? `<p class="release-date">업데이트 <time datetime="${manifest.releasedOn}">${date}</time></p>` : ''}
      </div>
      ${nav.length > 1 ? `<nav class="platform-nav" aria-label="운영체제별 다운로드">${nav.map(([id, name]) => `<a href="#${id}">${name}</a>`).join('')}</nav>` : ''}
      <div id="downloads">
        ${nav.length ? `<div class="platform-grid">
          ${windowsSection}
          ${mac.length ? `<section class="platform-section" id="mac">${productCard('mac', mac)}</section>` : ''}
          ${android.length ? `<section class="platform-section" id="android">${productCard('android', android)}</section>` : ''}
        </div>` : ''}
        ${!packages.length ? '<p class="empty-state">현재 준비된 배포 파일이 없습니다.</p>' : ''}
        ${tools.length ? `<details class="additional"><summary>추가 도구</summary><div class="tool-list">${tools.map(p => `<article class="tool-row"><div><h3>${escape(p.title || '개인 AI 실행기')}</h3><p>공동 작업 서버에 내 AI를 연결합니다.</p>${metadata(p)}</div>${download(p, '도구 다운로드')}</article>`).join('')}</div></details>` : ''}
        ${archived.length ? `<details class="additional"><summary>이전 버전 (${archived.length})</summary><div class="archive-list">${archived.map(archiveRow).join('')}</div></details>` : ''}
        ${notes.length ? `<details class="additional"><summary>배포 안내</summary><ul class="release-notes">${notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul></details>` : ''}
      </div>
    </main>
    <footer class="site-footer"><div class="container footer-inner">${brand}<div class="footer-links"><a href="/download/release.json">릴리즈 명세</a><a href="/download/SHA256SUMS.txt">SHA-256 목록</a></div></div></footer>
  </body></html>`;
}
