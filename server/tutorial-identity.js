import { createHash } from 'node:crypto';

// 토큰 원문은 문서 메타·완료 기록에 남기지 않는다. 이름이 같은 두 토큰도 별도로 기록한다.
// 새 토큰은 새 사용자다 — 이름만 같아서는 연습·진행·완료 기록을 이어받지 않는다(2026-11-01).
export const tutorialOwnerKey = user => createHash('sha256').update(String(user.token || `legacy-name:${user.name}`)).digest('hex');
export const ownsTutorial = (user, meta) => !!user && meta.createdBy === user.name && meta.tutorialOwnerKey === tutorialOwnerKey(user);
