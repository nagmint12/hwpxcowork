import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { ServiceError } from './service.js';
import { readJson } from './recovery-state.js';

const FIELDS = ['host', 'port', 'publicUrl'];
const ENV = { host: 'HWPX_COWORK_HOST', port: 'HWPX_COWORK_PORT', publicUrl: 'HWPX_COWORK_PUBLIC_URL' };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const revisionOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = (field, message) => new ServiceError('INVALID_SERVER_SETTINGS', message, 400, { field });

/** 바인딩 주소는 DNS 이름 대신 숫자 IP와 localhost만 받는다. */
export function validateServerSetting(field, value) {
  if (field === 'host') {
    if (typeof value !== 'string') throw invalid(field, '듣는 주소는 IP 주소 또는 localhost로 입력해 주세요.');
    const host = value.trim().toLowerCase();
    if (host !== 'localhost' && (!isIP(host) || host.includes('%'))) throw invalid(field, '듣는 주소는 IP 주소 또는 localhost로 입력해 주세요.');
    return host;
  }
  if (field === 'port') {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^\d+$/.test(value.trim()))) throw invalid(field, '포트는 1부터 65535까지의 정수로 입력해 주세요.');
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid(field, '포트는 1부터 65535까지의 정수로 입력해 주세요.');
    return port;
  }
  if (field === 'publicUrl') {
    if (typeof value !== 'string') throw invalid(field, '공유 주소는 비워 두거나 http(s) 주소를 입력해 주세요.');
    const text = value.trim();
    if (!text) return '';
    let url;
    try { url = new URL(text); } catch { /* 아래에서 같은 안내를 반환한다. */ }
    if (text.length > 2048 || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(text) || !url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.port && Number(url.port) < 1)) {
      throw invalid(field, '공유 주소는 경로·토큰·계정 정보 없이 http(s)://호스트:포트 형식으로 입력해 주세요.');
    }
    return url.origin;
  }
  throw invalid(field, '변경할 수 없는 설정 항목입니다.');
}

// 이전 설정에 토큰 쿼리나 경로가 있더라도 관리 API에 그대로 싣지 않는다.
function safeSetting(field, value, invalidFields) {
  if (field === 'port' && value === 0) return 0; // 시험·외부 실행기의 자동 포트는 읽기만 허용한다.
  try { return validateServerSetting(field, value); } catch {
    invalidFields.push(field);
    if (field === 'publicUrl') {
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) return url.origin; } catch { /* 안전한 빈 값 */ }
    }
    return field === 'port' ? null : '';
  }
}

function rawSettings(raw) {
  return { host: raw.host || '127.0.0.1', port: raw.port ?? 8787, publicUrl: raw.publicUrl || '' };
}

function normalizedSettings(settings) {
  return Object.fromEntries(FIELDS.map((field) => {
    try { return [field, validateServerSetting(field, settings[field])]; }
    catch { return [field, field === 'publicUrl' && typeof settings[field] === 'string' ? settings[field].replace(/\/$/, '') : settings[field]]; }
  }));
}

/** config 파일 읽기 → { bytes, raw, revision(sha256) }. 사용자 관리·응답 크기 설정(admin-accounts.js)도 같은 파일·같은 판 검사를 쓴다 */
export function readConfigFile(file, fsImpl = fs) {
  try {
    const bytes = fsImpl.readFileSync(file);
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (!object(raw)) throw new Error('object required');
    return { bytes, raw, revision: revisionOf(bytes) };
  } catch { throw new ServiceError('CONFIG_UNAVAILABLE', '서버 설정 파일을 읽지 못했습니다. 서버에서 파일 상태를 확인해 주세요.', 503); }
}

export function checkConfigRevision(revision, current) {
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) throw new ServiceError('REVISION_REQUIRED', '설정을 다시 불러온 뒤 저장해 주세요.', 400);
  if (revision !== current.revision) throw new ServiceError('CONFIG_CHANGED', '다른 곳에서 설정이 바뀌었습니다. 다시 불러온 뒤 확인해 주세요.', 409);
}

/** nextRaw 를 같은 폴더에 완전히 쓴 뒤 교체한다(쓰는 사이 파일이 바뀌었으면 CONFIG_CHANGED). 실패하면 기존 파일과 그 안의 토큰은 그대로 남는다 → { raw, bytes, revision } */
export function writeConfigFile(file, nextRaw, revision, fsImpl = fs) {
  const bytes = Buffer.from(`${JSON.stringify(nextRaw, null, 2)}\n`, 'utf8');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fsImpl.openSync(temporary, 'wx', fsImpl.statSync(file).mode & 0o777);
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = undefined;
    checkConfigRevision(revision, readConfigFile(file, fsImpl));
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('CONFIG_SAVE_FAILED', '설정을 저장하지 못했습니다. 서버의 파일 권한과 디스크 상태를 확인해 주세요.', 503);
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* 열린 임시 파일 정리 */ } }
    try { fsImpl.unlinkSync(temporary); } catch { /* 교체했거나 생성하지 않은 경우 */ }
  }
  return { raw: nextRaw, bytes, revision: revisionOf(bytes) };
}

/** 실행 중인 설정과 파일 원본을 분리한다. 파일에는 허용한 세 항목만 덮어쓴다. */
export function createAdminSettings({ config, env = process.env, restartControl, instanceId = '', fsImpl = fs }) {
  const file = config.configFile;
  const environment = Object.fromEntries(FIELDS.filter((field) => !!env[ENV[field]]).map((field) => [field, String(env[ENV[field]])]));
  const effective = (saved) => normalizedSettings({ ...saved, ...environment, port: Number(environment.port || saved.port) });
  // listen(0)이 실제 포트로 config.port를 바꾸기 전에 기록한다.
  const startup = normalizedSettings({ host: config.host, port: config.port, publicUrl: config.publicUrlAuto ? '' : config.publicUrl });
  const overrides = Object.fromEntries(Object.keys(environment).map((field) => [field, { locked: true, source: ENV[field], reason: '환경 변수로 고정되어 있습니다. 실행 환경에서 변경한 뒤 다시 시작해 주세요.' }]));

  const read = () => readConfigFile(file, fsImpl);
  const checkRevision = checkConfigRevision;

  function restartStatus() {
    const status = typeof restartControl?.status === 'function' ? restartControl.status() : restartControl;
    return { supported: status?.supported === true && typeof restartControl?.requestRestart === 'function', busy: status?.busy === true };
  }

  function snapshot(current = read()) {
    const saved = rawSettings(current.raw);
    const invalidFields = { saved: [], running: [] };
    const supervisor = config.dataDir ? readJson(path.join(config.dataDir, 'runtime/server-state.json')) : null;
    return {
      ...(supervisor ? { supervision: { phase: supervisor.phase, enabled: supervisor.enabled, restarts: supervisor.restarts, lastExit: supervisor.lastExit, nextRetryAt: supervisor.nextRetryAt, heartbeatAt: supervisor.heartbeatAt } } : {}),
      running: {
        ...Object.fromEntries(FIELDS.map((field) => [field, safeSetting(field, config[field], invalidFields.running)])),
        instanceId,
      },
      saved: Object.fromEntries(FIELDS.map((field) => [field, safeSetting(field, saved[field], invalidFields.saved)])),
      revision: current.revision,
      restartRequired: JSON.stringify(effective(saved)) !== JSON.stringify(startup),
      overrides,
      restart: restartStatus(),
      invalidFields,
    };
  }

  function save(settings, revision) {
    if (restartStatus().busy) throw new ServiceError('RESTART_BUSY', '서버를 다시 시작하고 있습니다. 잠시 기다려 주세요.', 409);
    if (!object(settings) || !Object.keys(settings).length || Object.keys(settings).some((key) => !FIELDS.includes(key))) throw new ServiceError('INVALID_SERVER_SETTINGS', '듣는 주소·포트·공유 주소만 변경할 수 있습니다.', 400);
    const current = read();
    checkRevision(revision, current);
    const saved = rawSettings(current.raw);
    const changes = Object.fromEntries(Object.entries(settings).map(([field, value]) => [field, validateServerSetting(field, value)]));
    for (const [field, value] of Object.entries(changes)) {
      if (!Object.hasOwn(environment, field)) continue;
      const previous = normalizedSettings(saved)[field];
      const imposed = effective(saved)[field];
      if (value !== previous && value !== imposed) throw new ServiceError('ENV_OVERRIDE', '환경 변수로 고정된 항목은 웹에서 변경할 수 없습니다.', 409, { field });
    }
    return snapshot(writeConfigFile(file, { ...current.raw, ...changes }, revision, fsImpl));
  }

  async function prepareRestart(revision) {
    const current = read();
    checkRevision(revision, current);
    const status = restartStatus();
    if (!status.supported) throw new ServiceError('RESTART_UNSUPPORTED', '이 실행 방식에서는 웹 재시작을 지원하지 않습니다. 서버를 다시 실행해 주세요.', 503);
    if (status.busy) throw new ServiceError('RESTART_BUSY', '서버를 다시 시작하고 있습니다. 잠시 기다려 주세요.', 409);
    let ticket;
    try { ticket = await restartControl.requestRestart(); }
    catch (error) {
      const allowed = {
        RESTART_BUSY: [409, '서버를 다시 시작하고 있습니다. 잠시 기다려 주세요.'],
        RESTART_UNSUPPORTED: [503, '이 실행 방식에서는 웹 재시작을 지원하지 않습니다.'],
        RESTART_TARGET_UNAVAILABLE: [409, '저장한 주소나 포트로 서버를 시작할 수 없습니다. 설정과 포트 사용 상태를 확인해 주세요.'],
        RESTART_UNAVAILABLE: [503, '재시작 준비에 실패했습니다. 현재 서버 상태를 확인해 주세요.'],
      };
      const [statusCode, message] = allowed[error?.code] || allowed.RESTART_UNAVAILABLE;
      throw new ServiceError(Object.hasOwn(allowed, error?.code) ? error.code : 'RESTART_UNAVAILABLE', message, statusCode);
    }
    // 실행기의 비동기 사전 검사 동안 외부 편집기가 파일을 바꾼 경우 예약을 취소한다.
    try { checkRevision(revision, read()); }
    catch (error) { ticket.cancel?.(); throw error; }
    return ticket;
  }

  function prepareStop(revision) {
    checkRevision(revision, read());
    if (typeof restartControl?.requestStop !== 'function') throw new ServiceError('STOP_UNSUPPORTED', '이 실행 방식에서는 원격 종료를 지원하지 않습니다.', 503);
    try { return restartControl.requestStop(); }
    catch (error) { throw new ServiceError(error.code === 'RESTART_BUSY' ? 'RESTART_BUSY' : 'STOP_UNSUPPORTED', error.code === 'RESTART_BUSY' ? '재시작이나 종료를 준비하고 있습니다.' : '관리 실행기로 시작한 서버만 원격 종료할 수 있습니다.', error.code === 'RESTART_BUSY' ? 409 : 503); }
  }
  return { snapshot, save, prepareRestart, prepareStop };
}
