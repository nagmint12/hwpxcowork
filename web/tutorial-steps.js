// 기존 코스 ID 호출의 호환 진입점. 기능 구현은 tutorial-modules/에 있습니다.
import { buildEditorBasics } from './tutorial-modules/editor-basics.js';
import { buildClipboard } from './tutorial-modules/clipboard.js';
import { buildAiReview } from './tutorial-modules/ai-review.js';
import { buildAiConnections } from './tutorial-modules/ai-connections.js';
import { buildAdvanced } from './tutorial-modules/advanced.js';
import { buildReportFlow } from './tutorial-modules/report-flow.js';
import { stepHelpers } from './tutorial-modules/common.js';

const builders = { report: buildReportFlow, overview: buildEditorBasics, clipboard: buildClipboard, 'ai-requests': buildAiReview, 'ai-connect': buildAiConnections, 'ai-advanced': buildAdvanced };
export function buildTutorialSteps(id, env) {
  if (builders[id]) return builders[id](env);
  const { intro, finish } = stepHelpers(env);
  return [intro('튜토리얼 안내', '이 문서는 참고 자료입니다. 문서의 내용을 읽고 필요한 항목을 확인하세요.'), finish];
}
