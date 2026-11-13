// Only manifest-listed release artifacts are public. Never serve artifacts/ as a static tree.
import fs from 'node:fs';
import path from 'node:path';

const safeName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== '.' && name !== '..';
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// 공개 배포 파일만 허용한다: PC용 묶음과 버전이 명시된 Android APK.
const RELEASE_FILE = /^(?:hwpx-(?:(?:cowork-server|ai-worker|cowork-user-app)-[A-Za-z0-9._-]+\.(?:zip|tar\.gz)|cowork-\d+\.\d+\.\d+-\d{8}\.zip)|(?:hwp-document-lite|rhwp-editor|hwpx-cowork)-\d+\.\d+\.\d+\.apk)$/;

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
  const mb = (bytes) => `${(bytes / 1000000).toFixed(2)} MB`;
  // 명세에 notes(안내 문장 목록)가 있으면 그것을, 없으면 종전 설치 안내를 쓴다
  const defaultNotes = [
    '설치형은 Node와 npm 라이브러리를 제외합니다. ZIP 해제 후 실제 사용할 PC에서 install-dependencies.bat(Windows) 또는 sh install-dependencies.sh(macOS/Linux)를 실행하세요. 인터넷 연결이 필요합니다.',
    '참여자용 user-app은 서버 화면을 여는 바로 가기입니다. 개인 AI 실행기(worker)는 별도 프로그램입니다.',
  ];
  app.get('/download', (req, res) => {
    const r = readCurrent(res); if (!r) return;
    const m = r.manifest;
    const notes = Array.isArray(m.notes) && m.notes.every((n) => typeof n === 'string') ? m.notes : defaultNotes;
    const date = typeof m.releasedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.releasedOn) ? ` · ${m.releasedOn}` : '';
    const cards = r.packages.map((p) => `<section class="pkg"><a class="btn" href="/download/${encodeURIComponent(p.file)}" download>내려받기</a><div><b>${escape(p.file)}</b><br><span class="dim">${mb(p.bytes)}${p.title ? ` · ${escape(p.title)}` : ''}</span><br><span class="dim">SHA-256 <code>${p.sha256}</code></span></div></section>`).join('');
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'").type('html').send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>hwpx-cowork 내려받기</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px;color:#1d2433}h1{font-size:26px;margin:0 0 4px}.dim{color:#5b6577;font-size:14px}.pkg{display:flex;gap:18px;align-items:center;border:1px solid #d6dbe4;border-radius:10px;padding:18px;margin:22px 0}.btn{flex:none;background:#2f5bd3;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px}.btn:hover{background:#2348ad}code{overflow-wrap:anywhere;font-size:12px}ul{padding-left:20px}</style><h1>hwpx-cowork ${escape(m.version)} 릴리즈</h1><div class="dim">최신판${escape(date)}</div>${cards || '<p>지금 내려받을 파일이 없습니다.</p>'}<ul>${notes.map((n) => `<li>${escape(n)}</li>`).join('')}</ul><p class="dim"><a href="/download/release.json">릴리즈 명세</a> · <a href="/download/SHA256SUMS.txt">SHA-256 목록</a> · <a href="/">hwpx-cowork 열기</a></p></html>`);
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
