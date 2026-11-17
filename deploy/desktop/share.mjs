// 공동 작업용 앱의 외부 접속(Cloudflare Quick Tunnel) 준비(2026-11-17). Windows 앱에서만 쓴다.
// cloudflared 는 Cloudflare 공식 GitHub 배포 파일만 받아 Cloudflare 코드 서명을 확인한 뒤 앱 설정 폴더(tools\)에 둔다 —
// deploy/portable/windows/hwpx-windows.ps1 의 Install-Cloudflared 와 같은 규칙. 계정·관리자 권한이 필요 없다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
export const shareSupported = (platform = process.platform) => platform === 'win32';
export const cloudflaredPath = (userdata) => path.join(userdata, 'tools', 'cloudflared.exe');

/** 앱이 받아 둔 것 → PATH → winget 기본 설치 폴더 순서로 찾는다 → 경로 또는 null */
export function findCloudflared(userdata, { env = process.env, exists = fs.existsSync } = {}) {
  const own = cloudflaredPath(userdata);
  if (exists(own)) return own;
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'cloudflared.exe');
    if (exists(file)) return file;
  }
  const bases = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  return bases.map((b) => path.join(b, 'cloudflared', 'cloudflared.exe')).find((p) => exists(p)) || null;
}

/** Windows Authenticode 서명 → { status, subject }(PowerShell Get-AuthenticodeSignature) */
export function readSignature(file, run = spawnSync) {
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:HWPX_SIGNED_FILE; [Console]::Out.Write(($s.Status.ToString()) + "`n" + $s.SignerCertificate.Subject)';
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HWPX_SIGNED_FILE: file }, timeout: 60000 });
  const [status = '', subject = ''] = String(r.stdout || '').split('\n');
  return { status: status.trim(), subject: subject.trim() };
}

/** 서명이 유효하고 서명자가 Cloudflare 인가 */
export const signedByCloudflare = ({ status, subject }) => status === 'Valid' && /\bO="?Cloudflare/.test(subject);

/** cloudflared 를 받아 서명을 확인한 뒤 tools\cloudflared.exe 로 둔다 → 경로. 서명이 맞지 않으면 지우고 오류 */
export async function installCloudflared(userdata, { fetchImpl = globalThis.fetch, signature = readSignature } = {}) {
  const target = cloudflaredPath(userdata); const part = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetchImpl(CLOUDFLARED_URL, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
  if (!response.ok) throw new Error(`cloudflared 를 받지 못했습니다(HTTP ${response.status}). 인터넷 연결을 확인해 주세요.`);
  fs.writeFileSync(part, Buffer.from(await response.arrayBuffer()));
  if (!signedByCloudflare(signature(part))) {
    fs.rmSync(part, { force: true });
    throw new Error('cloudflared 의 Cloudflare 서명을 확인하지 못해 쓰지 않았습니다.');
  }
  fs.renameSync(part, target);
  return target;
}

/** quick-tunnel.mjs 출력 한 줄에서 공개 주소('   - 웹:  https://….trycloudflare.com/') → 주소 또는 null */
export function shareUrlFromLine(line) {
  const m = /-\s*웹:\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\/?/i.exec(String(line));
  return m ? m[1].toLowerCase() : null;
}
