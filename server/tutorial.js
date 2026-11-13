// 튜토리얼 메뉴 → 새 임시 문서 → 완료 시 본인의 문서함에 저장(2026-11-01).
// 원본은 공통으로 보관하고 계정별로 미리 배포하지 않는다. 설계: docs/TUTORIAL_SESSIONS.md.
// config.tutorial은 원본 경로·공유 API·접근 제한을 설정한다. 별도 설정이 없어도 모든 로그인 사용자가 메뉴를 쓴다.
// users의 계정은 모든 문서, 나머지 계정은 tutorial 문서에서 shareFrom의 API를 사용한다.
import fs from 'node:fs';
import path from 'node:path';
import { ServiceError } from './service.js';
import { manualCatalog, advancedCatalog, tutorialBytes, withTrackChangeOn } from './tutorial-catalog.js';
import { seedTutorialExamples } from './tutorial-examples.js';
import { writeFileAtomic } from './store.js';
import { tutorialOwnerKey, ownsTutorial } from './tutorial-identity.js';
import { createTutorialDefinitionStore } from './tutorial-definition-store.js';
import { createTutorialRecovery, tutorialProgress } from './tutorial-recovery.js';
import { defaultTutorialDefinition, TUTORIAL_SOURCES } from '../web/tutorial-definition.js';

const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

/**
 * config.tutorial → { on, users: Set(공유 계정), shareFrom: [], shareAgent, everyone, autoStart, doc(절대 경로), title }.
 * shareAgent: shareFrom 의 실행기도 체험 요청을 맡는다 — true 면 아무 채널 세션, 글이면 그 client 이름(예: 'hwpx-codex-worker',
 * 판 번호 없이 'claude-code' 면 Claude Code 채널 세션 'claude-code/2.1.x' 도 맞음 — shareAgentMatches). 없으면 null(API 만)
 */
export function shareAgentMatches(want, client) {
  if (want === true) return true;
  if (Array.isArray(want)) return want.some((w) => shareAgentMatches(w, client));
  if (!want) return false;
  const c = String(client || '');
  return c === want || c.split('/')[0] === want;
}

/**
 * 튜토리얼 AI(관리자 화면 '튜토리얼 AI' — config.tutorial.provider, 2026-11-09). 고르면 shareAgent·shareChatGPT 보다 앞서고,
 * 고른 것 하나로만 처리한다(다른 연결로 넘기지 않는다):
 *   api     — shareFrom 가운데 그 연결 방식(gateway)의 개인 AI 키가 켜진 첫 사람의 키로 서버가 바로 처리
 *   chatgpt — shareFrom 관리자의 ChatGPT 이벤트 구독(대기열)
 *   agent   — shareFrom 의 그 실행기·채널 세션(client 이름). 꺼져 있으면 대기열에 두고 다시 붙으면 claim_next_request 로 가져간다
 * 없으면(null) 예전 설정(shareAgent·shareChatGPT·키 순서)을 그대로 쓴다.
 */
export const TUTORIAL_AI_PROVIDERS = Object.freeze({
  api: Object.freeze({ label: 'API', detail: '관리자 API 키로 서버가 바로 처리', kind: 'api', gateway: 'baze' }),
  local: Object.freeze({ label: '로컬 AI', detail: '관리자 로컬 AI(LM Studio 등 OpenAI 호환 API)로 서버가 바로 처리', kind: 'api', gateway: 'local' }),
  chatgpt: Object.freeze({ label: 'ChatGPT', detail: '관리자 ChatGPT의 튜토리얼 이벤트 구독으로 처리', kind: 'chatgpt' }),
  codex: Object.freeze({ label: 'Codex', detail: '관리자 PC의 Codex 실행기가 처리', kind: 'agent', clients: Object.freeze(['hwpx-tutorial-codex-worker', 'hwpx-codex-worker']) }),
  'claude-code': Object.freeze({ label: 'Claude Code', detail: '관리자 PC의 Claude Code 채널 세션이 처리', kind: 'agent', clients: Object.freeze(['claude-code']) }),
});

export function tutorialConfig(cfg) {
  const has = !!cfg?.tutorial && typeof cfg.tutorial === 'object' && !Array.isArray(cfg.tutorial);
  const t = has ? cfg.tutorial : {};
  const users = new Set(list(t.users));
  const root = cfg?.root || process.cwd();
  const everyone = t.everyone !== false;
  // 모르는 연결 ID(예전 설정의 옛 ID 포함)는 고르지 않은 것(null)으로 본다 — 관리자 화면 '튜토리얼 AI'에서 다시 고른다.
  const providerId = t.provider;
  const provider = typeof providerId === 'string' && Object.hasOwn(TUTORIAL_AI_PROVIDERS, providerId) ? providerId : null;
  const pick = provider ? TUTORIAL_AI_PROVIDERS[provider] : null;
  const shareFrom = list(t.shareFrom);
  return {
    on: t.enabled !== false && (everyone || users.size > 0),
    users,
    shareFrom,
    // provider: 관리자가 고른 튜토리얼 AI(TUTORIAL_AI_PROVIDERS 의 id) | null, providerKind: 'api'|'chatgpt'|'agent'|null
    provider,
    providerKind: pick?.kind || null,
    // shareApi: 공유 키로 서버가 처리할 때 쓸 연결 방식 — null(아무 키, 예전 동작) | 'baze'·'local' | 'none'(키를 쓰지 않음)
    shareApi: pick ? (pick.kind === 'api' ? pick.gateway : 'none') : null,
    shareAgent: pick ? (pick.kind === 'agent' ? [...pick.clients] : null)
      : t.shareAgent === true ? true : typeof t.shareAgent === 'string' && t.shareAgent.trim() ? t.shareAgent.trim() : null,
    everyone,
    autoStart: has && t.autoStart !== false,
    doc: path.resolve(root, t.doc || path.join('tutorial', '결과보고서.hwpx')),
    title: String(t.title || '결과보고서').trim() || '결과보고서',
    // 변경 추적을 켠 채 연습(문서 설정 track·exportKind tracked + 한/글 변경 내용 추적 켬). 2026-11-04 기본은 끔 — 켜면 반영 오류가 있었다
    trackChanges: t.trackChanges === true,
    trackChangesUsers: new Set(list(t.trackChangesUsers)),
    // 튜토리얼 연습 문서의 AI 요청은 미리 준비한 예시 답변으로만 처리한다(2026-11-12 사용자 지시 — 모든 튜토리얼, AI 호출 없음).
    // false 면 예전처럼 결과보고서 등 연습 문서도 관리자 AI(provider·shareAgent·공유 키)로 보낸다. 튜토리얼 6·AI로 보고서 만들기(tutorialOwnAi)는 늘 예시 답변
    examples: t.examples !== false,
    shareChatGPT: pick ? new Set(pick.kind === 'chatgpt' ? shareFrom : []) : new Set(list(t.shareChatGPT)),
  };
}

export function createTutorial({ service, config }) {
  const recovery = createTutorialRecovery({ service });
  const conf = () => tutorialConfig(config);
  /** 공유 계정(config.tutorial.users — 모든 문서에서 공유 AI) */
  const isUser = (name) => conf().on && conf().users.has(String(name ?? ''));
  /** 체험을 할 수 있는 계정(everyone 이면 누구나) */
  const canUse = (name) => { const c = conf(); return c.on && !!name && (c.everyone || c.users.has(String(name))); };
  const root = config.root || process.cwd();
  const definitions = createTutorialDefinitionStore({
    dataDir: config.dataDir || path.join(root, 'data'),
    error: (code, message, status) => new ServiceError(code, message, status),
    defaults: () => {
      const definition = defaultTutorialDefinition();
      definition.courses.find(course => course.id === 'report').title = conf().title;
      return definition;
    },
  });
  const sourceCatalog = () => [
    { id: 'report', title: conf().title, description: 'AI 요청·제안 반영·메모·차례 갱신을 화면 안내로 연습합니다(3~5분).', file: conf().doc, guided: true },
    // AI 활용 심화 연습 보고서는 AI 연결 안내 뒤, 관리자 참고 문서는 맨 끝(원본 목록 차례 — 메뉴 차례는 저장한 구성이 정한다)
    ...manualCatalog(root).filter((x) => x.id !== 'admin'),
    ...advancedCatalog(root),
    ...manualCatalog(root).filter((x) => x.id === 'admin'),
  ];
  const publicSource = ({ file, attachments, ...item }) => item;
  const availableSources = () => sourceCatalog().filter(item => fs.existsSync(item.file));
  const sourceOptions = () => {
    const sources = new Map(sourceCatalog().map(item => [item.id, item]));
    return TUTORIAL_SOURCES.map(source => {
      const item = sources.get(source.id);
      return { ...source, ...(item ? publicSource(item) : {}), available: !!item && fs.existsSync(item.file) };
    });
  };
  function catalog(snapshot = definitions.read()) {
    const sources = new Map(availableSources().map(item => [item.id, item]));
    return snapshot.definition.courses.filter(course => course.enabled && sources.has(course.sourceId)).map(course => ({
      ...sources.get(course.sourceId), ...course,
      guided: course.modules.some(module => module.moduleId !== 'admin-reference'),
      reference: !course.modules.some(module => module.moduleId !== 'admin-reference'),
      definitionRevision: snapshot.revision,
    }));
  }
  const entryCourse = () => {
    const snapshot = definitions.read();
    return snapshot.definition.entryCourseId == null ? null : catalog(snapshot).find(item => item.id === snapshot.definition.entryCourseId) || null;
  };
  const definition = user => definitions.snapshot(user, sourceOptions());
  const saveDefinition = (user, value) => definitions.save(user, value, sourceOptions());

  // ── 계정별 '처음 접속' 기록(<dataDir>/tutorial-seen.json { 이름: { at, how } }) ──
  const seenFile = () => path.join(config.dataDir || path.join(config.root || process.cwd(), 'data'), 'tutorial-seen.json');
  function readSeen() { try { const v = JSON.parse(fs.readFileSync(seenFile(), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } }
  function markSeen(name, how) {
    const all = readSeen();
    if (all[name]) return false;
    all[name] = { at: new Date().toISOString(), how };
    const file = seenFile(); const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, `${JSON.stringify(all, null, 1)}\n`); fs.renameSync(tmp, file); } catch (e) { console.error('[체험] 처음 접속 기록을 쓰지 못했습니다:', e.message); }
    return true;
  }
  /** 이 계정에 따라 하기를 저절로 열까(처음 접속이고 autoStart) */
  const autoFor = (name) => canUse(name) && !!entryCourse() && conf().autoStart && !readSeen()[name];
  // 방문·시작 여부와 완료 여부는 다르다. 완료 기록은 토큰별로 서버에 보관한다.
  const stateFile = () => path.join(config.dataDir || path.join(root, 'data'), 'tutorial-state.json');
  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  }
  function completion(user, course = 'report') {
    const saved = readState()[tutorialOwnerKey(user)]?.completed?.[course];
    if (saved) return saved;
    // 완료 문서는 이미 저장됐지만 기록 파일 쓰기가 실패한 경우를 복구한다(같은 토큰의 완료본만).
    const meta = service.store.list().find(m => !m.tutorialSession && m.tutorialId === course && m.tutorialCompletedAt && ownsTutorial(user, m));
    return meta ? { at: meta.tutorialCompletedAt, docId: meta.id } : null;
  }
  // 토큰별 기록 이전에 만든 연습·완료 문서는 서버를 켤 때 지금 그 이름의 토큰 하나에 한 번만 묶는다.
  // 그 뒤에 토큰을 바꾸면 이름이 같아도 새 사용자로 보고 결과보고서부터 다시 안내한다.
  (function bindLegacyOwners() {
    try {
      const old = [...service.store.list(), ...(service.store.listSessions?.() || [])].filter(m => m.tutorial && !m.tutorialOwnerKey && (m.tutorialSession || m.tutorialCompletedAt));
      for (const m of old) {
        const same = (config.users || []).filter(u => u.name === m.createdBy);
        if (same.length !== 1) continue;
        m.tutorialOwnerKey = tutorialOwnerKey(same[0]);
        service.store.saveMeta(m);
      }
    } catch (e) { console.error('[튜토리얼] 이전 연습 문서를 토큰에 연결하지 못했습니다:', e.message); }
  })();
  const introFor = user => { const item = entryCourse(); return canUse(user?.name) && !!item && !completion(user, item.id); };
  function recordCompletion(user, meta) {
    const all = readState(); const key = tutorialOwnerKey(user);
    all[key] ||= { completed: {} };
    all[key].completed[meta.tutorialId] ||= { at: meta.tutorialCompletedAt, docId: meta.id };
    writeFileAtomic(stateFile(), `${JSON.stringify(all, null, 1)}\n`);
  }

  function visit(user) {
    if (!canUse(user?.name)) throw new ServiceError('NOT_TUTORIAL', '튜토리얼을 사용할 수 없는 계정입니다', 403);
    const all = readSeen();
    const previous = Object.hasOwn(all, user.name) ? all[user.name] : null;
    if (previous?.menuVisitedAt) return { visited: true, at: previous.menuVisitedAt };
    const at = new Date().toISOString();
    Object.defineProperty(all, user.name, { value: { ...previous, menuVisitedAt: at }, enumerable: true, configurable: true, writable: true });
    writeFileAtomic(seenFile(), `${JSON.stringify(all, null, 1)}\n`);
    return { visited: true, at };
  }

  function ownSession(user, id) {
    const m = service.store.readMeta(String(id || ''));
    if (!m || !ownsTutorial(user, m) || (!m.tutorialSession && !m.tutorialCompletedAt))
      throw new ServiceError('NO_TUTORIAL_SESSION', '진행 중인 튜토리얼을 찾을 수 없습니다', 404);
    return m;
  }

  /** GET /api/tutorial → 공통 항목과 본인의 진행 중인 연습 목록. 사본을 만들지 않는다. */
  function status(user) {
    if (!canUse(user?.name)) return { enabled: false };
    return { enabled: true, apiOnly: true, api: service.tutorialAiStatus(user.name), autoStart: autoFor(user.name), introRequired: introFor(user),
      items: catalog().map(({ file, attachments, ...item }, i) => ({ ...item, number: i + 1 })),
      sessions: service.store.listSessions().filter(m => ownsTutorial(user, m)).map(m => ({ docId: m.id, tutorialId: m.tutorialId, title: m.title, updatedAt: m.updatedAt, guided: !!m.tutorialGuided })) };
  }

  // 로그인 직후에만 호출한다. 목록·문서함을 그리기 전에 결과보고서 연습을 준비한다.
  async function entry(user) {
    if (!canUse(user?.name)) throw new ServiceError('NOT_TUTORIAL', '튜토리얼을 사용할 수 없는 계정입니다', 403);
    return service.store.withDoc(`tutorial-start:${tutorialOwnerKey(user)}`, async () => {
      if (!introFor(user)) return { skipped: true };
      const item = entryCourse();
      const existing = service.store.listSessions().filter(m => m.tutorialId === item.id && ownsTutorial(user, m))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      if (existing) return { docId: existing.id, temporary: true, guided: !!existing.tutorialGuided, reused: true };
      return startSession(user, { tutorialId: item.id });
    });
  }

  function progress(user, id) {
    const meta = ownSession(user, id);
    return tutorialProgress(meta);
  }
  async function saveProgress(user, id, value) {
    if (!Number.isInteger(value?.i) || value.i < 0 || value.i > 10000 || !value.ctx || typeof value.ctx !== 'object' || Array.isArray(value.ctx) || JSON.stringify(value).length > 32768)
      throw new ServiceError('BAD_TUTORIAL_PROGRESS', '안내 진행 정보가 올바르지 않습니다', 400);
    return service.store.withDoc(id, () => {
      const meta = ownSession(user, id);
      if (!meta.tutorialSession) throw new ServiceError('TUTORIAL_SAVED', '이미 완료한 튜토리얼입니다', 409);
      meta.tutorialOwnerKey ||= tutorialOwnerKey(user);
      return recovery.save(meta, value);
    });
  }

  async function restore(user, id, value) {
    return service._tx(id, async () => {
      const meta = ownSession(user, id);
      if (!meta.tutorialSession || meta.tutorialCompletedAt) throw new ServiceError('TUTORIAL_SAVED', '문서함에 저장한 완료본은 단계 복구 대상이 아닙니다', 409);
      return recovery.restore(meta, value, user);
    });
  }

  /**
   * POST /api/tutorial/start { tutorialId?, auto? } → { docId, temporary, guided }.
   * 항상 새 임시 문서. auto는 이전 클라이언트 호환용으로 계정마다 한 번만 시작한다.
   */
  async function start(user, options = {}) {
    return service.store.withDoc(`tutorial-start:${tutorialOwnerKey(user)}`, () => startSession(user, options));
  }

  async function startSession(user, { auto = false, tutorialId } = {}) {
    if (!canUse(user?.name)) throw new ServiceError('NOT_TUTORIAL', '체험을 쓸 수 없는 계정입니다', 403);
    if (auto && !autoFor(user.name)) return { skipped: true };
    const snapshot = definitions.read();
    const items = catalog(snapshot);
    const selectedId = tutorialId || snapshot.definition.entryCourseId || items[0]?.id;
    const item = items.find(x => x.id === selectedId);
    if (!item) throw new ServiceError('NO_TUTORIAL', '튜토리얼을 찾을 수 없습니다', 404);
    const tracking = conf().trackChanges || conf().trackChangesUsers.has(user.name);
    let bytes;
    try { bytes = await tutorialBytes(item); if (tracking) bytes = await withTrackChangeOn(bytes); } catch (e) { throw new ServiceError('NO_TUTORIAL_DOC', `튜토리얼 원본을 읽지 못했습니다: ${e.message}`, 500); }
    // 자동 시작이 다른 탭에서 먼저 완료됐을 수 있으므로 비동기 원본 읽기 뒤 다시 확인한다.
    if (auto && !autoFor(user.name)) return { skipped: true };
    // 튜토리얼 6(ownAi)은 관리자 공유 API 가 아니라 본인 연결로 처리한다 — tutorial 표시 대신 tutorialOwnAi
    const made = await service.createDocument({ fileName: `${item.title}.hwpx`, title: `${item.title} — ${user.name}`, bytes, user,
      location: { space: 'private', owner: user.name }, note: '튜토리얼 시작',
      extra: { ...(item.ownAi ? { tutorialOwnAi: true } : { tutorial: true }), tutorialSession: true, tutorialId: item.id,
        tutorialSourceId: item.sourceId, tutorialModules: structuredClone(item.modules), tutorialDefinitionRevision: snapshot.revision,
        tutorialTitle: item.title, tutorialDescription: item.description,
        tutorialGuided: item.guided, tutorialOwnerKey: tutorialOwnerKey(user), settings: { ...service._normSettings(null), editMode: 'realtime', aiApply: 'manual', ...(tracking ? { track: 'tracked', exportKind: 'tracked' } : {}) } } });
    try {
      if (item.sourceId === 'ai-requests') await seedTutorialExamples(service, user, made.id);
      for (const a of item.attachments || []) await service.addAttachment(made.id, { name: a.name, bytes: fs.readFileSync(a.file) }, user);
    } catch (e) { await service.deleteDocument(made.id, user); throw e; }
    markSeen(user.name, auto ? 'auto' : 'start');
    return { docId: made.id, created: true, temporary: true, tutorialId: item.id, guided: item.guided };
  }

  async function complete(user, id) {
    return service.store.withDoc(id, async () => {
      const m = ownSession(user, id);
      if (m.tutorialSession) {
        if ((m.requests || []).some(r => r.status === 'working' || (r.status === 'pending' && !r.example)))
          throw new ServiceError('TUTORIAL_BUSY', '진행 중인 AI 요청이 끝난 뒤 완료해 주세요', 409);
        m.tutorialCompletedAt ||= new Date().toISOString();
        m.space = 'private'; m.spaceOwner = user.name;
        delete m.folderId; delete m.access;
        if (!m.activity.some(a => a.type === 'tutorial')) m.activity.push({ at: m.tutorialCompletedAt, by: user.name, type: 'tutorial', detail: '튜토리얼 완료·개인 문서함에 저장' });
        service.store.saveMeta(m);
      }
      service.store.promoteTutorial(id);
      if (m.tutorialSession) { m.tutorialSession = false; service.store.saveMeta(m); }
      recordCompletion(user, m);
      service.hub.broadcast(id, { type: 'doc', action: 'updated', by: user.name });
      return { docId: id, saved: true, completedAt: m.tutorialCompletedAt };
    });
  }

  async function discard(user, id) {
    return service.store.withDoc(id, async () => {
      const m = ownSession(user, id);
      if (!m.tutorialSession) throw new ServiceError('TUTORIAL_SAVED', '완료한 튜토리얼은 문서함에서 관리해 주세요', 409);
      if ((m.requests || []).some(r => r.status === 'working')) throw new ServiceError('TUTORIAL_BUSY', 'AI 요청이 끝난 뒤 종료해 주세요', 409);
      await service.deleteDocument(id, user);
      return { discarded: true };
    });
  }

  return { conf, isUser, canUse, autoFor, introFor, visit, status, entry, progress, saveProgress, restore, start, complete, discard, definition, saveDefinition };
}
