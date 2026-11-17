// Current CLI isolation flags are required by the server; older CLI versions
// cannot replace them. Monterey keeps editing/server features without local AI.
export function desktopAiSupport(platform, darwinRelease = '') {
  const major = Number.parseInt(darwinRelease, 10);
  const available = platform !== 'darwin' || (Number.isFinite(major) && major >= 22);
  return { available, minimumMacos: '13.0', message: available ? '' : 'macOS 12에서는 문서 편집과 개인 서버를 사용할 수 있습니다. 현재 구독 AI 연결은 macOS 13 이상에서 지원합니다.' };
}
export function desktopCliPackages() {
  return {
    codex: '@openai/codex@0.169.0',
    'claude-code': '@anthropic-ai/claude-code@2.1.323',
  };
}
