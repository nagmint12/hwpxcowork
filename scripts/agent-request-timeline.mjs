// 채널 에이전트 대화 기록에서 요청 한 건(n번째 알림)의 모델 호출별 시간·토큰·도구를 뽑는다. 글 내용은 내지 않는다(글자 수·개수만).
//   node request-timeline.mjs <jsonl> <몇 번째 요청(1부터, 음수 = 뒤에서)> [--json]
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2]; const pick = Number(process.argv[3] || -1);
const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
const requests = []; let cur = null;
const kst = (t) => new Date(new Date(t).getTime() + 9 * 3600e3).toISOString().slice(11, 19);
for await (const line of rl) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  const m = j.message; if (!m) continue;
  if (j.type === 'user') {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const p of parts) {
      if (p.type === 'text') {
        const ev = /<channel source="hwpx"[^>]*event="([a-z_]+)"[^>]*>/.exec(p.text || '');
        if (ev || !cur) {
          cur = { event: ev?.[1] || 'prompt', docId: /doc_id="([^"]+)"/.exec(p.text || '')?.[1] || null, rid: Number(/request_id="(\d+)"/.exec(p.text || '')?.[1]) || null,
            notifiedAt: j.timestamp, calls: [], byId: new Map(), toolUse: new Map(), lastEventAt: j.timestamp };
          requests.push(cur);
        }
      } else if (p.type === 'tool_result' && cur) {
        const use = cur.toolUse.get(p.tool_use_id);
        const chars = Array.isArray(p.content) ? p.content.reduce((a, b) => a + (b.type === 'text' ? (b.text || '').length : 0), 0) : String(p.content ?? '').length;
        if (use) { use.resultChars = chars; use.resultAt = j.timestamp; use.isError = !!p.is_error; use.ms = new Date(j.timestamp) - new Date(use.at);
          if (use.name === 'start_request' || use.name === 'claim_next_request') { try { const t = Array.isArray(p.content) ? p.content.find((b) => b.type === 'text')?.text : p.content; const o = JSON.parse(t);
            cur.brief = { kind: o.kind, label: o.label, target: o.target?.scope || (o.target?.whole ? '문단 전체' : o.target?.refs ? `문단 ${o.target.refs.length}개` : '문단 일부'), instructionChars: (o.instruction || '').length, contextChars: (o.context || '').length, howToChars: (o.howTo || '').length, lean: !('contextItems' in o) }; } catch { /* 글 아님 */ } }
          if (use.name === 'propose_changes') { try { const t = Array.isArray(p.content) ? p.content.find((b) => b.type === 'text')?.text : p.content; const o = JSON.parse(t); const list = o.results || (Array.isArray(o) ? o : []); use.items = list.length; use.ok = list.filter((x) => x.ok !== false).length; use.completed = o.completed ?? null; } catch { /* 글 아님 */ } }
        }
        cur.lastEventAt = j.timestamp;
      }
    }
  } else if (j.type === 'assistant' && cur) {
    const id = m.id || j.uuid; const u = m.usage || {};
    let call = cur.byId.get(id);
    if (!call) {
      call = { n: cur.calls.length + 1, startedAfter: cur.lastEventAt, firstAt: j.timestamp, lastAt: j.timestamp, input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, tools: [], textChars: 0, thinking: 0 };
      cur.byId.set(id, call); cur.calls.push(call);
    }
    call.lastAt = j.timestamp; call.output = Math.max(call.output, u.output_tokens || 0);
    for (const p of m.content || []) {
      if (p.type === 'tool_use') { const use = { name: p.name.replace(/^mcp__hwpx__/, ''), at: j.timestamp, argChars: JSON.stringify(p.input || {}).length, n: Array.isArray(p.input?.proposals) ? p.input.proposals.length : null }; cur.toolUse.set(p.id, use); call.tools.push(use); }
      else if (p.type === 'text') call.textChars += (p.text || '').length;
      else if (p.type === 'thinking') call.thinking++;
    }
    cur.lastEventAt = j.timestamp;
  }
}
const done = requests.filter((r) => r.calls.length);
const r = pick < 0 ? done[done.length + pick] : done[pick - 1];
if (!r) { console.error(`요청 ${pick} 없음(모두 ${done.length}건)`); process.exit(1); }
const sec = (a, b) => ((new Date(b) - new Date(a)) / 1000);
const rows = r.calls.map((c) => {
  const toolEnd = c.tools.reduce((t, x) => (x.resultAt && new Date(x.resultAt) > new Date(t) ? x.resultAt : t), c.lastAt);
  return { n: c.n, at: kst(c.firstAt), modelSec: +sec(c.startedAfter, c.lastAt).toFixed(1), toolSec: +sec(c.lastAt, toolEnd).toFixed(1),
    tools: c.tools.map((x) => x.name), toolCount: c.tools.length, sentChars: c.tools.reduce((a, x) => a + x.argChars, 0), receivedChars: c.tools.reduce((a, x) => a + (x.resultChars || 0), 0),
    context: c.input + c.cacheWrite + c.cacheRead, input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output,
    detail: c.tools.map((x) => `${x.name}${x.n != null ? `(${x.n}건)` : ''} ${x.resultChars ?? '?'}자${x.isError ? ' 오류' : ''}${x.completed != null ? ` completed=${x.completed}` : ''}`) };
});
const last = r.calls[r.calls.length - 1];
const allTools = r.calls.flatMap((c) => c.tools);
const out = { file: file.split(/[\\/]/).pop(), requestIndex: done.indexOf(r) + 1, of: done.length, docId: r.docId, rid: r.rid, brief: r.brief || null,
  notifiedAt: kst(r.notifiedAt), finishedAt: kst(last.lastAt), totalSec: +sec(r.notifiedAt, last.lastAt).toFixed(1),
  modelCalls: rows.length, toolCalls: allTools.length, toolByName: allTools.reduce((a, x) => { a[x.name] = (a[x.name] || 0) + 1; return a; }, {}),
  modelSec: +rows.reduce((a, x) => a + x.modelSec, 0).toFixed(1), toolSec: +rows.reduce((a, x) => a + x.toolSec, 0).toFixed(1),
  tokens: { inputTotal: rows.reduce((a, x) => a + x.context, 0), input: rows.reduce((a, x) => a + x.input, 0), cacheWrite: rows.reduce((a, x) => a + x.cacheWrite, 0), cacheRead: rows.reduce((a, x) => a + x.cacheRead, 0), output: rows.reduce((a, x) => a + x.output, 0) },
  contextStart: rows[0].context, contextEnd: rows[rows.length - 1].context,
  chars: { sent: rows.reduce((a, x) => a + x.sentChars, 0), received: rows.reduce((a, x) => a + x.receivedChars, 0) },
  proposals: allTools.filter((x) => x.name === 'propose_changes').map((x) => ({ sent: x.n, saved: x.ok ?? null, completed: x.completed ?? null })), rows };
console.log(JSON.stringify(out, null, 1));
