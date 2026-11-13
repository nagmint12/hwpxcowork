// 수정본·변경 요청·메모 스레드·타이핑 알림 경로(docs/V3_SPEC.md §3.3·§3.6):
//   /api/docs/:id/drafts/mine…, /change-requests…, /memos/:memoId/replies·resolve·ask-ai, /proposals/:pid/adopt, /editing
//   + v0.4(docs/V4_SPEC.md): PATCH /settings(문서 설정 §1), PUT /live(실시간 밀어 넣기 §2.2 — server/live.js)
//   + 제안 '기준에 바로 적용' 권한 문(POST /proposals/:pid/apply·POST /proposals applyNow·PUT /upload — 막을 때만 답하고 아니면 index.js 경로로 넘김)
//   (한글로 저장 /file?reviews=1 은 index.js 의 /file 경로가 돌려받은 crs.exportWithReviews 로 처리한다)
// 서버 index.js 가 기존 문서 경로보다 먼저 부른다.
//   ctx = { app, service, hub, config, store, wrap, auth, raw, bodyBytes, safeDecode, pkg, root, agents }
//   PUT /api/docs/:id/drafts/mine 은 index.js 가 JSON 해석을 건너뛰므로 ctx.raw(올리기와 같은 크기 한도) + ctx.bodyBytes 로 HWPX 바이트를 받는다.
//   설치할 때 stdout 에 쓰지 않는다(포트 0 이면 stdout 첫 줄이 'LISTENING <port>' 이어야 한다 — 로그는 console.error).
// 돌려주는 값 { crs } 는 index.js 가 ctx.collab 으로 담는다(service.crs 로도 둔다 — MCP 등 다른 경로가 같은 객체를 쓰게).
import { ChangeRequests } from '../crs.js';
import { LiveEditor } from '../live.js';

/** { resolved } 본문 → 불(없으면 true = 해결). 'false'·'0'·0 은 false */
const truthy = (v) => (v === undefined ? true : !(v === false || v === 0 || /^(false|0|no)$/i.test(String(v))));

export function installCollabRoutes(ctx) {
  const { app, service, hub, config, store, wrap, auth, raw, bodyBytes } = ctx;
  const crs = new ChangeRequests({ service, store, hub, config, registry: ctx.agents ?? null });
  service.crs = crs;
  // v0.4 실시간 수정(docs/V4_SPEC.md §2.2): 밀어 넣기 — crs 의 기록 문서·정렬 지도·덩어리 자리를 같이 쓴다
  const live = new LiveEditor({ service, crs });
  service.live = live;
  const D = '/api/docs/:id';
  const CR = `${D}/change-requests/:cid`;

  app.get(`${D}/formatting`, auth, wrap(async (req, res) => {
    const out = await store.withDoc(req.params.id, async () => {
      const { doc, meta } = await service._load(req.params.id);
      return { version: meta.version, catalog: doc.formattingCatalog(), ...(req.query.ref ? { paragraph: doc.inspectFormatting(req.query.ref) } : {}) };
    });
    res.json(out);
  }));
  app.post(`${D}/proposals/:pid/adopt-format`, auth, wrap(async (req, res) => res.json(await crs.adoptFormat(req.params.id, req.params.pid, req.body || {}, req.user))));
  app.post(`${D}/proposals/:pid/undo-adopt-format`, auth, wrap(async (req, res) => res.json(await crs.adoptFormat(req.params.id, req.params.pid, req.body || {}, req.user, true))));

  // ── v0.4 문서 설정(§1)·실시간 밀어 넣기(§2.2) ──
  // PATCH { editMode?, editors?, track?, exportKind?, aiMemo?, aiQuick? } → { settings } — 관리자·문서를 올린 사람(403 FORBIDDEN), 값 검사 400 BAD_SETTING
  app.patch(`${D}/settings`, auth, wrap(async (req, res) => res.json(await service.patchSettings(req.params.id, req.body, req.user))));
  // PUT ?base=<편집기 기준 기록 n>&seq=<이 창의 차례>&loaded=<편집기 문서를 연 판 — 메모 맞추기>(본문 HWPX — index.js 가 JSON 해석을 건너뛴다)
  app.put(`${D}/live`, auth, raw, wrap(async (req, res) => res.json(await live.push(req.params.id, bodyBytes(req), { base: req.query.base, seq: req.query.seq, loaded: req.query.loaded, user: req.user }))));

  // ── 내 수정본 ──
  app.get(`${D}/drafts/mine`, auth, wrap(async (req, res) => res.json(await crs.mine(req.params.id, req.user))));
  app.get(`${D}/drafts/mine/file`, auth, wrap(async (req, res) => {
    const f = await crs.mineFile(req.params.id, req.user);
    res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${f.title || 'document'}_수정본.hwpx`)}`);
    res.setHeader('X-Base-Version', String(f.baseVersion));
    res.setHeader('X-CR', String(f.cid));
    res.setHeader('X-Draft-Rev', String(f.rev));   // 이 바이트의 수정본 판 — 다음 PUT ?rev= 에 그대로
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(f.bytes));
  }));
  // ?rev=<읽어 온 판>: 그 사이 다른 창이 저장·버리기·다시 맞추기를 했으면 409 DRAFT_STALE { rev, updatedAt }(rev 를 안 주면 예전처럼 확인 없음)
  app.put(`${D}/drafts/mine`, auth, raw, wrap(async (req, res) => res.json(await crs.saveDraft(req.params.id, bodyBytes(req), { base: req.query.base, rev: req.query.rev, user: req.user }))));
  app.delete(`${D}/drafts/mine`, auth, wrap(async (req, res) => res.json(await crs.discard(req.params.id, req.user))));
  app.post(`${D}/drafts/mine/rebase`, auth, wrap(async (req, res) => res.json(await crs.rebase(req.params.id, req.user))));

  // ── 변경 요청 ──
  app.get(`${D}/change-requests`, auth, wrap(async (req, res) => res.json(await crs.list(req.params.id, { status: req.query.status, hunks: req.query.hunks === '1' }, req.user))));
  app.get(CR, auth, wrap(async (req, res) => res.json(await crs.get(req.params.id, req.params.cid, req.user))));
  app.patch(CR, auth, wrap(async (req, res) => res.json(await crs.patch(req.params.id, req.params.cid, req.body || {}, req.user))));
  app.post(`${CR}/submit`, auth, wrap(async (req, res) => res.json(await crs.submit(req.params.id, req.params.cid, req.body || {}, req.user))));
  app.post(`${CR}/reviews`, auth, wrap(async (req, res) => res.json(await crs.review(req.params.id, req.params.cid, req.body || {}, req.user))));
  app.post(`${CR}/threads`, auth, wrap(async (req, res) => res.json(await crs.addThread(req.params.id, req.params.cid, req.body || {}, req.user))));
  app.post(`${CR}/threads/:tid/replies`, auth, wrap(async (req, res) => res.json(await crs.replyThread(req.params.id, req.params.cid, req.params.tid, req.body || {}, req.user))));
  app.post(`${CR}/threads/:tid/resolve`, auth, wrap(async (req, res) => res.json(await crs.resolveThread(req.params.id, req.params.cid, req.params.tid, truthy(req.body?.resolved), req.user))));
  app.post(`${CR}/merge`, auth, wrap(async (req, res) => res.json(await crs.merge(req.params.id, req.params.cid, req.user))));
  app.post(`${CR}/close`, auth, wrap(async (req, res) => res.json(await crs.close(req.params.id, req.params.cid, req.user))));
  app.post(`${CR}/reopen`, auth, wrap(async (req, res) => res.json(await crs.reopen(req.params.id, req.params.cid, req.user))));

  // ── 제안 '기준에 바로 적용'(v0.2 apply·applyNow)·편집본 올리기 권한: 실시간 문서는 수정 권한(V4 §4.3), 승인 문서는 관리자 또는
  //    config.changeRequests.allowDirectApply(V3 §3.3) ──
  // index.js 의 v0.2 경로보다 먼저 받아 막고, 되면 next() 로 그 경로에 넘긴다. MCP apply_proposal 은 이 경로를 지나지 않고
  // 서비스(_assertDirectApply — 문서 큐 안에서 그 문서 설정으로)가 같은 규칙으로 막는다(에이전트는 사용자 권한을 넘지 못함 — 그에 더해 config.allowAgentApply).
  // 서비스도 같은 문을 다시 보므로(REST 도) 이 문은 본문(올리기 바이트)을 읽기 전에 일찍 답하는 몫이다
  if (config.changeRequests?.directApplyLegacy) {
    console.error('[hwpx-cowork] config 에 changeRequests 구역이 없어(v0.2 설정) 편집자도 제안을 기준에 바로 적용(편집본 올리기·에이전트 적용 포함)할 수 있습니다 — 관리자만 쓰게 하려면 "changeRequests": { "allowDirectApply": false }');
  }
  // 규칙은 서비스 _canDirectApply(user, meta) 하나(V4 §4.3 — 실시간 문서는 수정 권한, 승인 문서는 관리자 또는 allowDirectApply;
  // 요청 일괄 해결 resolve 의 apply·MCP apply_proposal 도 같은 것을 본다). 문서 meta(설정)를 읽어 부른다 — 문서가 없으면 경로가 404 로 답한다
  const gate = (message) => (req, res, next) => {
    let meta = null;
    try { meta = service._meta(req.params.id); } catch { return next(); }
    const err = service._directApplyDenial(req.user, meta, null, message);
    if (!err) return next();
    return res.status(err.status).json({ error: err.code, message: err.message });
  };
  const directApply = gate("'기준에 바로 적용'은 관리자만 할 수 있습니다(설정 changeRequests.allowDirectApply 꺼짐) — '내 수정본에 반영'한 뒤 변경 요청으로 올리세요");
  app.post(`${D}/proposals/:pid/apply`, auth, directApply);
  app.post(`${D}/proposals`, auth, (req, res, next) => (req.body?.applyNow ? directApply(req, res, next) : next()));
  // v0.2 편집본 올리기 PUT /upload(?live=1 포함)도 기준 문서를 바로 고친다(변경 요청·승인 없이 새 버전) — 같은 문(§0 원칙 1, §6.1:
  // 관리자용 '기준 문서 직접 갱신'). 본문은 읽지 않고 답한다(되면 index.js 의 경로가 받는다). 웹 편집기는 이 경로를 쓰지 않는다(내 수정본 PUT /drafts/mine)
  app.put(`${D}/upload`, auth, gate('편집본 올리기(기준 문서 직접 갱신)는 관리자만 할 수 있습니다(설정 changeRequests.allowDirectApply 꺼짐) — 편집기에서 고친 글은 내 수정본으로 저장되고 변경 요청으로 반영합니다'));

  // ── 제안을 내 수정본에 반영(기록) · 타이핑 중 알림 ──
  app.post(`${D}/proposals/:pid/adopt`, auth, wrap(async (req, res) => res.json(await crs.adopt(req.params.id, req.params.pid, { cid: req.body?.cid }, req.user))));
  app.post(`${D}/editing`, auth, wrap(async (req, res) => res.json(crs.editing(req.params.id, req.body?.ref ?? null, req.user))));

  // ── 메모 스레드(답글·해결, §3.6) ──
  app.post(`${D}/memos/:memoId/replies`, auth, wrap(async (req, res) => res.json(await service.replyMemo(req.params.id, req.params.memoId, req.body?.text, req.user))));
  // 'AI에게 요청하기': 메모 답장을 그 메모 자리의 AI 작업(지시)으로 이어 맡기고 같은 글을 답글로 남긴다 { text, route? }
  app.post(`${D}/memos/:memoId/ask-ai`, auth, wrap(async (req, res) => res.json(await service.askAiFromMemo(req.params.id, req.params.memoId, req.body || {}, req.user))));
  app.post(`${D}/memos/:memoId/resolve`, auth, wrap(async (req, res) => res.json(await service.resolveMemo(req.params.id, req.params.memoId, truthy(req.body?.resolved), req.user))));

  return { crs };
}
