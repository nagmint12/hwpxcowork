// 제공자가 보고한 토큰과 실행기가 확인한 횟수만 저장한다. 불명확한 native 작업은 별도 표시한다.
export const EDIT_USAGE_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'modelCalls', 'toolCalls', 'imageBlocks', 'imageBytes', 'imageInputTokens', 'unknownModelTasks']);
export function validEditUsage(usage) {
  return usage != null && typeof usage === 'object' && !Array.isArray(usage)
    && Object.entries(usage).every(([key, value]) => key === 'modelCallsUnknown' ? typeof value === 'boolean'
      : EDIT_USAGE_FIELDS.includes(key) && Number.isSafeInteger(value) && value >= 0 && value <= 1e12);
}
