// 채널 에이전트(Claude Code) 실제 대화 기록에서 요청별 흐름을 숫자로만 뽑는다(문서 글·지시 원문은 내지 않는다).
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
const turns = [];           // 요청(채널 알림) 단위
let cur = null;
const toolById = new Map();
const size = (c) => (typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length);
const seenMsg = new Set();
for await (const line of rl) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  const m = j.message; if (!m) continue;
  if (j.type === 'user') {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const p of parts) {
      if (p.type === 'text') {
        const ev = /<channel source="hwpx"[^>]*event="([a-z_]+)"[^>]*>/.exec(p.text || '');
        if (ev || !cur) {
          const kind = /kind="([a-z_]+)"/.exec(p.text || '')?.[1] || null;
          cur = { event: ev?.[1] || 'prompt', kind, at: j.timestamp, calls: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0, tools: [], results: {} };
          turns.push(cur);
        }
      } else if (p.type === 'tool_result' && cur) {
        const name = toolById.get(p.tool_use_id) || '?';
        const s = Array.isArray(p.content) ? p.content.reduce((a, b) => a + (b.type === 'text' ? (b.text || '').length : 0), 0) : size(p.content);
        const img = Array.isArray(p.content) ? p.content.filter((b) => b.type === 'image').length : 0;
        (cur.results[name] ||= []).push(img ? `${s}+img${img}` : s);
        if (name.endsWith('get_request') || name.endsWith('claim_next_request')) {
          // 응답 구성(글자 수만)
          try {
            const t = Array.isArray(p.content) ? p.content.find((b) => b.type === 'text')?.text : p.content;
            const o = JSON.parse(t);
            cur.reqParts = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v ?? null, null, 1).length]).filter(([, n]) => n > 60).sort((a, b) => b[1] - a[1]));
            cur.reqKind = o.kind; cur.scope = o.target?.scope || (o.target?.refs?.length > 1 ? `refs${o.target.refs.length}` : 'para'); cur.selLen = (o.target?.text || '').length; cur.instrLen = (o.instruction || '').length;
            cur.ctxItems = o.contextItems?.length; cur.lean = !!o.formattingHeader?.lean; cur.figs = o.document?.figures?.length; cur.tables = o.tables?.length;
          } catch { /* 글이 아님 */ }
        }
      }
    }
  } else if (j.type === 'assistant' && cur) {
    const u = m.usage || {};
    const id = m.id || j.uuid;
    if (!seenMsg.has(id)) {      // 한 응답이 블록마다 여러 줄로 기록된다 — usage 는 한 번만
      seenMsg.add(id);
      cur.calls++; cur.in += u.input_tokens || 0; cur.cacheRead += u.cache_read_input_tokens || 0; cur.cacheWrite += u.cache_creation_input_tokens || 0; cur.out += u.output_tokens || 0;
      cur.lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      cur.firstCtx ??= cur.lastCtx;
    }
    for (const p of m.content || []) if (p.type === 'tool_use') { toolById.set(p.id, p.name.replace(/^mcp__hwpx__/, '')); cur.tools.push(p.name.replace(/^mcp__hwpx__/, '')); }
  }
}
const rows = turns.filter((t) => t.calls > 0);
const fmt = (n) => String(n).padStart(8);
console.log(`파일 ${file.split(/[\\/]/).pop()} — 요청 ${rows.length}건`);
for (const t of rows) {
  console.log(`\n[${t.at?.slice(5, 16)}] ${t.event}/${t.reqKind || t.kind || '-'} 대상=${t.scope ?? '-'} 선택 ${t.selLen ?? '-'}자 지시 ${t.instrLen ?? '-'}자 | 모델 ${t.calls}회 · 문맥 ${t.firstCtx}→${t.lastCtx} · 입력합 ${t.in + t.cacheRead + t.cacheWrite}(새 ${t.in}, 캐시씀 ${t.cacheWrite}, 캐시읽음 ${t.cacheRead}) 출력 ${t.out}`);
  console.log(`  도구: ${t.tools.join(' → ')}`);
  console.log(`  도구 응답 글자: ${Object.entries(t.results).map(([k, v]) => `${k}[${v.join(',')}]`).join(' ')}`);
  if (t.reqParts) console.log(`  get_request 구성(문맥 ${t.ctxItems}문단, lean=${t.lean}, 그림 ${t.figs}, 표 ${t.tables}): ${Object.entries(t.reqParts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
const sum = (f) => rows.reduce((a, t) => a + f(t), 0);
console.log(`\n합계: 모델 ${sum((t) => t.calls)}회, 입력합 ${sum((t) => t.in + t.cacheRead + t.cacheWrite)}, 새 입력 ${sum((t) => t.in)}, 캐시씀 ${sum((t) => t.cacheWrite)}, 캐시읽음 ${sum((t) => t.cacheRead)}, 출력 ${sum((t) => t.out)}`);
