// 설치 도우미가 소유한 실행기만 IPC로 정상 종료한다(Windows에서 kill은 정리 절차 없이 끝나므로 사용하지 않는다).
import { main } from './ai-worker.mjs';
let ready = false;
let stopping = false;
function stop() {
  stopping = true;
  if (!ready) return;
  process.emit('SIGTERM');
  if (process.connected) process.disconnect();
}
process.on('message', message => { if (message === 'stop') stop(); });
await main();
ready = true;
if (stopping) stop();
if (process.exitCode && process.connected) process.disconnect();
