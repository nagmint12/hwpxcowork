// 튜토리얼 6(AI 활용 심화)의 요청 5가지 — 화면 안내(web/tutorial-steps.js)·예시 답변 실행기(server/tutorial-advanced.js)가 함께 쓴다.
// 2026-11-04: 15가지(A1~C5)는 과해서 꼭 필요한 5가지로 줄였고, 개인 AI 연결 없이 늘 준비된 예시 답변(preset)으로 진행한다.
// presets: tutorial/ai-advanced-answers.json 의 단계(A1~C5) — 앞에서부터 이어 붙인다. calls 를 주면 그 단계의 그 번째 호출만 쓴다.
// target: table = 그 표의 캡션 글, figure = 그 그림의 캡션 글, para = 그 글로 시작하는 문단, doc = 문서 전체.
//
// AI 작업 카드(2026-11-12, 'AI로 보고서 만들기' 코스 — docs/TUTORIAL_AI_WORK_2026-11-12.md): 작업 하나 = 강조할 화면 + 할 행동 + 확인할 결과.
//   why      손으로 하면 무엇을 해야 하는지 한 줄(요청 단계 안내 첫 줄 — 효능감)
//   attach   요청 창에 미리 붙일 첨부(이름에 이 글이 든 첨부). 입력하는 동안 첨부 칸을 금빛으로 강조한다
//   preCalls 예시 답변 앞에 붙이는 읽기 호출(첨부 읽기·스킬 읽기 — 작업 기록에 실제 AI 처럼 남는다). '@attach:글' = 그 이름의 첨부
// 화면은 작업마다 두 단계: [보내기](초록) → 결과가 오면 [모두 반영](초록) → 바뀐 본문으로 저절로 이동.
export const AI_WORK_TASKS = [
  { id: 'R1', title: '주제 조사해 문단 쓰기', target: { para: '(필요성) 재수강 신청 건수는' },
    why: '자료를 찾아 읽고, 출처와 함께 보고서 문체로 옮기는 일을 한 번에 맡깁니다.',
    prompt: '재수강 전후 성적을 비교할 때 주의할 점을 조사해서, 이 문단 뒤에 출처와 함께 한 문단으로 보태줘',
    look: '배경 뒤에 「(해석 시 유의점)」 문단이 들어오고, 제안 이유에 출처(Barnett 외, 2005)가 붙습니다.' },
  { id: 'X1', title: '엑셀로 절 쓰기', target: { table: '재수강 학년도·학기 유형별 재수강 건수' }, attach: ['.xlsx'], presets: [{ step: 'C2' }],
    preCalls: [{ name: 'read_attachment', args: { attachment_id: '@attach:.xlsx' } }, { name: 'get_writing_guide', args: {} }],
    why: '엑셀을 열어 수치를 옮기고, 표·그래프를 만들고, 문체를 맞추는 일을 요청 한 줄로 맡깁니다.',
    prompt: '첨부한 설문 엑셀로 이 표 뒤에 ‘재수강 경험자 설문 결과’ 절을 써줘. 표 2개와 그래프 1개를 넣고, 기존 보고서 톤으로',
    look: '새 절의 본문·표 2개·그래프가 한꺼번에 들어옵니다. 수치는 엑셀 요약 시트의 값입니다.' },
  { id: 'K1', title: '내 skill로 결론 쓰기', target: { para: '1) 분석 결과의 종합' }, attach: ['.skill'], presets: [{ step: 'C5' }],
    preCalls: [{ name: 'read_skill_resource', args: { attachment_id: '@attach:.skill' } }],
    summary: '첨부한 「보고서 작성 규칙(예시)」 skill을 읽고, 그 규칙(개조식 문장·근거 표 이름 붙이기·인과 단정 피하기·차례 새로 고침)대로 종합 뒤에 「2) 시사점 및 정책제언」 절(시사점 3개·정책제언 3개)과 차례 새로 고침을 제안했습니다.',
    why: '우리 기관의 작성 규칙을 .skill 파일로 첨부하면, 연결한 AI가 그 규칙을 읽고 따라 씁니다.',
    prompt: '첨부한 작성 규칙 skill대로, 분석 결과를 근거로 시사점과 정책제언을 3개씩 써 주고 마지막에 차례도 새로 고쳐줘',
    look: '문장이 개조식으로 끝나고, 제언마다 근거 표·그림 이름이 붙으며, 차례에 새 절이 들어갑니다.' },
];

export const ADVANCED_TASKS = [
  { id: 'S1', title: '그림 만들기', target: { table: '분석 기준 총괄' }, presets: [{ step: 'A3' }],
    prompt: '이 표를 시각화하여 제시해줘',
    look: '막대그래프가 아니라 분석 대상의 포함·제외 흐름과 재수강 판정의 갈래로 그렸는지 보세요.' },
  { id: 'S2', title: '그림 바꾸기', target: { figure: '소속대학별 재수강 경험 비율' }, presets: [{ step: 'A1' }],
    prompt: '해당 그림의 색이 너무 쨍한데, 문서의 다른 그림처럼 문서의 남색 톤으로 바꿔줘',
    look: '같은 자리·캡션에 값은 그대로 두고 색만 바뀐 그림으로 교체됩니다.' },
  { id: 'S3', title: '표 서식과 오탈자', target: { table: '소속대학별 재수강 현황' }, presets: [{ step: 'B3' }, { step: 'C1' }],
    prompt: '이 표를 문서의 다른 표와 같은 서식으로 맞추고, 문서 전체의 오탈자도 고쳐줘. 뜻·수치·용어는 그대로 두고',
    look: '주황 머리행·굵은 테두리가 다른 표와 같아지고, 심어 둔 오탈자·띄어쓰기가 고쳐집니다.' },
  { id: 'S4', title: '문서 교정', target: { doc: true }, presets: [{ step: 'C3' }, { step: 'C4', calls: [9, 13, 18] }],
    prompt: '표의 숫자와 본문의 서술이 다른 곳을 고치고, 과도한 해석이나 추측성 서술은 메모로 알려줘',
    summary: '표와 본문을 대조해 모집단 규모·입학년도별 경험 비율·대학별 경험 비율의 불일치를 표 기준으로 고치는 제안을 남기고, 표 안 계산 차이 1곳과 인과·동기 해석의 비약, 분석 범위를 넘는 정책 결론 3곳은 검토 메모로 남김.',
    look: '본문의 틀린 수치 3곳이 표 기준으로 고쳐지고, 과도한 해석 3곳에 메모가 달립니다.' },
  { id: 'S5', title: '결론 쓰기', target: { para: '1) 분석 결과의 종합' }, presets: [{ step: 'C5' }],
    prompt: '분석 결과를 근거로 시사점과 정책제언을 3개씩 작성해줘. 근거가 된 표·그림 번호를 함께 적고, 마지막에 차례도 새로 고쳐줘',
    look: '제언마다 근거 번호가 붙고, 앞에서 늘어난 그림이 차례에 들어갑니다.' },
];

/** 같은 연습 문서(ai-advanced)에서 쓰는 모든 AI 작업 — 코스 조합(compose.js)과 예시 답변 실행기(server/tutorial-advanced.js)가 번호로 찾는다 */
export const TUTORIAL_AI_TASKS = [...ADVANCED_TASKS, ...AI_WORK_TASKS];
