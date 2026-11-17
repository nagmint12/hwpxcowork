// Only manifest-listed release artifacts are public. Never serve artifacts/ as a static tree.
import fs from 'node:fs';
import path from 'node:path';
import { renderDownloadPage } from './download-page.js';
import { windowsSetupSettings, windowsSetupZip } from './windows-setup.js';

const safeName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== '.' && name !== '..';
// 공개 배포 파일만 허용한다: PC용 묶음(Windows 개인용·공동 작업용·Mac 편집기 포함)과 버전이 명시된 Android APK.
const RELEASE_FILE = /^(?:hwpx-(?:(?:cowork-server|cowork-windows|cowork-macos|ai-worker|cowork-user-app)-[A-Za-z0-9._-]+\.(?:zip|tar\.gz)|cowork-\d+\.\d+\.\d+-\d{8}\.zip)|(?:hwp-document-lite|rhwp-editor|hwpx-cowork)-\d+\.\d+\.\d+\.apk)$/;

export function installReleaseDownloads(app, { root, releaseDir = process.env.HWPX_COWORK_RELEASE_DIR } = {}) {
  const current = () => {
    let dir = releaseDir && path.resolve(releaseDir);
    if (!dir) {
      const base = path.join(root, 'artifacts');
      const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && /^release-\d{8}$/.test(e.name)).map((e) => e.name).sort().reverse();
      dir = dirs.map((name) => path.join(base, name)).find((p) => fs.existsSync(path.join(p, 'release.json')));
    }
    if (!dir) throw new Error('NO_RELEASE');
    const realDir = fs.realpathSync(dir);
    const manifestFile = path.join(realDir, 'release.json');
    if (!fs.lstatSync(manifestFile).isFile() || fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error('BAD_RELEASE');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const packages = (manifest.packages || []).filter((p) => safeName(p.file) && RELEASE_FILE.test(p.file) && Number.isSafeInteger(p.bytes) && /^[a-f0-9]{64}$/.test(p.sha256));
    return { dir: realDir, manifest, packages };
  };
  const readCurrent = (res) => {
    try { return current(); } catch { res.status(503).set('Cache-Control', 'no-store').json({ error: 'RELEASE_NOT_PUBLISHED', message: '릴리즈 파일이 아직 게시되지 않았습니다.' }); return null; }
  };
  // 명세에 notes(안내 문장 목록)가 있을 때만 보여 준다(설치 안내는 각 패키지의 guide)
  const defaultNotes = [];
  app.get('/download', (req, res) => {
    const r = readCurrent(res); if (!r) return;
    const m = r.manifest;
    const notes = Array.isArray(m.notes) && m.notes.every((n) => typeof n === 'string') ? m.notes : defaultNotes;
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'").type('html').send(renderDownloadPage({ manifest: m, packages: r.packages, notes }));
  });
  app.get('/download/windows-setup.zip', async (req, res, next) => {
    const mode = req.query.mode ?? 'personal', ai = req.query.ai ?? 'none';
    if (Object.keys(req.query).some(key => !['mode', 'ai'].includes(key)) || !['personal', 'shared'].includes(mode) || !['codex', 'claude-code', 'none'].includes(ai)) return res.status(400).json({ error: 'BAD_SETUP_CHOICE' });
    const r = readCurrent(res); if (!r) return;
    try {
      // 시작 안내의 설치 링크는 고른 운영 방식의 Windows 설치 묶음으로 보낸다(AI 는 설치 뒤 AI 연결.bat 에서 고른다).
      const installer = r.packages.find(p => !p.archived && p.target === `windows-${mode}`);
      if (installer) return res.set('Cache-Control', 'no-store').redirect(302, `/download/${encodeURIComponent(installer.file)}`);
      // 옛 간편 설치 링크도 완전 포함 파일로 연결한다. 받는 PC에서 추가 다운로드하지 않는다.
      const offline = r.packages.find(p => !p.archived && p.target === `windows-offline-${mode}-${ai}`);
      if (offline) return res.set('Cache-Control', 'no-store').redirect(302, `/download/${encodeURIComponent(offline.file)}`);
      const settings = windowsSetupSettings(r.manifest, r.packages, mode, ai);
      const name = decodeURIComponent(new URL(settings.bundle.url).pathname.split('/').pop());
      const file = path.join(r.dir, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== settings.bundle.bytes || !fs.realpathSync(file).startsWith(r.dir + path.sep)) throw new Error('NO_SETUP_BUNDLE');
      const bytes = await windowsSetupZip(settings);
      res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').attachment(`hwpx-setup-${mode}-${ai}.zip`).send(bytes);
    } catch (error) {
      if (/^(NO_SETUP_BUNDLE|BAD_SETUP_SOURCE)$/.test(error.message) || ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return res.status(503).json({ error: 'SETUP_NOT_AVAILABLE', message: '간편 설치 파일을 준비 중입니다. 다운로드 페이지에서 프로그램을 받아 주세요.' });
      next(error);
    }
  });
  app.get('/download/:file', (req, res) => {
    const r = readCurrent(res); if (!r) return;
    const name = req.params.file;
    const listed = r.packages.find((p) => p.file === name);
    // 지난 릴리즈 파일 주소(공모전 안내에 실린 /download/<파일> 등)는 지금 릴리즈 안내 페이지로 보낸다 — 거기서 최신 파일을 눌러 받는다
    if (!listed && safeName(name) && RELEASE_FILE.test(name)) return res.set('Cache-Control', 'no-store').redirect(302, '/download');
    if (!safeName(name) || (!listed && !['release.json', 'SHA256SUMS.txt'].includes(name))) return res.status(404).json({ error: 'RELEASE_FILE_NOT_FOUND' });
    const file = path.join(r.dir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || !fs.realpathSync(file).startsWith(r.dir + path.sep) || (listed && st.size !== listed.bytes)) throw new Error('BAD_RELEASE_FILE');
    } catch { return res.status(404).json({ error: 'RELEASE_FILE_NOT_FOUND' }); }
    res.set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-cache');
    if (name.endsWith('.apk')) res.type('application/vnd.android.package-archive');
    res.download(file, name);
  });
}
