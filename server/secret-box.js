// 사용자별 비밀 값(두레이 API 토큰 등)을 서버 디스크에 암호문으로만 두는 작은 상자(2026-11-17).
//   열쇠: config 파일 옆 .hwpx-cowork-secret — 개인 AI 키(server/personal-ai.js)와 같은 파일·같은 꼴(32바이트 base64).
//   데이터 폴더만 복사·백업해서는 풀리지 않는다. 열쇠 파일을 잃으면 각자 다시 넣는다.
//   AES-256-GCM, AAD = '<용도>:<사용자 이름>' — 다른 사람 칸·다른 용도로 옮긴 암호문은 풀리지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ServiceError } from './service.js';

export function secretKeyPath(config, secretFile = null) {
  return secretFile || path.join(path.dirname(config.configFile || path.join(config.root || process.cwd(), 'config.json')), '.hwpx-cowork-secret');
}

export function createSecretBox({ config, secretFile = null, purpose }) {
  if (!/^[a-z0-9-]{3,40}$/.test(purpose || '')) throw new Error('secret-box purpose');
  const keyPath = secretKeyPath(config, secretFile);
  let master = null;
  const broken = (message) => new ServiceError('SECRET_KEY', message, 500);
  function masterKey() {
    if (master) return master;
    for (let attempt = 0; attempt < 2 && !master; attempt++) {
      try {
        const bytes = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
        if (bytes.length !== 32) throw broken('서버 암호 열쇠 파일이 손상되었습니다(관리자에게 알리세요)');
        master = bytes;
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        if (e.code !== 'ENOENT') throw broken('서버 암호 열쇠 파일을 읽지 못했습니다(관리자에게 알리세요)');
        // 처음: 새 열쇠. 이미 있는 파일은 덮어쓰지 않는다(wx) — 동시에 만들었으면 다시 읽는다
        try { fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' }); }
        catch (w) { if (w.code !== 'EEXIST') throw broken('서버 암호 열쇠 파일을 만들지 못했습니다(관리자에게 알리세요)'); }
      }
    }
    return master;
  }
  const aad = (name) => Buffer.from(`hwpx-${purpose}:${name}`, 'utf8');
  return {
    seal(text, name) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv); cipher.setAAD(aad(name));
      const box = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return { iv: iv.toString('base64'), data: box.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    /** 풀지 못하면(열쇠가 바뀜·다른 칸) null */
    unseal(box, name) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(box.iv, 'base64'));
        decipher.setAAD(aad(name)); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        return null;
      }
    },
  };
}
