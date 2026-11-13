// 화면 오류 기록(관리자만): 브라우저(특히 폰)에서 난 오류·편집기 단계 기록을 받아 <dataDir>/runtime/client-log.jsonl 에 쌓는다.
// 폰처럼 개발자 도구를 열 수 없는 곳의 문제를 서버에서 읽으려는 것. 파일이 5MB 를 넘으면 .1 로 밀어 두고 새로 쓴다.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE = 5 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_TEXT = 4000;

const clip = (v, n = MAX_TEXT) => String(v ?? '').slice(0, n);

export function installClientLog(app, { auth, dir }) {
  const file = path.join(dir, 'client-log.jsonl');
  app.post('/api/client-log', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN', message: '관리자만 보낼 수 있습니다' });
    const body = req.body || {};
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
    if (!entries.length) return res.status(204).end();
    const session = clip(body.session, 64);
    const page = clip(body.page, 300);
    const env = body.env && typeof body.env === 'object' ? JSON.parse(clip(JSON.stringify(body.env), 1000)) : undefined;
    const lines = entries.map((e) => JSON.stringify({
      at: clip(e?.at, 40), recv: new Date().toISOString(), user: req.user.name, session, page,
      level: clip(e?.level, 16), src: clip(e?.src, 40), msg: clip(e?.msg), ...(env ? { env } : {}),
    })).join('\n') + '\n';
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_FILE) fs.renameSync(file, `${file}.1`); } catch { /* 아직 없음 */ }
      fs.appendFileSync(file, lines);
    } catch (e) {
      return res.status(500).json({ error: 'CLIENT_LOG_FAILED', message: e.message });
    }
    res.status(204).end();
  });
}
