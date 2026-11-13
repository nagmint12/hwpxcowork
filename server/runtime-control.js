// 관리 실행기와 서버 사이의 재시작 약속. 문서 작업을 기다리는 일은 index.js 의 콜백이 맡는다.
import crypto from 'node:crypto';

const PREFIX = 'hwpx:';
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

export function createRuntimeControl({ onPrepareRestart, processRef = process, requestTimeoutMs = 10000 } = {}) {
  const supported = processRef.env.HWPX_COWORK_MANAGED === '1' && typeof processRef.send === 'function' && processRef.connected;
  const instanceId = crypto.randomUUID();
  let state = 'running';
  let reservation = null;
  let shutdown = null;
  let shutdownReason = null;

  const send = (message, callback) => {
    if (!processRef.connected || typeof processRef.send !== 'function') { callback?.(new Error('IPC disconnected')); return false; }
    try { return processRef.send(message, callback); } catch (error) { callback?.(error); return false; }
  };
  function release(ticket) {
    if (reservation !== ticket || state === 'draining' || state === 'stopping') return;
    clearTimeout(ticket.timer);
    reservation = null;
    state = 'running';
    send({ type: `${PREFIX}restart-cancel`, id: ticket.id });
  }
  function exit(code) {
    if (processRef.connected) send({ type: `${PREFIX}drained`, id: reservation?.id, reason: shutdownReason || 'stop' }, () => processRef.exit(code));
    else processRef.exit(code);
  }
  function prepare(reason) {
    if (shutdown) return shutdown;
    shutdownReason = reason;
    send({ type: `${PREFIX}stopping`, reason });
    state = reason === 'restart' ? 'draining' : 'stopping';
    shutdown = Promise.resolve().then(() => onPrepareRestart?.({ reason, restartId: reservation?.id })).then(() => exit(0), (error) => {
      console.error('[hwpx-cowork] 서버 종료 준비에 실패했습니다:', error?.message || String(error));
      exit(1);
    });
    return shutdown;
  }
  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === `${PREFIX}ping`) { send({ type: `${PREFIX}heartbeat` }); return; }
    if (message.type === `${PREFIX}stop`) { void prepare('stop'); return; }
    if (message.type !== `${PREFIX}restart-result` || message.id !== reservation?.id || state !== 'reserving') return;
    const ticket = reservation;
    clearTimeout(ticket.timer);
    if (!message.ok) {
      reservation = null; state = 'running';
      ticket.reject(fail(message.code === 'RESTART_TARGET_UNAVAILABLE' ? message.code : 'RESTART_UNAVAILABLE', message.code === 'RESTART_TARGET_UNAVAILABLE' ? '새 서버 주소나 포트를 사용할 수 없습니다. 설정을 확인해 주세요.' : '관리 실행기가 재시작을 준비하지 못했습니다.', message.code === 'RESTART_TARGET_UNAVAILABLE' ? 409 : 503));
      return;
    }
    state = 'reserved';
    // 응답이 중단되어 commit/cancel 이 호출되지 않아도 영구히 잠기지 않는다.
    ticket.timer = setTimeout(() => release(ticket), requestTimeoutMs);
    ticket.timer.unref?.();
    ticket.resolve({
      restartId: ticket.id,
      commit() {
        if (reservation !== ticket || state !== 'reserved') return;
        clearTimeout(ticket.timer);
        send({ type: `${PREFIX}restart-commit`, id: ticket.id });
        void prepare('restart');
      },
      cancel() { release(ticket); },
    });
  }
  if (supported) processRef.on('message', onMessage);
  // 관리 실행기를 강제 종료해도 자신이 띄운 서버만 종료된다.
  if (supported) processRef.once('disconnect', () => { void prepare('disconnect'); });
  processRef.once('SIGINT', () => { void prepare('stop'); });
  processRef.once('SIGTERM', () => { void prepare('stop'); });
  if (supported && typeof processRef.pid === 'number') {
    const heartbeat = setInterval(() => send({ type: `${PREFIX}heartbeat` }), 10000);
    heartbeat.unref();
    processRef.once('disconnect', () => clearInterval(heartbeat));
  }

  return {
    supported, instanceId,
    get busy() { return state !== 'running'; },
    get state() { return state; },
    status() { return { supported, busy: state !== 'running', state, instanceId }; },
    markReady(info) { if (supported) send({ type: `${PREFIX}ready`, ...info }); },
    requestStop() {
      if (!supported) throw fail('STOP_UNSUPPORTED', '관리 실행기로 시작한 서버만 원격 종료할 수 있습니다.');
      if (state !== 'running') throw fail('RESTART_BUSY', '이미 재시작이나 종료를 준비하고 있습니다.', 409);
      state = 'stop-reserved';
      let pending = true;
      return {
        stopId: crypto.randomUUID(),
        cancel() { if (pending) { pending = false; state = 'running'; } },
        commit() { if (pending) { pending = false; void prepare('stop'); } },
      };
    },
    requestRestart() {
      if (!supported) return Promise.reject(fail('RESTART_UNSUPPORTED', '이 실행 방식에서는 웹 재시작을 사용할 수 없습니다. 시작 파일이나 npm start로 서버를 실행해 주세요.'));
      if (state !== 'running') return Promise.reject(fail('RESTART_BUSY', '이미 재시작이나 종료를 준비하고 있습니다.', 409));
      state = 'reserving';
      return new Promise((resolve, reject) => {
        const ticket = { id: crypto.randomUUID(), resolve, reject, timer: null };
        reservation = ticket;
        ticket.timer = setTimeout(() => {
          if (reservation !== ticket || state !== 'reserving') return;
          release(ticket);
          reject(fail('RESTART_UNAVAILABLE', '관리 실행기가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.'));
        }, requestTimeoutMs);
        ticket.timer.unref?.();
        send({ type: `${PREFIX}restart-reserve`, id: ticket.id }, (error) => {
          if (!error || reservation !== ticket || state !== 'reserving') return;
          release(ticket);
          reject(fail('RESTART_UNAVAILABLE', '관리 실행기와 연결이 끊겼습니다.'));
        });
      });
    },
  };
}
