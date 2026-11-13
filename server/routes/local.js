// PC 폴더 연결·함께 검토 경로(docs/LOCAL_FOLDER_APP_2026-11-10.md — server/local-folders.js). config.local.enabled 일 때만 단다.
// 서버 PC 의 폴더를 열고 다른 서버에 내 토큰으로 올리는 일이라, 모든 경로는 관리자가 이 PC 에서 보낸 요청만 받는다
// (터널·프록시를 거쳐 온 요청은 127.0.0.1 로 보여도 거절 — isSameMachine).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 이 PC 에서 직접 온 요청인가: 소켓이 loopback 이고, 주소도 localhost 이며, 프록시 머리글이 없고, Origin 이 있으면 같은 주소 */
export function isSameMachine(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (!LOCAL_HOSTS.has(String(req.hostname).toLowerCase())) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers['cf-connecting-ip']) return false;
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

export function installLocalRoutes({ app, service, auth, wrap }) {
  const local = service.local;
  if (!local) return null;
  const owner = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'ADMIN_REQUIRED', message: 'PC 폴더 연결은 이 앱의 관리자만 쓸 수 있습니다' });
    if (!isSameMachine(req)) return res.status(403).json({ error: 'SAME_PC_REQUIRED', message: '이 PC 에서 연 화면에서만 쓸 수 있습니다' });
    next();
  };
  const viewOf = (req) => local.view(req.user, { sameMachine: isSameMachine(req) });

  // 연결 목록·검토 서버 목록(화면이 처음 한 번)
  app.get('/api/local', auth, wrap(async (req, res) => { await local.scan(); res.set('Cache-Control', 'no-store').json(viewOf(req)); }));
  // 폴더 고르기 창(이 PC 화면에 뜬다) → { path } | { path: null }(취소)
  app.post('/api/local/pick', auth, owner, wrap(async (req, res) => res.json({ path: await local.pick() })));
  // 연결 { path, name? } → { link, local }
  app.post('/api/local/links', auth, owner, wrap(async (req, res) => {
    const link = local.link(req.user, req.body || {});
    await local.scan({ force: true });
    res.json({ link: { id: link.id, folderId: link.folderId, name: link.name, path: link.path, owner: link.owner }, local: viewOf(req) });
  }));
  app.delete('/api/local/links/:id', auth, owner, wrap(async (req, res) => {
    local.unlink(req.user, req.params.id);
    await local.scan({ force: true });
    res.json({ ok: true, local: viewOf(req) });
  }));
  app.post('/api/local/rescan', auth, wrap(async (req, res) => { await local.scan({ force: true }); res.json({ ok: true }); }));

  // 검토 서버(다른 hwpx-cowork 서버 + 내 토큰)
  app.post('/api/local/remotes', auth, owner, wrap(async (req, res) => res.json({ remote: await local.addRemote(req.user, req.body || {}), local: viewOf(req) })));
  app.delete('/api/local/remotes/:id', auth, owner, wrap(async (req, res) => { local.removeRemote(req.user, req.params.id); res.json({ ok: true, local: viewOf(req) }); }));
  // 그 서버를 내 토큰으로 여는 주소 { url }(주소의 # 뒤에 토큰이 든다 — 이 PC 화면에만 준다)
  app.get('/api/local/remotes/:id/open', auth, owner, wrap(async (req, res) => res.json({ url: local.openUrl(req.user, req.params.id) })));

  // 함께 검토: 보내기 { remote, space } · 상태 · 검토본 가져오기 { kind } (문서 읽기 문 /api/docs/:id 뒤)
  app.get('/api/docs/:id/review', auth, owner, wrap(async (req, res) => res.json(await local.reviewStatus(req.user, req.params.id))));
  app.post('/api/docs/:id/review/send', auth, owner, wrap(async (req, res) => res.json(await local.send(req.user, req.params.id, req.body || {}))));
  app.post('/api/docs/:id/review/fetch', auth, owner, wrap(async (req, res) => res.json(await local.fetchBack(req.user, req.params.id, req.body || {}))));
  return local;
}
