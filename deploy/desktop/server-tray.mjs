// Keep the icon alive until the app has drained its own server and is quitting.
export function createServerTray({ Tray, Menu, icon, mode, showWindow, quit }) {
  const name = mode === 'shared' ? '공동 작업 서버' : '개인 서버';
  const labels = { starting: '시작 중', ready: '실행 중', stopping: '종료 중', error: '연결 오류' };
  const tray = new Tray(icon);
  let lastPhase;
  function update(phase) {
    if (phase === lastPhase) return;
    lastPhase = phase;
    const status = `${name} · ${labels[phase] || '상태 확인 중'}`;
    tray.setToolTip(`Hwpx Cowork · ${status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: '앱 열기', click: showWindow, enabled: phase !== 'stopping' },
      { label: '앱과 서버 종료', click: quit, enabled: phase !== 'stopping' },
    ]));
  }
  tray.on('click', showWindow);
  update('starting');
  return { update, destroy: () => tray.destroy() };
}
