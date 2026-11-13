import os from 'node:os';
import { buildConnectionInfo } from '../connections.js';

/** 로그인한 사용자에게 주소·가이드만 제공한다. 토큰·사용자 목록·키 파일 경로는 응답에 포함하지 않는다. */
export function installConnectionRoutes({ app, config, auth, wrap }, { networkInterfaces = os.networkInterfaces } = {}) {
  app.get('/api/connections', auth, wrap(async (req, res) => {
    let interfaces = {}; let unavailable = false;
    try { interfaces = networkInterfaces(); } catch { unavailable = true; }
    const info = buildConnectionInfo(config, { interfaces });
    if (unavailable) info.warnings.push({ code: 'INTERFACES_UNAVAILABLE', message: '서버 네트워크 인터페이스를 읽지 못했습니다. 바인딩과 설정 주소만 표시합니다.' });
    res.set('Cache-Control', 'no-store').json(info);
  }));
}
