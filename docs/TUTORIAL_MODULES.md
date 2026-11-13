# 튜토리얼 모듈 구성

관리자로 로그인한 뒤 **튜토리얼 → 구성 편집**을 엽니다.

## 각 행동 단계 편집

모듈 아래에 **행동 단계** 목록이 펼쳐집니다. 결과보고서는 1~15단계가 각각 한 행으로 표시됩니다. 한 모듈로 묶인 기존 구성을 읽어도 이 목록이 자동으로 나타나므로 기본 구성을 다시 저장할 필요가 없습니다.

- 각 행에서 행동 종류, 대상, 완료 조건과 필요한 준비 단계를 확인합니다.
- **문구·행동 편집**에서 해당 단계의 제목·안내 문구를 수정합니다. 모듈의 도입 설명과 별개로 실제 실행 단계의 문구를 교체합니다. **기본 문구 복원**은 상태에 따라 바뀌는 원래 안내로 되돌립니다.
- 사용 체크, 위·아래, 제거로 단계를 편집합니다. 삭제한 내장 행동은 **기본 행동 다시 추가**로 복구합니다. 전체 단계 편집은 **기본 단계로 되돌리기**로 취소할 수 있습니다.
- 보고서의 AI 요청→대기→반영, 메모→답글 등은 앞선 결과를 사용합니다. 필요한 준비 단계를 빼거나 뒤로 옮기면 저장 전에 누락된 단계 이름을 알려줍니다. 보고서의 문장 AI 실습(1~5), 메모 실습(6~12), 차례 실습(13~14), 다운로드(15)는 독립 묶음으로 구성할 수 있습니다.
- **등록된 custom 동작으로 전환**은 현재 행동의 대상·실행 함수·완료 조건을 유지하면서 custom 항목으로 편집합니다. 요청 대기·제안 반영처럼 단순한 클릭 설정만으로 표현하기 어려운 동작에 사용합니다.

**custom 행동 추가**는 현재 모듈 안에 새 행동을 넣습니다. 여러 행동을 별도 모듈로 관리하려면 아래 모듈 목록에서 **직접 구성한 행동**을 추가합니다.

| 행동 | 편집하는 값 | 진행 방식 |
| --- | --- | --- |
| 안내 읽기 | 제목, 설명, 다음 버튼 문구 | 다음 버튼 |
| 대상 클릭 | 앱 화면/편집기, CSS 선택자 | 사용자의 실제 클릭 |
| 예시 입력 | 대상 위치·선택자, 입력 예시 | 예시 입력 버튼으로 타이핑, 값 확인 |
| 문서의 글 선택 | 선택할 문구 | 실제 선택 확인 |
| 등록된 custom 동작 | 등록된 기존 행동 | 해당 행동의 원래 완료 조건 |

custom의 선택자는 앱 내부 요소를 가리킵니다. 예를 들어 AI 요청의 입력 칸은 앱 화면의 `.composer-win .cmp-instr`입니다. 해당 창을 여는 준비 단계가 앞에 있어야 합니다. 등록된 동작은 같은 연습 문서의 행동만 선택할 수 있으며, 임의 JavaScript를 설정에 넣어 실행하지 않습니다. 새로운 프로그램 동작 자체가 필요하면 아래의 빌더 등록 절차로 코드를 추가합니다.

## 포인터·타자 효과

모든 튜토리얼에서 강조 대상에 가상 포인터를 표시합니다. 글 선택은 끄는 모션, 버튼은 클릭 예시, 입력은 타이핑으로 보여줍니다. 보고서·기본 편집·AI 검토에서 예시 입력 버튼을 누르면 글자가 차례로 입력됩니다. 연결 폼은 읽기 전용 예시에서 보여줍니다. 실제 AI 전송·제안 반영은 사용자가 직접 누릅니다.

모듈의 **포인터·타자 효과 사용**을 끄면 해당 모듈 전체에 적용됩니다. 각 단계에서도 별도로 끌 수 있습니다. 모듈 효과가 꺼져 있으면 단계에서 다시 켤 수 없습니다. 실행 안내의 **동작 예시 끄기**는 현재 연습 전체의 설정이고, 시스템의 동작 줄이기 설정도 존중합니다. 효과를 끄면 포인터가 숨겨지고 예시 입력은 즉시 채워집니다. 사용자가 입력을 고치거나 단계를 이동하면 진행 중인 타이핑은 중단됩니다.

## 그림 장면(촬영 영상 대신, 2026-11-12)

복사 모듈의 빈 입력창 검사 단계와 그 뒤의 실제 한/글 촬영 영상(5초)은 **웹 요소로 그린 그림 장면**으로 바뀌었습니다(`web/tutorial-scenes.js`, 장면 `hangul-paste`). 같은 단계 참조(`1s3lf9h`)를 유지하므로 기존 설정과 진행 위치가 이어집니다. 제목은 '한/글에 붙여넣는 흐름', 첫 단계의 바로가기는 **붙여넣기 흐름 보기**입니다. 장면은 영상 파일·바깥 라이브러리 없이 단계별로 움직이고 [다시 보기]로 다시 재생합니다. 동작 줄이기·[동작 예시 끄기]에서는 마지막 장면을 정지 그림으로 보여 주며, 시청 완료를 요구하지 않습니다. 다음 단계·닫기 때 타이머를 정리합니다. 촬영 원본(`web/tutorial-media/hangul-paste.mp4`·포스터)은 보관만 하고 부르지 않습니다.

같은 방식의 장면 모듈 셋 — **한자리에서 하는 AI 작업**(`ai-place`), **한/글 파일로 가져가기**(`hangul-export`, 실제 [한글로 저장]을 초록 테두리로 가리킴), **내 AI와 skill 그대로**(`own-ai`) — 은 연습 문서에 기대지 않아 어느 튜토리얼에나 넣을 수 있습니다. 구성과 근거는 [AI로 보고서 만들기](TUTORIAL_AI_WORK_2026-11-12.md)를 참고합니다.

## AI 작업 카드(2026-11-12)

**주제 조사해 문단 쓰기**(`topic-research`), **엑셀로 절 쓰기**(`excel-report`), **내 skill로 결론 쓰기**(`skill-conclusion`)는 AI 활용 심화와 같은 연습 보고서를 씁니다. 작업마다 [보내기] → [모두 반영] 두 단계입니다. 카드 데이터(대상·첨부·요청 예시·손으로 할 일·확인할 결과·예시 답변)는 `web/tutorial-advanced-tasks.js`의 `AI_WORK_TASKS`에 있습니다. 첨부가 있는 카드는 요청 창에 엑셀·`.skill`을 미리 붙이고, 입력하는 동안 첨부 칸을 금빛으로 강조합니다. `skill-conclusion`과 `conclusion`은 같은 자리에 쓰므로 한 코스에 하나만 넣습니다.

단계를 해제하면 기본 다음 버튼도 남은 단계에 맞춰 바뀝니다. 조판 부호 단계는 사용자가 충분히 살펴본 뒤 다음으로 이동하며, 이동·닫기 때 원래 표시 상태로 복구합니다.

## AI 연결 모듈(2026-11-13)

연결 우선순위(앱 전체 같은 결정)대로 단계를 줄였습니다. 단계 수는 예전 21개에서 12개입니다(Gemini 안내 9단계는 뺐고, 절차는 `web/tutorial-gemini.js`에 남겨 두었습니다).

1. **내 PC의 구독 AI · 기본**(추가 비용 없이 바로 처리): 내 개인 토큰 저장 → VS Code 대화창용 MCP 등록(Codex `config.toml`, Claude Code 작업 폴더의 `.mcp.json`; 실행기만 쓰면 생략 가능) → Codex 실행기 `start-codex-agent.bat` → Claude Code 실행기 `start-claude-worker.bat` → 연결 확인. Claude Code 채널 `start-agent.bat`는 대안입니다.
2. **선택(고급) — ChatGPT 웹 앱**: Plugins → Add custom MCP server → 주소와 OAuth → 대화에서 처리. 실제 계정 화면 `chatgpt-*.png` 두 장을 씁니다.
3. **선택(유료) — API 키**: 문서함 [내 AI 키]. 일반 예시 그림 `api-*.png`를 씁니다.

- 글은 `web/tutorial-connect.js`(`connectGuide(mcpUrl)`) 하나에 있고, 화면(`web/tutorial-modules/ai-connections.js`)과 한/글 가이드 생성기(`scripts/build-tutorial-connection.mjs` → `tutorial/AI 연결 — 사용자 가이드.hwpx`)가 함께 씁니다.
- **붙여넣을 내용과 사람에게 하는 말을 나눕니다.** 붙여넣을 내용은 단계의 `blocks`(이름표 `VS Code에 붙여넣을 내용 — …`·`PowerShell에 붙여넣을 내용 — …`)이며 화면에서는 [복사] 상자, 한/글 가이드에서는 `(… 붙여넣을 내용)` 머리말 뒤 바탕글 줄입니다. 화면의 상자에는 지금 서버의 MCP 주소가, 한/글 가이드에는 예시 주소가 들어갑니다. 토큰·키 값은 넣지 않습니다(`HWPX_COWORK_TOKEN` 환경 변수 참조만).
- 첫 고르기 단계 [내 PC의 구독 AI · 기본]·[ChatGPT 앱 연결 · 선택]·[내 AI 키 · 선택 · 사용료 별도]는 각 묶음의 첫 단계로 갑니다. 연결 확인 단계의 다음 버튼은 완료로 가고, 선택 연결은 [선택 연결도 보기]로 봅니다. PowerShell의 실행기 명령은 옵션이 그대로 전달되도록 `npm.cmd`를 씁니다.
- 모듈 버전을 2로 올렸습니다. 진행 중이던 예전 연습은 저장된 숫자 위치로 이어집니다.

## 메뉴 번호와 문서 제목

메뉴 번호는 `/api/tutorial`이 저장한 구성의 차례대로 매깁니다(`server/tutorial.js` `number: i + 1`). 그래서 안내 제목·연습 문서 표지·설명서 본문에는 **메뉴 번호를 쓰지 않습니다**(2026-11-13 — 메뉴 차례를 바꾼 뒤 '5. 내 AI 연결', '6. 튜토리얼 — AI 활용 심화'가 실제 차례와 어긋났습니다).

- 모듈 안내 첫 제목에서 번호를 뺐습니다(처음 쓰기·한글과 복사·붙여넣기·AI 작업 맡기기·AI 연결). 결과보고서 단계 제목의 `1.`~`15.`는 그 코스 안 단계 차례이고, 단계 ID(`stepToken`)가 이 제목으로 정해져 그대로 둡니다. 조합 실행기가 화면에 낼 때 번호를 뗍니다(`displayTitle`).
- `docs/manuals`의 파일 이름 `00`~`04`는 파일 차례일 뿐이고(서버가 제목에서 뗌), 본문은 다른 설명서를 튜토리얼 이름('한글과 복사·붙여넣기' 등)으로 가리킵니다. `node scripts/build-manuals.mjs --only 0,3,4`로 그 셋만 다시 만들었습니다. 01(복사·붙여넣기 시험 자료)·02(예시 기록이 기대는 글)는 그대로입니다.
- 'AI 활용 심화 — 연습 보고서'는 'AI 활용 심화'와 'AI로 보고서 만들기'가 함께 쓰므로 표지를 「튜토리얼 연습 보고서」로 바꿨습니다. 다시 만들면 수치와 예시 답변이 바뀌므로 `node scripts/build-tutorial-refresh.mjs`로 표지·안내 글만 고칩니다(생성기에도 같은 글).
- **미리보기 글**(`Preview/PrvText.txt`): 표준서식 템플릿의 미리보기 글이 그대로 따라오던 생성기(`build-tutorial-advanced.mjs`·`build-tutorial-doc.py`)도 이제 그 문서 본문으로 다시 씁니다(`build-tutorial-refresh.mjs`의 `previewText`). `tests/tutorial_guides.test.mjs`가 표지·본문의 메뉴 번호와 미리보기 글을 검사합니다.

## 튜토리얼과 모듈 편집

1. 왼쪽에서 튜토리얼을 고릅니다. 위·아래 버튼으로 메뉴 순서를 바꿀 수 있습니다.
2. 오른쪽의 진행 순서에서 모듈을 제거하거나 위·아래로 이동합니다.
3. 아래 모듈 목록에서 필요한 실습을 추가합니다. **직접 작성한 안내**는 원하는 위치에 여러 번 넣을 수 있습니다.
4. **안내 문구 편집**에서 실습 앞에 보여 줄 제목과 설명을 적습니다. 튜토리얼 제목·목록 설명·메뉴 표시 여부·첫 접속 안내도 변경할 수 있습니다.
5. **구성 저장**을 누릅니다. 저장하지 않은 수정은 **변경 취소**, 초기 조합은 **기본 구성 불러오기**로 복구할 수 있습니다. 기본 구성을 불러온 뒤에도 저장을 눌러야 적용됩니다.

새 튜토리얼은 연습 문서를 선택하고 **튜토리얼 추가**로 만듭니다. 예를 들어 AI 활용 심화 원본으로 새 항목을 만든 뒤 그림 생성·그림 변경만 남겨 그림 연습을 구성할 수 있습니다. 복사·편집 원본에서는 편집 명령만 남기는 것도 가능합니다.

모듈마다 연습에 쓰는 문장·표·그림이 있으므로 같은 연습 문서를 사용하는 실습끼리 조합합니다. 다른 원본의 실습은 별도 튜토리얼로 추가하고 메뉴 순서로 이어 붙입니다. 모듈을 뺐다고 원본 HWPX의 본문까지 삭제되지는 않습니다. 같은 원문을 다시 수정하는 문제를 막기 위해 실습 모듈은 코스당 한 번만 넣고, 자유 안내는 여러 번 넣을 수 있습니다.

## 구성과 실행의 분리

| 역할 | 파일 |
| --- | --- |
| 모듈 ID·설명·호환 원본·버전, 기본 코스, 검증 규칙 | `web/tutorial-definition.js` |
| custom 행동의 인수 계약 | `web/tutorial-action-definition.js` |
| 개별 단계 편집 UI | `web/tutorial-step-editor.js` |
| 모듈별 안내·실습 동작 | `web/tutorial-modules/*.js` |
| 모듈 등록, 상태 격리, 단계 조합과 이동 변환 | `web/tutorial-modules/compose.js` |
| 강조 표시·안내창·진행 저장 등 공통 실행기 | `web/tutorial.js` |
| 촬영 영상 대신 쓰는 그림 장면 | `web/tutorial-scenes.js`, 장면 모듈 `web/tutorial-modules/ai-work.js` |
| AI 작업 카드(심화 5작업 + 조사·엑셀·skill) | `web/tutorial-advanced-tasks.js` |
| 이전 세션용 진입점 | `web/tutorial-steps.js` |
| 관리자 편집 UI | `web/tutorial-editor.js` |
| 관리자 구성 저장·수정 충돌 검사 | `server/tutorial-definition-store.js` |
| 코스 목록·원본 준비·세션 snapshot | `server/tutorial.js` |

설정은 `<dataDir>/tutorial-definition.json`에 저장합니다. 파일이 없으면 기본 구성을 메모리에서 사용하며, 조회만으로 파일을 만들지 않습니다. 기존 `config.json`의 AI 연결·접근 제한과 원본 HWPX는 별도로 유지합니다.

```json
{
  "version": 1,
  "entryCourseId": null,
  "courses": [
    {
      "id": "picture-practice",
      "title": "그림 연습",
      "description": "기존 그림을 바꾸고 새 그림을 만듭니다.",
      "sourceId": "ai-advanced",
      "enabled": true,
      "modules": [
        { "key": "welcome", "moduleId": "guide", "title": "시작 전", "text": "원본 그림과 표를 먼저 살펴보세요." },
        { "key": "replace", "moduleId": "image-replace" },
        { "key": "create", "moduleId": "image-create", "text": "이번에는 표를 시각화합니다." }
      ]
    }
  ]
}
```

`id`는 코스 식별자, `sourceId`는 연습 원본, `modules` 배열은 실행 순서입니다. `moduleId`는 기능 종류, `key`는 코스 안에서 모듈 상태를 구분하는 고유 키입니다. `title`·`text`는 실습 앞의 사용자 안내입니다. `guide`에서는 둘 다 필수입니다. ID·키는 영문 소문자·숫자·하이픈 1~64자, 코스 최대 50개, 코스별 모듈 최대 64개입니다. `entryCourseId: null`이면 첫 접속 자동 안내를 생략합니다.

모듈의 `motion: false`는 포인터·타자 효과를 끕니다. `steps`를 생략하면 기존 모든 행동을 사용합니다. `steps`를 지정하면 배열 순서가 실행 순서가 되며, 최대 128개까지 넣을 수 있습니다.

```json
{
  "key": "my-actions",
  "moduleId": "custom",
  "motion": false,
  "steps": [
    { "key": "before", "kind": "custom", "actionId": "notice", "title": "시작 전 확인", "text": "연습 문서를 살펴보세요.", "params": {} },
    { "key": "pick", "kind": "custom", "actionId": "select-text", "title": "글 선택", "text": "학생 만족도 문구를 선택하세요.", "params": { "text": "학생 만족도" } }
  ]
}
```

내장 단계 참조는 `{ key, kind: 'builtin', stepId, title?, text?, next?, enabled?, motion? }`, custom은 `{ key, kind: 'custom', actionId, title, text, params, enabled?, motion? }`입니다. 내장 ID와 `handlerId`는 `describeTutorialModule(moduleId).steps`에서 얻습니다. 등록 동작은 `params.handlerId`에 그 값을 넣습니다. `next`는 기존 다음 버튼의 문구만 바꾸며 완료 조건을 우회하는 새 버튼을 만들지 않습니다.

새 세션에는 원본 ID, 모듈 배열, 제목·설명, 구성 revision을 복사해 보관합니다. 관리자가 이후 구성을 바꾸어도 진행 중인 연습은 바뀌지 않습니다. 진행 위치는 모듈 키와 단계 ID로 저장하고, 이전 세션의 숫자 인덱스도 지원합니다. 다음 코스는 서버의 현재 메뉴 순서를 따릅니다.

## 새 기능 모듈을 코드로 추가하기

1. `tutorial-definition.js`의 `TUTORIAL_MODULES`에 `id`, `title`, `description`, `sourceId`, `version`을 등록합니다. 기능 변경으로 단계 의미가 달라지면 버전을 올립니다.
2. `tutorial-modules/`에 빌더를 작성합니다. 빌더는 `env`로 문서·선택·화면 함수·자기 모듈의 `ctx`를 받으며, 소개·실습·완료 단계 배열을 반환합니다. 실제 동작은 `enter`, `action.run`, `until`, `leave` 등 기존 단계 계약을 사용합니다.
3. `compose.js`의 `buildTutorialModule()`에 빌더와 실습 단계 `indexes`를 연결합니다. 소개와 완료는 조합 실행기가 코스 전체에서 한 번만 붙입니다. 내부 숫자 이동 및 `nextTo`는 조합 후 위치로 변환되므로 다른 모듈의 위치를 하드코딩하지 않습니다.
4. 새 원본이 필요하면 공통 `TUTORIAL_SOURCES`와 서버 원본 카탈로그에 등록하고, 해당 원본의 기본 코스도 추가합니다. 단순 조합 변경은 코드 수정 없이 관리 화면에서 합니다.
5. 독립 실행, 순서 변경, 중간 안내 삽입, 새로고침 이어하기를 검증합니다. 이전 완료 요청을 이어받는 동작과 새 모듈 요청을 구별합니다.

공통 구성은 JSON 데이터만 받습니다. 실행 함수·임의 스크립트는 구성에서 받지 않으며, 새 동작은 검토 가능한 빌더 코드로 추가합니다.

## API와 검증

관리자 `GET /api/tutorial/definition`은 `{ definition, revision, modules, sources }`를 반환합니다. 원본 목록의 `available`은 파일 준비 여부입니다. `PUT`은 `{ definition, revision }`을 받으며 다른 관리자가 먼저 저장했으면 409를 반환합니다. 일반 계정은 403, 잘못된 조합은 400입니다.

주요 검사: `tests/tutorial_definition.test.mjs`, `tests/tutorial_definition_api.test.mjs`, `tests/tutorial_modules_runtime.test.mjs`. 기존 guide·entry·session·progress·navigation·motion·advanced 검사를 함께 유지합니다. UI 검증에서는 임시 데이터 서버에서 추가·제거·재정렬·안내 편집·저장·새로고침·실제 실행과 이어하기를 확인했습니다. 실제 사용자 데이터나 유료 AI는 검증에 사용하지 않았습니다.

단계 편집 추가 검사: `tests/tutorial_step_definition.test.mjs`, `tests/tutorial_step_runtime.test.mjs`, `tests/tutorial_all_motion.test.mjs`. 전체 회귀검사 결과와 기존 실패의 비교 근거는 `docs/TUTORIAL_STEP_REGRESSION_2026-11-05.md`를 참고합니다.
