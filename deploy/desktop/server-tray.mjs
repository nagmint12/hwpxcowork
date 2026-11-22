// Keep the icon alive until the app has drained its own server and is quitting.
export function createServerTray({ Tray, Menu, icon, mode, portless = false, showWindow, quit }) {
  const name = mode === 'shared' ? '공동 작업 서버' : portless ? '개인 문서함' : '개인 서버';
  const labels = { starting: '시작 중', ready: '실행 중', stopping: '종료 중', 'stop-error': '중지 확인 필요', stopped: '중지됨', error: '연결 오류' };
  const tray = new Tray(icon);
  let lastPhase;
  function update(phase) {
    if (phase === lastPhase) return;
    lastPhase = phase;
    const status = `${name} · ${labels[phase] || '상태 확인 중'}`;
    tray.setToolTip(`HWPX Cowork · ${status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: '앱 열기', click: showWindow, enabled: phase !== 'stopping' },
      { label: portless ? '앱 종료' : '앱과 서버 종료', click: quit, enabled: phase !== 'stopping' },
    ]));
  }
  tray.on('click', showWindow);
  update('starting');
  return { update, destroy: () => tray.destroy() };
}
