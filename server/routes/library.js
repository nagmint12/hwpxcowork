// 문서함 경로(docs/LIBRARY_SPEC.md): 폴더 만들기·바꾸기·지우기, 폴더·공용 문서함 맨 위 권한, 문서 옮기기·문서 권한.
// 문서 읽기 문(볼 수 없는 문서는 404 NO_DOC)은 index.js 의 /api/docs/:id 앞 미들웨어가 맡는다.
import { isSameMachine } from './local.js';

export function installLibraryRoutes({ app, service, auth, wrap }) {
  const lib = () => service.library;
  const folderView = (user, f) => lib().foldersFor(user).find((x) => x.id === f.id) || { id: f.id, name: f.name };

  // PC 폴더 연결이 켜져 있으면(개인용 앱) local = { canLink, links, remotes } 을 함께 싣는다(server/local-folders.js view)
  app.get('/api/library', auth, wrap(async (req, res) => {
    const view = await service.libraryView(req.user, { includeTutorialTemplates: req.query.includeTutorialTemplates === '1' });
    if (service.local) view.local = service.local.view(req.user, { sameMachine: isSameMachine(req) });
    res.set('Cache-Control', 'no-store').json(view);
  }));

  // { name, parentId?, space? } → 폴더
  app.post('/api/folders', auth, wrap(async (req, res) => {
    const f = lib().createFolder(req.user, req.body || {});
    res.json(folderView(req.user, f));
  }));
  // { name?, parentId? } → 폴더(이름 바꾸기·같은 문서함 안에서 옮기기)
  app.patch('/api/folders/:fid', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const f = lib().updateFolder(req.user, req.params.fid, { name: b.name, parentId: b.parentId });
    res.json(folderView(req.user, f));
  }));
  // { inherit?, acl? } → 폴더
  app.put('/api/folders/:fid/access', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const f = lib().setFolderAccess(req.user, req.params.fid, { inherit: b.inherit, acl: b.acl });
    res.json(folderView(req.user, f));
  }));
  app.delete('/api/folders/:fid', auth, wrap(async (req, res) => {
    const ok = lib().deleteFolder(req.user, req.params.fid, service.folderDocCount(req.params.fid));
    res.json({ ok });
  }));
  // 공용 문서함 맨 위 권한 { acl } → { perms, acl }
  app.put('/api/library/public/access', auth, wrap(async (req, res) => {
    lib().setPublicRootAccess(req.user, req.body?.acl);
    res.json(lib().publicRootFor(req.user));
  }));

  // 새 문서로 시작 { title?, space?, owner?, folderId? } → 문서 요약(빈 한/글 문서 — 같은 자리 같은 제목은 '제목 (2)')
  app.post('/api/library/docs', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const location = b.space || b.folderId ? { space: b.space || undefined, owner: b.owner || undefined, folderId: b.folderId || undefined } : null;
    res.json(await service.createBlankDocument({ title: b.title, user: req.user, location }));
  }));
  // 문서 옮기기 { space?, owner?, folderId? } · 문서 권한 { inherit: true } | { acl }
  app.patch('/api/docs/:id/location', auth, wrap(async (req, res) => { const out = await service.moveDocument(req.params.id, req.body || {}, req.user); res.json(out); }));
  app.put('/api/docs/:id/access', auth, wrap(async (req, res) => { const out = await service.setDocAccess(req.params.id, req.body || {}, req.user); res.json(out); }));
}
