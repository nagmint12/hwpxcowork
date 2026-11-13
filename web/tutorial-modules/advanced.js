// 기능별 튜토리얼 단계. 실행기와 코스 구성은 이 파일 밖에서 관리합니다.
import { ADVANCED_TASKS } from '../tutorial-advanced-tasks.js';
import { requestControl } from '../tutorial-targets.js';
import { typeTutorialPrompt } from '../tutorial-motion.js';
// 튜토리얼 6 정답 목록(가상 자료 — scripts/build-tutorial-advanced.mjs 가 만든다). 한 번 읽어 둔다
let advancedKey = null; let advancedKeyLoading = null;
function loadAdvancedKey() {
  if (advancedKey || advancedKeyLoading) return advancedKeyLoading;
  advancedKeyLoading = fetch('/tutorial-assets/ai-advanced-key.json').then((r) => (r.ok ? r.json() : null)).then((k) => { advancedKey = k; return k; }).catch(() => null);
  return advancedKeyLoading;
}
import { stepHelpers, el, length, image, practice, external, commandExample } from './common.js';

export function buildAdvanced(env, tasks = ADVANCED_TASKS) {
  const { d, s, ctx, config, focusIn, rectOf, pad, q, fdoc, inFrame, frameRect, selectFor, locate, phraseRect, cw } = env;
  const { finish, intro, paragraph, focus, frameButton, frameDialog, closeFrameDialog, openShape, reveal, top, memo, memoCard, fill } = stepHelpers(env);
    // 튜토리얼 6(AI 활용 심화, 2026-11-04 간소화): 꼭 필요한 5가지 작업을 준비된 예시 답변(preset)으로 진행한다 — 개인 AI 연결은 쓰지 않는다.
    // 작업마다 두 단계: ① 요청 창이 예시 문구로 열리면 [보내기] ② 결과가 오면 [모두 반영] → 바뀐 본문으로 저절로 이동해 보여 준다(확인 단추 없음 — tutorial.js showApplied).
    if (!env.describe) loadAdvancedKey();
    const titleOf = (task) => task.target.table || task.target.figure || task.target.para || '문서 전체';
    const reqOf = (rid) => (rid != null ? (s.requests || []).find((r) => r.rid === rid) : null);
    const ridOf = (task) => ctx[`rid${task.id}`];
    // Legacy sessions recover by tutorialStep; composed modules only recover their own requests.
    const newRequest = (task) => reqOf(ridOf(task))
      || (!env.moduleKey && [...(s.requests || [])].reverse().find(r => r.tutorialStep === task.id))
      || (ctx[`before${task.id}`] && [...(s.requests || [])].reverse().find((r) => r.tutorialStep === task.id && !ctx[`before${task.id}`].includes(r.rid)))
      || (ctx[`before${task.id}`] && (s.requests || []).find((r) => !ctx[`before${task.id}`].includes(r.rid) && !r.tutorialStep));
    const finished = (task) => ['done', 'failed', 'cancelled'].includes(reqOf(ridOf(task))?.status);
    const propsOf = (task) => (s.proposals || []).filter((p) => p.rid === ridOf(task));
    const pendingOf = (task) => propsOf(task).filter((p) => p.status === 'pending' && !d.proposalDone?.(p));
    const showRequest = (rid) => { const r = reqOf(rid); if (!r) return; s.tab = 'ai'; s.activeRid = r.rid; s.active = { kind: 'request', id: String(r.rid) }; s.panelPing = (Number(s.panelPing) || 0) + 1; };
    const sendButton = () => q('.composer-win .cmp-send');
    // AI 작업 카드의 attach: 연습 문서에 미리 올려 둔 첨부(엑셀·.skill)를 요청 창에 붙인다 — 이름에 그 글이 든 첨부
    const attachmentsOf = (task) => (task.attach || []).flatMap((part) => (s.attachments || []).filter((a) => String(a.name || '').toLowerCase().includes(String(part).toLowerCase())).map((a) => a.aid)).filter((aid, k, all) => all.indexOf(aid) === k);
    const attachNames = (task) => (task.attach || []).flatMap((part) => (s.attachments || []).filter((a) => String(a.name || '').toLowerCase().includes(String(part).toLowerCase())).map((a) => a.name));
    const chips = () => q('.composer-win .cmp-chips');
    async function openTask(task, stepTitle) {
      if (s.composer || newRequest(task)) return;
      let t;
      if (task.target.doc) t = { scope: 'document', display: '문서 전체', refs: [] };
      else { t = await selectFor(titleOf(task)); if (!t) throw new Error(`‘${titleOf(task)}’을(를) 문서에서 찾지 못했습니다`); }
      if (env.isCurrentStep?.(stepTitle) === false || s.composer) return;
      d.openComposer(t, 'instruct', { instruction: '', tutorialStep: task.id, attachments: attachmentsOf(task) });
      await typePrompt(task, stepTitle);
    }
    // 요청 글을 한 글자씩 쳐 넣는 연출(2026-11-04) — 치는 동안은 [보내기] 테두리를 숨기고, 단계를 떠나거나 창을 닫으면 멈춘다
    let typing = null;
    async function typePrompt(task, stepTitle) {
      const composer = s.composer; const me = typing = {};
      try {
        await typeTutorialPrompt({ composer, text: task.prompt,
          current: () => typing === me && s.composer === composer && env.isCurrentStep?.(stepTitle) !== false,
          reduced: env.motionReduced || (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) });
      } finally { if (typing === me) typing = null; }
    }
    const keyLines = (task) => {
      const k = advancedKey; if (!k) return null;
      if (task.id === 'S3') return ['심어 둔 오탈자', ...k.typos.map((t) => `${t.wrong} → ${t.right}`)];
      if (task.id === 'S4') return ['심어 둔 오류', ...k.mismatches.map((m) => `${m.where}: ${m.text} → ${m.right}(${m.table})`), ...k.overclaims.map((o) => `「${o.text}」 — ${o.why}`)];
      return null;
    };
    const keyBox = (task) => (root) => {
      const lines = finished(task) ? keyLines(task) : null; if (!lines) return;
      const box = el('details', null, 'tour-practice'); box.append(el('summary', `정답 보기 — ${lines[0]}`));
      const ul = el('ul'); for (const line of lines.slice(1)) ul.append(el('li', line)); box.append(ul); root.append(box);
    };
    const steps = [];
    tasks.forEach((task, n) => {
      const name = `${n + 1}. ${task.title}`; const askTitle = `${name} — AI에게 요청`;
      // why(효능 한 줄)·attach(첨부 강조)는 AI 작업 카드(AI_WORK_TASKS)에만 있다 — 예전 다섯 작업은 그대로 보인다
      const lead = () => { const names = attachNames(task); return [task.why, names.length ? `첨부: ${names.map((x) => `「${x}」`).join(' ')}` : ''].filter(Boolean).join(' '); };
      const askText = (line) => (lead() ? `${lead()}\n${line}` : line);
      steps.push({ title: askTitle, press: '보내기', pressHidden: () => !!typing,   // 입력하는 동안은 첨부 칸을 금빛으로(이름표 없이) — 다 적으면 [보내기] 초록
        text: () => askText(!s.composer ? '요청 창을 여는 중입니다. 열리지 않으면 아래 [요청 창 열기]를 누르세요.' : typing ? (task.attach ? 'AI에게 보낼 요청을 입력하고 있습니다… 금빛 테두리가 함께 보낼 첨부입니다.' : 'AI에게 보낼 요청을 입력하고 있습니다…') : '요청을 다 적었습니다. 초록 테두리의 [보내기]를 누르세요.'),
        enter: () => {
          ctx[`before${task.id}`] ||= (s.requests || []).map((r) => r.rid);
          if (!task.target.doc) { const at = locate(titleOf(task)); if (at) focusIn(d, at, { quiet: true }); }
          openTask(task, askTitle).catch(() => { /* [요청 창 열기]로 다시 */ });
        },
        ring: () => (typing ? (task.attach ? pad(rectOf(chips()), 4) : null) : pad(rectOf(sendButton()), 4)), open: () => rectOf(q('.composer-win')) || frameRect(),
        motion: () => s.composer?.phase === 'edit' ? { rect: rectOf(typing ? q('.composer-win .cmp-instr') : sendButton()), mode: typing ? 'typing' : 'click' } : null,
        action: { label: '요청 창 열기', show: () => !s.composer, run: () => openTask(task, askTitle) },
        // WS로 먼저 완료가 와도 전송 함수가 마무리되기 전에 요청 창을 닫지 않는다.
        until: () => { const r = newRequest(task); if (r) ctx[`rid${task.id}`] = r.rid; return !!r && !s.sending; } });
      steps.push({ title: `${name} — 결과 반영`, press: '모두 반영', wait: true, idle: () => finished(task),
        reviewApplied: () => propsOf(task),
        // 모두 반영이 끝난 뒤 한꺼번에 한 번만 본문을 보여 준다 — 남은 제안이 있어도 반영 수가 3초 동안 그대로면(충돌·하나만 반영) 더 기다리지 않는다
        reviewWait: () => {
          if (!pendingOf(task).length) return false;
          const applied = propsOf(task).filter((p) => p.status === 'applied').length; const now = Date.now();
          if (ctx[`applied${task.id}`] !== applied) { ctx[`applied${task.id}`] = applied; ctx[`appliedAt${task.id}`] = now; }
          return now - (ctx[`appliedAt${task.id}`] || 0) < 3000;
        },
        text: () => {
          const r = reqOf(ridOf(task));
          if (!r || !finished(task)) return 'AI에게 보내고 답변을 기다리는 중입니다…';
          if (r.status !== 'done') return `답변을 넣지 못했습니다${r.error ? `: ${r.error}` : ''}. 아래 [반영하지 않고 다음]으로 넘어가세요.`;
          const what = [propsOf(task).length ? `제안 ${propsOf(task).length}건` : '', (r.comments || []).length ? `메모 ${r.comments.length}건` : ''].filter(Boolean).join(' · ') || '결과';
          if (pendingOf(task).length && propsOf(task).some((p) => p.status === 'applied')) return `남은 제안 ${pendingOf(task).length}건은 반영하지 못했거나 아직 정하지 않았습니다. AI 작업 창에서 [반영]·[거절]하거나 아래 [반영하지 않고 다음]으로 넘어가세요.`;
          return pendingOf(task).length
            ? `AI가 ${what}을 남겼습니다. ${task.look} 초록 테두리의 [모두 반영]을 누르면 바뀐 본문으로 이동해 보여 줍니다.`
            : `AI가 ${what}을 남겼습니다. ${task.look}`;
        },
        enter: () => { try { d.closeWindow('composer'); } catch { /* 이미 닫힘 */ } showRequest(ridOf(task)); },
        ring: () => pad(rectOf(requestControl(document, ridOf(task))), 4) || pad(rectOf(q(`.result[data-rid="${ridOf(task)}"]`)), 2),
        open: () => rectOf(q('.panel')),
        reveal: () => requestControl(document, ridOf(task)),
        motion: () => ({ rect: rectOf(requestControl(document, ridOf(task))), mode: 'click' }),
        ...(['S3', 'S4'].includes(task.id) ? { example: keyBox(task) } : {}),
        until: () => finished(task) && propsOf(task).length > 0 && !pendingOf(task).length,
        next: n === tasks.length - 1 ? '완료 단계로' : '반영하지 않고 다음', nextPlain: n < tasks.length - 1 });
    });
    steps.unshift(intro(`AI 활용 심화 — 선택한 AI 작업 ${tasks.length}가지`, `가상의 분석 보고서에서 ${tasks.map((t) => t.title).join(' → ')} 순서로 AI에게 맡깁니다. 화면 속 가상 커서와 타이핑 예시를 보고 [보내기]와 [모두 반영]을 직접 누르세요. 가상 커서는 클릭 위치만 보여 주며, 반영하면 바뀐 본문으로 이동합니다. 답변은 미리 준비한 예시라 AI 연결이나 사용료가 필요 없습니다. 수치는 모두 연습용 가상 자료입니다.`));
    steps.push({ ...finish, text: () => {
      const pending = (s.proposals || []).filter(p => p.status === 'pending' && !d.proposalDone?.(p)).length;
      return `선택한 AI 작업을 맡기고 반영해 보았습니다.${pending ? ` 반영하지 않은 제안 ${pending}건은 AI 작업 창에 남아 있습니다.` : ''} 완료하면 연습 문서와 요청·제안·메모 기록을 내 문서함에 보관합니다.`;
    } });
    return steps;
}
