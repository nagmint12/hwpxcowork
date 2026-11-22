import crypto from 'node:crypto';
import { ServiceError } from '../service.js';
import { cleanName } from '../mcp.js';
import { fmtTime } from '../memotext.js';
import { requestedSurface } from '../mcp2.js';

export function installDocumentRoutes(routeCtx) {
  const { app, service, store, wrap, auth, raw, rawAttachment, bodyBytes, safeDecode } = routeCtx;
  // ── 문서 ──
  app.get('/api/docs', auth, wrap(async (req, res) => res.json(await service.listDocuments(req.user))));
  app.post('/api/docs', auth, raw, wrap(async (req, res) => {
    const fileName = safeDecode(req.headers['x-file-name'] || 'document.hwpx', 'document.hwpx');
    // 올릴 자리(문서함·폴더): x-space public|private, x-folder-id — 없으면 공용 문서함 맨 위(작성 권한이 없으면 내 개인 문서함)
    const head = (k) => (req.headers[k] ? safeDecode(String(req.headers[k]), '') : '');
    const location = head('x-folder-id') || head('x-space') ? { space: head('x-space') || undefined, owner: head('x-space-owner') || undefined, folderId: head('x-folder-id') || undefined } : null;
    res.json(await service.createDocument({ fileName, bytes: bodyBytes(req), user: req.user, location }));
  }));
  app.get('/api/docs/:id', auth, wrap(async (req, res) => res.json(await service.getDocument(req.params.id, req.user))));
  app.delete('/api/docs/:id', auth, wrap(async (req, res) => res.json({ ok: await service.deleteDocument(req.params.id, req.user) })));
  // 문서 이름(제목) 바꾸기 { title } → 문서 요약
  app.patch('/api/docs/:id', auth, wrap(async (req, res) => res.json(await service.renameDocument(req.params.id, req.body?.title, req.user))));
  app.get('/api/docs/:id/file', auth, wrap(async (req, res) => {
    const kind = req.query.kind || 'working';
    // 한글로 저장 단추 하나(V4 §3): 문서 설정 exportKind 대로 — final = 최종본 + 메모(최종본을 못 만들면 변경 추적 포함으로 바꿔 내고
    // X-Export-Fallback: tracked), tracked = 변경 추적 + 메모. 메모 = 문서의 메모 전부 + 승인 방식이면 진행 중 변경 요청의 검토 메모(V3 §3.7).
    // 파일 이름 <제목>.hwpx, 머리글 X-Export-Kind = 실제로 낸 것(final|tracked)
    if (kind === 'export' && routeCtx.collab?.crs) {
      const meta = service._meta(req.params.id);
      const s = service._settings(meta);
      const reviews = s.editMode === 'review';
      let out; let fallback = null; let made = s.exportKind;
      if (s.exportKind === 'final') {
        try { out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'final', { reviews, strict: true }); } catch (e) {
          if (!(e instanceof ServiceError) || e.code !== 'CANNOT_FLATTEN') throw e;
          out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'tracked', { reviews }); fallback = 'tracked'; made = 'tracked';
        }
      } else out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'tracked', { reviews });
      res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${out.title || meta.title || 'document'}.hwpx`)}`);
      res.setHeader('X-Doc-Version', String(out.version));
      res.setHeader('X-Review-Memos', String(out.memos));
      res.setHeader('X-Export-Kind', made);
      if (fallback) res.setHeader('X-Export-Fallback', fallback);
      return res.send(Buffer.from(out.bytes));
    }
    // 한글로 저장(V3 §3.7): tracked|final + reviews=1 → 진행 중인 변경 요청 덩어리마다 검토 메모를 더한 사본(원본·버전은 그대로)
    if (req.query.reviews === '1' && (kind === 'tracked' || kind === 'final') && routeCtx.collab?.crs) {
      const out = await routeCtx.collab.crs.exportWithReviews(req.params.id, kind);
      res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
      res.setHeader('X-Doc-Version', String(out.version));
      res.setHeader('X-Review-Memos', String(out.memos));
      return res.send(Buffer.from(out.bytes));
    }
    // working(final 도 같음): 사본과 버전을 같은 커밋 상태에서 함께 뽑는다(X-Doc-Version 이 바이트와 어긋나지 않게)
    let bytes; let version = null;
    if (kind === 'tracked') bytes = service.trackedCopy(req.params.id);
    else if (kind === 'version') bytes = service.versionCopy(req.params.id, req.query.n);
    else ({ bytes, version } = await service.workingSnapshot(req.params.id));
    const meta = store.readMeta(req.params.id);
    // 기록(kind=version&n=기록 번호) 내려받기 이름은 웹과 같은 꼴(V3 §9.7): 그 기록이 사람용 버전이면 '_v3', 아니면 '_10-23_0116' —
    // 기록 번호(내부 판)를 'v' 로 이름에 쓰지 않는다
    const versionTag = () => {
      const m = service._meta(req.params.id); const n = Number(req.query.n);
      const ms = (m.milestones || []).find((x) => x.n === n);
      if (ms) return `_v${ms.v}`;
      const at = (m.versions || []).find((x) => x.n === n)?.at;
      return `_${(at ? fmtTime(at).replace(' ', '_').replace(':', '') : '') || '기록'}`;
    };
    res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((meta?.title || 'document') + (kind === 'tracked' ? '_변경추적' : kind === 'version' ? versionTag() : kind === 'final' ? '_최종' : '_최종본') + '.hwpx')}`);
    res.setHeader('X-Doc-Version', String(version ?? meta?.version ?? 0));
    res.send(Buffer.from(bytes));
  }));
  app.get('/api/docs/:id/paragraphs', auth, wrap(async (req, res) => res.json(await service.paragraphs(req.params.id, { view: req.query.view || 'final', nested: req.query.nested !== '0' }))));
  app.get('/api/docs/:id/tables', auth, wrap(async (req, res) => res.json(await service.tables(req.params.id))));
  app.get('/api/docs/:id/search', auth, wrap(async (req, res) => res.json(await service.search(req.params.id, req.query.q))));
  app.get('/api/docs/:id/history', auth, wrap(async (req, res) => res.json(await service.history(req.params.id))));
  // [버전 저장](V3 §9.4): 지금 기록에 사람용 버전 하나 { note? } → { milestone } / 409 NO_CHANGES — 로그인한 사람 누구나(글을 바꾸지 않음)
  app.post('/api/docs/:id/milestones', auth, wrap(async (req, res) => res.json(await service.saveMilestone(req.params.id, req.body || {}, req.user))));
  app.put('/api/docs/:id/upload', auth, raw, wrap(async (req, res) => res.json(await service.uploadEdited(req.params.id, bodyBytes(req), { baseVersion: req.query.base, user: req.user, live: req.query.live === '1' }))));
  app.post('/api/docs/:id/versions/:n/restore', auth, wrap(async (req, res) => res.json(await service.restoreVersion(req.params.id, Number(req.params.n), req.user))));

  // ── 첨부 ──
  app.get('/api/docs/:id/attachments', auth, wrap(async (req, res) => res.json(await service.listAttachments(req.params.id))));
  app.post('/api/docs/:id/attachments', auth, rawAttachment, wrap(async (req, res) => {
    const name = safeDecode(req.headers['x-file-name'] || 'file', 'file');
    res.json(await service.addAttachment(req.params.id, { name, bytes: bodyBytes(req) }, req.user));
  }));
  app.get('/api/docs/:id/attachments/:aid', auth, wrap(async (req, res) => {
    // MCP v3 실험(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §21): 'template' = 이 문서의 스타일·쪽 설정만 가진 빈 서식, 'document' = 이 문서 사본(최종본).
    // 개인 브리지의 download_attachment_file 이 그대로 받는다(첨부 aid 는 a1·a2… 이라 겹치지 않는다). 읽기 권한은 위 /api/docs/:id 문이 본다
    if (req.params.aid === 'template' || req.params.aid === 'document') {
      const f = await service.documentFile(req.params.id, req.params.aid);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.send(f.bytes);
    }
    const { entry, bytes } = await service.getAttachment(req.params.id, req.params.aid);
    const inline = entry.kind === 'image' || entry.kind === 'pdf';
    res.setHeader('Content-Type', inline ? entry.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(bytes);
  }));
  // 개인 브리지의 로컬 파일 도구(upload_result_file)가 내 PC 작업 폴더의 결과 파일을 요청 결과 첨부로 올린다.
  // 요청자·현재 시도(?attempt=)·선점 세션(X-Hwpx-Agent-Session — 브리지의 MCP 호출과 같은 값) 검사는 MCP save_result_file 과 같다. 같은 시도·같은 내용은 한 번만
  app.post('/api/docs/:id/requests/:rid/files', auth, rawAttachment, wrap(async (req, res) => {
    const rawSession = String(req.headers['x-hwpx-agent-session'] ?? '').trim();
    if (rawSession && !/^[A-Za-z0-9_-]{1,64}$/.test(rawSession)) return res.status(400).json({ error: 'BAD_SESSION', message: '에이전트 세션 id 가 올바르지 않습니다' });
    const attempt = Number(req.query.attempt);
    const user = { ...req.user, ...(rawSession ? { agentSession: rawSession } : {}), ...(Number.isInteger(attempt) && attempt > 0 ? { agentAttempt: attempt } : {}) };
    const bytes = bodyBytes(req);
    const name = safeDecode(String(req.headers['x-file-name'] || ''), '') || '결과 파일';
    const sourceFileId = `local:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    res.json(await service.addRequestFile(req.params.id, { rid: Number(req.params.rid), sourceFileId, name, bytes }, user, cleanName(req.query.agent) || 'AI'));
  }));
  app.get('/api/docs/:id/attachments/:aid/text', auth, wrap(async (req, res) => res.json(await service.attachmentText(req.params.id, req.params.aid, Number(req.query.max) || 20000))));
  app.delete('/api/docs/:id/attachments/:aid', auth, wrap(async (req, res) => res.json({ ok: await service.deleteAttachment(req.params.id, req.params.aid, req.user) })));

  // ── 메모 ──
  app.get('/api/docs/:id/memos', auth, wrap(async (req, res) => res.json(await service.memos(req.params.id, req.user))));
  app.post('/api/docs/:id/memos', auth, wrap(async (req, res) => res.json(await service.addMemo(req.params.id, req.body || {}, req.user))));
  app.patch('/api/docs/:id/memos/:memoId', auth, wrap(async (req, res) => res.json(await service.patchMemo(req.params.id, req.params.memoId, req.body?.text, req.user))));
  app.delete('/api/docs/:id/memos/:memoId', auth, wrap(async (req, res) => res.json({ ok: await service.deleteMemo(req.params.id, req.params.memoId, req.user) })));

  // ── 제안 ──
  app.get('/api/docs/:id/proposals', auth, wrap(async (req, res) => res.json(await service.listProposals(req.params.id, req.query.status))));
  app.post('/api/docs/:id/proposals', auth, wrap(async (req, res) => {
    const b = req.body || {};
    // 그림 제안은 그림 출처(첨부 aid·imageBase64·chart)를 먼저 첨부로 만든다(service.proposeFigure)
    if (b.type === 'figure') return res.json(await service.proposeFigure(req.params.id, { ...b, ...(b.figure || {}) }, req.user));
    res.json(await service.propose(req.params.id, b, req.user));
  }));
  app.patch('/api/docs/:id/proposals/:pid', auth, wrap(async (req, res) => res.json(await service.patchProposal(req.params.id, req.params.pid, req.body || {}, req.user))));
  app.post('/api/docs/:id/proposals/:pid/apply', auth, wrap(async (req, res) => res.json(await service.applyProposal(req.params.id, req.params.pid, req.user))));
  app.post('/api/docs/:id/proposals/:pid/reject', auth, wrap(async (req, res) => res.json(await service.rejectProposal(req.params.id, req.params.pid, req.user))));
  app.post('/api/docs/:id/proposals/:pid/undo', auth, wrap(async (req, res) => res.json(await service.undoProposal(req.params.id, req.params.pid, req.user))));
  app.post('/api/docs/:id/proposals/:pid/reopen', auth, wrap(async (req, res) => res.json(await service.reopenProposal(req.params.id, req.params.pid, req.user))));

  // ── 변경 추적 ──
  app.get('/api/docs/:id/changes', auth, wrap(async (req, res) => res.json(await service.changes(req.params.id))));
  app.post('/api/docs/:id/changes/accept-all', auth, wrap(async (req, res) => res.json({ accepted: await service.acceptAll(req.params.id, req.user) })));
  // 묶음(교체·개체 짝)을 한 번에: { ids: number[], mode: 'accept'|'reject' } → { ok, done, gone } — 번호 다시 매김을 서버가 따라간다
  app.post('/api/docs/:id/changes/resolve', auth, wrap(async (req, res) => res.json(await service.resolveChangeList(req.params.id, req.body?.ids, req.body?.mode, req.user))));
  app.post('/api/docs/:id/changes/:cid/accept', auth, wrap(async (req, res) => res.json({ ok: await service.resolveChange(req.params.id, Number(req.params.cid), 'accept', req.user) })));
  app.post('/api/docs/:id/changes/:cid/reject', auth, wrap(async (req, res) => res.json({ ok: await service.resolveChange(req.params.id, Number(req.params.cid), 'reject', req.user) })));

  // ── AI 작업(요청) / 잠금 ──
  app.get('/api/docs/:id/requests', auth, wrap(async (req, res) => res.json(await service.listRequests(req.params.id, { status: req.query.status }, req.user))));
  app.post('/api/docs/:id/requests', auth, wrap(async (req, res) => res.json(await service.createRequest(req.params.id, req.body || {}, req.user))));
  app.get('/api/docs/:id/requests/:rid', auth, wrap(async (req, res) => res.json(await service.getRequestView(req.params.id, req.params.rid, req.user))));
  app.get('/api/docs/:id/requests/:rid/workspace-file', auth, wrap(async (req, res) => {
    const kind = req.query.kind || 'hwpx';
    const bytes = await service.editWorkspaceFile(req.params.id, req.params.rid, { kind, attempt: req.query.attempt, revision: req.query.revision }, req.user);
    res.set('Cache-Control', 'no-store').type(kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/vnd.hancom.hwpx');
    res.set('Content-Disposition', `attachment; filename="request-${Number(req.params.rid)}-draft.${kind === 'markdown' ? 'md' : 'hwpx'}"`).send(bytes);
  }));
  // AI 작업 진행 기록(server/activity.js — AI 가 부른 도구를 한 줄씩. 새 줄은 WebSocket { type:'activity' } 로 온다)
  app.get('/api/docs/:id/requests/:rid/activity', auth, wrap(async (req, res) => res.json(service.requestActivity(req.params.id, req.params.rid, req.user))));
  // 새 MCP 연결의 요청 내용(task 응답과 같다 — server/mcp2/service.js agentBrief): 실행기가 모델의 첫 입력에 실어 task 호출 한 번을 아낀다
  app.get('/api/docs/:id/requests/:rid/brief', auth, wrap(async (req, res) => {
    service.assertDocRead(req.params.id, req.user);
    const session = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.headers['x-hwpx-agent-session'] || '')) ? String(req.headers['x-hwpx-agent-session']) : null;
    res.set('Cache-Control', 'no-store').json(await service.agentBrief(req.params.id, Number(req.params.rid), req.user, { session, surface: requestedSurface(req) === 'v3' ? 'v3' : 'v2' }));
  }));
  // 요청의 선점 상태만(문서를 읽지 않는다 — server/mcp2/service.js agentClaimState): 새 연결의 실행기 도구 연결(server/codex-mcp.js)이 쓰기 직전에 본다
  app.get('/api/docs/:id/requests/:rid/claim', auth, wrap(async (req, res) => {
    const session = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.headers['x-hwpx-agent-session'] || '')) ? String(req.headers['x-hwpx-agent-session']) : null;
    res.set('Cache-Control', 'no-store').json(service.agentClaimState(req.params.id, Number(req.params.rid), req.user, session));
  }));
  app.patch('/api/docs/:id/requests/:rid', auth, wrap(async (req, res) => res.json(await service.patchRequest(req.params.id, req.params.rid, req.body || {}, req.user))));
  app.post('/api/docs/:id/requests/:rid/cancel', auth, wrap(async (req, res) => res.json(await service.cancelRequest(req.params.id, req.params.rid, req.user))));
  app.post('/api/docs/:id/requests/:rid/retry', auth, wrap(async (req, res) => res.json(await service.retryRequest(req.params.id, req.params.rid, req.user))));
  app.post('/api/docs/:id/requests/:rid/recover', auth, wrap(async (req, res) => res.json(await service.recoverRequest(req.params.id, req.params.rid, req.user))));
  // AI 작업 하나를 한 번에 정하기(V3 §9.5): { adopt?, apply?: pid[]|'rest', reject?: pid[]|'rest', cid? } → { request, results, counts, version, milestone }
  app.post('/api/docs/:id/requests/:rid/resolve', auth, wrap(async (req, res) => res.json(await service.resolveRequest(req.params.id, req.params.rid, req.body || {}, req.user))));
  app.post('/api/docs/:id/locks', auth, wrap(async (req, res) => res.json(await service.lock(req.params.id, req.body?.ref, req.user))));
  app.delete('/api/docs/:id/locks', auth, wrap(async (req, res) => res.json({ ok: await service.unlock(req.params.id, req.query.ref, req.user) })));
}
