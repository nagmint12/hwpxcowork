const control = window.hwpxServer;
const byId = id => document.getElementById(id);
const labels = { stopped: '중지됨', starting: '시작 중', ready: '실행 중', stopping: '저장 후 중지 중', 'stop-error': '중지 확인 필요', error: '오류' };
function render(state) {
  const ready = state.phase === 'ready';
  byId('phase').textContent = labels[state.phase] || '상태 확인 중';
  byId('detail').textContent = { stopped: '시작을 누르면 앱에 포함된 Node로 문서 서비스를 엽니다.', starting: '문서함을 준비하고 있습니다.',
    ready: '이 앱에서 문서함을 열고 참여자와 AI 연결을 관리할 수 있습니다.', stopping: '진행 중인 저장 작업을 마치고 있습니다.', 'stop-error': state.message, error: state.message }[state.phase];
  byId('address').textContent = ready ? state.address : '서버 시작 후 표시';
  byId('shareState').textContent = state.shareUrl || (state.share === 'opening' ? '여는 중' : '닫힘');
  byId('start').hidden = ready || ['stopping', 'stop-error'].includes(state.phase);
  byId('start').disabled = !['stopped', 'error'].includes(state.phase);
  byId('open').hidden = !ready; byId('stop').hidden = !ready && state.phase !== 'stop-error';
  byId('stop').textContent = state.phase === 'stop-error' ? '중지 다시 확인' : '서버 중지';
  byId('share').disabled = !ready || !state.shareSupported || state.share === 'opening';
  byId('share').textContent = state.share === 'on' ? '외부 접속 닫기' : '외부 접속 열기';
  byId('copy').hidden = state.share !== 'on';
  byId('ai').disabled = !state.aiSupported;
}
async function action(name) {
  byId('error').textContent = '';
  try { const reply = await control.action(name); if (reply.error) byId('error').textContent = reply.error; render(reply.state); }
  catch (error) { byId('error').textContent = error.message; }
}
for (const id of ['start', 'open', 'stop', 'share', 'copy', 'ai']) byId(id).addEventListener('click', () => action(id));
control.onState(render);
void action('state');
