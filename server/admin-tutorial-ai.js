// 관리자 화면 '튜토리얼 AI'(2026-11-09): 튜토리얼·체험 계정의 AI 요청을 무엇으로 처리할지 고른다.
// config.tutorial.provider 하나만 쓰고(재시작 없이 바로 적용), 예전 shareAgent·shareChatGPT 값은 지우지 않는다(provider 를 비우면 그 값으로 돌아간다).
import fs from 'node:fs';
import { ServiceError } from './service.js';
import { readConfigFile, checkConfigRevision, writeConfigFile } from './admin-settings.js';
import { TUTORIAL_AI_PROVIDERS, tutorialConfig, shareAgentMatches } from './tutorial.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createAdminTutorialAi({ config, service, fsImpl = fs }) {
  const file = config.configFile;
  const read = () => readConfigFile(file, fsImpl);

  /** 공유자(shareFrom)의 개인 AI 키 가운데 그 연결 방식(gateway)으로 켜진 첫 키 → { owner, model, baseUrl? } | null */
  function keyFor(gateway, shareFrom) {
    for (const owner of shareFrom) {
      let st = null; try { st = service?.personalAi?.status({ name: owner }) || null; } catch { st = null; }
      if (st?.configured && st.active && st.gateway === gateway) return { owner, model: st.model || '', ...(st.baseUrl ? { baseUrl: st.baseUrl } : {}) };
    }
    return null;
  }

  /** 공유자의 실행기·채널 세션 가운데 그 client 에 맞는 것 → { owner, agent, client, since } | null */
  function sessionFor(clients, shareFrom) {
    for (const owner of shareFrom) {
      let hs = []; try { hs = service?.agents?.sessions(owner) || []; } catch { hs = []; }
      const h = hs.filter((x) => x.channel && shareAgentMatches(clients, x.client)).at(-1);
      if (h) return { owner, agent: h.agent || '', client: h.client || '', since: h.since || null };
    }
    return null;
  }

  /** 선택지마다 지금 쓸 수 있는가 → { ready, note } */
  function optionStatus(id, t) {
    const p = TUTORIAL_AI_PROVIDERS[id];
    if (p.kind === 'api') {
      const k = keyFor(p.gateway, t.shareFrom);
      return k ? { ready: true, note: `${k.owner} · ${k.model}${k.baseUrl ? ` · ${k.baseUrl}` : ''}` } : { ready: false, note: `공유자(${t.shareFrom.join(', ') || '없음'})에게 ${p.label} 키가 없습니다` };
    }
    if (p.kind === 'chatgpt') {
      const admins = (config.users || []).filter((u) => u.role === 'admin' && t.shareFrom.includes(u.name));
      if (!admins.length) return { ready: false, note: '공유자 가운데 관리자 계정이 없습니다' };
      let ready = false; try { ready = !!service?.tutorialChatGPTReady?.(); } catch { ready = false; }
      return ready ? { ready: true, note: `${admins[0].name} · 이벤트 구독 중` } : { ready: false, note: '관리자 ChatGPT의 튜토리얼 이벤트 구독을 기다립니다' };
    }
    const h = sessionFor(p.clients, t.shareFrom);
    return h ? { ready: true, note: `${h.owner} · ${h.agent || h.client} 연결됨` } : { ready: false, note: '실행기가 꺼져 있습니다 — 요청은 대기열에서 기다립니다' };
  }

  function snapshot(current = read()) {
    const t = tutorialConfig(config);
    const saved = object(current.raw.tutorial) && typeof current.raw.tutorial.provider === 'string' ? current.raw.tutorial.provider : null;
    return {
      enabled: t.on,
      // 연습 문서의 요청은 예시 답변으로만(2026-11-12) — 켜져 있으면 여기서 고른 AI 는 체험 계정(tutorial.users)의 자기 문서에만 쓴다
      examples: t.examples,
      examplesEditable: true,   // 2026-11-18 화면에서 고를 수 있음(이 값이 없는 옛 서버는 PUT 의 examples 를 무시한다)
      provider: t.provider,
      saved,
      shareFrom: t.shareFrom,
      legacy: { shareAgent: t.provider ? null : t.shareAgent, shareChatGPT: t.provider ? [] : [...t.shareChatGPT] },
      options: Object.entries(TUTORIAL_AI_PROVIDERS).map(([id, p]) => ({ id, label: p.label, detail: p.detail, kind: p.kind, ...optionStatus(id, t) })),
      revision: current.revision,
    };
  }

  /**
   * provider: TUTORIAL_AI_PROVIDERS 의 id 또는 null(예전 설정)
   * examples(2026-11-18): 연습 문서의 AI 요청을 예시 답변(true — 기본, AI 호출 없음)으로 할지 공유 AI(false — 위 provider)로 할지. undefined 면 그대로.
   *   튜토리얼 6·AI로 보고서 만들기(tutorialOwnAi)는 이 값과 관계없이 늘 예시 답변이다(server/service.js _exampleDoc).
   */
  function save(provider, revision, { examples } = {}) {
    if (provider !== null && !(typeof provider === 'string' && Object.hasOwn(TUTORIAL_AI_PROVIDERS, provider))) {
      throw new ServiceError('INVALID_TUTORIAL_AI', `튜토리얼 AI는 ${Object.keys(TUTORIAL_AI_PROVIDERS).join('·')} 중 하나입니다`, 400);
    }
    if (examples !== undefined && typeof examples !== 'boolean') throw new ServiceError('INVALID_TUTORIAL_AI', '연습 문서 처리 방식(examples)은 true(예시 답변)·false(공유 AI)입니다', 400);
    const current = read();
    checkConfigRevision(revision, current);
    // 기본(예시 답변)은 키를 지우고, 공유 AI 일 때만 examples:false 를 적는다
    const apply = (t) => {
      if (provider) t.provider = provider; else delete t.provider;
      if (examples === true) delete t.examples; else if (examples === false) t.examples = false;
      return t;
    };
    const tutorial = apply({ ...(object(current.raw.tutorial) ? current.raw.tutorial : {}) });
    const written = writeConfigFile(file, { ...current.raw, tutorial }, revision, fsImpl);
    // 실행 중인 설정에도 바로 반영(tutorialConfig 는 요청마다 config.tutorial 을 읽는다)
    config.tutorial = apply({ ...(object(config.tutorial) ? config.tutorial : {}) });
    return snapshot(written);
  }

  return { snapshot: () => snapshot(), save };
}
