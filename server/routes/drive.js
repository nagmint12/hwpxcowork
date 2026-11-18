import { DriveService } from '../drive.js';

// 두레이 드라이브(2026-11-17 두레이 서비스 API 방식) — 모든 경로는 cowork 로그인 사용자 본인의 연결만 다룬다.
// 토큰은 PUT /api/drive/connection 으로 한 번 받아 암호문으로 보관하고, 어떤 응답에도 다시 싣지 않는다.
export function installDriveRoutes({ app, service, config, auth, wrap, rawAttachment, bodyBytes, safeDecode }) {
  const drive = new DriveService({ config, service }); service.drive = drive;
  const send = (res, f) => res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.entry.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(f.bytes);
  app.use('/api/drive', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/drive', auth, wrap(async (req, res) => res.json(drive.status(req.user))));
  app.put('/api/drive/connection', auth, wrap(async (req, res) => res.json(await drive.connect(req.user, req.body || {}))));
  app.post('/api/drive/connection/check', auth, wrap(async (req, res) => res.json(await drive.check(req.user))));
  app.delete('/api/drive/connection', auth, wrap(async (req, res) => res.json(drive.disconnect(req.user))));
  // 프로젝트 드라이브(2026-11-18): 볼 수 있는 목록은 두레이에서 그때 읽고, 보일 것은 사용자가 고른 것만(허용 목록)
  app.get('/api/drive/projects', auth, wrap(async (req, res) => res.json(await drive.availableProjects(req.user))));
  app.put('/api/drive/projects', auth, wrap(async (req, res) => res.json(await drive.setProjects(req.user, req.body?.driveIds))));
  app.post('/api/drive/actions', auth, wrap(async (req, res) => res.json(await drive.action(req.user, req.body || {}))));
  app.post('/api/drive/files', auth, rawAttachment, wrap(async (req, res) => res.json(drive.stage(req.user, bodyBytes(req), safeDecode(req.get('x-file-name') || '', 'file'), req.get('x-file-mime')))));
  app.get('/api/drive/files/:file', auth, wrap(async (req, res) => send(res, drive.bytes(req.user, req.params.file))));
  app.delete('/api/drive/files/:file', auth, wrap(async (req, res) => res.json(drive.deleteFile(req.user, req.params.file))));
  app.post('/api/drive/files/:file/open', auth, wrap(async (req, res) => res.json(await drive.importDocument(req.user, req.params.file, req.body?.location))));
  app.post('/api/drive/documents/:id/stage', auth, wrap(async (req, res) => res.json(await drive.prepareDocument(req.user, req.params.id))));
  app.post('/api/drive/files/:file/attach', auth, wrap(async (req, res) => { const f = drive.bytes(req.user, req.params.file); service.assertDocRead(req.body?.docId, req.user); res.json(await service.addAttachment(req.body.docId, { name: f.entry.name, bytes: f.bytes }, req.user)); }));
  return drive;
}
