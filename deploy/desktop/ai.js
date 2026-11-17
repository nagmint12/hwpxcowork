const api = window.hwpxDesktop;
const button = document.querySelector('#connect');
function render(state) {
  document.querySelector('#status').textContent = state.ai === 'none' ? 'AI 없이 문서 편집을 사용하고 있습니다.' : state.message;
  document.querySelector('#dot').className = state.aiPhase;
  const busy = ['preparing', 'login'].includes(state.aiPhase);
  button.disabled = busy;
  document.querySelectorAll('input').forEach(input => { input.disabled = busy; if (state.ai !== 'none') input.checked = input.value === state.ai; });
  button.textContent = state.aiPhase === 'connected' ? '다시 연결' : busy ? '연결 중…' : '로그인하고 연결';
}
api.onState(render);
api.action('state').then(render);
button.addEventListener('click', async () => { const r = await api.action('connect', document.querySelector('input:checked').value); if (!r.ok) { document.querySelector('#status').textContent = r.message; button.disabled = false; } });
document.querySelector('#disconnect').addEventListener('click', () => api.action('disconnect'));
document.querySelector('#close').addEventListener('click', () => api.action('close'));
