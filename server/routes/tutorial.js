export function installTutorialRoutes({ app, auth, wrap, tutorial }) {
  // 튜토리얼: 목록 조회·새 임시 문서 시작·완료 저장·버리기. 조회에는 문서를 만들지 않는다.
  app.get('/api/tutorial', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.status(req.user))));
  app.get('/api/tutorial/definition', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.definition(req.user))));
  app.put('/api/tutorial/definition', auth, wrap(async (req, res) => res.json(tutorial.saveDefinition(req.user, req.body))));
  app.post('/api/tutorial/visit', auth, wrap(async (req, res) => res.json(tutorial.visit(req.user))));
  app.post('/api/tutorial/entry', auth, wrap(async (req, res) => res.json(await tutorial.entry(req.user))));
  app.post('/api/tutorial/start', auth, wrap(async (req, res) => res.json(await tutorial.start(req.user, { auto: !!req.body?.auto, tutorialId: req.body?.tutorialId }))));
  app.get('/api/tutorial/:id/progress', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.progress(req.user, req.params.id))));
  app.put('/api/tutorial/:id/progress', auth, wrap(async (req, res) => res.json(await tutorial.saveProgress(req.user, req.params.id, req.body))));
  app.post('/api/tutorial/:id/restore', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await tutorial.restore(req.user, req.params.id, req.body))));
  app.post('/api/tutorial/:id/complete', auth, wrap(async (req, res) => res.json(await tutorial.complete(req.user, req.params.id))));
  app.delete('/api/tutorial/:id', auth, wrap(async (req, res) => res.json(await tutorial.discard(req.user, req.params.id))));
}
