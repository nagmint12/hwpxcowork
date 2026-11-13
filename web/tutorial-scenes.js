// 튜토리얼 안의 '그림 장면' — 촬영한 영상 대신 웹 화면 요소(HTML·CSS)로 그리고 움직인다(2026-11-12).
// 영상 파일·외부 라이브러리 없이 안내창 안에서 재생하며, 진행 조건이 아니라 이해를 돕는 그림이다(다 보지 않아도 다음으로 간다).
// 동작 줄이기·'동작 예시 끄기'면 마지막 장면을 정지 그림으로 보여 준다. 다음 단계·닫기 때 cleanup 으로 타이머를 정리한다.

const WEB_BAR = '<div class="ts-bar"><i></i><i></i><i></i><span>hwpx-cowork</span></div>';
const HWP_BAR = '<div class="ts-bar ts-bar-hwp"><span>한/글</span></div>';
// 웹 문서와 한/글 문서가 같은 꼴(병합한 머리 칸·서로 다른 칸 너비·그림)을 갖는지 견주는 작은 표
const MINI_TABLE = '<div class="ts-table"><div class="ts-tr ts-th"><span class="ts-merge">표준서식 표</span></div>'
  + '<div class="ts-tr"><span class="ts-c1"></span><span class="ts-c2"></span><span class="ts-c3"></span></div>'
  + '<div class="ts-tr"><span class="ts-c1"></span><span class="ts-c2"></span><span class="ts-c3"></span></div></div>';

export const TUTORIAL_SCENES = Object.freeze({
  // 복사 모듈: 예전 hangul-paste.mp4(실제 한/글 촬영본 5초)를 대신한다
  'hangul-paste': {
    title: '웹 문서에서 복사해 한/글에 붙여넣는 흐름',
    layout: 'ts-two',
    beats: [300, 1500, 2500, 3400, 4300, 5500],
    html: `<div class="ts-win ts-web">${WEB_BAR}<div class="ts-page"><div class="ts-line ts-w80"></div><div class="ts-selwrap"><div class="ts-sel"></div>
      <div class="ts-line ts-w60"></div>${MINI_TABLE}<div class="ts-pic"></div></div><div class="ts-line ts-w70"></div></div>
      <kbd class="ts-key ts-key-a">Ctrl+C</kbd></div>
      <div class="ts-arrow"><span class="ts-packet">글·표·그림</span></div>
      <div class="ts-win ts-hwp">${HWP_BAR}<div class="ts-page"><div class="ts-paste"><div class="ts-line ts-w60"></div>${MINI_TABLE}<div class="ts-pic"></div></div></div>
      <kbd class="ts-key ts-key-b">Ctrl+V</kbd>
      <ul class="ts-checks"><li>병합 칸</li><li>칸 너비</li><li>그림 크기</li></ul></div>`,
    steps: ['웹 문서에서 필요한 부분을 고르고 Ctrl+C로 복사합니다.', '한/글에서 Ctrl+V로 붙여넣습니다(한/글 쪽 설치 없이).', '표의 병합과 칸 너비, 그림 크기를 확인합니다.'],
  },
  // AI 코스 첫 장면: 자료 → 내 AI → 문서의 제안 → 사람이 반영 → 한/글 파일
  'ai-place': {
    title: '자료·내 AI·제안·한/글 파일이 한자리에서 이어지는 흐름',
    layout: 'ts-flow',
    beats: [200, 1300, 2500, 3700, 4800],
    html: `<div class="ts-node ts-n1"><b>주제·자료</b><span class="ts-chip">주제 한 줄</span><span class="ts-chip ts-xls">엑셀</span><span class="ts-chip">PDF</span><span class="ts-chip ts-skill">.skill</span></div>
      <div class="ts-link ts-l1"><i></i></div>
      <div class="ts-node ts-n2"><b>내 AI</b><span class="ts-chip ts-ai">Claude Code</span><span class="ts-chip ts-ai">Codex</span><span class="ts-chip ts-ai">ChatGPT</span><span class="ts-chip ts-ai">API</span><small>내 skill·웹 검색 그대로</small></div>
      <div class="ts-link ts-l2"><i></i></div>
      <div class="ts-node ts-n3"><b>문서에 제안</b><div class="ts-prop"><s>보인다</s> <ins>나타남</ins></div><div class="ts-btns"><span class="ts-apply">✓ 반영</span><span>거절</span></div><small>반영은 사람이</small></div>
      <div class="ts-link ts-l3"><i></i></div>
      <div class="ts-node ts-n4"><b>한/글 파일</b><span class="ts-file">보고서.hwpx</span><small>메모·차례 그대로</small></div>`,
    steps: ['고른 글·표나 문서 전체에 요청하고, 엑셀·PDF·.skill을 첨부합니다.', '연결한 AI가 자료를 읽고 제안·메모를 남깁니다.', '[반영]·[거절]로 정하고 한/글 파일로 저장합니다.'],
  },
  // 내 AI의 skill: 내 AI가 가진 도구·skill은 그대로, 문서에는 제안만. .skill 첨부는 API로 연결한 AI도 읽는다(read_skill_resource)
  'own-skills': {
    title: '내 AI와 그 AI의 skill을 그대로 연결하는 그림',
    layout: 'ts-skills',
    beats: [200, 1200, 2300, 3400, 4600],
    html: `<div class="ts-box ts-mine"><b>내 AI</b><small>내 PC·내 계정</small><div class="ts-chips"><span class="ts-chip">웹 검색</span><span class="ts-chip">엑셀 분석</span><span class="ts-chip ts-skill">표준서식 skill</span><span class="ts-chip ts-skill">우리 기관 양식</span></div></div>
      <div class="ts-pipe"><small>MCP 연결</small><span class="ts-pkt ts-p1">문서 읽기</span><span class="ts-pkt ts-p2">제안·메모</span></div>
      <div class="ts-box ts-doc"><b>hwpx-cowork 문서</b><div class="ts-mini-doc"><div class="ts-line ts-w90"></div><div class="ts-line ts-w70 ts-insline"></div><div class="ts-line ts-w80"></div><span class="ts-memo">메모</span></div></div>
      <div class="ts-attach"><span class="ts-chip ts-skill">보고서 작성 규칙.skill</span><span>요청에 첨부하면 API로 연결한 AI도 읽고 따릅니다</span></div>`,
    steps: ['Claude Code·Codex·ChatGPT는 MCP로 연결하고, API는 내 AI 키로 연결합니다.', '연결한 AI는 문서를 읽고, 자기 skill로 만든 결과를 제안·메모로 남깁니다.', '.skill 파일을 요청에 첨부하면 그 지침을 AI가 MCP로 읽습니다.'],
  },
  // AI 코스 마무리: [한글로 저장] → HWPX → 한/글에서 제안 반영 결과·메모·차례 그대로
  'hangul-export': {
    title: '고친 문서를 한/글 파일로 가져가는 흐름',
    layout: 'ts-two',
    beats: [300, 1300, 2300, 3400],
    html: `<div class="ts-win ts-web">${WEB_BAR}<div class="ts-tools"><span class="ts-save">한글로 저장</span></div><div class="ts-page"><div class="ts-line ts-w80"></div><div class="ts-line ts-w60 ts-insline"></div>${MINI_TABLE}<span class="ts-memo">메모</span></div></div>
      <div class="ts-arrow"><span class="ts-packet ts-file">.hwpx</span></div>
      <div class="ts-win ts-hwp">${HWP_BAR}<div class="ts-page"><div class="ts-paste"><div class="ts-line ts-w80"></div><div class="ts-line ts-w60"></div>${MINI_TABLE}<span class="ts-memo">메모</span></div></div>
      <ul class="ts-checks"><li>반영한 글</li><li>표·그림</li><li>메모·차례</li></ul></div>`,
    steps: ['[한글로 저장]을 누르면 HWPX 파일을 내려받습니다.', '한/글에서 열면 반영한 글·표·그림이 그대로 있습니다.', '남긴 메모는 한/글 메모로, 차례는 새로 고친 그대로 보입니다.'],
  },
});

/**
 * 안내창(root) 안에 그림 장면을 넣고 재생한다 → cleanup.
 * @param reduced 동작 줄이기면 true — 마지막 장면을 정지 그림으로
 */
export function tutorialScene(root, name, { reduced = () => false } = {}) {
  const spec = TUTORIAL_SCENES[name];
  if (!spec) throw new Error(`등록되지 않은 튜토리얼 장면입니다: ${name}`);
  const doc = root.ownerDocument || document;
  const make = (tag, text, className) => { const node = doc.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const still = () => { try { return !!(typeof reduced === 'function' ? reduced() : reduced); } catch { return true; } };
  const figure = make('figure', null, 'tour-scene');
  figure.setAttribute('data-scene', name);
  const stage = make('div', null, `ts-stage ${spec.layout}`);
  stage.setAttribute('role', 'img'); stage.setAttribute('aria-label', spec.title);
  stage.innerHTML = spec.html;
  const list = make('ol', null, 'ts-steps');
  for (const text of spec.steps) list.append(make('li', text));
  const replay = make('button', '다시 보기', 'small ts-replay'); replay.type = 'button';
  replay.setAttribute('aria-label', `${spec.title} 다시 보기`);
  figure.append(stage, list, replay);   // 설명 글은 안내창 본문이 맡는다(같은 말을 그림 밑에 되풀이하지 않는다)
  root.append(figure);

  let timers = [];
  const show = (n) => { stage.className = ['ts-stage', spec.layout, ...spec.beats.slice(0, n).map((_, k) => `ts-b${k + 1}`)].join(' '); stage.setAttribute('data-beat', String(n)); };
  const stop = () => { for (const t of timers) clearTimeout(t); timers = []; };
  function play() {
    stop();
    if (still()) { show(spec.beats.length); replay.hidden = true; return; }
    replay.hidden = false; show(0);
    spec.beats.forEach((at, k) => timers.push(setTimeout(() => show(k + 1), at)));
  }
  const onReplay = () => play();
  replay.addEventListener('click', onReplay);
  play();
  return () => { stop(); replay.removeEventListener('click', onReplay); };
}
