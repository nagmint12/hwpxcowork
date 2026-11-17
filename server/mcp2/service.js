// 새 MCP 연결(server/mcp2.js)의 서비스 쪽 — Service.prototype 에 섞는다(server/service.js 끝). docs/MCP_REDESIGN_2026-11-16.md
//   agentTake(맡기) · agentBrief(요청 내용 — 짧게) · agentRead(읽기 보기) · agentEdit(ops 를 제안으로) · agentFinish(완료·실패)
// 문서를 바꾸는 일은 모두 지금 있는 서비스 길(proposeMany·propose·addMemo·completeRequest …)로 한다 — 여기서는 읽고, 풀고, 영수증을 줄일 뿐이다.
// 주의: _read·_tx 는 문서별 대기열이라 겹쳐 부르면 멈춘다(server/store.js withDoc) — _read 안에서는 대기열을 타는 서비스 메서드를 부르지 않는다.
import { HwpxDoc } from '../../engine/doc.js';
import { docBytesSync, containerFromBytesSync } from '../../engine/toc.js';
import { editPageLayout } from '../../engine/page-layout.js';
import { ServiceError } from '../service.js';
import { needsFormatting } from '../ai.js';
import { imageForModel } from '../image-convert.js';
import { docMap, textLines, pageLines, layoutLines, outlineLines, tableLines, rangePicker } from './views.js';
import { parseOps, prepareOps, opsGuide } from './ops.js';
import { pageEstimateMethods } from '../page-estimate.js';
import { withdrawMethods, pidRanges } from '../proposal-withdraw.js';

const VERIFY_NOTE = Symbol.for('hwpx-cowork.verifyNote');
const STOP = new Set(['REQUEST_CLOSED', 'ATTEMPT_CHANGED', 'CLAIMED', 'CLAIM_REQUIRED', 'NOT_OWNER']);
const BRIEF_CONTEXT_CHARS = 6000;
// 완료 막기 안내(agentEdit done — 2026-11-17 REPORT.md 문제 1)
const BLOCKED_NOTE = '요청을 완료하지 않았습니다(저장은 됐다) — [모두 반영]하면 apply_failed 의 제안이 실패한다. withdraw 로 그 제안을 거두고 고쳐 다시 내거나, 먼저 반영돼야 할 제안이 앞 번호가 되게 다시 낸 뒤 done 을 다시 준다';
/** pages.apply_failed(반영에서 실패할 제안)를 영수증 맨 위 칸으로도 올린다 — pages 안에 묻혀 모델이 지나치지 않게(2026-11-17 같은 문제) */
const liftFailed = (o) => (o?.pages?.apply_failed?.length ? { apply_failed: o.pages.apply_failed, ...o } : o);
// 한 호출은 다 저장되거나 하나도 저장되지 않는다(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-4)
const NOT_SAVED = '저장하지 못할 op 가 있어 아무것도 저장하지 않았습니다 — failed 의 op 를 고쳐 ops 전체를 다시 내세요';
// 저장 전 검사(사본에서 만들어 보기)의 한도: 쪽 수 어림(server/page-estimate.js LIMITS)과 같은 문서 크기·시간. 넘으면 검사 없이 저장하고 실패하면 되돌린다
const PREFLIGHT_MAX_CHARS = 6_000_000;
const PREFLIGHT_MS = 6000;
// finish 의 summary 한도(server/mcp2.js finish inputSchema 와 같다) — summary·error 를 함께 받아 완료로 닫을 때 합친 요약도 이 안에서(agentFinish)
const FINISH_SUMMARY_MAX = 2000;
// 문서 전체 대상인데 본문이 이만큼 이하면 끊지 않고 다 싣는다 — 2026-11-16 밤 실험에서 8,600자 문서가 116/141줄에서 끊겨 12건 가운데 6건이 이어 읽기를 한 번 더 불렀다
const BRIEF_WHOLE_CHARS = 12000;
/** 이 지침(표준서식 작성 지침)의 예전 도구 이름을 새 연결의 op 로 읽는 법 — read view='guide' 응답 앞에 붙인다 */
const GUIDE_NAMES_NOTE = "이 지침의 도구 이름은 예전 연결의 것이다. 새 연결에서는 이렇게 읽는다: propose_insert(after_ref, paragraphs) → edit 의 {op:'insert', after, paragraphs:[{text, style}]}(blank=true → text:''), format.styleId → style(스타일 이름), get_formatting → read(view='format', at), propose_changes → {op:'replace'}, propose_table → {op:'table'}, propose_table_edit → {op:'table_edit'}, propose_figure → {op:'figure'}, propose_chart → {op:'chart'}, propose_toc_update → {op:'toc'}, read_document → read, get_writing_guide(part='spec') → read(view='guide', id='spec'). 표 앞 단위 줄·표 아래 주석 → table 의 unit·notes(차트 제목은 chart 의 caption — insert 로 따로 넣지 않는다), 문단·절 지우기·옮기기 → {op:'delete_paragraphs'}·{op:'move_paragraphs'}, 같은 낱말 모두 바꾸기 → {op:'replace_all'}.";
const dropEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !(v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))));
const escapeContext = (s) => String(s).replace(/<(\/?)(document_context)/gi, '＜$1$2');
const wrapContext = (s) => `<document_context>\n${escapeContext(s)}\n</document_context>`;
const clip = (s, max) => { const t = [...String(s ?? '')]; return t.length > max ? `${t.slice(0, max).join('')}…` : t.join(''); };

const TODO = {
  review: () => '문제점·개선점은 edit 의 memo 로, 꼭 고칠 표현만 replace 로 남긴다.',
  suggest: (count) => (count > 1 ? `edit 의 alternatives(at=target.ref, find=대상 글, options ${count}개)로 서로 다른 안을 낸다.` : '대상 글을 대신할 추천 문장 하나를 edit 의 replace(at=target.ref, find=대상 글)로 낸다(선택지를 여럿 만들지 않는다).'),
  polish: () => '기준에 맞게 고칠 곳만 replace 로 남긴다(문단을 통째로 다시 쓰지 않는다). 수치·사실 확인이 필요하면 memo.',
  instruct: () => '지시에 맞는 op 를 edit 한 번에 모아 낸다(op 꼴은 edit 도구 설명).',
  fill_table: () => "edit 의 replace(at={table,row,col}, find=칸의 지금 글(빈 칸은 ''), with=첨부 근거 값).",
  make_table: () => 'edit 의 table(after=target.ref, rows, header_rows, caption=제목만) — 첨부 수치로.',
  insert: () => 'edit 의 insert(after=target.ref, paragraphs).',
};

/** 영수증에 싣는 제안 한 줄 */
function receipt(index, p) {
  return dropEmpty({ op: index, pid: p.pid, ref: p.insertedRef || p.ref || p.afterRef, table: p.tableKey || null, status: p.status === 'pending' ? null : p.status,
    warning: p[VERIFY_NOTE] || null, error: p.autoApplyError ? `자동 반영 실패: ${p.autoApplyError.message}` : null });
}
/**
 * 영수증 줄이기(2026-11-17 — §10.4 나-4·나-6·나-10): 같은 op 에서 잇달아 저장된 제안(경고·오류·알림·안 번호가 없고 상태가 같은 것) 셋 이상은 한 줄
 * { op, pids:'120-180', count } — pid 범위는 정확히(그 번호로 다시 거둘 수 있게). replace_all 은 count 대신 replaced·paragraphs·where(그 op 의 첫 줄에만)
 */
function compactSaved(rows, summaries = []) {
  const sum = new Map(summaries.map((x) => [x.op, x])); const used = new Set();
  const plain = (x) => Number.isInteger(x.pid) && Object.keys(x).every((k) => ['op', 'pid', 'ref', 'table', 'status'].includes(k));
  const out = [];
  for (let i = 0; i < rows.length;) {
    const x = rows[i]; let j = i;
    if (plain(x)) while (j + 1 < rows.length && plain(rows[j + 1]) && rows[j + 1].op === x.op && rows[j + 1].status === x.status) j++;
    const s = plain(x) && !used.has(x.op) ? sum.get(x.op) : null;
    if (j - i >= 2 || s) {
      const run = rows.slice(i, j + 1); if (s) used.add(x.op);
      const tables = [...new Set(run.map((r) => r.table))];
      out.push(dropEmpty({ op: x.op, ...(s ? { replaced: s.replaced, paragraphs: s.paragraphs, where: s.where, not_searched: s.not_searched } : { count: run.length }), pids: pidRanges(run.map((r) => r.pid)), ...(s && run.length !== s.replaced ? { count: run.length } : {}), table: tables.length === 1 ? tables[0] : null, status: x.status }));
      i = j + 1;
    } else { out.push(x); i++; }
  }
  return out;
}
/** 개체 → 본문 결과(영수증용 — 버린 줄은 종류별 수와 보기 몇 개만) */
function compactReports(reports) {
  const n = (v) => Number(v || 0).toLocaleString('ko-KR');
  // removed = 본문으로 옮기고 지운 글상자·선, removed_rest = 옮기지 못해 남았다가 함께 지운 개체(remove_rest·합친 delete_objects), kept = 그래도 남긴 개체
  // 2026-11-17 안전장치(engine/flow.js): backgrounds = 쪽 배경 그림을 지웠는지·글 뒤로 보냈는지, warning = 옮긴 글 영역에 겹치는 글 앞 개체(글을 가릴 수 있다),
  // numbers = 숫자 토큰 보존 검사를 지난 수(붙거나 갈라지면 제안이 만들어지지 않는다)
  const bgText = (b) => (!b ? null : [b.removed ? `${n(b.removed)}장 지움` : '', b.behind ? `${n(b.behind)}장 글 뒤로${b.content ? `(내용으로 보여 지우지 않음 ${n(b.content)}장)` : ''}` : ''].filter(Boolean).join(' · ') || null);
  const coverText = (c) => (!c?.count ? null : `글 앞 개체 ${n(c.count)}개가 옮긴 글 영역에 겹친다(${c.items.map((x) => `${x.ref} ${x.name} ${x.mm}mm`).join(' · ')}${c.count > c.items.length ? ' …' : ''}) — 글을 가릴 수 있다: remove_rest 로 지우거나, 쪽 배경이면 background:'behind'`);
  return (reports || []).map((r) => dropEmpty({ tables: r.tables, paragraphs: r.paragraphs, removed: r.removed, removed_rest: r.removedRest || null, kept: r.kept || null,
    backgrounds: bgText(r.backgrounds), warning: coverText(r.covering),
    dropped: r.dropped.length ? { count: r.dropped.length, why: [...new Set(r.dropped.map((d) => d.why))].join('·'), sample: r.dropped.slice(0, 5).map((d) => clip(d.text, 20)) } : null,
    // 쪽을 넘어 이은 표(join_pages 기본 true — 되풀이 머리행은 dropped 의 '되풀이 머리행'으로 센다)
    joined: r.tables.some((t) => t.pages > 1) ? `쪽을 넘는 표 ${r.tables.filter((t) => t.pages > 1).length}개를 한 표로 이었다(쪽마다 따로는 join_pages:false)` : null,
    sections: r.sections[0] !== r.sections[1] ? `${r.sections[0]} → ${r.sections[1]}` : null, margins_mm: r.margins,
    numbers: r.text.numbers != null ? `숫자 ${n(r.text.numbers)}개 그대로` : null,
    text: `옮긴 글자 ${n(r.text.moved)} + 버린 글자 ${n(r.text.dropped)}${r.text.removedWithObjects ? ` + 남은 개체와 함께 지운 글자 ${n(r.text.removedWithObjects)}` : ''} = 원문 글상자·본문 글자 ${n(r.text.source)}(빠진 글자 ${r.text.lost})` }));
}

export const agentServiceMethods = {
  /** 요청 맡기: docId·rid 를 주면 그 요청(start_request 와 같은 선점 규칙), 아니면 가장 오래된 내 대기 요청 → { docId, rid } | null(없음) */
  async agentTake(user, agent, session, { docId = null, rid = null } = {}) {
    if (docId && rid != null) { await this.startRequest(docId, Number(rid), user, agent, { session }); return { docId, rid: Number(rid) }; }
    const out = await this.claimNextRequest(user, agent, session, docId || undefined, { light: true });
    return out.none ? null : { docId: out.docId, rid: out.rid };
  },

  /**
   * 요청 내용(모델용 — 글과 주소만): 지시·대상·문서 얼개·대상 주변 글(문서 전체 대상이면 앞부분, 글이 글상자에 든 문서면 배치 요약)·할 일 한 줄.
   * 서식 번호·이력·해결 통계는 싣지 않는다(서식은 read view='format').
   */
  async agentBrief(id, rid, user, { session = null, budget = BRIEF_CONTEXT_CHARS } = {}) {
    return this._read(id, async () => {
      const { doc, meta } = await this._load(id);
      const r = this._req(meta, rid);
      if (r.options?.workflow === 'content_format') throw new ServiceError('EDIT_WORKFLOW', '내용·서식 나눠 처리(실험)로 맡긴 요청입니다 — 그 방식의 실행기가 처리합니다. 이 요청은 그만두세요', 409);
      const v = this._mcpReq(meta, r, user); const claim = this._agentFields(r, user, session).claim;
      const t = r.target || {}; const scope = t.scope === 'document';
      const refs = Array.isArray(t.refs) && t.refs.length ? t.refs : (t.ref ? [t.ref] : []);
      const map = docMap(doc, { title: meta.title });
      let context = ''; let more = null;
      if (map.stats.floating) {
        const page = pageLines(layoutLines(doc, { detail: false }).lines, { maxChars: budget });
        context = page.text;
        if (!page.done) more = `배치 요약이 길어 줄였다(${page.to}/${page.total}줄) — read(view='layout', cursor='layout:${meta.version}:${page.to}')`;
      } else if (scope || !refs.length) {
        // 문서 전체 대상의 from/to 는 문서 전체 본문 차례(0부터, to 제외)
        const from = Number(t.from) || 0; const to = t.to == null ? Infinity : Number(t.to);
        const pick = scope && (t.from != null || t.to != null) ? (s, b, g) => g >= from && g < to : null;
        const { lines } = textLines(doc, { pick });
        const whole = lines.reduce((n, l) => n + l.text.length + 1, 0);
        const page = pageLines(lines, { maxChars: budget === BRIEF_CONTEXT_CHARS && whole <= BRIEF_WHOLE_CHARS ? whole + 100 : budget });
        context = page.text;
        if (!page.done) more = `문서가 길어 앞부분만 실었다(${page.to}/${page.total}줄) — 이어 읽기 read(view='text', cursor='text:${meta.version}:${page.to}'), 제목만 보려면 view='outline'`;
      } else {
        // 대상 문단과 앞뒤 2문단(구역마다)
        const ranges = new Map();
        for (const x of refs) { const m = /^s(\d+)\/p(\d+)/.exec(x); if (!m) continue; const cur = ranges.get(Number(m[1])) || [Infinity, -Infinity]; ranges.set(Number(m[1]), [Math.min(cur[0], Number(m[2]) - 2), Math.max(cur[1], Number(m[2]) + 2)]); }
        const { lines } = textLines(doc, { pick: (s, b) => { const g = ranges.get(s); return !!g && b >= g[0] && b <= g[1]; } });
        const targets = new Set(refs);
        const isTarget = (l) => !!l.ref && (targets.has(l.ref) || [...targets].some((x) => l.ref.startsWith(`${x}/`) || (t.tableKey && l.table === t.tableKey)));
        const marked = lines.map((l) => ({ text: `${isTarget(l) ? '*' : ' '}${l.text}` }));
        const page = pageLines(marked, { maxChars: budget });
        context = page.text;
        if (!page.done) more = `대상 주변이 길어 줄였다 — read(view='text', at='${refs[0]}')`;
      }
      // 표 칸 대상이면 표 열쇠·줄·칸을 알려 준다(edit 의 at:{table,row,col})
      let cell = null;
      if (!scope && refs.length === 1 && /\/n\d+/.test(refs[0])) {
        for (const tb of doc.tables()) { const c = tb.cells.find((x) => x.refs.includes(refs[0])); if (c) { cell = { table: tb.key, row: c.row, col: c.col }; break; } }
      }
      const whole = !scope && refs.length === 1 && t.text && (() => { try { return doc.text(refs[0], 'final') === t.text; } catch { return false; } })();
      const target = scope ? dropEmpty({ scope: '문서 전체', from: t.from, to: t.to })
        : dropEmpty({ ref: t.ref, refs: refs.length > 1 ? refs : null, text: whole ? null : (t.text || null), whole: whole || null, start: whole ? null : t.start, end: whole ? null : t.end, table: t.tableKey || null, cell });
      const closed = r.status === 'done' || r.status === 'cancelled';
      const count = Number(r.options?.count) || 1;
      const todo = closed ? `이 요청은 이미 ${r.status === 'done' ? '완료' : '취소'}되었다 — 더 손대지 않는다.` : [
        r.followUp ? '이 요청은 메모에 사람이 단 답장이다 — follow_up.memo_text(앞 작업 메모, 자료)의 맥락을 이어 instruction 대로 실제 결과를 낸다.' : '',
        map.stats.floating ? "context 는 배치 요약이다(문단마다 읽힌 줄·표, 마지막 줄 = 옮기면 생길 표·문단). 글상자를 본문·표로 옮기는 일이면 이것으로 충분하다 — 바로 objects_to_body 를 쓰고(먼저 결과를 보려면 dry_run), 줄·칸을 자세히 보려면 read(view='layout', at='s0/p0')." : '',
        (TODO[r.kind] || TODO.instruct)(count),
        needsFormatting(r) ? "서식을 바꾸거나 맞출 때는 read(view='format', at=그 문단들)로 지금 서식을 본다." : '',
        this._isStandardFormat(doc) ? "표준서식 문서 — 새 문단·표·서식을 만들 때만 read(view='guide') 를 먼저 읽는다." : '',
        v.attachments?.length ? "첨부는 read(view='attachment', id=aid) 로 읽는다." : '',
        `끝나면 edit 의 done 에 공유 요약 1~2문장을 준다(쓰기 없이 끝낼 때는 finish). request_id=${r.rid}·expected_attempt=${v.attempt ?? 1}.`,
      ].filter(Boolean).join(' ');
      const existing = r.proposals.length || r.comments.length || r.resultAttachments.length
        ? { proposals: this._reqProposals(meta, r).filter((p) => !['rejected', 'undone', 'superseded'].includes(p.status)).length, memos: r.comments.length, files: r.resultAttachments.length, note: "이어받은 요청 — read(view='proposals') 로 이미 낸 결과를 보고 남은 일만 한다" } : null;
      return dropEmpty({
        doc_id: id, request_id: r.rid, attempt: v.attempt ?? 1, title: meta.title, status: r.status, kind: r.kind, label: v.label,
        ...(v.instructionHidden ? { instruction_hidden: true } : { instruction: v.instruction || '' }),
        options: dropEmpty({ count: count > 1 ? count : null, format: r.options?.format || null }),
        target,
        follow_up: r.followUp ? dropEmpty({ memo_id: r.followUp.memoId, request: r.followUp.rid, memo_text: r.followUp.memoText, instruction: r.followUp.instruction }) : null,
        attachments: (v.attachments || []).map((a) => dropEmpty({ id: a.aid, name: a.name, kind: a.kind, chars: a.chars, deleted: a.deleted || null })),
        existing,
        map: map.text, context: wrapContext(context), more, todo,
        claim: claim && (!claim.mine || claim.expired) ? dropEmpty({ mine: !!claim.mine, agent: claim.agent, by: claim.by, expires: claim.expires, expired: claim.expired || null }) : null,
      });
    });
  },

  /**
   * 읽기 보기 → { text } | { content }(그림 첨부).
   * view: text(기본) · layout · outline · map · tables · objects · format · memos · proposals · changes · fields · figures · attachments · attachment · page · guide · history · requests
   */
  async agentRead(id, { view = 'text', at = null, find = null, cursor = null, maxChars = null, item = null, detail = null, status = null } = {}, user) {
    const limit = Math.max(1000, Math.min(Number(maxChars) || 20000, this.mcpLimit() - 600));
    const compact = (v) => ({ text: JSON.stringify(v) });
    const paged = ['text', 'layout', 'outline', 'tables', 'objects'];
    if (paged.includes(view) || view === 'map') {
      return this._read(id, async () => {
        const { doc, meta } = await this._load(id);
        let from = 0;
        if (cursor) {
          const m = /^([a-z]+):(\d+):(\d+)$/.exec(String(cursor));
          if (!m || m[1] !== view) throw new ServiceError('BAD_CURSOR', `이 보기(${view})의 cursor 가 아닙니다 — 응답에 적힌 cursor 를 그대로, 같은 view·at 으로 보내세요`);
          if (Number(m[2]) !== meta.version) throw new ServiceError('READ_CHANGED', '이어 읽는 동안 문서가 바뀌었습니다. 필요한 범위를 처음부터 다시 읽으세요', 409);
          from = Number(m[3]);
        }
        const pick = rangePicker(at);
        if (view === 'map') return { text: docMap(doc, { title: meta.title }).text };
        let lines; let head = '';
        if (view === 'text') {
          const out = textLines(doc, { pick });
          lines = out.lines; head = `본문 문단 ${out.bodyTotal.toLocaleString('ko-KR')}개`;
          if (find != null && String(find) !== '') {
            const needle = String(find).toLowerCase(); const hit = []; let table = null; let tablePushed = false;
            for (const l of lines) {
              const isHead = /^\s*▦ /.test(l.text); if (isHead) { table = l; tablePushed = false; }
              const isRow = /^\s+r\d+ \|/.test(l.text); if (!isRow && !isHead) table = null;
              if (!l.text.toLowerCase().includes(needle)) continue;
              if (isRow && table && !tablePushed) { hit.push(table); tablePushed = true; }
              if (!(isHead && tablePushed)) hit.push(l);
              if (isHead) tablePushed = true;
            }
            head += ` — 「${clip(find, 30)}」 이 든 줄 ${hit.length}개`; lines = hit.length ? hit : [{ text: '(찾는 글이 없습니다 — 글상자 안 글은 view=\'layout\' 에서 보입니다)' }];
          }
        } else if (view === 'layout') {
          const hosts = pick ? doc.sections.flatMap((s) => s.bodyParas.filter((p) => pick(s.index, p.body)).map((p) => p.ref)) : null;
          lines = layoutLines(doc, { refs: hosts, detail: detail ?? !!pick }).lines;
          head = pick || detail ? '배치(줄 L 번호·표 줄)' : "배치 요약 — 자세히는 at='s0/p0' 처럼 문단을 주거나 detail:true";
        } else if (view === 'outline') { lines = outlineLines(doc, { pick }); head = '제목 얼개'; }
        else if (view === 'tables') {
          const tables = doc.tables();
          if (item) {
            const t = tables.find((x) => x.key === item); if (!t) throw new ServiceError('NO_TABLE', `표를 찾지 못했습니다: ${item} (read view='tables' 의 열쇠)`);
            lines = [{ text: `▦ ${t.key} 표 ${t.rows}×${t.cols}${t.caption?.text ? ` 「${clip(t.caption.text, 80)}」` : ''}` }, ...tableLines(t).map((x) => ({ text: x }))];
          } else lines = tables.length ? tables.map((t) => ({ text: `${t.key} ${t.rows}×${t.cols}${t.caption?.text ? ` 「${clip(t.caption.text.replace(/\s+/g, ' '), 80)}」` : ''}` })) : [{ text: '(표가 없습니다)' }];
          head = item ? '' : `표 ${tables.length}개 — 칸 글은 id=표 열쇠`;
        } else {   // objects
          lines = [];
          for (const s of doc.sections) for (const p of s.bodyParas) {
            if (pick && !pick(s.index, p.body)) continue;
            const own = doc.ownObjects(p.ref); if (!own.length) continue;
            const tally = new Map(); for (const o of own) tally.set(o.name, (tally.get(o.name) || 0) + 1);
            lines.push({ text: `[${p.ref}] ${[...tally].map(([k, c]) => `${k} ${c}`).join(' · ')}` });
          }
          if (!lines.length) lines = [{ text: '(표·그림·도형이 없습니다)' }];
          head = '문단이 가진 개체';
        }
        const page = pageLines(lines, { from, maxChars: limit });
        const tail = page.done ? '' : `\n…이어 읽기(${page.to}/${page.total}줄): read(view='${view}'${at ? `, at='${at}'` : ''}${find ? ', find=…' : ''}${item ? `, id='${item}'` : ''}, cursor='${view}:${meta.version}:${page.to}')`;
        return { text: `${head ? `${head}${from ? `(줄 ${from}부터)` : ''}\n` : ''}${wrapContext(page.text)}${tail}` };
      });
    }
    if (view === 'format') {
      let refs = Array.isArray(at) ? at : at ? String(at).split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (!refs?.length) throw new ServiceError('BAD_ARGS', "view='format' 은 at 에 서식을 볼 문단 주소(들)를 줍니다(예: at='s0/p3' 또는 's0/p3,s0/p4'). 스타일 이름만 필요하면 view='text' 의 〔 〕 로 충분합니다");
      // 범위('s1/p3..p9')·구역('s2')은 다른 보기처럼 그 안의 본문 문단으로 푼다(2026-11-16 밤 실험: 범위를 주면 NO_PARAGRAPH 였다)
      // 2026-11-17(§10.4 나-n 작은 버그): 역슬래시가 빠진 /..|^sd+$/ 는 모든 주소(표 칸 's0/p3/n2' 포함)를 범위로 보고 본문 문단으로 바꿨다 —
      // 범위는 '..' 가 든 것, 구역은 's숫자' 하나뿐인 것만
      const isRange = (x) => String(x).includes('..') || /^s\d+$/.test(String(x));
      if (refs.some(isRange)) {
        refs = await this._read(id, async () => {
          const { doc } = await this._load(id); const out = [];
          for (const x of refs) {
            if (!isRange(x)) { out.push(x); continue; }
            const pick = rangePicker(x);
            for (const sec of doc.sections) for (const p of sec.bodyParas) if (pick(sec.index, p.body)) out.push(p.ref);
          }
          return out;
        });
        if (!refs.length) throw new ServiceError('NO_PARAGRAPH', `그 범위에 본문 문단이 없습니다: ${Array.isArray(at) ? at.join(',') : at}`);
        if (refs.length > 200) throw new ServiceError('BAD_ARGS', `view='format' 은 한 번에 문단 200개까지입니다(범위 안 ${refs.length}개) — 범위를 줄이세요`);
      }
      const fmt = await this.getFormatting(id, { refs, breaks: true });   // 쪽 나눔이 걸린 문단은 pageBreakBefore:true(format op 의 같은 키로 끄고 켠다)
      // 응답 안내 글의 예전 도구 이름을 새 연결 것으로
      if (typeof fmt?.header?.note === 'string') fmt.header.note = fmt.header.note.replace('contextItems 의', 'paragraphs 의').replace('get_formatting 으로 받는다', "read(view='format', at=문단들)로 받는다");
      return compact(fmt);
    }
    if (view === 'memos') return compact((await this.memos(id, user)).map((m) => dropEmpty({ id: m.id, ref: m.ref, by: m.author, text: clip(m.body ?? m.text ?? '', 400), link: m.link, replies: m.thread?.replies?.length || null, resolved: m.thread?.resolved ? true : null })));
    if (view === 'proposals') return compact((await this.listProposals(id, status || undefined)).map((p) => dropEmpty({ pid: p.pid, type: p.type, status: p.status, ref: p.ref || p.afterRef, request: p.rid, find: p.find ? clip(p.find, 60) : null, with: p.replace != null ? clip(p.replace, 80) : null, text: p.text ? clip(p.text, 80) : null, labels: p.pageLayout?.labels || p.tableEdit?.labels || null })));
    if (view === 'changes') return compact(await this.changes(id));
    if (view === 'fields') return compact((await this.fields(id)).map(({ id: fid, ...f }) => f));
    if (view === 'figures') return compact(await this.listFigures(id));
    if (view === 'attachments') return compact(await this.listAttachments(id));
    if (view === 'attachment') {
      if (!item) throw new ServiceError('BAD_ARGS', "view='attachment' 는 id 에 첨부 aid 를 줍니다(read view='attachments')");
      const from = cursor ? Number(String(cursor).split(':').pop()) || 0 : 0;
      const t = await this.attachmentText(id, item, limit, { from });
      if (t.kind === 'image') {
        const { entry, bytes } = await this.getAttachment(id, item);
        const img = imageForModel(bytes, entry.mime);
        if (!img) return { text: `그림 「${entry.name}」(${entry.mime})은 AI 가 볼 수 있는 형식이 아닙니다` };
        return { content: [{ type: 'text', text: `첨부 그림 「${entry.name}」(${img.mime}, ${img.bytes.length}B)` }, { type: 'image', data: img.bytes.toString('base64'), mimeType: img.mime }] };
      }
      if (t.text == null) return { text: `「${t.name}」에서 뽑은 글이 없습니다${t.error ? `: ${t.error}` : ''}` };
      return { text: `<attachment name="${t.name}" kind="${t.kind}">\n${t.text}\n</attachment>${t.next_from != null ? `\n…이어 읽기: read(view='attachment', id='${item}', cursor='attachment:0:${t.next_from}')` : ''}` };
    }
    // 쪽 구성 + 쪽 수 어림(2026-11-17, §10.4 나-7 — server/page-estimate.js). id=요청 번호면 그 요청의 대기 제안을 모두 반영한 쪽 수도
    if (view === 'page') return compact({ ...(await this.pageLayout(id)), pages: await this.agentEstimate(id, { rid: item != null && /^\d+$/.test(String(item)) ? Number(item) : null }) });
    if (view === 'guide') {
      if (item && ['ops', 'table_edit', 'chart', 'page'].includes(item)) return { text: opsGuide(item) };
      return compact({ names: GUIDE_NAMES_NOTE, ...(await this.writingGuide(id, { part: item === 'spec' ? 'spec' : 'guide' })) });
    }
    if (view === 'history') return compact(await this.history(id));
    if (view === 'requests') return compact((await this.mcpListRequests(id, { mine: true, status: status || undefined }, user)).map((r) => dropEmpty({ doc_id: r.docId, request_id: r.rid, attempt: r.attempt, status: r.status, kind: r.kind, instruction: r.instructionHidden ? null : clip(r.instruction, 120), mine: r.claim?.mine || null })));
    throw new ServiceError('BAD_ARGS', `모르는 view: ${view}`);
  },

  /** 쪽 구성·개체 → 본문 ops 를 사본에서 미리 해 본다(문서는 그대로) → { labels, result, after(결과 문서 앞부분) } */
  async agentPreviewStructure(id, ops, author) {
    return this._read(id, async () => {
      const { doc, meta } = await this._load(id);
      const clone = new HwpxDoc(containerFromBytesSync(docBytesSync(doc)));
      const dry = this._engine(() => editPageLayout(clone, ops, { attachmentBytes: (aid) => this._layoutAttachment({ id, meta }, aid), author }));
      const page = pageLines(textLines(clone).lines, { maxChars: 3000 });
      return { labels: dry.labels, result: compactReports(dry.reports), after: `${page.text}${page.done ? '' : `\n… (${page.total}줄 가운데 ${page.to}줄)`}` };
    });
  },

  /**
   * ops 를 제안·메모로 저장한다. 한 호출은 다 저장되거나 하나도 저장되지 않는다(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-4):
   *  ① 꼴·대상이 틀린 op(parseOps·prepareOps)·붙일 글이 없는 메모 → 아무것도 저장하지 않는다
   *  ② 저장 전 검사: 사본에서 제안을 만들어 본다(server/page-estimate.js _simulateAll createOnly) — 저장해도 실패할 op 가 있으면 아무것도 저장하지 않는다
   *  ③ 저장 단계에서 그래도 실패하면(그 사이 문서가 바뀜 등 — 멈춤 오류 STOP 은 빼고) 이 호출이 만든 제안·메모·답글을 거두고 거둔 제안은 되살린다(_agentRollback)
   * 저장 차례: 거두기(withdraw) → 제안 op(차례대로) → 메모·답글 → '지금 적용' 차례. 사람에게 보이는 것은 ③ 일 때만 잠깐 생겼다 사라지는 카드다(② 가 대부분을 거른다).
   * dryRun: 저장하지 않고 검사 결과(구조 op 는 사본에서 해 본 결과)만. done(공유 요약): 모두 저장됐을 때만 요청을 완료한다.
   * → { saved: [{ op, pid, ref, status? } | { op, pids:'12-15', count }], withdrawn?, structure?, failed?: [{ op, error }], completed?, pages, … }
   *   같은 op 에서 잇달아 저장된 제안은 한 줄(pids 범위 — 그 번호로 다시 거둘 수 있다, §10.4 나-10), replace_all 은 replaced·paragraphs·where
   */
  async agentEdit(id, { ops, rid = null, dryRun = false, done = null, session = null } = {}, user, agent) {
    const nothing = (errors) => ({ saved: [], failed: errors.map((e) => ({ op: e.index, error: e.error })), note: NOT_SAVED });
    // 빈 ops(2026-11-17 작업 Q — REPORT-G3.md: Z01 의 첫 edit 가 쪽 수만 보려는 ops:[] dry_run 이라 꼴 오류로 응답 한 번을 버렸다):
    // dry_run 이면 쪽 수 어림만(지금 문서·이 요청의 대기 제안을 모두 반영하면), 아니면 오류
    if (Array.isArray(ops) && !ops.length) {
      if (!dryRun) return nothing([{ index: 0, error: 'ops 가 비었습니다 — 쪽 수만 보려면 dry_run:true' }]);
      this.assertDocRead(id, user);
      return { dry_run: true, checked: 0, pages: await this.agentEstimate(id, { rid, author: this.authorName(user, agent) }) };
    }
    const parsed = parseOps(ops);
    if (parsed.errors.length) return nothing(parsed.errors);
    const author = this.authorName(user, agent);
    const prep = await this._read(id, async () => {
      const { doc, meta } = await this._load(id);
      // 이 요청이 앞선 호출에서 낸, 아직 대기 중인 objects_to_body 제안 — 같은 문단의 개체 지우기를 뒤에 따로 제안하지 않게 prepareOps 에 알린다
      const earlier = rid == null ? [] : meta.proposals.filter((p) => p.rid === Number(rid) && p.type === 'page_layout' && p.status === 'pending')
        .flatMap((p) => (p.pageLayout?.ops || []).filter((op) => op.op === 'objects_to_body').map((op) => ({ pid: p.pid, at: op.at })));
      const out = this._engine(() => prepareOps(doc, parsed.ok, { earlier }));
      // 거두기 대상(같은 요청·같은 작성자·대기 — server/proposal-withdraw.js)과 메모·답글을 붙일 자리는 저장 전에 본다(만들기 흉내는 메모를 만들지 않는다)
      for (const s of out.steps) {
        if (s.kind === 'withdraw') {
          const at = s.indexes[0];
          if (rid == null) { out.errors.push({ index: at, error: `ops[${at}] withdraw: request_id 와 함께 씁니다(그 요청에서 낸 제안만 거둔다)` }); continue; }
          const t = this._withdrawTargets(meta, rid, author, s);
          if (t.errors.length) out.errors.push({ index: at, error: `ops[${at}] withdraw: ${t.errors.join(' · ')}` }); else s.targets = t.pids;
        } else if (s.kind === 'memo') {
          try { this._range(doc, s.input.ref, { find: s.input.find, occurrence: s.input.occurrence }); } catch (e) { if (!e?.code) throw e; out.errors.push({ index: s.index, error: `ops[${s.index}] memo: ${e.message}` }); }
        } else if (s.kind === 'reply' && !doc.memos().some((m) => m.id === s.input.memoId)) out.errors.push({ index: s.index, error: `ops[${s.index}] memo: 답글을 달 메모가 없습니다: ${s.input.memoId}(read view='memos' 의 id)` });
      }
      out.errors.sort((a, b) => a.index - b.index);
      return out;
    });
    if (prep.errors.length) return nothing(prep.errors);
    const sums = prep.summaries || [];
    const wstep = prep.steps.find((s) => s.kind === 'withdraw');
    if (dryRun) {
      const out = { dry_run: true, checked: parsed.ok.length, note: '저장하지 않았습니다. 글·주소 검사는 통과했습니다(제안이 실제로 만들어지는지는 저장할 때 확인됩니다).', ...(prep.notes.length ? { notes: prep.notes } : {}), ...(prep.previews?.length ? { preview: prep.previews } : {}) };   // preview: 문단 지우기·옮기기의 대상·결과 차례(2026-11-17 server/mcp2/ops.js)
      if (sums.length) out.replace_all = sums;
      if (wstep) out.withdraw = { pids: pidRanges(wstep.targets) || null, count: wstep.targets.length };
      const st = prep.steps.find((s) => s.kind === 'structure');
      if (st) out.structure = { ops: st.indexes, ...(await this.agentPreviewStructure(id, st.ops, author)) };
      // 2026-11-17(§10.4 나-7·나-9): 사본에서 제안을 만들고 이 요청의 앞선 대기 제안과 함께 반영해 본다 — 저장해도 실패할 op(failed)·반영에서 실패할 제안·쪽 수.
      // 한도를 넘으면 made 가 없고 예전 안내 글 그대로(server/page-estimate.js)
      const est = await this.agentEstimate(id, { rid, steps: prep.steps, author });
      if (est.made != null) {
        out.made = est.made; if (est.failed?.length) out.failed = est.failed; if (est.skipped_ops?.length) out.skipped_ops = est.skipped_ops;
        out.note = `저장하지 않았습니다. 사본에서 제안 ${est.made}건을 만들어${rid != null ? ' 이 요청의 대기 제안과 함께' : ''} 반영해 보았습니다 — failed 가 있으면 저장할 때 아무것도 저장되지 않는다, pages.apply_failed = 반영에서 실패할 제안.`;
      }
      else {
        // 쪽 수 어림이 꺼졌거나 한도를 넘었으면 저장 전 검사(만들어 보기)만이라도 — 저장할 때 아무것도 저장되지 않을 op 를 미리 안다(2026-11-17 §10.4 나-4)
        const pre = await this._agentPreflight(id, { rid, steps: prep.steps, author });
        if (pre.failed.length) out.failed = pre.failed;
      }
      out.pages = est.pages;
      return liftFailed(out);
    }
    // ② 저장 전 검사(사본에서 만들어 보기 — 실제 문서·meta·방송은 그대로)
    const pre = await this._agentPreflight(id, { rid, steps: prep.steps, author });
    if (pre.failed.length) return nothing(pre.failed.map((f) => ({ index: f.op, error: `ops[${f.op}]: ${f.error}` })));

    const saved = []; const failed = []; let structure = null; let stopped = null; let withdrawn = null;
    // 되돌릴 때 쓸 것: 이 호출이 만든 제안·메모·답글, 거둔 제안, 호출 전 첨부(그림 op 가 올린 첨부를 가린다)
    const made = []; const memos = []; const replies = []; let pulled = [];
    const attachmentsBefore = prep.steps.some((s) => s.kind === 'figure') ? this._meta(id).attachments.map((a) => String(a.aid)) : null;
    const nowItems = [];
    const late = prep.steps.filter((s) => s.kind === 'memo' || s.kind === 'reply');
    const order = [...prep.steps.filter((s) => !late.includes(s)), ...late];
    const fail = (e, index) => { failed.push({ op: index, error: `오류(${e.code}): ${e.message}` }); if (STOP.has(e.code)) stopped = e.code; };
    for (const step of order) {
      const first = step.index ?? step.indexes?.[0] ?? step.items?.[0]?.index ?? 0;
      try {
        if (step.kind === 'withdraw') {
          if (step.targets.length) pulled = (await this.withdrawProposals(id, rid, { pids: step.targets }, user, agent)).pids;
          withdrawn = { ops: step.indexes.length > 1 ? step.indexes : step.indexes[0], pids: pidRanges(pulled) || null, count: pulled.length };
        } else if (step.kind === 'proposals') {
          // 차례 '지금 적용'은 맨 뒤에 따로(권한이 없으면 제안으로 남긴다 — 옛 propose_toc_update 와 같다). 바로 반영되므로 다른 것이 모두 저장된 뒤에
          const plain = step.items.filter((x) => !x.input.applyNow); nowItems.push(...step.items.filter((x) => x.input.applyNow));
          if (plain.length) {
            const res = await this.proposeMany(id, plain.map((x) => x.input), user, agent, { rid });
            // 결과가 입력보다 많아도(서비스가 한 항목을 여럿으로 나눈 경우) 영수증을 만들다 죽지 않게 — 넘치는 것은 마지막 op 의 것으로 적는다
            res.forEach((r, i) => { const index = (plain[i] ?? plain[plain.length - 1]).index; if (r.ok) { made.push(r.proposal.pid); saved.push(receipt(index, r.proposal)); } else failed.push({ op: index, error: r.error }); });
          }
        } else if (step.kind === 'structure') {
          const p = await this.propose(id, { type: 'page_layout', pageLayout: { ops: step.ops }, rid }, user, agent);
          made.push(p.pid);
          structure = dropEmpty({ ops: step.indexes, pid: p.pid, status: p.status === 'pending' ? null : p.status, labels: p.pageLayout?.labels, result: compactReports(p.pageLayout?.result) });
        } else if (step.kind === 'alternatives') {
          const out = await this.proposeAlternatives(id, { ...step.input, rid }, user, agent);
          for (const r of out.results) { if (r.ok) { made.push(r.proposal.pid); saved.push({ ...receipt(step.index, r.proposal), option: r.proposal.option }); } else failed.push({ op: step.index, error: r.error }); }
        } else if (step.kind === 'memo') { const m = await this.addMemo(id, { ...step.input, rid }, user, agent); memos.push(m.id); saved.push(dropEmpty({ op: step.index, memo: m.id, ref: m.ref })); }
        else if (step.kind === 'reply') { await this.replyMemo(id, step.input.memoId, step.input.text, user, agent, rid); replies.push({ memoId: step.input.memoId, text: step.input.text }); saved.push({ op: step.index, reply_to: step.input.memoId }); }
        else if (step.kind === 'chart') { const p = await this.proposeChart(id, { ...step.input, rid }, user, agent); made.push(p.pid); saved.push(receipt(step.index, p)); }
        else if (step.kind === 'figure') { const p = await this.proposeFigure(id, { ...step.input, rid }, user, agent); made.push(p.pid); saved.push(receipt(step.index, p)); }
      } catch (e) {
        if (!e?.code) throw e;
        fail(e, first);
      }
      if (failed.length) break;   // 하나라도 실패하면 뒤는 저장하지 않는다(어차피 거둔다)
    }
    if (!failed.length) {
      for (const x of nowItems) {
        try {
          let p;
          try { p = await this.propose(id, { ...x.input, rid }, user, agent); }
          catch (e) { if (!['FORBIDDEN', 'DIRECT_APPLY_FORBIDDEN'].includes(e.code)) throw e; const { applyNow, ...rest } = x.input; p = await this.propose(id, { ...rest, rid }, user, agent); p = { ...p, note: '바로 적용할 권한이 없어 제안으로 남겼습니다' }; }
          made.push(p.pid);
          saved.push({ ...receipt(x.index, p), ...(p.applyNowWanted ? { note: '같은 요청의 본문·표·그림을 먼저 반영한 뒤 마지막에 차례를 갱신합니다' } : p.note ? { note: p.note } : {}) });
        } catch (e) { if (!e?.code) throw e; fail(e, x.index); break; }
      }
    }
    // notes: 서버가 op 를 다르게 푼 자리(같은 호출의 objects_to_body 에 합친 delete_objects — server/mcp2/ops.js)
    const sortOps = (rows) => rows.map((x, i) => [x, i]).sort((a, b) => (a[0].op - b[0].op) || (a[1] - b[1])).map(([x]) => x);
    if (stopped) return { ...dropEmpty({ saved: compactSaved(sortOps(saved), sums), withdrawn, structure, failed, notes: prep.notes }), stopped, note: '이 요청은 더 처리할 수 없습니다(취소·재시도·선점 바뀜) — 그만두세요' };
    // ③ 저장 단계 실패 → 이 호출을 없던 것으로
    if (failed.length) {
      try {
        const rb = await this._agentRollback(id, { rid, made, memos, replies, withdrawn: pulled, attachmentsBefore }, user, agent);
        return { saved: [], failed, note: NOT_SAVED, ...(rb.kept.length ? { kept: `사람이 그 사이 정해 거두지 못한 제안: ${rb.kept.join(', ')}` } : {}) };
      } catch (e) {
        if (!e?.code) throw e;
        return dropEmpty({ saved: compactSaved(sortOps(saved), sums), withdrawn, structure, failed, rollback_error: `오류(${e.code}): ${e.message}`, note: '저장 단계에서 실패했고 이 호출이 저장한 것을 거두지 못했습니다 — read(view=\'proposals\') 로 확인하고 withdraw 로 거두세요' });
      }
    }
    const out = dropEmpty({ saved, withdrawn, structure, notes: prep.notes });
    const shown = (o) => dropEmpty({ ...o, saved: compactSaved(sortOps(o.saved || []), sums) });
    // 영수증 끝에 쪽 수 어림(2026-11-17, §10.4 나-7 — 지금 쪽 수와 이 요청의 대기 제안을 모두 반영하면 쪽 수). 저장 고리와 떨어진 한 번의 호출이라 옮기기 쉽다
    const withPages = async (o, pages = null) => liftFailed({ ...shown(o), pages: pages || await this.agentEstimate(id, { rid, pids: rid == null ? made : [], author }) });
    if (done != null && String(done).trim() !== '') {
      if (rid == null) return withPages({ ...out, completed: false, complete_note: 'done 은 request_id 와 함께 씁니다' });
      // 완료 막기(2026-11-17 — artifacts/mcp-round3-20261117/codex/REPORT.md 문제 1): X02 는 영수증 pages.apply_failed 가 [모두 반영]의 실패를 미리 알렸는데
      // 같은 호출의 done 으로 완료돼, 모델이 알아챈 뒤의 withdraw·다시 내기가 REQUEST_CLOSED 로 막혔다(틀린 결과·사실과 다른 요약이 남음).
      // 완료 전에 반영 흉내를 하고 실패할 제안이 있으면 완료하지 않는다(저장은 그대로). 흉내를 건너뛰면(꺼짐·한도·바쁨) 예전처럼 완료한다
      const est = await this.agentEstimate(id, { rid, author });
      if (est.apply_failed?.length) return withPages({ ...out, completed: false, complete_note: BLOCKED_NOTE }, est);
      const pendingBefore = new Set((await this.listProposals(id)).filter((p) => p.rid === Number(rid) && p.status === 'pending').map((p) => p.pid));
      try {
        const view = await this.completeRequest(id, rid, { summary: String(done), session }, user, agent);
        // 완료는 자동 반영 문서의 제안을 바로 반영한다 — 저장 직후가 아니라 완료 뒤의 상태를 싣는다
        const now = new Map((await this.listProposals(id)).filter((p) => p.rid === Number(rid)).map((p) => [p.pid, p]));
        const fix = (x) => { const p = now.get(x.pid); if (!p) return x; const { status, ...rest } = x; return dropEmpty({ ...rest, status: p.status === 'pending' ? null : p.status, error: p.autoApplyError ? `자동 반영 실패: ${p.autoApplyError.message}` : null }); };
        // 쪽 수: 완료가 아무것도 반영하지 않았으면 완료 전 어림 그대로(조판을 두 번 하지 않는다), 반영했으면 다시 잰다
        const changed = [...pendingBefore].some((pid) => now.get(pid)?.status !== 'pending');
        return withPages(dropEmpty({ ...out, saved: saved.map(fix), structure: structure ? fix(structure) : null, completed: view.status === 'done' }), changed ? null : est);
      } catch (e) {
        if (!e?.code) throw e;
        return withPages({ ...out, completed: false, complete_error: `오류(${e.code}): ${e.message}` }, est);   // 결과는 저장됐다 — 완료만 안 됐다
      }
    }
    return withPages(out);
  },

  /**
   * 저장 전 검사(2026-11-17 §10.4 나-4): 사본에서 이 호출의 제안을 만들어 본다(반영·조판은 하지 않는다) → { failed: [{ op, error }], skipped? }.
   * 만들 제안이 없거나(메모·답글·거두기만) 문서가 크거나 시간 한도를 넘으면 건너뛴다 — 그때는 저장 단계 실패를 되돌림(_agentRollback)이 맡는다.
   * 비용: 사본 직렬화·읽기(10쪽 연습 보고서 9ms) + 제안 만들기(그림은 72dpi 로 그린다)
   */
  async _agentPreflight(id, { rid, steps, author }) {
    if (!steps.some((s) => ['proposals', 'structure', 'alternatives', 'chart', 'figure'].includes(s.kind))) return { failed: [] };
    try {
      const snap = await this._read(id, async () => {
        const { doc, meta } = await this._load(id);
        const chars = (doc.header?.xml?.length || 0) + doc.sections.reduce((n, s) => n + s.xml.length, 0);
        if (chars > PREFLIGHT_MAX_CHARS) return null;
        return { bytes: docBytesSync(doc), meta: structuredClone(meta) };
      });
      if (!snap) return { failed: [], skipped: 'big' };
      const sim = await this._simulateAll(id, { ...snap, rid: rid != null ? Number(rid) : null, pids: [], steps, author, deadline: Date.now() + PREFLIGHT_MS, createOnly: true });
      if (sim.abort) return { failed: [], skipped: sim.abort };
      return { failed: sim.failed };
    } catch (e) {
      // 검사는 덤이다 — 검사가 깨져도 저장은 되돌림으로 지킨다
      console.error('[저장 전 검사]', e?.stack || e);
      return { failed: [], skipped: String(e?.message || e).slice(0, 120) };
    }
  },

  /**
   * 요청의 선점 상태만 → { doc_id, request_id, attempt, status, mine(이 세션이 맡고 있는가), expired(맡은 시간이 끝났는가) }. 문서를 읽지 않는다.
   * 실행기의 도구 연결(server/codex-mcp.js)이 쓰기 직전에 취소·다시 요청·선점 상실을 볼 때 쓴다 — 예전 연결의 그 확인은 get_request(요청 내용 전체를 만든다)라
   * 조각이 많은 문서에서는 쓰기마다 2초 가까이 걸렸다(2026-11-16 실제 실행: 서버 처리 2.5초인 edit 의 왕복이 4.35초)
   */
  agentClaimState(id, rid, user, session = null) {
    this.assertDocRead(id, user);
    const meta = this._meta(id); const r = this._req(meta, rid);
    const claim = this._agentFields(r, user, session).claim;
    return { doc_id: id, request_id: r.rid, attempt: this._attempt(r), status: r.status, mine: !!claim?.mine, expired: claim ? !!claim.expired : true };
  },

  /**
   * 쓰기 없이 끝내기: summary(변경이 필요 없었으면 noChangesReason) → 완료, error → 실패 기록.
   * summary 와 error 를 함께 주고 이 요청에 저장된 결과(대기·반영된 제안, 메모, 결과 파일 — service._hasRequestResults)가 있으면 완료로 닫고
   * error 는 요약 끝 '못 한 것: …'으로 붙인다(2026-11-17 작업 Q — REPORT-G3.md 문제 1: Z01 은 제안 29·메모 2 를 저장한 뒤 finish({summary, error})로 끝내
   * 요청이 '실패', 요약이 「AI 처리 실패」가 됐다 — 목표 6쪽은 못 맞췄지만 9쪽 결과는 쓸모 있었다. 실패로 닫으면 결과는 남아도 요약을 잃고 '다시 요청'만 권한다).
   * 결과가 없거나 summary 없이 error 만이면 예전처럼 실패. 실행기의 실패 보고·예전 연결(complete_request·fail_request)은 이 길을 지나지 않는다
   */
  async agentFinish(id, rid, { summary = null, noChangesReason = null, error = null, session = null } = {}, user, agent) {
    const err = error != null && String(error).trim() !== '' ? String(error).trim() : null;
    const sum = summary != null && String(summary).trim() !== '' ? String(summary).trim() : null;
    let view = null; let partial = false;
    if (err && sum) {
      let has = false;
      try { const meta = this._meta(id); has = this._hasRequestResults(meta, this._req(meta, rid)); } catch (e) { if (!e?.code) throw e; }
      if (has) {
        // 요약 길이(finish summary 2,000자)를 넘지 않게 — 못 한 것(error ≤ 500자)은 그대로 두고 앞 요약을 줄인다
        const tail = ` 못 한 것: ${err}`; const room = FINISH_SUMMARY_MAX - [...tail].length;
        const head = [...sum].length > room ? `${[...sum].slice(0, room - 1).join('')}…` : sum;
        try { view = await this.completeRequest(id, rid, { summary: head + tail, session }, user, agent); partial = true; }
        catch (e) { if (e?.code !== 'NO_RESULTS') throw e; }   // 그 사이 결과가 사라졌으면(사람이 모두 거절 등) 예전처럼 실패로
      }
    }
    if (!view) view = err
      ? await this.failRequest(id, rid, { error: err, session }, user, agent)
      : await this.completeRequest(id, rid, { summary: summary || undefined, noChangesReason: noChangesReason || undefined, session }, user, agent);
    // completed: 지침이 이 값을 본다(2026-11-17 §10.4 나-13 — edit 의 done 영수증과 같은 이름)
    return dropEmpty({ request_id: view.rid, status: view.status, completed: view.status === 'done', summary: view.summary, error: view.error, proposals: view.proposals?.length || null, memos: view.comments?.length || null,
      note: partial ? '저장한 결과가 있어 완료로 닫았습니다 — error 는 요약 끝 「못 한 것」에 붙였습니다' : null });
  },
};
// 쪽 수 어림(agentEstimate — server/page-estimate.js, 2026-11-17 §10.4 나-7)도 같이 섞는다(server/service.js 를 고치지 않게)
Object.assign(agentServiceMethods, pageEstimateMethods);
// 자기 대기 제안 거두기·edit 한 호출 되돌림(server/proposal-withdraw.js, 2026-11-17 §10.4 나-4)
Object.assign(agentServiceMethods, withdrawMethods);
