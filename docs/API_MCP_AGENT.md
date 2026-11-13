# API에서 MCP 도구로 작업 처리

2026-11-05 검증 추가: native 흐름과 현재 읽기 규칙을 유지하면서, 모델 입력의 정확한 문단 중복만 제거하고 표·그림 자동번호를 원문과 분리한 메타데이터로 전달했다. 총 모델 토큰 절감은 실측에서 입증되지 않았다. 변경 범위·실측·제외 기록·운영 미반영 상태는 [검증 보고서](NATIVE_CONTEXT_DEDUP_2026-11-05.md)를 따른다. 아래 날짜별 측정/설계는 당시 기록이다.

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
