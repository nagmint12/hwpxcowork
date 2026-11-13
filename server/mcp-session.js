import crypto from 'node:crypto';

/**
 * OpenAI 호스트는 한 작업에서도 HTTP MCP 연결을 다시 초기화할 수 있다.
 * 인증된 사용자 + 호스트 작업/주체 식별자로 업무 선점을 유지한다.
 * 이 헤더는 인증 수단이 아니다. 사용자 토큰 검증 뒤에만 호출한다.
 * 헤더가 없는 일반 MCP 클라이언트는 기존 연결별 선점을 유지한다.
 */
export function openAiClaimSession(headers, user) {
  const session = headers['x-openai-session'];
  const subject = headers['x-openai-subject'];
  if (typeof session !== 'string' || !session.trim() || session.length > 2048) return null;
  if (subject != null && (typeof subject !== 'string' || subject.length > 2048)) return null;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([user.name, user.token, session, subject || ''])).digest('hex');
  return `openai_${fingerprint.slice(0, 56)}`;
}
