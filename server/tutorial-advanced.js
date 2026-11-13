// 튜토리얼 6(AI 활용 심화 — docs/TUTORIAL_AI_ADVANCED_PLAN_2026-11-04.md §8): 2026-11-04 부터 개인 AI 연결 없이 늘 미리 준비한
// 예시 답변(tutorial/ai-advanced-answers.json)으로 진행한다. 예시 답변은 단계(A1~C5)마다 MCP 도구 호출 목록이며, 화면의 작업(S1~S5,
// web/tutorial-advanced-tasks.js)은 그 단계 몇 개를 이어 붙인 것이다(presets).
// '예시 답변' 실행기(가짜 서버 AI)가 그 호출을 API 실행기와 같은 MCP 도구(openServiceApiTools)로 다시 낸다 — 유료 호출 없음.
// 학습자가 앞 단계 제안을 반영해 문단 주소가 밀려도 맞도록, 호출 인자의 '@…' 자리는 지금 문서에서 글·캡션으로 다시 찾는다
// (빈 문단은 '@after:k>>…' — 글이 있는 앞 문단에서 k 번째 뒤).
// 2026-11-12(사용자 지시): 모든 튜토리얼의 AI 요청을 예시 답변으로 처리한다. 단계 번호를 보내지 않는 연습(결과보고서 — 학습자가 도구 막대·메모
// 답글로 직접 요청한다)은 연습 문서별 답변 파일(SOURCE_ANSWERS)의 when 조건으로 요청에 맞는 답을 고르고, 맞는 답이 없으면 문서를 고치지
// 않는 안내 답(NO_EXAMPLE)으로 끝낸다 — 대기열에 남아 완료를 막지 않게.
import fs from 'node:fs';
import path from 'node:path';
import { TUTORIAL_AI_TASKS } from '../web/tutorial-advanced-tasks.js';

export const ADVANCED_ID = 'ai-advanced';
export const EXAMPLE_AGENT = '예시 답변';
export const ANSWERS_FILE = path.join('tutorial', 'ai-advanced-answers.json');
/** 연습 문서(tutorialSourceId)별 예시 답변 파일 — 답마다 when(요청과 맞추는 조건)이 있다 */
export const SOURCE_ANSWERS = Object.freeze({ report: path.join('tutorial', 'report-answers.json') });
/** 준비된 답이 없는 요청 — 문서를 고치지 않고 안내만 남긴다 */
export const NO_EXAMPLE = Object.freeze({
  summary: '튜토리얼의 AI 답변은 미리 준비한 예시입니다. 이 요청에 맞는 예시는 준비되어 있지 않아 문서를 고치지 않았습니다. 실제 AI 작업은 내 문서에서 내 AI 연결로 해 보세요.',
  instructionSummary: '', calls: [], none: true,
});

const caches = new Map();
function loadFile(root, rel, label) {
  const file = path.join(root || process.cwd(), rel);
  let st = null; try { st = fs.statSync(file); } catch { return { steps: {} }; }
  const hit = caches.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.value;
  let value = { steps: {} };
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`[${label}] 예시 답변을 읽지 못했습니다:`, e.message); }
  caches.set(file, { mtime: st.mtimeMs, value });
  return value;
}
/** 예시 답변 { steps: { A1: { summary, instructionSummary, calls: [{ name, args }] } } } — 파일이 바뀌면 다시 읽는다 */
export function loadAnswers(root) { return loadFile(root, ANSWERS_FILE, '튜토리얼 6'); }
/** 연습 문서별 예시 답변(SOURCE_ANSWERS) — 없으면 { steps: {} } */
export function loadSourceAnswers(root, sourceId) {
  const rel = Object.hasOwn(SOURCE_ANSWERS, sourceId || '') ? SOURCE_ANSWERS[sourceId] : null;
  return rel ? loadFile(root, rel, `튜토리얼 ${sourceId}`) : { steps: {} };
}

/**
 * when 조건 하나라도 맞으면 참. 조건 { followUp: true|false(메모 답글로 맡긴 요청인가), instruction: '글'(지시에 든 글), target: '글'(고른 글에 든 글) } —
 * 적은 항목이 모두 맞아야 한다. 글은 띄어쓰기를 무시하고 견준다
 */
export function whenMatches(when, r) {
  const conds = (Array.isArray(when) ? when : when ? [when] : []).filter((c) => c && typeof c === 'object' && Object.keys(c).length);
  return conds.some((c) => (c.followUp === undefined || !!r?.followUp === !!c.followUp)
    && (c.instruction === undefined || tight(r?.instruction).includes(tight(c.instruction)))
    && (c.target === undefined || tight(r?.target?.text).includes(tight(c.target))));
}
/** 단계 번호 없이 맡긴 요청에 맞는 그 연습 문서의 예시 답변 { step, summary, instructionSummary, calls } | null(파일 차례대로 처음 맞는 답) */
export function matchAnswer(root, sourceId, r) {
  for (const [step, a] of Object.entries(loadSourceAnswers(root, sourceId).steps || {})) if (whenMatches(a.when, r)) return { ...a, step };
  return null;
}

/** 단계 번호(A1~C5 꼴) — 요청 본문의 tutorialStep 검사 */
export const stepId = (v) => (typeof v === 'string' && /^[A-Z][0-9]{1,2}$/.test(v) ? v : null);

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tight = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * 인자 안의 '@종류:값' 을 지금 문서의 주소로: @para:글(그 글이 든 첫 문단) · @table:캡션(표 열쇠) · @tablepara:캡션(표가 든 문단)
 * · @cell:캡션|행|열(그 칸의 첫 문단) · @figure:캡션(그림 주소) · @figpara:캡션(그림이 든 문단)
 * · @attach:이름(그 이름이 든 첨부의 aid — 2026-11-12 엑셀 읽기·.skill 읽기 호출). 못 찾으면 null(그 호출은 건너뛴다)
 */
export function resolveAnchors(doc, figures, value, attachments = []) {
  const paras = doc.paragraphs({ view: 'final', nested: true });
  const tables = doc.tables();
  const table = (cap) => tables.find((t) => clean(t.caption?.text).includes(clean(cap)));
  const figure = (cap) => figures.find((f) => clean(f.caption).includes(clean(cap)));
  const one = (s) => {
    const m = /^@(para|table|tablepara|cell|figure|figpara|after|attach):(.*)$/s.exec(s);
    if (!m) return s;
    const [, kind, arg] = m;
    // @after:k>>자리표시 — 그 문단에서 k 번째 뒤 본문 문단(글이 없는 빈 문단 자리)
    if (kind === 'after') {
      const a = /^(\d+)>>(.*)$/s.exec(arg); const base = a ? one(a[2]) : null;
      const b = base ? /^s(\d+)\/p(\d+)$/.exec(base) : null;
      return b ? `s${b[1]}/p${Number(b[2]) + Number(a[1])}` : null;
    }
    // 글 조각은 띄어쓰기를 무시하고도 찾는다 — 앞 단계(오탈자·띄어쓰기 고침)를 반영하면 '입학년도가' → '입학 연도가' 처럼 바뀐다
    if (kind === 'para') { const p = paras.find((x) => clean(x.text).includes(clean(arg))) || paras.find((x) => tight(x.text).includes(tight(arg))); return p ? p.ref : null; }
    if (kind === 'attach') {
      const name = (a) => String(a?.name || '').toLowerCase(); const want = arg.toLowerCase();
      return (attachments.find((a) => name(a) === want) || attachments.find((a) => name(a).includes(want)))?.aid ?? null;
    }
    if (kind === 'table') return table(arg)?.key ?? null;
    if (kind === 'tablepara') return table(arg)?.ref ?? null;
    if (kind === 'cell') {
      const [cap, row, col] = arg.split('|'); const t = table(cap);
      const c = t?.cells.find((x) => x.row === Number(row) && x.col === Number(col));
      return c?.refs?.[0] ?? null;
    }
    if (kind === 'figure') return figure(arg)?.figure ?? null;
    return figure(arg)?.ref ?? null;
  };
  let missing = false;
  const walk = (v) => {
    if (typeof v === 'string') { const r = one(v); if (r == null) missing = true; return r; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return missing ? null : out;
}

/** 여러 건 제안(propose_changes)은 항목마다 자리를 찾는다 — 못 찾은 항목만 뺀다 */
function resolveCall(doc, figures, call, attachments = []) {
  if (call.name === 'propose_changes' && Array.isArray(call.args?.proposals)) {
    const resolved = call.args.proposals.map((p) => resolveAnchors(doc, figures, p, attachments)).filter(Boolean);
    // 숫자 표기 예시는 B1·B4가 겹친다. 해당 칸 전체가 이미 원하는 값이면 다시 제안하지 않는다.
    // 다른 값으로 고친 칸은 건너뛰지 않아 기존 충돌 안내를 유지한다.
    const text = new Map(doc.paragraphs({ view: 'final', nested: true }).map(p => [p.ref, doc.text(p.ref, 'final')]));
    let dropped = call.args.proposals.length - resolved.length;
    let alreadyApplied = 0;
    const proposals = call.skipIfApplied ? resolved.filter(p => {
      if (typeof p.replace !== 'string') return true;
      const current = text.get(p.ref)?.trim();
      if (current === p.replace.trim()) { alreadyApplied++; return false; }
      if (current !== p.find.trim()) { dropped++; return false; }
      return true;
    }) : resolved;
    const rest = resolveAnchors(doc, figures, { ...call.args, proposals: [] }, attachments);
    return (proposals.length || alreadyApplied) && rest ? { name: call.name, args: { ...rest, proposals }, dropped, alreadyApplied } : null;
  }
  const args = resolveAnchors(doc, figures, call.args || {}, attachments);
  return args ? { name: call.name, args, dropped: 0 } : null;
}

/** 작업(S1~S5·R1·X1·K1)이나 예전 단계(A1~C5)의 예시 답변 { summary, instructionSummary, calls } — 작업은 presets 단계를 이어 붙이고
 *  preCalls(첨부·스킬 읽기)를 앞에 둔다. 없으면 null */
export function answerFor(root, step) {
  const steps = loadAnswers(root).steps || {};
  if (steps[step]) return steps[step];
  const task = TUTORIAL_AI_TASKS.find((t) => t.id === step);
  const parts = (task?.presets || []).map((p) => {
    const a = steps[p.step]; if (!a) return null;
    return { ...a, calls: p.calls ? p.calls.map((k) => a.calls?.[k]).filter(Boolean) : (a.calls || []) };
  });
  if (!parts.length || parts.some((a) => !a)) return null;
  return { summary: task.summary || parts.map((a) => a.summary).filter(Boolean).join(' '), instructionSummary: task.title, calls: [...(task.preCalls || []), ...parts.flatMap((a) => a.calls)] };
}

/**
 * 이 요청의 예시 답변: 단계 번호(tutorialStep — 튜토리얼 6·AI로 보고서 만들기)의 답 → 연습 문서별 답 가운데 when 이 맞는 답 → NO_EXAMPLE.
 * r 대신 단계 글을 주면(예전 호출) 그 단계의 답만 본다(없으면 null)
 */
export function exampleAnswer(service, docId, r) {
  const root = service.cfg?.root;
  if (typeof r === 'string' || r == null) return r ? answerFor(root, r) : null;
  const byStep = r.tutorialStep ? answerFor(root, r.tutorialStep) : null;
  if (byStep) return byStep;
  let sourceId = null;
  try { const m = docId ? service._meta(docId) : null; sourceId = m?.tutorialSourceId || m?.tutorialId || null; } catch { sourceId = null; }
  return matchAnswer(root, sourceId, r) || NO_EXAMPLE;
}

/**
 * '예시 답변' 실행기 — 서비스의 서버 AI 자리에 넣는다(_runAi 가 MCP 도구를 열어 run 에 준다). r = 요청(단계 글이면 그 단계의 답만 — 없으면 null)
 */
export function exampleAi(service, docId, r) {
  const answer = exampleAnswer(service, docId, r);
  if (!answer) return null;
  return {
    agentName: EXAMPLE_AGENT, enabled: true, supportsTools: true, mock: true, runKind: 'example', cfg: {},
    async run(input, { toolContext } = {}) {
      if (!toolContext) throw new Error('예시 답변을 넣을 도구 연결이 없습니다');
      // 실제 AI 와 주고받는 느낌이 나게 잠깐 기다린다(기본 3초 — 시험은 cfg.tutorialExampleDelayMs: 0)
      const wait = Number(service.cfg?.tutorialExampleDelayMs ?? 3000);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let skipped = 0;
      for (const call of answer.calls || []) {
        // 문서가 바뀌었을 수 있다 — 호출마다 지금 문서로 자리를 다시 찾는다
        const doc = await service.store.doc(docId);
        const figures = await service.listFigures(docId);
        let attachments = []; try { attachments = service._meta(docId).attachments || []; } catch { /* 첨부 없음 */ }
        const ready = resolveCall(doc, figures, call, attachments);
        if (!ready) { skipped++; continue; }
        skipped += ready.dropped;
        if (ready.alreadyApplied && !ready.args.proposals.length) continue;
        const res = await toolContext.call(ready.name, ready.args);
        if (res?.isError) skipped++;
      }
      const note = skipped ? ' 문서가 바뀌어 예시의 일부를 넣지 못했습니다.' : '';
      return { proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [],
        summary: `${answer.summary || '준비된 예시 답변입니다.'}${note}`, instructionSummary: answer.instructionSummary || '', usage: null, model: EXAMPLE_AGENT,
        // 준비된 답이 없는 요청은 문서를 고치지 않은 이유를 남겨 완료한다(서비스가 결과 없는 완료를 실패로 보지 않게)
        ...(answer.none ? { noChangesReason: answer.summary } : {}) };
    },
  };
}
