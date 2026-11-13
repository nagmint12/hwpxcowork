// 'AI로 보고서 만들기' 코스(2026-11-12)의 그림 장면 모듈. 연습 문서의 특정 글에 기대지 않으므로 어느 튜토리얼에도 넣을 수 있다(sourceId 없음).
// 장면은 web/tutorial-scenes.js — 촬영 영상 대신 웹 요소로 그린다. 진행 조건이 아니므로 다 보지 않아도 [다음]으로 간다.
import { stepHelpers } from './common.js';
import { tutorialScene } from '../tutorial-scenes.js';

const sceneStep = (env, scene, step) => ({ center: true, scene, example: (root) => tutorialScene(root, scene, { reduced: env.motionReduced }), next: '다음 단계', ...step });

/** 한자리에서 하는 AI 작업 — 자료 → 내 AI → 문서의 제안 → 반영 → 한/글 파일 */
export function buildAiPlace(env) {
  const { intro, finish } = stepHelpers(env);
  return [
    intro('한자리에서 하는 AI 작업', '자료와 내 AI, 문서의 제안, 한/글 파일이 한 화면에서 이어지는 흐름을 봅니다.'),
    sceneStep(env, 'ai-place', { title: '한자리에서 하는 AI 작업',
      text: '자료를 문서 옆에 두고 AI에게 맡기면 결과가 이 문서에 제안으로 들어오고, 반영은 사람이 정합니다.\n이어지는 AI 작업마다 [보내기]와 [모두 반영] 두 번만 누르면 됩니다.' }),
    finish,
  ];
}

/** 한/글 파일로 가져가기 — 장면을 보여 주면서 실제 [한글로 저장]을 초록 테두리로 가리킨다(누르면 다음, 안 눌러도 다음으로 갈 수 있다) */
export function buildHangulExport(env) {
  const { intro, finish } = stepHelpers(env);
  const { pad, rectOf, q } = env;
  const save = () => env.saveButton?.() || null;
  // 좁은 화면은 [한글로 저장]이 위 ⋯ 메뉴 안에 있다 — 메뉴 단추를 금빛으로 가리킨다
  const target = () => save() || q?.('[data-testid="bar-more-toggle"]') || null;
  return [
    intro('한/글 파일로 가져가기', '반영한 문서를 한/글 파일로 저장하는 흐름을 봅니다.'),
    { title: '한/글 파일로 가져가기', scene: 'hangul-export', example: (root) => tutorialScene(root, 'hangul-export', { reduced: env.motionReduced }),
      text: () => (save() || !q?.('[data-testid="bar-more-toggle"]')
        ? '반영한 글·표·그림과 메모, 차례가 그대로 담긴 한/글 파일(HWPX)을 내려받습니다. 초록 테두리의 [한글로 저장]을 누르세요.'
        : '반영한 글·표·그림과 메모, 차례가 그대로 담긴 한/글 파일(HWPX)을 내려받습니다. 위 [⋯] 메뉴를 열고 [한글로 저장]을 누르세요.'),
      ring: () => pad(rectOf(target()), 4), open: () => pad(rectOf(target()), 4), press: () => (save() ? '한글로 저장' : null),
      click: save, next: '저장하지 않고 다음', nextPlain: true },
    finish,
  ];
}

/** 내 AI와 skill 그대로 — 실제 작업은 내가 쓰는 AI를 연결해 맡긴다(연결 방법은 'AI 연결' 튜토리얼) */
export function buildOwnAi(env) {
  const { intro, finish } = stepHelpers(env);
  return [
    intro('내 AI와 skill 그대로', '내가 쓰는 AI와 그 AI의 skill을 연결해 같은 작업을 맡기는 방법을 봅니다.'),
    sceneStep(env, 'own-skills', { title: '내 AI와 skill 그대로',
      text: '실제 작업은 내가 쓰는 AI에게 맡깁니다. 그 AI에 설치한 skill·웹 검색·코드 실행은 그대로 쓰이고, 이 문서에는 결과만 제안·메모로 남습니다.\n연결 방법은 튜토리얼 메뉴의 ‘AI 연결’에서 봅니다.' }),
    { ...finish, text: '이제 내 AI를 연결하면 같은 요청을 실제 자료로 맡길 수 있습니다. 완료하면 지금의 연습 문서와 요청·제안·메모 기록을 내 문서함에 보관합니다.' },
  ];
}
