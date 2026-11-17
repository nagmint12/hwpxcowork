// 시작 안내에서 고른 여섯 조합만 설치 파일로 만든다. 토큰·운영 설정은 포함하지 않는다.
import fs from 'node:fs';
import JSZip from 'jszip';

const modes = new Set(['personal', 'shared']);
const providers = new Set(['codex', 'claude-code', 'none']);
export function windowsSetupSettings(manifest, packages, mode, ai) {
  if (!modes.has(mode) || !providers.has(ai)) throw new Error('BAD_SETUP_CHOICE');
  const bundle = packages.find(p => !p.archived && (p.target === 'bundle' || /^hwpx-cowork-\d+\.\d+\.\d+-\d{8}\.zip$/.test(p.file)));
  if (!bundle || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundle.topFolder || '')) throw new Error('NO_SETUP_BUNDLE');
  let base;
  try { base = new URL(manifest.downloadBase); } catch { throw new Error('BAD_SETUP_SOURCE'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('BAD_SETUP_SOURCE');
  return { schema: 1, mode, ai, bundle: { url: `${base.href.replace(/\/$/, '')}/${encodeURIComponent(bundle.file)}`, bytes: bundle.bytes, sha256: bundle.sha256, topFolder: bundle.topFolder } };
}

export async function windowsSetupZip(settings) {
  const zip = new JSZip();
  const folder = zip.folder(`hwpx-setup-${settings.mode}-${settings.ai}`);
  folder.file('설치 시작.bat', '@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"\r\nif errorlevel 1 pause\r\n');
  // Windows PowerShell 5.1은 UTF-8 BOM이 있어야 한글 스크립트를 정확히 읽는다.
  folder.file('setup.ps1', '\uFEFF' + fs.readFileSync(new URL('./windows-setup.ps1', import.meta.url), 'utf8'));
  folder.file('install-settings.json', JSON.stringify(settings, null, 2));
  folder.file('먼저 읽기.txt', '\uFEFF' + `1. ZIP 전체를 압축 해제하세요.\r\n2. "설치 시작.bat"을 더블클릭하세요.\r\n\r\n선택: ${settings.mode === 'personal' ? '개인 서버' : '공동 서버'} / ${settings.ai}\r\n인터넷에서 프로그램·공식 Node·필요한 라이브러리를 이 폴더에 준비하고 문서함을 엽니다. 관리자 권한은 필요하지 않습니다.\r\nAI를 골랐다면 VS Code에 열린 "VS Code에 붙여넣기.txt"의 내용을 Codex·Claude Code 대화창에 붙여넣으세요. VS Code가 없으면 해당 파일을 직접 엽니다. 최초 구독 로그인·동의는 직접 진행합니다.\r\n다음에도 같은 "설치 시작.bat"으로 실행합니다. 기존 프로그램·문서를 삭제하거나 복사하지 않습니다.\r\n공동 서버는 먼저 이 PC에서만 열립니다. 외부 공개 주소와 권한 설정은 별도입니다.\r\n`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
