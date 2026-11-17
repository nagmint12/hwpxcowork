// 에이전트가 자기 대기 제안을 거두기·한 edit 호출을 통째로 없던 것으로(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-4).
// Service.prototype 에 섞는다(server/mcp2/service.js 가 agentServiceMethods 에 더한다 — server/service.js 를 고치지 않게).
//
// 2차 실험 T09: 한 edit 호출의 저장 단계에서 한 항목이 실패하면 나머지는 저장되어 차례가 어긋났고, 에이전트가 다시 내면서 중복 제안 4건이 남았다
// (거절은 사람만 할 수 있어 에이전트가 자기 제안을 치울 길이 없었다). 그래서 둘을 더한다.
//  · 거두기(withdraw): 같은 요청에서 같은 작성자가 낸, 아직 대기 중인 제안만. 상태 'withdrawn' + 그 요청의 제안 목록(r.proposals)에서 뺀다 —
//    요청의 셈(memotext requestOutcome)·카드·[모두 반영]·쪽 수 흉내·완료 때 자동 반영은 모두 r.proposals 로 고르므로 저절로 빠진다.
//    문서의 제안 목록(listProposals)도 기본은 숨긴다(status='withdrawn' 으로 물을 때만). 사람의 '거절'(rejected)과 다르다 — 거절은 사람만,
//    다시 열기(reopen)·반영·되돌리기는 대기·적용 상태만 받으므로 거둔 제안은 다시 열리지 않는다. 기록은 남는다(r.withdrawn·제안 log·요청 log 한 줄).
//  · 되돌림(_agentRollback): edit 한 호출이 저장 단계에서 실패하면 그 호출이 만든 제안(대기는 거두고, 자동 반영·바로 적용된 것은 되돌린 뒤 거둠)·
//    메모·답글을 지우고, 그 호출이 거둔 제안은 다시 대기로 돌린다. 제안이 그림 첨부를 새로 올렸으면 그 첨부도 지운다.
import * as MT from './memotext.js';
import { ServiceError } from './service.js';

const nowIso = () => new Date().toISOString();
/** pid 목록 → '12-15,18' (거둔 것·영수증 글) */
export function pidRanges(pids) {
  const list = [...new Set(pids.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i; while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > i ? `${list[i]}-${list[j]}` : String(list[i])); i = j;
  }
  return out.join(',');
}

export const withdrawMethods = {
  /**
   * 거둘 제안 고르기(문서를 바꾸지 않는다 — 저장 전 검사에도 쓴다). by = 작성자 이름(authorName), exclude = 거두지 않을 pid(같은 호출에서 이미 거둔 것 등).
   * all 이면 그 요청에서 그 작성자의 대기 제안 모두(수정본에 반영해 둔 것은 사람 몫이라 뺀다). → { pids, errors: [글] }
   */
  _withdrawTargets(meta, rid, by, { pids = [], all = false } = {}) {
    const r = meta.requests.find((x) => x.rid === Number(rid));
    if (!r) return { pids: [], errors: [`AI 작업 #${rid} 이 없습니다`] };
    const mine = (p) => p.by === by;
    if (all) return { pids: this._reqProposals(meta, r).filter((p) => p.status === 'pending' && mine(p) && !MT.isAdopted(p)).map((p) => p.pid), errors: [] };
    const out = []; const errors = [];
    for (const pid of [...new Set(pids.map(Number))]) {
      const p = meta.proposals.find((x) => x.pid === pid);
      if (!p) errors.push(`#${pid}: 없는 제안입니다`);
      else if (p.rid !== r.rid) errors.push(`#${pid}: ${p.rid != null ? `다른 요청(#${p.rid})` : '요청에 딸리지 않은'} 제안입니다 — 이 요청(#${r.rid})의 제안만 거둘 수 있습니다`);
      else if (!mine(p)) errors.push(`#${pid}: 다른 작성자(${p.by})의 제안입니다 — 자기 제안만 거둘 수 있습니다`);
      else if (p.status === 'withdrawn') errors.push(`#${pid}: 이미 거둔 제안입니다`);
      else if (p.status !== 'pending') errors.push(`#${pid}: 이미 ${({ applied: '반영', rejected: '거절', undone: '되돌림', superseded: '다른 안으로 대체' })[p.status] || p.status}된 제안입니다 — 대기 중인 제안만 거둘 수 있습니다(반영·거절은 사람이 정한다)`);
      else if (MT.isAdopted(p)) errors.push(`#${pid}: 사람이 수정본에 반영해 둔 제안입니다 — 거둘 수 없습니다`);
      else out.push(pid);
    }
    return { pids: out, errors };
  },

  /** 제안 하나 거두기(ctx 안 — 저장은 호출자 _finish). 대기(되돌림 때는 방금 되돌린 것도)만. 요청의 제안 목록에서 빼고 거둔 목록에 적는다 */
  _withdrawCore(ctx, p, by, { why = '거둠', rollback = false } = {}) {
    if (p.status !== 'pending' && !(rollback && p.status === 'undone')) throw new ServiceError('STATE', `제안 ${p.pid} 은 대기 중이 아닙니다(지금: ${p.status})`, 409);
    const { doc, meta } = ctx; const at = nowIso();
    p.status = 'withdrawn'; p.withdrawn = { at, by, ...(rollback ? { rollback: true } : {}) };
    delete p.applyNowWanted; delete p.autoApplyError;
    p.log.push({ at, by, action: 'withdraw', detail: why });
    // 요청 없는 제안의 제안 메모(_proposeCore memo) — 문서에 남지 않게 지운다
    if (p.memo && p.memoId) {
      const m = this._memoById(doc, p.memoId);
      if (m && MT.isProposalMemoText(m.text, p.pid)) {
        this._memoEdit(ctx, m.ref, () => this._engine(() => doc.deleteMemo(p.memoId)));
        if (meta.memoThreads) delete meta.memoThreads[this._memoKey(m)];
        ctx.dirty = true;
      }
      p.memo = false; p.memoId = null;
    }
    if (p.rid != null) {
      const r = meta.requests.find((x) => x.rid === p.rid);
      if (r) { r.proposals = r.proposals.filter((x) => x !== p.pid); (r.withdrawn ||= []).push(p.pid); ctx.reqs.add(r.rid); }
    }
  },

  /** 거둔 제안을 다시 대기로(같은 edit 호출의 다른 단계가 실패해 그 호출을 없던 것으로 할 때만) */
  _unwithdrawCore(ctx, p, by) {
    if (p.status !== 'withdrawn') return;
    const at = nowIso();
    p.status = 'pending'; delete p.withdrawn;
    p.log.push({ at, by, action: 'withdraw-undo', detail: '같은 호출이 실패해 거두기를 되돌림' });
    const r = p.rid != null ? ctx.meta.requests.find((x) => x.rid === p.rid) : null;
    if (r) {
      r.withdrawn = (r.withdrawn || []).filter((x) => x !== p.pid);
      if (!r.proposals.includes(p.pid)) { r.proposals.push(p.pid); r.proposals.sort((a, b) => a - b); }
      ctx.reqs.add(r.rid);
    }
  },

  /**
   * 에이전트가 자기 대기 제안을 거둔다(새 연결 edit 의 withdraw op). 요청을 맡은 세션만(다른 쓰기와 같은 선점·시도 검사 — _touchRequest).
   * 하나라도 거둘 수 없으면 아무것도 거두지 않는다. → { pids: 거둔 것 }
   */
  async withdrawProposals(id, rid, { pids = [], all = false } = {}, user, agent) {
    const by = this.authorName(user, agent);
    const out = await this._tx(id, async () => {
      const { doc, meta } = await this._load(id);
      const r = this._req(meta, rid);
      this._touchRequest(r, user, agent);   // 닫힌 요청 REQUEST_CLOSED · 다시 요청 ATTEMPT_CHANGED · 남의 선점 CLAIMED
      const pick = this._withdrawTargets(meta, r.rid, by, { pids, all });
      if (pick.errors.length) throw new ServiceError('WITHDRAW', `거둘 수 없는 제안이 있어 아무것도 거두지 않았습니다 — ${pick.errors.join(' · ')}`, 409);
      if (!pick.pids.length) return { pids: [], version: meta.version };
      const ctx = this._ctx(id, doc, meta, by);
      for (const pid of pick.pids) this._withdrawCore(ctx, this._prop(meta, pid), by);
      this._reqEvent(ctx, r.rid, 'withdraw', `제안 ${pick.pids.length}건 거둠(#${pidRanges(pick.pids)})`, by);
      this.store.log(meta, by, 'proposal.withdraw', `#${pidRanges(pick.pids)}`);
      const version = await this._finish(ctx, `제안 ${pick.pids.length}건 거둠`);
      return { pids: pick.pids, version };
    });
    if (out.pids.length) {
      // 화면은 'proposal' 방송이면 제안·메모·요청을 다시 읽는다(web/store.js) — 모르는 action 은 알림 글을 띄우지 않는다
      this.hub.broadcast(id, { type: 'proposal', action: 'withdrawn', pids: out.pids, by, version: out.version });
      this.hub.broadcast(id, { type: 'request', action: 'update', rid: Number(rid), by, owner: this._reqOwner(id, Number(rid)) });
    }
    return { pids: out.pids };
  },

  /**
   * edit 한 호출을 없던 것으로(저장 단계 실패 뒤): made = 이 호출이 만든 제안 pid, memos = 만든 메모 id, replies = [{ memoId, text }] 단 답글,
   * withdrawn = 이 호출이 거둔 pid(다시 대기로), attachmentsBefore = 호출 전 첨부 aid 들(그 뒤 올라온 그림 첨부 가운데 거둔 제안이 쓰던 것을 지운다).
   * 사람이 그 사이 반영·거절한 제안은 건드리지 않고 남은 것으로 알린다. → { withdrawn, undone, memos, replies, restored, kept: [글] }
   */
  async _agentRollback(id, { rid = null, made = [], memos = [], replies = [], withdrawn = [], attachmentsBefore = null } = {}, user, agent) {
    const by = this.authorName(user, agent);
    const out = await this._tx(id, async () => {
      const { doc, meta } = await this._load(id);
      const ctx = this._ctx(id, doc, meta, by);
      const res = { withdrawn: [], undone: [], memos: 0, replies: 0, restored: [], kept: [], figureAids: [] };
      const why = '같은 edit 호출의 다른 op 가 저장되지 않아 거둠';
      // 나중에 만든 것부터(자동 반영·바로 적용이 겹쳐 있으면 뒤의 것부터 되돌린다)
      for (const pid of [...made].sort((a, b) => b - a)) {
        const p = meta.proposals.find((x) => x.pid === pid); if (!p) continue;
        if (p.status === 'applied' && (p.autoApplied || p.by === by)) { this._undoCore(ctx, p, by, '같은 edit 호출 실패로 되돌림'); res.undone.push(pid); }
        if (p.status === 'pending' || (p.status === 'undone' && res.undone.includes(pid))) {
          this._withdrawCore(ctx, p, by, { why, rollback: true }); res.withdrawn.push(pid);
          for (const aid of [p.figure?.aid, p.figure?.svgAid]) if (aid != null) res.figureAids.push(String(aid));
        } else res.kept.push(`#${pid}(${p.status})`);
      }
      const list = doc.memos(); const links = this._memoLinks(meta, list);
      for (const memoId of memos) {
        const m = list.find((x) => x.id === memoId); if (!m) continue;
        this._memoEdit(ctx, m.ref, () => this._engine(() => doc.deleteMemo(memoId)));
        if (meta.memoThreads) delete meta.memoThreads[this._memoKey(m)];
        for (const r of meta.requests) { const i = r.comments.indexOf(memoId); if (i >= 0) { r.comments.splice(i, 1); ctx.reqs.add(r.rid); } }
        ctx.dirty = true; res.memos++;
      }
      // 답글: 그 메모 스레드에서 이 작성자의 같은 글 마지막 하나를 뺀다(_memoThreadOp 'reply' 의 거꾸로 — 메모 글의 스레드 블록도 다시 쓴다)
      for (const { memoId, text } of replies) {
        const m = doc.memos().find((x) => x.id === memoId); if (!m) continue;
        const key = this._memoKey(m); const th = meta.memoThreads?.[key]; if (!th?.replies?.length) continue;
        const want = MT.xmlSafe(text).trim();
        let k = -1; for (let i = th.replies.length - 1; i >= 0; i--) if (th.replies[i].by === by && th.replies[i].text === want) { k = i; break; }
        if (k < 0) continue;
        th.replies.splice(k, 1);
        for (const r of meta.requests) if (Array.isArray(r.resultReplies)) {
          const j = r.resultReplies.findIndex((x) => x.memoId === memoId && x.reply === k + 1);
          if (j >= 0) r.resultReplies.splice(j, 1);
          for (const x of r.resultReplies) if (x.memoId === memoId && x.reply > k + 1) x.reply -= 1;
        }
        const link = links.get(memoId) || null;
        if (!link || link.type === 'comment') { const full = MT.withThread(m.text, th); if (full !== m.text) { this._memoEdit(ctx, m.ref, () => this._engine(() => doc.setMemoText(memoId, full))); ctx.dirty = true; } }
        else if (link.type === 'request') ctx.reqs.add(link.rid);
        else if (link.type === 'proposal') { const p = meta.proposals.find((x) => x.pid === link.pid); if (p) this._writeProposalMemo(ctx, p); }
        res.replies++;
      }
      for (const pid of withdrawn) { const p = meta.proposals.find((x) => x.pid === pid); if (p?.status === 'withdrawn') { this._unwithdrawCore(ctx, p, by); res.restored.push(pid); } }
      const parts = [res.withdrawn.length ? `제안 ${res.withdrawn.length}건` : '', res.memos ? `메모 ${res.memos}건` : '', res.replies ? `답글 ${res.replies}건` : ''].filter(Boolean);
      if (rid != null && (parts.length || res.restored.length)) this._reqEvent(ctx, Number(rid), 'withdraw', `edit 호출이 저장되지 않아 ${parts.length ? `${parts.join('·')}을 거둠` : ''}${res.restored.length ? `${parts.length ? ', ' : ''}거둔 제안 ${res.restored.length}건을 되살림` : ''}`, by);
      this.store.log(meta, by, 'agent.rollback', `제안 #${pidRanges(res.withdrawn)} 메모 ${res.memos} 답글 ${res.replies}`);
      res.version = await this._finish(ctx, 'edit 호출 되돌림');
      // 이 호출에서 새로 올라왔고 지금 아무 제안도 쓰지 않는 그림 첨부만
      const before = new Set(attachmentsBefore || []);
      const used = new Set(meta.proposals.filter((p) => p.status !== 'withdrawn').flatMap((p) => [p.figure?.aid, p.figure?.svgAid]).filter((x) => x != null).map(String));
      res.figureAids = attachmentsBefore ? [...new Set(res.figureAids)].filter((aid) => !before.has(aid) && !used.has(aid) && meta.attachments.some((a) => a.aid === aid)) : [];
      return res;
    });
    for (const aid of out.figureAids) { try { await this.deleteAttachment(id, aid, user); } catch { /* 그대로 둔다(첨부 한 개 — 제안은 이미 거뒀다) */ } }
    this.hub.broadcast(id, { type: 'proposal', action: 'withdrawn', pids: out.withdrawn, by, version: out.version });
    if (out.memos || out.replies) this.hub.broadcast(id, { type: 'memo', action: 'delete', by, version: out.version });
    if (out.undone.length) this.hub.broadcast(id, { type: 'doc', action: 'changed', version: out.version, by });
    if (rid != null) this.hub.broadcast(id, { type: 'request', action: 'update', rid: Number(rid), by, owner: this._reqOwner(id, Number(rid)) });
    return { withdrawn: out.withdrawn, undone: out.undone, memos: out.memos, replies: out.replies, restored: out.restored, kept: out.kept };
  },
};
