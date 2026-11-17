# API에서 MCP 도구로 작업 처리

2026-11-14 방법론 조사: [AI 문서 편집 에이전트 공식 가이드·전문 방법론 HTML 보고서](../reports/ai-document-agent-methodology-2026-11-14.html) — OpenAI·Anthropic 공식 자료, 규격·논문·기술서 35종과 실제 실행 로그를 대조하고 개선·검증 설계를 정리했다. 구현·배포 완료 보고서는 아니다.

2026-11-05 검증 추가: native 흐름과 현재 읽기 규칙을 유지하면서, 모델 입력의 정확한 문단 중복만 제거하고 표·그림 자동번호를 원문과 분리한 메타데이터로 전달했다. 총 모델 토큰 절감은 실측에서 입증되지 않았다. 변경 범위·실측·제외 기록·운영 미반영 상태는 [검증 보고서](NATIVE_CONTEXT_DEDUP_2026-11-05.md)를 따른다. 아래 날짜별 측정/설계는 당시 기록이다.

## 2026-11-14 내용·형식 분리 실험 경로

> **2026-11-16: 이 방식은 쓰지 않는다(기본 끔 — 사용자 결정).** 형식 단계가 큰 문서에서 서버를 멈추게 했고 그 요청이 밤새 되풀이됐다(`docs/MCP_REDESIGN_2026-11-16.md` §2). `config.experiments.contentFormat` 이 true 일 때만 아래 내용이 동작한다. 꺼져 있으면 `/api/config.features.contentFormatWorkflow` 가 false 라 편집기에 선택 칸이 없고, 그 선택으로 보낸 새 요청은 보통 방식으로 만들며, `start_request(workflow=…)`·사본 도구는 `EDIT_WORKFLOW_OFF` 로 거절하고, 남아 있던 그 방식의 요청은 누가 맡으려 할 때 실패로 닫는다('다시 요청'하면 보통 방식). 글상자·선 문서를 표로 옮기는 일은 새 연결의 `objects_to_body` 를 쓴다.

사용자가 선택하는 별도 경로 `options.workflow="content_format"`을 추가했다. **내용은 전체 문서의 글자·Markdown으로 읽고, 형식은 내용 확정 뒤 새 모델 대화에서 처리한다.** 변경 범위는 사용자 지시와 target을 따른다. 기존 경로는 기본값 그대로다. 실험의 전체 문서 문맥이 불필요한 작은 선택 작업은 기본 경로를 쓸 수 있다.

웹의 **지시 → 내용·서식 나눠 처리(실험)**를 선택한다. 이 선택지는 새 서버의 `/api/config.features.contentFormatWorkflow`가 있을 때만 나타난다. 결과 카드에서 검토용 HWPX와 내용 Markdown을 내려받고, 기존 문서 권한/반영 정책으로 한 묶음을 반영·복구한다. 검토 모드의 묶음은 기존 표·그림 제안처럼 공유 문서에 직접 반영할 권한이 필요하다. 발행 전 사본은 작성자·관리자만 내려받고, 발행된 특정 버전은 문서를 읽는 공동 검토자도 내려받는다.

REST로 생성할 때는 기존 `/api/docs/:id/requests`에 다음을 보낸다.

```json
{"kind":"instruct","instruction":"내용을 정리하고 표준 서식으로 맞춰줘","target":{"scope":"document","ref":"s0/p0"},"options":{"workflow":"content_format"},"route":"queue"}
```

실행 계약은 다음과 같다.

1. 원문과 별개인 `edit-workspaces/r<rid>-a<attempt>-v<revision>.hwpx` 사본을 만든다. 내용 단계에는 스타일 번호·원본 XML·되돌리기 기록을 보내지 않는다. 표 글은 Markdown 표로 한 번만, 글상자·각주 등 글과 누름틀 이름/안내문은 주소가 있는 글 자료로 읽는다. 큰 자료는 `get_edit_workspace`의 nextFrom을 이어 읽는다.
2. `get_edit_capabilities` 기본은 지원 동작 이름/단계만, `operations=[...]`는 필요한 동작의 args 스키마만 준다. `edit_workspace(stage,revision,operations)`가 타입 검사·선점·시도·원문 해시를 검사하고 사본에 원자적으로 적용한다. 한 호출이 실패하면 앞 동작도 사본에 저장하지 않는다. 완료 단계는 `complete_stage=true`와 요약, 무변경 단계는 명시적 `no_changes_reason`을 요구한다.
3. API(OpenAI·Claude·Gemini)·Codex CLI·Claude Code CLI 실행기는 내용 단계 종료 뒤 **새 ai.run/runMcp**로 형식을 시작한다. 이전 단계의 모델 응답/도구 이력을 넘기지 않는다. API 단계 종료는 정상 `edit.stage.boundary`로 기록하며 형식 오류/AI 실패로 기록하지 않는다. 일반 외부 채널은 같은 단계 도구를 연속 사용할 수 있으나 대화 초기화는 클라이언트 책임이다.
4. 형식 단계는 확정된 본문·표 셀·각주 글을 바꾸지 못한다. 머리말/꼬리말과 자동 생성 차례는 별도 형식 작업이다. ready 뒤 `publish_edit_workspace`가 한 `edit_batch` 제안을 만들고 `complete_request`로 끝낸다. 원문 반영 때 동작을 재실행하고 검토 사본과 본문 해시를 대조한다. 원문이 달라졌으면 적용하지 않는다.
5. 복구는 문서 해시·제안/요청 차례와 주소 상태를 확인한 뒤 문서와 관련 주소/글자 위치를 함께 복원한다. 다른 편집이 있으면 STALE로 알리고 사본/이력을 보존한다. 임시 실패 파일도 덮지 않고 다음 revision을 사용한다.

| 단계 | 지원 동작 |
|---|---|
| 내용 | 글 바꿈, 여러 문단 삽입, 표 작성·행/열 삽입·삭제·셀 병합/분할(`table_structure`), 개체 삭제, SVG/첨부 그림, 표 기반 편집 가능한 차트, URL 하이퍼링크 생성, 누름틀 생성/채우기, 본문 각주·미주 생성 |
| 형식 | 여러 문단 서식/역할 스타일 적용, 표 모양/폭/정렬, 구역·용지·머리말·꼬리말·쪽 번호, 차례 생성/갱신, 표준 역할 스타일 가져오기, 이름 있는 스타일 정의 생성 |

새 스타일은 기존 타입 검사·서식 importer를 사용한다. `import_styles(preset="hwpx_standard")`는 앱의 빈 표준 문서에서 스타일과 참조 글꼴/번호/글머리표를 가져오고, 같은 이름의 기존 정의는 보존한다. `define_style`은 기준 스타일과 char/paragraph 속성으로 새 정의를 만든다. 컨트롤은 WASM에서 **새 조각만 생성**해 원래 run에 삽입한다. 기존 문서를 WASM export로 통째로 덮지 않는다. 각주·미주는 현재 본문 문단 대상으로 제공하며, 앞에 새 주석을 넣을 때 기존 주석의 본문 번호와 자동 번호도 함께 갱신한다.

API 작업공간의 생성 파일 회수와 CLI의 download/upload_result_file도 사본 경로에서 사용할 수 있다. 서버의 원문 쓰기 도구와 사본 쓰기는 섞지 않는다. API 모델에 주는 기본 사본 도구는 8개, CLI는 파일 도구 2개가 추가된다. 필요한 동작의 스키마를 더 읽는 방식이므로 UI 기능마다 MCP 도구를 하나씩 늘리지 않는다. 일반 프로필은 현재 API 36개·Codex 43개다.

새 실행기는 `claim_next_request(workflows=["content_format"])`로 지원을 선언한다. 이를 생략하는 옛 실행기는 일반 요청만 가져가며, 새 실험을 잘못 맡아 내용 단계에서 끝내지 않는다. 개인 실행기는 새 코드/ZIP으로 다시 켜고, 외부 채널도 새 도구/이 안내를 다시 읽어야 한다. 서버 재시작만으로 다른 PC나 이미 실행 중인 세션이 갱신됐다고 보고하지 않는다.

진단은 `edit.stage.start/complete/usage/boundary`, `edit.workspace.saved`에 단계·사본 차례·원문 해시와 원래 모델/MCP 송수신을 연결한다. 단계별 실제 제공자 사용량과 입력 Markdown 문자/바이트 수는 `r.editWorkspace.stages`에 남기고 합계를 기존 `r.usage`에 저장한다. 제공자 카운터를 금전 청구액이나 토크나이저 추정치로 바꾸지 않는다.

검증은 [검증 원문](../artifacts/content-format-workflow-20261114/verification.txt), [새 경로 시험](../tests/edit_workspace.test.mjs), [20개 표 실험 최신 결과](../artifacts/content-format-workflow-20261114/20-tables/latest.json), [한/글 독립 재저장 결과](../artifacts/content-format-workflow-20261114/feature-oracle-latest.json)에 있다. 20표·800행·2,400셀에서 전체 20개 표 내용과 정렬을 확인했다. 모의 모델의 대화는 2개(동작 규격 조회를 포함한 응답은 4회)였으며 실제 AI 토큰 절감 실측은 아니다. 한/글 2022(12.0.0.3146)에서 링크·누름틀·각주·미주·가져온 스타일과 역순 삽입 주석 번호 1/2를 확인했다. 브라우저는 사용하지 않았으며 웹은 JS 구문·Vue 템플릿 컴파일과 같은 REST 저장/다운로드 경로로 검증했다.

운영 상태: **2026-11-14 20:16 KST 정상 재시작으로 보완분까지 공개 서버 반영 완료**(instance `9a56f90376f28eeb`). 저장·처리 대기 후 정상 종료, 공개 `/api/config`의 실험 플래그, 공개 MCP의 17개 동작, 개인 실행기 ZIP의 34개 소스 파일 SHA256 일치를 확인했다. 공개 웹 JS 5개와 운영 원문 로그의 구현 파일 11개 해시·송수신 무결성도 일치했다. 운영 설정 파일은 변경하지 않았다. [운영 확인 원문](../artifacts/content-format-workflow-20261114/deployment-1794655011300/verified.json), [공개 웹·원문 로그 확인](../artifacts/content-format-workflow-20261114/deployment-1794655011300/static-and-debug.json). 검토 모드의 개별·일괄 개인 수정본 반영/REST 채택 기록은 묶음 제안을 거절하며, 실시간 문서 반영과 권한 있는 직접 적용·복구는 가능하다. 새 기능 16개 사례와 기존 주변 회귀(실행별 수는 검증 기록)에서 확인했으며, 기존 진단의 회귀 실패 2건 기록은 유지한다. 이미 실행 중인 개인 실행기/외부 채널은 갱신하지 않았다. 실제 유료 AI 호출은 하지 않았다.

## 2026-11-14 20:53 실제 Codex 1회 관측: 형식 단계 중단

사용자가 지정한 `ActionObject`(`mwgch3xz44c830`)의 #1·시도 1을 관측했다. 원문 지시는 “문서 전체의 내용을 표로 만들고 불필요한 양식 및 개체는 삭제해줘”이며, 이미 실행 중이던 Codex 구독 실행 1건을 끝까지 확인했다. 관측자가 새 모델 실행·재시도를 시작하거나 운영 문서/설정을 고치지 않았다. 모델은 `gpt-6.1-sol`, 추론 강도 medium이다. **예상한 정상 완료·큰 폭의 토큰 절감은 확인되지 않았다.**

| 단계 | 기록된 실제 입력 | 캐시 읽기(입력에 포함) | 입력−캐시 | 출력 | 실제 응답 기록 |
|---|---:|---:|---:|---:|---:|
| 내용 | 2,410,262 | 2,271,232 | 139,030 | 11,472 | 19 |
| 형식(중단) | 547,237 | 502,272 | 44,965 | 2,290 | 12 |
| 합계 | **2,957,499** | **2,773,504** | **183,995** | **13,762** | **31** |

수치는 Codex 원본 JSONL의 `token_usage_record`를 response_id별로 중복 제거한 합계다. 내용 단계 합계는 CLI `turn.completed.usage`와 일치한다. 형식 단계는 강제 중단되어 최종 CLI 사용량이 없으며, 미보고된 진행 중 요청의 사용량까지 확정할 수는 없다. worker 오류의 usage는 내용 단계의 2,410,262만 보유해 형식 단계의 기록된 547,237을 누락했고, 요청의 최종 usage도 저장되지 않았다. 이전 #1의 동일 방식 native 입력 2,958,812와는 수치상 1,313(0.044%)만 차이 난다. 현재 실행은 중단됐고 이전 문서와 입력 원본 해시 동일성도 확인하지 못했으므로 성공적인 절감률 비교로 사용하지 않는다.

확인한 실행 결과와 차이:

- 내용 단계는 20개 표·781행(머리행 20 + 자료행 761)·2,343셀을 저장했다. 사본의 본문 소유 개체는 기존 도형 5,639개에서 표 20개가 됐다. 원문은 서버와 같은 `documentEditHash/docBytesSync` 비교에서 보존됐다. 원문 문자열 조각 4,631개 중 4,619개가 표 텍스트에서 발견됐으며, 미포함 12개는 쪽 번호 7개·기타 2개·도움말 1개·explanation 2개다. 이 대조는 행/열 위치와 반복 글의 개수까지 입증하지 않으므로 완전한 의미 보존을 통과로 보고하지 않는다.
- 두 단계의 thread_id가 달랐고 형식 단계 첫 입력은 28,244토큰으로, 내용 마지막 입력 155,064토큰의 이력이 이어지지 않았다. 새 대화 경계는 의도대로 동작했다. 내용 중 형식 목록 조회의 EDIT_STAGE 1회는 단계 제한에 따른 거절이며 그 뒤 내용 처리는 계속됐다.
- 21:00:45에 보낸 형식 25동작은 현재 타입 검사에 유효하다. 그중 문단 서식 4동작의 대상은 2,283·60·20·40개였고, 나머지는 표 서식 20동작과 쪽 구성 1동작이다. `edit_workspace` 응답은 120초에 시간 초과했다. 감시 실행기는 21:02:48에 heartbeat 128,067ms 부재를 기록하고 21:02:53에 서버를 종료·자동 복구했다. `server/edit-workspace-service.js`의 문단별 동기 `formatRange` 반복과 그 안의 헤더/구역 재계산이 장시간 막힘의 원인으로 추정되지만, 개별 문단 시간 트레이스까지 얻은 것은 아니다.
- 21:02:53에 worker의 선점 갱신 실패 경로가 ABORTED로 끝났다. 사용자 취소 기록은 없고, 단계 종료·발행·완료에 도달하지 못했다. 최신 사본은 revision 5(스타일 가져오기까지), 형식 내용 해시는 내용 단계와 같으며 발행 제안은 0개다. 요청 표시는 관측 종료 시에도 working이었다. 중단 상태/사용량 저장 누락도 남은 결함이다.
- 원문 글은 24,505자인데 문단 주소·구분 등을 포함한 초기 Markdown은 126,775자였다. 내용 단계에서 작업 사본을 19회 조회했으며 첫 실제 입력부터 71,161토큰이었다. 새 대화 전환만으로 반복 입력과 누적 토큰이 충분히 줄지는 않았다.

[최종 관측 결과·실제 사용량·실패 연결·증거 해시](../artifacts/content-format-real-20261114-mwgch3xz44c830-r1/final-result.json). 해당 실행의 원본 스트림·두 Codex JSONL·사본·서버 종료 기록 208개 파일을 별도 사본과 SHA256 목록으로 보존했다. 브라우저/유료 API 재실행/추가 모델 실험/운영 재시작/제품 코드 수정은 하지 않았다.

## 2026-11-14 실문서 AI #1~#4 진단 및 수정

대상 `mwg38fksc852d7`의 요청 기록과 해당 요청을 실행한 Codex CLI 원본 JSONL 4개를 대조했다. 네 요청은 `route=agent`이며 유료 API 실행이 아니다. 원본 로그는 존재한다. 이 진단에서는 실제 모델을 재호출하거나 사용자 문서를 수정하지 않았다. 수치는 [추출 스크립트·원본 해시·집계](../artifacts/ai-audit-20261114/audit.json), [텍스트 토큰 추정](../artifacts/ai-audit-20261114/tokens.json)에 있다.

| 요청 | 저장된 입력 합계 | 캐시 읽음(입력에 포함) | 입력−캐시 | 실제 CLI 모델 응답 수 | 확인된 결과/문제 |
|---|---:|---:|---:|---:|---|
| #1 | 2,965,610 | 2,815,232 | 150,378 | 29 | 표 20개·기존 개체 삭제 20건. 전체 글을 확보하려고 문서 검색을 458회 반복 |
| #2 | 2,059,282 | 1,908,608 | 150,674 | 21 | 표 20개 폭 180mm·CENTER, 요약·도식·쪽 구성 등 35건. 글자처럼 표의 실제 정렬을 바꾸는 경로 누락 |
| #3 | 988,161 | 892,544 | 95,617 | 23 | 20개 중 3개 표만 수정하고 완료. 존재하지 않는 ref와 잘못된 제안 인자의 오류도 있음 |
| #4 | 545,754 | 466,176 | 79,578 | 12 | 11개 문단 직접 서식 제안 후 fail_request. 표준 역할 스타일 정의 생성/가져오기 경로 없음 |

입력 합계는 매 모델 응답 때 이전 대화·도구 정의·도구 결과를 다시 읽은 누적값이다. 실제 CLI 응답별 첫 입력은 16,554~31,304, 가장 큰 입력은 156,908토큰이다. 요청 기록에는 부가 작업 사용량도 있어 위 입력 합계와 CLI 본 세션 합계는 조금 다르다. `modelCalls=0, modelCallsUnknown=true` 기록을 실제 호출 0회로 해석하면 안 된다. 캐시 읽음은 새 문서 글과 구분해야 하며 이 수치로 구독의 금전 청구액을 계산하지 않는다.

사용자 비교 기준은 **20개 표와 같은 분량의 내용이 글자/Markdown으로만 있는 경우**다(20글자 아님). #1에서 저장한 표 20개의 792행·2,376개 셀을 빠뜨리지 않고 추출한 결과, 로컬 `o200k_base` 기준 Markdown 13,367토큰(34,410자), 탭 구분 글 12,821토큰(27,654자)이다. 이는 표에 저장된 텍스트 기준이며 변환 전 원문 전체와의 동등성 검증이나 실제 AI 재실행은 아니다. 지시·도구 정의·메시지 포장·반복 작업을 제외한 추정치이므로 그만큼의 토큰만으로 같은 작업이 끝난다는 뜻은 아니다. 다만 수백만 입력 전부가 본문 자체 때문은 아니다.

수정한 원인과 소비 경로:

- `read_document(from/to)`가 구역 내부 `p.body`로 범위를 골라 구역마다 p0인 문서의 뒷부분을 빈 결과로 돌려줬다. 문서 전체 본문 차례로 고쳤다. 응답 한도에 걸린 중첩 셀·긴 문단도 `이어 읽기.cursor`로 계속 읽고, source hash·문서·범위·view·nested가 달라지면 오류로 알린다. cursor가 없는 호출의 범위 선택은 그대로다.
- `get_request.tables`는 근처 상세 일부(최대 3개)였다. 전체 수 `tableInventory.total`과 `list_tables`의 페이지/전체 수/key/ref/크기를 추가했다. API·Codex 프로필과 Claude 채널 허용 목록·공통 지시에 연결했다. 현재 프로필 수는 API 32개·Codex 38개이며 아래의 26개 측정은 과거 기록이다. 도구를 요청 종류별로 제한하지 않는다.
- 제안 응답에 `tableUndo` 등 내부 XML/복원 스냅샷이 노출됐다. MCP 쓰기·목록 응답과 모델 전달에서 제안의 `*Undo/*Snapshot`만 제외하고, 제안 내용·오류·경고·이미지와 서버의 복원 기록은 유지한다. 저장된 91건을 읽기 전용 재생한 JSON은 2,272,210자 → 105,652자(95.4% 감소), 로컬 추정 786,084 → 44,876토큰이다. 당시 Codex가 도구 출력을 잘라 받은 흔적도 있어 이 감소율을 실제 모델 사용량 절감률로 주장하지 않는다.
- 글자처럼 표의 `align`은 표의 `hp:pos`만 바꿔 한/글에서도 제자리에 남았다. Node 엔진 `editTable`이 소유 문단 정렬도 바꾸고 함께 되돌리도록 고쳤다. 떠 있는 표는 기존 위치 속성을 사용한다. 한/글 2022(12.0.0.3146)의 독립 CreatePageImage에서 90mm 표 x는 LEFT=113px, inline pos.CENTER만=113px, 소유 문단 CENTER=227px, floating pos.CENTER=227px였다. 고정 WASM의 실제 계산값과도 대조했다. [입력·기준](../tests/fixtures/inline-table-align-20261114/), [원본 측정](../artifacts/ai-audit-20261114/table-alignment-oracle.json).

MCP 기능 경계(코드 연결 기준):

| 동작 | 편집기 WASM API | AI 서버/MCP 경로 |
|---|---|---|
| 기존 스타일 적용 / 새 스타일 정의 | `createStyle` 등 | 기존 styleId 적용 가능 / 정의 생성·가져오기 미연결 |
| 하이퍼링크 생성 | `insertHyperlinkEx` | 생성 미연결 |
| 누름틀 신규 생성 / 기존 틀 채우기 | `insertClickHereField*` | 생성 미연결 / `list_fields`, `propose_fill_fields`로 채움 가능 |
| 각주·미주 생성 | `insertFootnote`, `insertEndnote` | 생성 미연결 |

엔진 기능을 AI가 쓰려면 **허용된 호출 경로**가 필요하지만 UI 버튼마다 별도 MCP 도구 하나가 필요하지는 않다. 스타일 관리·링크·필드·주석처럼 관련 동작을 타입이 있는 도구로 묶거나 제한된 편집 명령에 연결할 수 있다. 문서 권한·시도·제안·복구·주소 검사를 함께 거쳐야 하며 임의 메서드/XML 실행으로 우회하지 않는다. 위 미연결 생성 기능은 이번에 구현했다고 보고하지 않는다. #4의 요청 대상도 문서 전체가 아니라 마지막 구역 11개 문단으로 전달됐다는 범위 차이가 있다.

검증: 새 재현 9/9, 기존 표/자동번호/저장 회귀 16/16, 기존 MCP/API/문맥/활동 회귀 26/28, 채널 브리지 142개 확인 통과. 기존 회귀 2건은 미해결로 남긴다: 크기 비율 검사는 새 tableInventory를 제외해도 `27425 < 34585×0.7`에서 실패하고, 활동 배열 검사는 기존 비동기 조판 확인 행이 추가되어 실패했다. 기준 완화·SKIP 처리를 하지 않았다. [검증 원문](../artifacts/ai-audit-20261114/verification.txt). 브라우저는 사용하지 않았고 유료 AI 재실행·원문 변환 품질 전수 대조·요약의 실제 한 쪽 여부는 미검증이다. 이 진단 직후에는 로컬 검증만 완료한 상태였으며, 최신 운영 상태는 위 실험 경로 절을 따른다.

## 이전 측정·설계 기록

2026-10-28. OpenAI Responses 호환 API(API의 OpenAI 경로 포함, `--gateway baze`)에서 기존 HWPX MCP 도구와 파일 반환 경로를 사용한다. 외부 CLI 실행기와 서버 개인 API 키 양쪽에 적용된다.

2026-11-03. **Claude(Messages API)·Gemini(generateContent) API도 같은 MCP 도구를 쓴다.** 세 제공자 모두 같은 허용 목록(`server/tool-profiles.js`의 `api` 프로필 — 읽기 13·요청 읽기 1·결과 쓰기 12, 26개)을 받는다. 같은 날 오후부터는 요청 종류별로 그 일에 쓰는 도구만 준다(아래 '요청 종류별 도구'). 개인 API 실행기, 서버 개인 키, 서버 공용 AI 모두 같다. 설계 근거는 [MCP_TOOLSET_PLAN_2026-11-03.md §10](MCP_TOOLSET_PLAN_2026-11-03.md).

## 기본 MCP 모드

`대기 요청 → 모델 도구 요청 → MCP 실행 → 결과를 모델에 전달 → 최종 결과 → 완료`

- 도구 정의는 MCP 서버의 `tools/list`가 단일 출처다. 실행기는 doc_id·request_id·expected_attempt·image_base64를 떼어 모델에 주고, 호출이 오면 고정한 값을 다시 채워 MCP `tools/call`로 보낸다(`server/api-mcp-tools.js`). 제공자 꼴은 어댑터가 씌운다: OpenAI `function`(`server/api-responses-agent.js`), Claude `tools[].input_schema` → `tool_use`/`tool_result`(`server/api-messages-agent.js`), Gemini `functionDeclarations[].parametersJsonSchema` → `functionCall`/`functionResponse`(`server/api-gemini-agent.js`). 반복문·호출 상한·취소 처리는 `server/api-tool-loop.js` 하나다.
- 주는 도구(`api` 프로필, 지시 요청): 읽기 `read_document`·`search_document`·`get_formatting`·`get_writing_guide`·`get_page_layout`·`read_skill_resource`·`list_memos`·`list_proposals`·`list_changes`·`list_attachments`·`read_attachment`·`list_figures`·`preview_figure`·`get_history`, 요청 `get_request`, 쓰기 `propose_changes`·`propose_format`·`propose_alternatives`·`propose_insert`·`propose_table`·`propose_table_edit`·`propose_delete`·`propose_toc_update`·`propose_page_layout`·`propose_figure`·`add_memo`·`export_figure`·`export_skill_resource`.
- 주지 않는 도구와 까닭은 `RUNNER_EXCLUDED`에 적는다: 요청 흐름(`start_request`·`complete_request`·`fail_request` — 실행기가 부름), 사람이 정할 일(반영·수락·거절·되돌리기), 다른 문서·요청(`list_documents`·`list_requests`·`claim_next_request`), 메모 고치기·지우기, 변경 요청 검토, ChatGPT Work 전용 파일 참조, 드라이브. 새 MCP 도구는 프로필이나 제외 목록 중 한 곳에 넣어야 `tests/api_tool_providers.test.mjs`를 지난다. Codex 실행기(`codex` 프로필)도 같은 목록에 요청 흐름·내 PC 작업 폴더 파일 도구를 더해 쓴다.
- 결과는 도구로 남겨도 되고 최종 JSON으로 내도 된다. 도구로 남긴 결과는 최종 JSON에서 뺀다(`withoutToolDuplicates` — 글 제안은 ref·find·replace, 서식은 ref·find, 문단 추가는 자리·글, 표는 자리·칸, 표 고치기는 표, 의견은 ref·글로 견주고, 여러 안·차례·그림은 도구를 불렀으면 뺀다). 같은 실행 안의 같은 쓰기 호출은 처음 영수증을 돌려줘 두 번 저장하지 않는다. 도구 오류 글(틀린 ref·find 등)은 서버 경로·실행기 경로 모두 모델에 그대로 되돌려 고치게 하고, 취소·다시 요청·선점 오류(`ATTEMPT_CHANGED`·`REQUEST_CLOSED`·`CLAIMED`·`CLAIM_REQUIRED`·`NOT_OWNER`)는 되돌리지 않고 실행을 멈춘다. 쪽 구성(`propose_page_layout`)은 최종 JSON에 없어 도구로만 된다.
- Claude: 구조화 출력(`output_config.format`)을 도구와 함께 보낸다. 생각·도구 호출 블록은 그대로 되돌리고, 한 차례의 `tool_result`는 한 사용자 메시지에 모은다. 도구 정의·시스템 지시와 첫 사용자 글(문맥·첨부)에 `cache_control`을 달아 라운드마다 다시 보내는 앞부분을 캐시한다.
- Gemini: 함수 선언은 JSON Schema의 일부만 받으므로 값 범위·패턴을 빼고 `oneOf`→`anyOf`, `const`→`enum`으로 바꾼다. 생각 서명(`thoughtSignature`)이 붙은 모델 차례를 그대로 되돌린다. 도구와 구조화 출력을 함께 거절(HTTP 400)하는 모델·게이트웨이는 구조화 출력 없이 한 번 더 보내고(스키마는 지시 글로) 답에서 JSON을 꺼낸다. Gemini는 제약이 많아 실제 게이트웨이에서는 함수 호출이 거절될 수 있다 — 그때는 `API_TOOLS_UNAVAILABLE`로 실패를 알린다(가짜 fetch 시험만 통과, 실제 호출 미확인).
- 비용: API는 라운드마다 받은 도구 정의 전체를 다시 보낸다. Claude는 `cache_control`, OpenAI는 접두 자동 캐시, Gemini는 묵시 캐시로 줄어든다. 주어진 문맥으로 충분하면 읽기 도구를 부르지 않도록 지시한다.

### 도구는 모델이 고른다(2026-11-03)

요청 종류(검토·다듬기·지시 …)와 관계없이 `api` 프로필 26개를 모두 주고 어느 도구를 쓸지는 모델이 고른다. 같은 날 요청 종류별로 도구를 좁혀 보았으나(검토 9개 등) 되돌렸다 — 사람이 상황에 맞춰 메뉴를 고르는 것에 기대지 않고 AI 가 지시·문맥을 보고 고르게 한다(사용자 결정). 도구 목록과 도구 규칙 글(`toolRules`)은 늘 같아 요청이 달라도 앞부분이 같고 캐시가 맞는다. `propose_change` 는 `propose_changes` 한 건과 같아 API 에서 뺀 채로 둔다.

### API 크레딧 계산 규칙(2026-11-03 실측)

**크레딧 = USD × 1000**, USD = Σ(토큰 × 단가) ÷ 1,000,000. 응답 머리글에는 비용이 없으므로 usage 토큰으로 계산한다. effort 는 단가를 바꾸지 않는다(모델 목록 `pricing` 은 모델별 한 값) — 추론 토큰 수만 바꾸고 추론 토큰은 출력 단가로 센다(gpt-6.1-sol 추론 1,000토큰 = 10 크레딧). 도구 반복에서는 추론 암호문(`reasoning.encrypted_content`)을 다음 라운드에 되돌려 보내므로 입력도 그만큼 조금 는다.

- 단가: 모델 목록 API `GET https://api.baze.co/v1/gateway/models/` 의 `pricing`(USD, `per_tokens` 1,000,000 — 조회는 과금 없음). gpt-6.1-sol 은 input 2 · output 10 · cache_read 0.1 · cache_write 2.5. 단가는 코드에 박지 말고 이 목록에서 읽는다.
- `/responses` usage 나누기: 일반 입력 = `input_tokens − cached_tokens − cache_write_tokens`(× input), `input_tokens_details.cached_tokens`(× cache_read), `input_tokens_details.cache_write_tokens`(× cache_write), `output_tokens`(× output — 추론 토큰 포함). 요청 기록 `usage` 의 input·output·cacheRead·cacheWrite 와 같다.
- 첫 호출은 입력 거의 전부가 캐시 쓰기(입력 단가의 1.25배)라 더 비싸고, 25~40분 안의 같은 앞부분은 캐시 읽기(0.05배)다.

| 실측(실문서C, 시각화 요청) | 입력 | 캐시 읽음 | 캐시 씀 | 출력 | 계산 | 대시보드 |
|---|---|---|---|---|---|---|
| 문서 전체, 첫 요청 | 89,963 | 0 | 89,960 | 1,244 | 237.3 | 238 |
| 기존 방식(문맥 2문단), 5라운드 | 129,391 | 117,382 | 11,994 | 507 | 46.82 | 46.98 |
| 문서 전체, 8분 뒤 다시 | 89,963 | 89,960 | 0 | 1,241 | 21.42 | 21.42 |

### 캐시 실측(2026-11-03, API gpt-6.1-sol, effort low)

관리자 개인 키를 격리된 임시 서비스(시험 문서 `tests/fixtures/tool_memo_tracked.hwpx`)에서 불렀다. 실제 `data/`·:8787 은 쓰지 않았다. 검토 A·B 는 종류별 묶음(9개)을 쓰던 때의 측정이다 — 지금은 모든 요청이 지시 C 처럼 26개를 받는다.

| 호출 | 도구 | 입력 토큰 | 캐시 읽음 | 출력 |
|---|---|---|---|---|
| 검토 A (첫 호출) | 9개 | 8,852 | 0 | 182 |
| 검토 B (곧바로, 다른 문단) | 9개 | 8,835 | 8,253 (93%) | 101 |
| 지시 C 1라운드(read_document 호출) | 26개 | 17,235 | 0 | 14 |
| 지시 C 2라운드(propose_changes 호출) | 26개 | 17,394 | 17,232 (99%) | 65 |
| 지시 C 3라운드(최종 JSON) | 26개 | 17,715 | 17,391 (98%) | 108 |

- API(OpenAI 경로)는 접두 캐시를 쓴다: 같은 종류의 다음 요청, 같은 요청의 다음 라운드 모두 앞부분이 캐시에서 읽혔다.
- 도구 묶음이 다르면(검토 9개 → 지시 26개) 앞부분이 달라 첫 호출은 캐시 없이 갔다. 지금은 모든 요청이 같은 26개라 요청 종류가 바뀌어도 앞부분이 같다.
- 도구 정의 1천 자 ≈ 300토큰(9개와 26개의 차이 28천 자 ≈ 8.4천 토큰). 26개 전부는 약 1.1만 토큰이다.
- **지속시간 실측**: 앞부분이 서로 다른 시험 요청 4개(각 5,412토큰)를 한꺼번에 캐시에 쓰고 각각 한 번만 다시 읽었다 — 10분 뒤·25분 뒤는 5,409토큰 캐시 읽음, 40분 뒤·60분 뒤는 캐시 없음(다시 5,409 씀). API gpt-6.1-sol 의 캐시는 마지막 쓰기·읽기에서 25~40분 사이에 사라진다 — OpenAI 문서의 GPT-5.6 이후 기본 '최소 30분'(읽으면 다시 30분)과 맞고, 그보다 길게 남지는 않았다. 쓰기는 1.25배·읽기는 0.05배(OpenAI 문서 — 기관 게이트웨이 요금은 따로 확인). 더 긴 `prompt_cache_options.ttl: "12h"`(쓰기 2.5배)는 시험하지 않았다.
- OpenAI 경로는 `usage.input_tokens_details.cached_tokens`(읽음)·`cache_write_tokens`(씀), Claude 는 `cache_read_input_tokens`·`cache_creation_input_tokens`, Gemini 는 `cachedContentTokenCount` 를 `usage.cacheRead`·`usage.cacheWrite` 로 모아 요청 기록(`r.usage`)과 활동 기록(`ai.run` — "토큰 입력/출력(캐시 읽음 n·씀 m)")에 남긴다. Claude·Gemini 경로의 실제 캐시는 재지 않았다.
- 차트 요청은 기본으로 `propose_chart`를 사용해 한/글에서 다시 편집 가능한 차트 개체를 만든다(2026-11-12 구현). 표가 있으면 `source_table`로 실제 행·열을 선택하며 PNG/Python이 필요하지 않다. 사용자가 그림 파일을 명시적으로 요청해 `propose_figure(chart)`를 쓰는 경우는 기존 Python·matplotlib PNG 경로다.
- `attachment_id`는 실제 저장된 파일을 사용한다. `replace_ref`는 그림 교체이며 캡션·번호·자리를 유지한다. 본문 반영은 사람이 결정한다.
- 문장·표·서식은 도구 또는 최종 JSON으로 저장한다. 그림 요청에 실제 그림 제안 없이 표·서식·설명으로 답하면 그 답은 그대로 받고, 그림이 없는 이유를 '그림 제안 없음: …' 의견 메모(모델이 남긴 이유, 없으면 서버가 쓴 이유)와 요청 기록·활동(ai.figure_missing)에 남긴다. 실패로 버리지 않는다.

### 편집 가능한 차트(2026-11-12)

`propose_chart(after_ref, chart, source_table?, width_mm?, height_mm?)`는 rhwp의 차트 API로 `hp:chart`와 `Chart/chartN.xml`을 만든다. 직접 자료는 `chart.categories/series`, 표 자료는 `source_table`의 표 key·머리행·항목 열·값 열·자료 행(모두 0부터) 중 한 출처만 쓴다. 표를 삭제하지 않고, 선택한 표 자료가 제안 후 바뀌면 적용을 막는다. 기존 제안·변경 추적·복구·요청/시도 고정을 사용한다. API·Codex·채널에 도구와 지침을 연결했다.

막대·가로 막대·꺾은선·원형·도넛·영역·누적·100% 누적 10종과 제목·범례·데이터 레이블·축 제목을 지원한다. 빈칸·결측값, 병합 셀 범위, 사용자 축 범위 등 미지원 입력은 오류로 알리며 그림으로 자동 대체하지 않는다. 원본 표와의 자동 동기화·기존 차트 AI 수정은 후속 범위다. [계획·계약·예시와 검증](NATIVE_CHART_2026-11-12.md), 시험 `npm run test:chart:native`.

### SVG 그림(2026-11-03)

차트로 그릴 수 없는 그림(상자형 도식·흐름도·개념도·구조도·표를 옮긴 그림 등)은 모델이 SVG 문서를 쓰고 서버가 PNG로 그린다. 작업공간(hosted)이 없는 API도 어떤 그림이든 넣을 수 있다.

- 도구: `propose_figure(svg, after_ref | replace_ref, width_mm, caption)`. 출처는 svg·chart·attachment_id·image_base64 중 하나다. `.svg` 첨부를 attachment_id로 주면 그 SVG를 그린다.
- 도구를 쓰지 않는 경로(모의 AI 등)·최종 JSON: `figures[{ afterRef, replaceRef, caption, widthMm, svg, reason }]`. 서버 개인 키는 결과를 저장하기 전에, 개인 API 실행기는 `propose_figure(svg)`로 그림 제안을 만든다. 못 그린 그림은 건너뛴 항목(실행기는 '그림 제안 없음' 의견)으로 남기고 나머지 결과는 받는다.
- 위치·크기는 AI가 정한다: after_ref = 그 본문 문단 바로 뒤, width_mm = 문서에 보일 폭. 폭을 생략하면 SVG 고유 폭(96dpi)이고, 둘 다 그 구역의 본문 폭까지다. 높이는 그림 비율이며 한 쪽 안으로 줄인다. 정렬은 기존 그림 규칙(좁은 그림 가운데)이다.
- 그리기: `server/figure-svg.js`. resvg(WASM, `@resvg/resvg-wasm`)로 그림마다 별도 스레드에서 그리며 30초 제한이 있다. 300dpi PNG, 바탕은 흰색이다. 외부 파일·웹 주소·스크립트는 무시하고 DOCTYPE·ENTITY는 거절한다. 글꼴은 서버의 한글 글꼴 한 벌로, KoPubWorld돋움체 → Noto Sans KR → 맑은 고딕 → 나눔고딕 → Noto Sans CJK 순서로 찾는다. `config.figures.fontFiles`로 바꿀 수 있다.
- PNG와 SVG 원문을 둘 다 첨부로 저장한다. 그림 제안의 `figure.svgAid`가 원문 첨부를 가리킨다. `.svg` 첨부는 글 첨부라서 read_attachment로 읽고, 내려받기는 octet-stream이다.

### BMP 그림 보내기

OpenAI·Claude·Gemini의 그림 입력은 PNG·JPEG·GIF·WebP만 받는다. BMP를 그대로 보내면 API가 요청 전체를 400으로 거절했다. 이제 read_attachment와 서버 AI 입력에서는 BMP를 무손실 보기용 PNG로 바꿔 보낸다(`server/image-convert.js` — 1·4·8·16·24·32비트, BITFIELDS, RLE8·RLE4). 문서와 첨부의 원본 바이트는 바꾸지 않는다. Work 결과 파일의 GIF·BMP·SVG 확장자도 맞췄다.

기존 명령은 기본 MCP 모드를 사용한다.

```powershell
npm run worker -- --provider openai --gateway baze --model gpt-6.1-sol --effort medium
```

새 코드를 읽도록 서버·개인 실행기를 재시작한다. ZIP 사용자는 새 배포본으로 갱신한다. 한 사용자 대기열에는 실행기를 하나만 연결한다.

## API 작업공간 모드

게이트웨이가 Code Interpreter·Files·Containers 파일 다운로드를 지원하면 `hosted`를 명시한다.

```powershell
npm run worker -- --provider openai --gateway baze --model gpt-6.1-sol --workspace hosted --effort medium
```

- API 작업공간의 Python으로 자유로운 그래프·파일을 만들 수 있다. 원본 이미지·PDF는 Files API로 전달한다. MCP로 읽은 이미지도 원본 바이트로 전달한다.
- `container_file_citation`의 파일을 같은 API 주소에서 다운로드한다. `image_generation_call` 결과가 반환되면 이미지 바이트도 회수한다. hosted에서 요청하는 기본 생성 도구는 Code Interpreter이며 별도 이미지 생성 도구는 자동 추가하지 않는다.
- 파일은 기존 요청 결과 첨부에 저장한다. 모델에는 첨부 ID·파일 이름·크기·SHA-256을 알려주며, 그 ID로 그림 제안을 만든다. 모델이 Base64를 작성하거나 복사하지 않는다.
- 이번 실행기가 올린 입력 사본만 끝날 때 삭제를 시도한다. API에서 생성한 결과 원본은 삭제하지 않는다. 삭제를 지원하지 않는 게이트웨이 및 결과 원본의 보관 정책은 제공자 설정을 확인한다.
- 입력은 10개·각 32MB, 결과는 10개·각 10MB 이내다. PNG는 청크 CRC·압축 스트림·일반 영상 행 길이를 검사한다. 다른 그림 형식은 기존 헤더·크기 검사 수준이다. 원본 바이트는 축소·색상 변환·재인코딩하지 않는다.

서버 공용 AI는 설정의 `ai.workspace: "hosted"`, 서버 개인 키는 `PUT /api/me/ai`의 `workspace: "hosted"`로 선택한다. 기본은 `"mcp"`이며 개인 키 갱신 시 생략하면 기존 선택을 유지한다. 현재 개인 키 화면에는 workspace 선택 항목이 없으므로 API 설정 또는 CLI 옵션을 사용한다.

API 웹 채팅의 작업 도구가 API에도 제공된다고 가정하지 않는다. 게이트웨이가 해당 도구·파일 경로를 지원해야 하며 작업공간 사용료가 발생할 수 있다. 기존 BAZE/ChatGPT 웹 대화·개인 지침·작업공간을 원격 실행하는 기능은 아니다. 지원 오류·파일 회수 실패는 성공으로 대체하지 않는다.

## 범위와 검증

문서 ID·요청 ID·시도는 실행기가 고정한다. 허용 목록 밖 도구(반영·삭제 등), 다른 문서·시도 지정, 모델 Base64는 거절한다. 선점·취소·재시도 검사는 기존 MCP를 사용하며 서버 개인 키에는 외부 JSON으로 만들 수 없는 내부 실행 표식을 사용한다. 같은 그림 제안의 반복 호출은 실행 안에서 한 번만 저장한다. 도구 반복은 24회·함수 호출은 48회로 제한한다(2026-11-04 — 3쪽 절 쓰기가 12회를 넘었다). API 키는 설정한 API 주소로만 전송한다.

`node --test tests/api_agent.test.mjs`는 MCP 차트 생성, 서버 개인 키의 파일 회수·그림 교체, HWPX 이미지 바이트 보존, 입력 파일 전달·정리, 취소·재시도·반복 상한·손상 PNG 거절을 검사한다. `node --test tests/api_tool_providers.test.mjs`는 모든 MCP 도구의 프로필 분류, 서버 개인 Claude·Gemini 키의 도구 왕복(생각 블록·생각 서명 되돌림, 결과 되돌림, 스키마 투영), Gemini 400 대체 경로, 도구·최종 JSON 중복 제거, 개인 API 실행기(Claude)의 원격 MCP 도구 사용을 검사한다. API 응답은 fake fetch이며 유료 API는 부르지 않는다. 실제 BAZE 계정의 도구 지원은 별도 확인이 필요하다.

공식 규격: [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter).
