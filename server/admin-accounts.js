// 관리자: 사용자(이름·역할·접속 토큰) 관리와 AI 응답 크기 한도.
// config 파일을 판(revision) 검사 뒤 원자적으로 고치고(admin-settings.js 와 같은 판), 실행 중인 설정에도 바로 반영한다(재시작 없음).
// 토큰은 관리자가 직접 정한다(시험용이면 짧아도 됨). 비워 두면 무작위로 만든다. 만들거나 바꿀 때 한 번만 돌려주고, 목록에는 끝 4자리만 보인다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ServiceError } from './service.js';
import { readConfigFile, checkConfigRevision, writeConfigFile } from './admin-settings.js';
import { LIMIT_DEFAULTS, LIMIT_RANGE } from './config.js';

export const ROLES = ['admin', 'editor', 'viewer'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const newToken = () => crypto.randomBytes(24).toString('base64url');
const tokenHint = (t) => (t ? `…${String(t).slice(-4)}` : '(없음)');
// 직접 정하는 토큰: HTTP 머리글(Authorization: Bearer)·주소(/mcp/t/<토큰>)·환경 변수에 그대로 쓰이므로 영문·숫자와 일부 기호만, 4~200자
export const TOKEN_RE = /^[A-Za-z0-9._~!@$*+=:,-]{4,200}$/;
// 이름: 제어·줄 구분·양방향 제어·BOM 글자를 빼고 공백을 줄인다(작성자 표기·요청 주인 비교에 그대로 쓰인다)
const badCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
const cleanUserName = (s) => [...String(s ?? '')].filter((ch) => !badCp(ch.codePointAt(0))).join('').replace(/\s+/g, ' ').trim();
const fail = (code, message, status = 400) => new ServiceError(code, message, status);

/** 응답 크기 안내(관리자 화면에 그대로 보인다) — 2026-10-27 확인 값 */
export const LIMIT_GUIDE = Object.freeze({
  model: 'Claude Opus 5.5: 대화(컨텍스트) 1M 토큰, 한 번 출력 최대 128K 토큰 — 대화 전체로는 넉넉하다.',
  client: 'Claude Code 는 MCP 도구 결과 하나가 2만 5천 토큰(MAX_MCP_OUTPUT_TOKENS 기본)을 넘으면 대화에 싣지 않고 파일로 돌린다(1만 토큰부터 경고). 환경 변수로 늘릴 수 있다.',
  chars: '한글이 섞인 JSON 은 대략 2자 = 1토큰(이 서버의 에이전트 기록에서 1.8~2.9자/토큰). 2만 5천 토큰 ≈ 4만 5천~5만 자.',
  recommend: '기본 4만 자(약 2만 토큰)는 Claude Code 한도 안에 여유를 둔 값이다. ChatGPT 등 다른 클라이언트의 도구 결과 한도가 더 작으면 낮춘다.',
});

// serverAiStatus: () => { enabled, mock, restricted } — 공용 서버 AI 상태(service.serverAiStatus). 없으면 목록에 싣지 않는다
export function createAdminAccounts({ config, fsImpl = fs, serverAiStatus = null }) {
  const file = config.configFile;
  const read = () => readConfigFile(file, fsImpl);
  const usersOf = (raw) => (Array.isArray(raw.users) ? raw.users.filter(object) : []);
  // 실행 중 설정에 반영: config.users 배열 자체를 고친다(userByToken 이 같은 배열을 본다 — 지운 토큰은 다음 요청부터 401)
  const applyUsers = (raw) => { config.users.splice(0, config.users.length, ...usersOf(raw).map((u) => ({ role: 'editor', ...u }))); };
  const admins = (list) => list.filter((u) => (u.role || 'editor') === 'admin').length;
  const find = (list, name) => {
    const i = list.findIndex((u) => u.name === name);
    if (i < 0) throw fail('NO_USER', `사용자가 없습니다: ${name}`, 404);
    return i;
  };
  const role = (v) => {
    if (!ROLES.includes(v)) throw fail('BAD_ROLE', `역할은 ${ROLES.join('·')} 중 하나입니다`);
    return v;
  };

  function users(current = read(), me = null) {
    return {
      // serverAi: 공용 서버 AI(서버의 API 키) 사용 허용 — 2026-11-10, 관리자도 따로 켠다
      users: usersOf(current.raw).map((u) => ({ name: u.name, role: u.role || 'editor', tokenHint: tokenHint(u.token), serverAi: u.serverAi === true, me: !!me && u.name === me })),
      roles: ROLES, revision: current.revision,
      ...(serverAiStatus ? { serverAi: serverAiStatus() } : {}),
    };
  }

  /** 사용자 목록을 고친다: change(list) 가 새 목록을 돌려준다(던지면 저장하지 않음) */
  function writeUsers(revision, change, me) {
    const current = read();
    checkConfigRevision(revision, current);
    const list = change(usersOf(current.raw).map((u) => ({ ...u })));
    if (!admins(list)) throw fail('LAST_ADMIN', '관리자가 한 명은 있어야 합니다', 409);
    const written = writeConfigFile(file, { ...current.raw, users: list }, revision, fsImpl);
    applyUsers(written.raw);
    return users(written, me);
  }

  /** 직접 정한 토큰(형식·중복 검사) 또는 비었으면 무작위 */
  const chooseToken = (given, list, owner) => {
    if (given === undefined || given === null || given === '') return newToken();
    if (typeof given !== 'string' || !TOKEN_RE.test(given)) throw fail('BAD_TOKEN', '토큰은 4~200자의 영문·숫자와 . _ ~ ! @ $ * + = : , - 만 쓸 수 있습니다');
    if (list.some((u) => u.name !== owner && u.token === given)) throw fail('TOKEN_TAKEN', '다른 사용자가 쓰는 토큰입니다', 409);
    return given;
  };

  function addUser({ name, role: r = 'editor', token: given } = {}, revision, me) {
    const clean = cleanUserName(name);
    if (!clean || [...clean].length > 40) throw fail('BAD_NAME', '이름은 1~40자로 입력해 주세요');
    let token;
    const out = writeUsers(revision, (list) => {
      if (list.some((u) => u.name === clean)) throw fail('NAME_TAKEN', `이미 있는 이름입니다: ${clean}`, 409);
      token = chooseToken(given, list, clean);
      return [...list, { name: clean, token, role: role(r) }];
    }, me);
    return { ...out, created: { name: clean, role: r, token } };
  }

  /** 역할·서버 AI 허용을 고친다(준 것만). serverAi 는 true 면 적고 false 면 항목을 지운다 */
  function updateUser(name, { role: r, serverAi } = {}, revision, me) {
    if (r === undefined && serverAi === undefined) throw fail('NO_CHANGE', '바꿀 항목(role·serverAi)이 없습니다');
    if (serverAi !== undefined && typeof serverAi !== 'boolean') throw fail('BAD_SERVER_AI', 'serverAi 는 true 또는 false 입니다');
    return writeUsers(revision, (list) => {
      const u = list[find(list, name)];
      if (r !== undefined) u.role = role(r);
      if (serverAi === true) u.serverAi = true; else if (serverAi === false) delete u.serverAi;
      return list;
    }, me);
  }

  function resetToken(name, revision, me, given) {
    let token;
    const out = writeUsers(revision, (list) => { const i = find(list, name); token = chooseToken(given, list, name); list[i].token = token; return list; }, me);
    return { ...out, issued: { name, token } };
  }

  function deleteUser(name, revision, me) {
    if (name === me) throw fail('SELF_DELETE', '지금 로그인한 자기 계정은 지울 수 없습니다', 409);
    return writeUsers(revision, (list) => { list.splice(find(list, name), 1); return list; }, me);
  }

  function limits(current = read()) {
    const saved = object(current.raw.limits) ? current.raw.limits : {};
    return {
      limits: { mcpResponseChars: config.limits?.mcpResponseChars ?? LIMIT_DEFAULTS.mcpResponseChars },
      saved: { mcpResponseChars: saved.mcpResponseChars ?? null },
      defaults: LIMIT_DEFAULTS, range: LIMIT_RANGE, guide: LIMIT_GUIDE, revision: current.revision,
    };
  }

  function saveLimits(next, revision) {
    if (!object(next) || !Object.keys(next).length || Object.keys(next).some((k) => !Object.hasOwn(LIMIT_DEFAULTS, k))) throw fail('INVALID_LIMITS', '바꿀 수 있는 항목은 mcpResponseChars 뿐입니다');
    const [min, max] = LIMIT_RANGE.mcpResponseChars;
    const v = Number(next.mcpResponseChars);
    if (!Number.isInteger(v) || v < min || v > max) throw fail('INVALID_LIMITS', `응답 글자 수는 ${min.toLocaleString()}~${max.toLocaleString()} 사이의 정수입니다`);
    const current = read();
    checkConfigRevision(revision, current);
    const written = writeConfigFile(file, { ...current.raw, limits: { ...(object(current.raw.limits) ? current.raw.limits : {}), mcpResponseChars: v } }, revision, fsImpl);
    config.limits = { ...(config.limits || {}), mcpResponseChars: v };
    return limits(written);
  }

  /** 서버 AI 가 쓸 키: useKeyOf = 관리자 이름(그 사람의 '내 AI 키') 또는 null(config.ai 의 키). 바로 적용 */
  function setServerAiKey(useKeyOf, revision, me) {
    const current = read();
    checkConfigRevision(revision, current);
    const ai = object(current.raw.ai) ? { ...current.raw.ai } : {};
    if (useKeyOf === null || useKeyOf === '') delete ai.useKeyOf;
    else {
      if (typeof useKeyOf !== 'string' || !usersOf(current.raw).some((u) => u.name === useKeyOf && u.role === 'admin')) throw fail('BAD_KEY_OWNER', '서버 AI 키는 관리자 계정의 "내 AI 키"만 쓸 수 있습니다');
      ai.useKeyOf = useKeyOf;
    }
    const written = writeConfigFile(file, { ...current.raw, ai }, revision, fsImpl);
    if (ai.useKeyOf) config.ai.useKeyOf = ai.useKeyOf; else delete config.ai.useKeyOf;
    return users(written, me);
  }

  return { users, addUser, updateUser, resetToken, deleteUser, limits, saveLimits, setServerAiKey };
}
