// 인증된 본인의 프로필·실행만 제공한다. 세션은 서버가 HTTP/MCP 연결에서 받는다.
export function installOrchestrationRoutes({ app, service, auth, wrap }) {
  const orchestration = service.orchestration;
  const send = (fn) => wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await fn(req)));
  app.get('/api/me/orchestration', auth, send(req => orchestration.profile(req.user)));
  app.put('/api/me/orchestration', auth, send(req => orchestration.saveProfile(req.user, req.body)));
  app.get('/api/orchestration/status', auth, send(req => orchestration.status(req.user)));
  app.get('/api/orchestration/runs', auth, send(req => orchestration.listRuns(req.user, { doc_id: req.query.doc_id })));
  app.post('/api/orchestration/runs', auth, send(req => orchestration.createRun(req.user, req.body)));
  app.get('/api/orchestration/runs/:run_id', auth, send(req => orchestration.getRun(req.user, req.params.run_id)));
  app.post('/api/orchestration/runs/:run_id/cancel', auth, send(req => orchestration.advance(req.user, { run_id: req.params.run_id, action: 'cancel' })));
}
