// 다운로드 페이지(/download). 기능·요구 사항·설치 순서만 보여 준다(2026-11-16 사용자 지시: 설명 문구·포함 내역·설치 글꼴 언급 없음).
// 패키지 분류는 release.json 의 target 으로 한다: windows-personal·windows-shared·macos-editor-*·Android APK·그 밖(추가 도구).
// 패키지에 guide(설치 안내 전문)가 있으면 '설치 안내 전체'로 펼쳐 볼 수 있다.
import fs from 'node:fs';
const cssFile = new URL('./download-page.css', import.meta.url);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = bytes => `${(bytes / 1000000).toFixed(1)} MB`;
const version = p => p.version || /-(\d+\.\d+\.\d+)(?:-|\.)/.exec(p.file)?.[1] || '';
const icons = {
  windows: '<path d="M3 5.2 10.5 4v7.4H3zm8.8-1.4L21 2.5v8.9h-9.2zM3 12.7h7.5v7.4L3 18.9zm8.8 0H21v8.8l-9.2-1.3z" fill="currentColor" stroke="none"/>',
  mac: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M3 13h18"/>',
  android: '<path d="m7 5-2-3m12 3 2-3M4 11a8 8 0 0 1 16 0v7H4zm0 0h16M8 18v3m8-3v3"/><path d="M8 8h.01M16 8h.01" stroke-width="3"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h5"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M17.5 13.5A5 5 0 0 1 20.5 19"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5m-5 11h5"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
const isArchive = p => p.archived === true || /previous|archive/.test(p.target || '');
const isUniversal = p => p.arch === 'universal' || /macos-(?:editor-\d|universal)/.test(p.file);
const archLabel = p => isUniversal(p) ? 'Intel·Apple Silicon 공용' : p.arch === 'arm64' || /arm64/.test(p.file) ? 'Apple Silicon' : 'Intel';
const download = (p, label = '다운로드') => `<a class="btn" href="/download/${encodeURIComponent(p.file)}" download data-file="${escape(p.file)}"><span>${escape(label)}</span>${icon('download')}</a>`;
const metadata = p => `<span class="file-meta">${version(p) ? 'v' + escape(version(p)) + '<span>·</span>' : ''}${size(p.bytes)}</span>`;
const integrity = packages => `<details class="integrity"><summary>파일 정보 · SHA-256</summary><div class="integrity-content">${packages.map(p => `<div><span>${escape(p.title || p.file)}</span><code>${escape(p.file)}</code><code class="hash">${p.sha256}</code></div>`).join('')}</div></details>`;
const guide = p => typeof p.guide === 'string' && p.guide.trim() ? `<details class="guide"><summary>설치 안내 전체</summary><pre class="guide-text">${escape(p.guide.trim())}</pre></details>` : '';
const sectionHeading = (number, name, description) => `<div class="section-heading"><span class="section-number">${number}</span><div><h2>${name}</h2><p>${description}</p></div></div>`;
const list = (cls, items) => `<ul class="${cls}">${items.map(s => `<li>${s}</li>`).join('')}</ul>`;
const steps = labels => `<ol class="steps">${labels.map((s, i) => `<li><span>${i + 1}</span>${s}</li>`).join('')}</ol>`;

// 패키지 종류별 화면 문구(기능·요구 사항·설치 순서)
const PRODUCTS = {
  // 2026-11-17: Windows 는 클릭 설치 앱 하나(혼자 쓰기·함께 쓰기·AI 실행기만을 처음 실행에서 고름) — bat 묶음 대신(사용자 결정)
  'windows-app': {
    icon: 'windows', eyebrow: 'WINDOWS · 설치 파일', title: 'Hwpx Cowork', tag: '클릭해서 설치',
    lead: '설치 파일 하나로 설치하고, 처음 실행할 때 혼자 쓰기·여러 사람과 함께 쓰기·AI 실행기만 가운데 하나를 고릅니다.',
    features: ['혼자 쓰기: PC 폴더의 HWPX를 열어 고치고 원래 파일에 저장', '함께 쓰기: 이 PC를 서버로 — 참여자는 브라우저로 접속, [함께 쓰기 → 외부 접속 열기]', 'AI 실행기 관리: Codex·Claude Code·Gemini CLI·Antigravity 구독으로 수정 제안 받기', 'AI 실행기만: 이미 운영 중인 공동 작업 서버에 내 AI만 연결'],
    requires: ['Windows 10·11 (64비트)', '관리자 권한 필요 없음', 'AI는 본인 구독 계정 로그인'],
    steps: ['설치 파일 실행 — "Windows의 PC 보호" 창이 뜨면 [추가 정보] → [실행]', '[다음] → [설치] → [마침]', '처음 실행에서 쓰는 방식 고르기', 'AI는 메뉴 [AI → 실행기 관리…]에서 [실행기 추가]'],
  },
  'windows-personal': {
    icon: 'document', eyebrow: 'WINDOWS · 개인용', title: '개인용', tag: '이 PC에서만',
    lead: '내 PC의 HWPX 문서를 열어 고치고 원래 파일에 저장합니다.',
    features: ['PC 폴더를 연결하면 그 폴더의 HWPX를 바로 열고 저장', '한/글에서 고친 내용도 다시 읽음', 'AI 연결(선택): ChatGPT·Claude 구독으로 수정 제안 받기', '공동 작업 서버로 보내 함께 검토하고 검토본 가져오기(선택)'],
    requires: ['Windows 10·11 (64비트)', '처음 설치할 때 인터넷', '관리자 권한 필요 없음'],
    steps: ['ZIP 압축 풀기', '시작.bat 실행 — 처음 한 번 Node.js·라이브러리 설치(2~5분)', '문서함 [PC 폴더 연결]로 문서 폴더 연결'],
  },
  'windows-shared': {
    icon: 'people', eyebrow: 'WINDOWS · 공동 작업용', title: '공동 작업용', tag: '여럿이 함께',
    lead: '이 PC를 서버로 삼아 여러 사람이 같은 HWPX 문서를 함께 고칩니다. 참여자는 브라우저로 접속합니다.',
    features: ['실시간 공동 편집, 메모·답글', '변경 내용 추적: 제안을 [반영]·[거절]로 확정', '사용자별 토큰, 폴더별 열람·편집 권한', '외부 접속 주소 열기(외부 접속 열기.bat)', 'AI 연결(선택): 각자 본인 구독으로'],
    requires: ['서버로 쓸 Windows 10·11 PC (64비트)', '처음 설치할 때와 외부 접속에 인터넷', '참여자: 브라우저만'],
    steps: ['ZIP 압축 풀기', '시작.bat 실행', '[관리자] → [사용자]에서 참여자 추가', '외부 접속 열기.bat의 주소와 토큰 전달'],
  },
  mac: {
    icon: 'document', eyebrow: 'MAC', title: 'Hwpx Editor', tag: '서버 없이 실행',
    lead: 'HWP·HWPX·HML 문서를 열어 고치고 원래 파일에 저장합니다.',
    features: ['파일 메뉴: 열기 ⌘O · 저장 ⌘S · 다른 이름으로 저장 ⇧⌘S(HWP·HWPX) · 인쇄 ⌘P', 'Finder에서 [다음으로 열기] → Hwpx Editor', '다른 프로그램이 바꾼 파일은 덮어쓰지 않고 알림', '인터넷·계정 없이 동작'],
    requires: ['macOS 12.1 이상', 'Intel·Apple Silicon 공용 파일 하나'],
    steps: ['ZIP 풀기', 'Hwpx Editor.app을 응용 프로그램 폴더로 옮기기', '처음 열 때 Control-클릭 → [열기] → [열기]'],
  },
  android: {
    icon: 'android', eyebrow: 'ANDROID', title: 'Hwpx-Cowork', tag: '서버 없이 실행',
    lead: '휴대폰에서 HWP·HWPX 문서를 열어 고치고 원래 파일에 저장합니다.',
    features: ['HWP·HWPX 문서 열기·편집', '편집 후 원본 저장'],
    requires: ['Android 8.0 이상'],
    steps: ['APK 받기', '설치(요청하면 이 출처의 앱 설치 허용)', '앱에서 문서 열기'],
  },
};

function productCard(kind, packages, { buttonLabel } = {}) {
  const d = PRODUCTS[kind];
  const main = packages[0];
  return `<article class="product-card ${kind}-product"><div class="product-head"><span class="product-icon ${kind.startsWith('windows') ? 'windows-icon' : kind === 'android' ? 'android-icon' : 'mac-icon'}">${icon(d.icon)}</span><div><span class="eyebrow">${escape(d.eyebrow)}</span><h3>${escape(d.title)}</h3></div><span class="tag">${escape(d.tag)}</span></div>
    <p class="product-description">${escape(d.lead)}</p>
    ${list('feature-list', d.features.map(escape))}
    <div class="compat-line">${d.requires.map(escape).join('<span>·</span>')}</div>
    <div class="download-line">${packages.map(p => download(p, buttonLabel || (kind === 'mac' && !isUniversal(p) ? archLabel(p) + '용 받기' : '다운로드'))).join('')}${metadata(main)}</div>
    ${steps(d.steps.map(escape))}
    ${guide(main)}${integrity(packages)}</article>`;
}

function archiveRow(p) {
  return `<div class="archive-row"><div><strong>${escape(p.title || p.file)}</strong>${metadata(p)}<code>${escape(p.file)}</code></div>${download(p, '이전 파일 받기')}</div>`;
}

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
  const windows = winApp.length || personal.length || shared.length;
  const nav = [windows && ['windows', 'Windows'], mac.length && ['mac', 'Mac'], android.length && ['android', 'Android']].filter(Boolean);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="hwpx-cowork 다운로드: ${winApp.length ? 'Windows 앱' : 'Windows 개인용·공동 작업용'}, Mac 편집기, Android 앱."><title>다운로드 · hwpx-cowork</title><style>${fs.readFileSync(cssFile, 'utf8')}</style></head><body>
  <a class="skip-link" href="#downloads">다운로드 목록으로 건너뛰기</a>
  <header class="site-header"><a class="brand" href="/">${icon('document')}<span>hwpx<span class="brand-dot">.</span>cowork</span></a><a class="web-link" href="/">웹 편집기 열기 ${icon('arrow')}</a></header>
  <main><section class="hero compact"><div class="hero-copy"><span class="eyebrow">HWPX COWORK / DOWNLOADS</span><h1>다운로드</h1><p>HWPX 문서를 열어 고치고 저장합니다. 혼자 쓸지, 여럿이 함께 쓸지 고르세요.</p>${date ? `<div class="release-line"><span class="status-dot"></span>업데이트 <time datetime="${manifest.releasedOn}">${date}</time></div>` : ''}</div>
  <aside class="quick-guide"><span class="eyebrow">고르는 방법</span>${winApp.length ? `<a href="#windows-app"><span class="guide-symbol">${icon('windows')}</span><span><strong>Windows에서 혼자·함께 편집</strong><small>Hwpx Cowork 설치 파일 · 방식은 처음 실행에서</small></span>${icon('arrow')}</a>` : ''}${personal.length ? `<a href="#windows-personal"><span class="guide-symbol">${icon('document')}</span><span><strong>내 PC 파일을 혼자 편집</strong><small>Windows 개인용</small></span>${icon('arrow')}</a>` : ''}${shared.length ? `<a href="#windows-shared"><span class="guide-symbol">${icon('people')}</span><span><strong>여러 사람이 함께 편집</strong><small>Windows 공동 작업용 · 참여자는 브라우저</small></span>${icon('arrow')}</a>` : ''}${mac.length ? `<a href="#mac"><span class="guide-symbol">${icon('mac')}</span><span><strong>Mac에서 파일 편집</strong><small>Hwpx Editor · macOS 12.1 이상</small></span>${icon('arrow')}</a>` : ''}</aside></section>
  ${nav.length ? `<nav class="platform-nav" aria-label="운영체제별 다운로드">${nav.map(([id, name], i) => `<a href="#${id}">${icon(id)}${name}<span>0${i + 1}</span></a>`).join('')}</nav>` : ''}
  <div id="downloads" class="downloads">
  ${windows ? `<section class="platform-section" id="windows">${sectionHeading('01', 'Windows', winApp.length ? '설치 파일 하나로 설치합니다. 쓰는 방식은 처음 실행할 때 고릅니다.' : '프로그램만 받고, Node.js와 라이브러리는 처음 실행할 때 인터넷으로 설치합니다.')}${winApp.length ? `<div id="windows-app">${productCard('windows-app', winApp)}</div>` : ''}${personal.length || shared.length ? `<div class="pair-grid">${personal.length ? `<div id="windows-personal">${productCard('windows-personal', personal)}</div>` : ''}${shared.length ? `<div id="windows-shared">${productCard('windows-shared', shared)}</div>` : ''}</div>` : ''}</section>` : ''}
  ${mac.length ? `<section class="platform-section" id="mac">${sectionHeading(String(nav.findIndex(n => n[0] === 'mac') + 1).padStart(2, '0'), 'Mac', '서버 없이 내 Mac의 문서를 직접 편집합니다.')}${productCard('mac', mac)}</section>` : ''}
  ${android.length ? `<section class="platform-section" id="android">${sectionHeading(String(nav.findIndex(n => n[0] === 'android') + 1).padStart(2, '0'), 'Android', '휴대폰에서 문서를 직접 편집합니다.')}${productCard('android', android, { buttonLabel: 'Android APK 다운로드' })}</section>` : ''}
  ${!packages.length ? '<div class="empty-state">현재 준비된 배포 파일이 없습니다.</div>' : ''}
  ${tools.length ? `<details class="additional"><summary><span>추가 도구<small>이미 운영 중인 공동 작업 서버에 내 AI를 연결할 때</small></span><span class="expand-mark">+</span></summary><div class="tool-list">${tools.map(p => `<article class="tool-row"><span class="product-icon">${icon('server')}</span><div><h3>${escape(p.title || '개인 AI 실행기')}</h3><p>서버의 내 AI 요청을 내 PC의 AI 계정으로 처리합니다.</p>${metadata(p)}</div>${download(p, '도구 다운로드')}</article>`).join('')}</div></details>` : ''}
  ${archived.length ? `<details class="additional archive"><summary><span>이전 버전<small>보관 파일 ${archived.length}개</small></span><span class="expand-mark">+</span></summary><div class="archive-list">${archived.map(archiveRow).join('')}</div></details>` : ''}
  ${notes.length ? `<section class="release-notes"><details><summary>배포 안내</summary><ul>${notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul></details></section>` : ''}
  </div></main><footer><a class="brand" href="/">${icon('document')}<span>hwpx<span class="brand-dot">.</span>cowork</span></a><div><a href="/download/release.json">릴리즈 명세</a><a href="/download/SHA256SUMS.txt">SHA-256 목록</a><a href="/">웹 편집기</a></div></footer></body></html>`;
}
