# 시험·검증 안내 — 무엇을 어떻게 확인하나 (2026-11-03, 8절 회귀시험 종류별 절차 2026-11-06)

다른 개발을 할 때 "이 변경은 무엇으로 확인하나"를 찾는 색인이다. 시험 명령 목록 자체는 `CLAUDE.md`(시험 줄)에 있고, 여기서는
**어떤 변경에 어떤 시험·도구를 쓰는지, 재사용할 받침과 조사 방법, 알려진 기존 실패, 기록 문서 위치**를 모은다.
회귀시험의 종류·순서·판정·기준 갱신 절차와 실제 예시 위치는 **8절**에 있다.

## 1. 기본 원칙

- `data/` 는 실제 문서, `config.json` 은 실제 토큰 — 시험에서 쓰지도 고치지도 않는다. 운영 문서로 확인하려면 `data/docs/<id>/current.hwpx`(또는
  `versions/<n>.hwpx`)를 scratch 폴더로 **복사**해서 쓴다. 시험 서버는 `tests/helpers/server.mjs`(임시 data·config·빈 포트).
- 개발을 마친 뒤 검증은 `verifier` 에이전트(effort medium). 바뀐 파일·확인할 점·돌릴 시험을 좁혀 넘기고, 메인이 이미 돌린 시험은 다시 시키지 않는다.
- **"같은 결과" 비교가 기본 증거다.** 속도를 위해 경로를 바꿀 때(묶음 처리 등)는 예전 길(하나씩)과 새 길의 결과를 견준다 — 바이트 같음이
  가장 좋고, 안 되면 뜻 같음(문단 글·서식 지문·개체 지문·남은 변경·그림 파일·rhwp 쪽마다 글)을 확인하고 다른 점을 설명한다.
- 바이트로 견줄 때는 시각(`new Date()`·`Date.now()`)과 `Math.random`(개체 새 id)을 고정한다(`tests/helpers/live-batch.mjs` 의 `frozen`).
- 웹 표시·조판은 모든 검사 단계에서 엔진 내부 계산값으로 확인한다(`AGENTS.md` §2.1, 아래 8.0절).
  특별히 브라우저가 필요한 기능 확인이나 사용자 명시 요청이 아니면 headless·headed 브라우저와 화면 캡처를 사용하지 않는다.
  시스템 클립보드는 다른 세션과 같이 쓰므로, 실제 브라우저 클립보드·한/글 붙여넣기 확인이 필요한 경우에만 조율한 뒤 사용한다.

## 2. 변경 종류별로 돌릴 것

| 바꾼 곳 | 자동 시험(`npm test` 안) | 더 확인할 것 |
| --- | --- | --- |
| 실시간 밀어 넣기 `server/live.js`, 개체·구역 지문(`engine/doc.js` `diffDocs`·`paragraphCodes`·그림 정규 지문) | `edit_preservation`(편집기 엔진 API → 실제 `PUT /live` 왕복 보존, 2026-11-12)·`live_bulk_insert`·`live_track_batch`·`live_memo_copy`·`live_styles`·`sections` | `npm run test:live`(아래 기존 실패 참고), 큰 문서 묶음 비교 `scripts/check-live-batch.mjs`, 큰 개체 문서 밀어 넣기 시간 `research/edit-preservation-20261112/preserve/big_push_bench.mjs` |
| 편집 뒤 검증 `server/edit-verify.js`(V1 구조 → `VERIFY_STRUCTURE` 로 저장 막음, V2 의도 → lean 영수증 경고 한 줄) | `edit_verify`(결함 주입 V1 8·V2 3 + 정상 대조 17) | `node scripts/measure-lean-flow.mjs`(영수증 글자 수 불변), 지연 `research/edit-preservation-20261112/verify/latency.mjs` |
| 편집 뒤 조판 검사(V3) `server/layout-check.js`·`layout-worker.js`(worker 스레드) | `edit_verify_layout`(중첩 칸·표 짝짓기·큐 합치기·지연) | 측정 `research/edit-preservation-20261112/verify/v3-measure.mjs` |
| 편집기 한컴 호환 누름틀 API `rhwp-studio/src/hwpctl/field-api.ts` | `hwpctl_put_field_text`(한/글 2022 PutFieldText 실측 글과 대조) | 형 검사 `research/hangul2022-features-20261111/impl/typecheck.mjs` |
| 누름틀 채우기 `engine/fields.js`·`list_fields`/`propose_fill_fields` | `field_fill` | 한/글 왕복 `research/edit-preservation-20261112/range/export_for_hangul.mjs` |
| 변경 추적 엔진 `engine/doc.js`(넣기·지우기·나눔·개체) | `engine*`·`engine_track_breaks`·`engine_track_objects`·`memo_delete`·`page_break`·`table_edit`·`shapes_sync` | 위와 같음 |
| 작업본(편집기 열기) `acceptAll`·`viewerCopy`·`flattened` | `viewer_copy_batch` | `scripts/check-viewer-copy.mjs`(운영 문서 사본 포함), `node tests/api_smoke.mjs`, `npm run smoke` |
| 편집기 엔진 `vendor/rhwp/src`(Rust) | `npm run test:objects`, `empty_object_caret`(캐럿), `object_numbering` | `cargo test --lib <이름>`(일부는 이 PC 에 없는 upstream 샘플로 실패), `npm run test:layout`, `npm run test:layout:regression`(한/글 정답 대비 조판 회귀 두 묶음 — `regression-20261103` 17,467회 + `regression-20261104` 개체 폭·각주 쪽 나눔·실문서A 관찰점, 합쳐 약 2분, 새 차이·악화면 실패) |
| 웹 ↔ 한/글 클립보드 | `clipboard*`·`hancom_board`·`native_paste_format`·`hyperlink_clipboard` | `python -I tests/native_clipboard_bridge.py`·`native_clipboard_rotation.py`·`clipboard_resources.py`(도우미), `npm run test:clipboard:hancom`(시스템 클립보드·한글), 아래 4절 한글 받침 |
| 상단 칩·보기 글 `web/view.js` | `view` | — |
| PC 폴더 연결·함께 검토 `server/local-folders.js`·`routes/local.js`, 저장소의 정한 id·`afterCommit`, 문서 만들기·이름·옮기기·지우기의 PC 폴더 갈래, 개인용 앱 `deploy/portable/personal.mjs` | `local_folders`·`personal_app`(= `npm run test:personal`) | 화면 `python -I tests/ui_local.py`(빈 포트 둘), 문서함 `npm run test:library`, 묶음 `npm run package:personal` 뒤 풀어서 `personal.mjs --no-window` 로 켜 보기(`docs/LOCAL_FOLDER_APP_2026-11-10.md` 8절) |

## 3. 재사용할 받침·도구

| 도구 | 하는 일 | 쓰는 법 |
| --- | --- | --- |
| `tests/helpers/live-batch.mjs` | 한 프로세스 안 서비스+LiveEditor(`liveFixture`), 묶음 켬·끔 결과 비교(`compareBatch` — 시각·난수 고정), 편집기 내보내기 흉내(`withoutParagraphs`·`withCopiedParagraphs`) | 시험 코드에서 import |
| `scripts/check-live-batch.mjs` | 문서마다 6장면(덩어리·전체 잘라내기, 다시 붙이기, 바꿔 붙이기 …)을 묶음 켬·끔으로 밀어 넣고 바이트 비교·시간 | `node scripts/check-live-batch.mjs <hwpx...> [--track tracked\|final]` |
| `scripts/check-viewer-copy.mjs` | 작업본을 묶음 수락 켬·끔으로 만들어 BYTE/SEMANTIC/DIFF 판정 | `node scripts/check-viewer-copy.mjs <hwpx...> [--a seq\|B\|BI] [--b …]` |
| `artifacts/live-track-cut-paste-20261103/push-repro.mjs` | 임시 HTTP 서버로 밀어 넣기 하나의 시간 + 100ms 탐침으로 **서버 전체가 멈춘 가장 긴 시간** | `node push-repro.mjs <기준.hwpx> <보낼.hwpx> tracked` |
| 같은 폴더 `push-prof.mjs`·`push-prof2.mjs` | 한 프로세스 밀어 넣기의 단계별 시간(엔진·서비스 함수 감싸기), 이벤트 고리 막힘 | `node push-prof2.mjs <기준> <보낼> tracked`. CPU 프로파일은 `node --cpu-prof` + 같은 폴더 방식 |
| 같은 폴더 `wc-time.mjs` | 잘라내기·다시 붙이기 뒤 작업본(편집기 열기) 시간 | `node wc-time.mjs <원본.hwpx> <빈.hwpx>` |
| 같은 폴더 `ui-repro.py` | headless Chromium + 임시 서버로 실제 Ctrl+A/C/X/V 재현, PUT /live 시작·끝, 상단 칩 글, 주 스레드 막힘 | `python -I ui-repro.py <hwpx> cut-paste <out.json>` |
| 같은 폴더 `caret-node.mjs` | Node 에서 rhwp 로 작업본의 캐럿 자리(getCursorRect) 확인 | `node caret-node.mjs <hwpx...>` |
| `artifacts/toc-font-paste-20261103/bench-copy.mjs`·`bench-browser.py` | 복사 시간(엔진·브라우저), 편집기 준비 시간(운영 빌드 vs 새 빌드 교대) | 각 파일 머리 주석 |
| `scripts/benchmark-clipboard.mjs`·`scripts/benchmark-native-clipboard.py` | 클립보드 변환 시간 | 각 파일 머리 주석 |
| `scripts/layout-trace.mjs`·`scripts/layout-probe.mjs` | 조판이 한/글과 갈라지는 문단 찾기·조판 시험지 | `CLAUDE.md` 참고 |

`artifacts/` 의 도구는 그 작업 때의 사본이다(경로가 `<repo>` 로 고정된 것이 있다). 여러 번 쓸 것은 `scripts/` 로 옮긴다.

## 4. 한/글 실측 받침 (2018·2022)

- `artifacts/toc-font-paste-20261103/harness/` — `hh.py`(내가 띄운 Hwp 만 다룸·ROT·2018 `-Automation`), `paste_matrix.py`(시스템 클립보드 →
  숨은 한글 붙여넣기, 사용자 입력 중이면 기다림), `insert.py`(클립보드 없이 InsertFile 로 붙여넣기 차이 재현), `fontdump.py`(붙인 결과의 글꼴·크기·
  자간), `e2e.py`(운영 편집기 빌드 → Chromium Ctrl+C → 한글), `samewin.py`(같은 한글 창 붙여넣기), `dlgwatch.py`(숨은 대화 상자 닫기).
- 규칙은 `CLAUDE.md`(임시 폴더만, `SetMessageBoxMode(0x00011011)`, 패스마다 하위 프로세스, 내가 띄운 Hwp.exe 만 정리)와
  `docs/CLIPBOARD_AND_FORMAT_COPY.md`. 화면이 잠겨 있으면 클립보드를 못 연다 — InsertFile 대용으로 먼저 확인한다.

## 5. 운영 사고 조사 방법

- **브라우저 기록** `data/runtime/client-log.jsonl`: `at`(브라우저 시각)·`recv`(서버가 받은 시각)·`session`·`page`. 문서 id 로 거른 뒤
  같은 메시지는 접어서 본다. `recv − at` 가 크면 브라우저나 서버가 그동안 멈춘 것이다.
- **문서 기록** `data/docs/<id>/meta.json`: `activity`(편집·설정 차례와 '1문단 변경, 583 추가' 같은 요약), `versions`(판 — 실시간 밀어 넣기는
  `seq` 로 보낸 창을 안다), `liveTouch`(마지막 작성자·보낸 글 지문 — 빈 글 지문 `2jmj7l5rSw0yVb/v`). 판 파일 `versions/<n>.hwpx` 를
  복사해 변경 표식 수(`deleteBegin`·`insertBegin`)·문단 수를 센다.
- **서버** `data/runtime/server-state.json`(pid·재시작), `events.jsonl`(시작 출력).
- 재현은 그 판 사본으로 임시 서버에서 — 3절 `push-repro`(서버)·`ui-repro`(화면). 보고서 예: `artifacts/live-track-cut-paste-20261103/REPORT.md`.

## 6. 알려진 기존 실패 (2026-11-03 기준 — 새 변경 탓으로 착각하지 않게)

- `tests/studio_typing_performance.test.mjs` "build patches retain unique upstream anchors": progressive-open 패치 두 개
  (`progressive-open-load-retry-wrapper`·`-end`)가 `src/view/canvas-view.ts` 기준 글을 못 찾음. `build-studio --check` 의 NG 2 도 같은 것.
- ~~`npm run test:live`(`tests/api_live.mjs`): '손대지 않은 작업본(편집기 내보내기)을 다시 보냄 → 커밋 없음' 확인들 — 밀어 넣기 앞
  `copyStyleDefinitionsFrom` 이 문단 모양 정의를 더해 서식 커밋이 생김(11-01 스타일 정의 복사 도입 뒤로 보임). 첫 실패에서 멈춘다.~~
  → 2026-11-04 고침(같은 이름 스타일은 옮기지 않음 — `engine/formatting.js`, rhwp 가 개요 8~10 의 hp:switch 개요 수준을 잃어 같은 정의가 달라 보였음).
  195개 통과. 자세히는 `artifacts/layout-fix-20261103/reports/fix-ui-studio.md`.
- `cargo test --lib cursor` 등: 이 PC 에 없는 upstream 샘플(`samples/…`)을 읽는 시험 10개.

## 7. 기록 문서 목록

| 주제 | 문서 |
| --- | --- |
| 변경 추적 큰 잘라내기·붙여넣기, 작업본 속도(측정·재현·비교 결과) | `artifacts/live-track-cut-paste-20261103/REPORT.md` |
| 웹 → 한글 붙여넣기 글꼴, 복사 지연, 한글 실측 | `artifacts/toc-font-paste-20261103/REPORT.md`, `docs/CLIPBOARD_AND_FORMAT_COPY.md` |
| 한글 2018·2022 ↔ 웹 서식 보존(방법·실험·코드 목록·최종) | `docs/HANCOM_WEB_FIDELITY_HANDOFF_2026-11-02.md`, `docs/HANCOM_WEB_FIDELITY_CODE_INDEX_2026-11-02.md`, `docs/HANCOM_WEB_FINALIZATION_2026-11-02.md` 와 같은 날 `HANCOM_WEB_*` |
| 엔진 소스 색인 | `docs/FINAL_ENGINE_SOURCE_INDEX_2026-11-02.md` |
| 구역을 넘는 편집(한/글 실측 fixture) | `docs/SECTIONS.md` |
| 편집기 입력 반응성 | `docs/EDITOR_PERFORMANCE_2026-10-28.md` |
| 글꼴 공급·지연 읽기 | `docs/FONT_SUPPLY_2026-11-01.md`, `docs/FONT_LAZY_LOADING_2026-11-01.md` |
| 바뀐 점(작업마다 시험·측정 한 줄) | `docs/CHANGELOG.md` |
| 그 밖의 작업별 산출물 | `artifacts/<주제>-<날짜>/`(클립보드·글꼴·드라이브·자동화 등 — 폴더마다 보고서나 기록) |

## 8. 회귀시험 종류별 절차 (2026-11-06)

"무슨 시험을 골라, 어떤 순서로, 무엇을 근거로 판정하나"를 종류별로 적는다. 모든 시험을 돌리라는 목록이 아니다 — 바뀐 값을 소비하는
경로에 맞는 종류만 고른다. 아래 경로는 2026-11-06 에 실제로 있는지 확인했다.

- 표시 **[PC]** = 이 PC 에만 있는 실행 결과·기준 자료(`artifacts/`·`output/`·`hwp2024/`). 배포 꾸러미나 다른 PC 에는 없을 수 있다.
- 예시 결과·저장된 해시는 **그때 그 엔진의 기록**이다. 현재 엔진이 검증됐다는 뜻으로 인용하지 않는다.
- 실행 스크립트(`scripts/`·`tests/*.py|mjs`), 고정 자료(fixture — 입력과 한/글 기준, `tests/fixtures/`), 생성 결과(`runs/`·`reports/`·`artifacts/`)를 구분한다.
  fixture 폴더 안의 `runs/` 는 생성 결과이지 기준이 아니다.

### 8.0 모든 종류에 공통

**웹 환경 확인 — 모든 검사 단계의 기본 방식**
- 웹에 표시될 결과는 엔진 내부 계산값으로 확인한다. 사용자가 확인한 엔진 예상값과 웹 실측값의 일치를 근거로 정한
  검증 방침이며, 조사·수정 전후·부분 검사·전체 회귀·최종 확인에 모두 적용한다.
- 같은 입력·같은 엔진 경로에서 쪽·줄·개체 좌표와 크기, 선택 글꼴, 글자 폭·기준선 등 필요한 값만 메트릭·트레이스·출력 데이터로 비교한다.
  웹 화면을 다시 캡처하는 절차나 headless 브라우저 실행을 기본 단계에 추가하지 않는다.
- 엔진만으로 확인할 수 없는 브라우저 고유 동작(입력·포커스·IME·권한·클립보드 API·DOM/CSS·글꼴 로딩 등)이나
  사용자가 명시적으로 요청한 경우에만 브라우저·캡처를 사용한다. 필요한 이유와 범위를 먼저 적는다.
- 아래의 UI 명령·캡처 예시는 이 예외가 필요한 작업의 절차다. 브라우저를 실행하지 않았다는 이유만으로
  엔진 계산값을 통한 웹 표시 검증을 미완료로 처리하지 않는다. 실제 브라우저 실행·실측 여부는 보고에서 별도로 구분한다.
- 원본 한/글 기준과 엔진 결과의 비교는 유지한다. 엔진 계산값을 웹 실측 대신 사용한다는 방침이
  한/글 정답과의 차이까지 이미 해결됐다는 뜻은 아니다.

**순서**
1. **작은 재현 + 정상 대조군**: 증상 문서의 사본이나 사례 ID 하나(`--only`·`--select`·`--fonts`)와, 같은 조건에서 맞게 나오는 대조 사례 하나.
2. **수정 전후**: 같은 입력·같은 판정으로 수정 전 실패(의도한 원인으로) → 수정 후 통과를 확인한다. 수정 전에도 통과하면 그 결함을 잡는 증거가 아니다.
3. **관련 범위**: 바뀐 값을 소비하는 묶음(아래 각 절의 '고르는 때').
4. **영향이 넓을 때만 전체**: `npm test` 전체, `npm run test:layout:regression` 두 묶음 전체, 전수 벤치마크. 큰 차이가 보이면 전체를 돌리기 전에 원인부터 고친다.

**판정**
- **통과 / 실패 / 미검증**으로 나눈다. 기준 누락·입력 해시 불일치·한/글 열기 실패·SKIP·대상 0건은 미검증(자료·환경 오류)이며,
  통과나 조판 실패로 바꾸지 않는다. 종료 코드 0 이라도 조용히 return 했거나 비교한 사례가 0이면 통과가 아니다.
- **대상 엔진을 적는다**: `vendor/rhwp/pkg/cowork-engine.json`(빌드 시각·프로필·고친 파일)과 `rhwp_bg.wasm` SHA-256.
  후보 빌드는 고정한 사본에 `RHWP_PKG=<폴더>`(Node 시험) 또는 `--pkg <폴더>`(회귀 스크립트)로 돌리고, 운영 반영본 결과와 섞지 않는다.
- **재사용**: 엔진 해시·입력 해시·판정 코드가 모두 같은 결과만 재사용한다. 코드가 바뀌면 영향받은 사례는 다시 돌린다. 부분 실행(`--only`·`--limit`·`--select`)의
  결과를 전체 통과로 보고하지 않는다.

**장시간·한/글 COM·벤치마크**
- 시작 전에 같은 작업이 이미 도는지 확인한다(프로세스, 잠금, `status.json`). 상태를 묻는다는 이유로 다시 시작하지 않는다.
- CPU 는 PC 전체의 50% 까지(`CLAUDE.md`, `scripts/cpu-cap.ps1`). 한/글은 내가 띄운 인스턴스만 다룬다(`tests/helpers/hangul_com.py` — DispatchEx·소유 PID 확인·
  파일 열기 전 보안 모듈 `RegisterModule('FilePathCheckDLL', 'HwpxCoworkFilePathCheck')`). 사용자가 띄운 한/글 창과 시스템 클립보드는 공유 자원이다.

**기준값·발견 기록 갱신과 새 회귀 사례 추가**
1. 기대값은 한/글 실측에서 가져온다. **어느 판·빌드**(이 PC 한/글 2022 `12.0.0.3146`, 외부 PC 한/글 2024 `13.0.0.564`)인지, **어떤 출력**
   (COM `CreatePageImage` 쪽 그림 / PDF / 한/글이 다시 저장한 HWPX)인지 함께 적는다. 판이나 출력 방식이 다른 기준은 한 판정에 섞지 않는다.
2. 기존 기준 폴더는 덮어쓰지 않는다. 새 기준은 새 폴더나 새 파일로 만든다(`layout-regression.mjs prepare` 는 자료가 있으면 거부한다).
3. 발견 기록(`known-observations.json`·`pagesplit_known.json`)은 "아직 남은 차이"의 기록이지 한/글과 같다는 승인이 아니다. 다시 고정할 때는
   이전 기록을 날짜 붙인 파일로 남기고, 사라진 것·새로 생긴 것·종류가 바뀐 것을 근거와 함께 문서에 적는다
   (예: `docs/LAYOUT_REGRESSION_2026-11-03.md` 8장). 새로 생기거나 악화된 차이를 받아들이는 것은 사용자 결정이 필요하다.
4. 시험 기대값을 바꾸는 판단은 `docs/STALE_TESTS_2026-11-04.md` 의 기준을 따른다. 기대값을 바꾸는 경우는 시험이 낡았다는 독립 근거가 있을 때뿐이다.
   진짜 결함이면 시험은 두고 제품을 고친다. 단언을 지우거나 허용 오차를 근거 없이 키우지 않는다.
5. 새 회귀 사례는 원본(사용자 문서는 사본)과 입력 해시, 한/글 기준, 수정 전 실패·수정 후 통과 기록을 함께 남긴다.
   빈칸으로 남은 범위는 각 묶음의 `manifest.json`(`coverageGaps`)이나 README 의 미검사 범위에 적는다.

### 8.1 한눈에 보기

| 종류 | 확인하는 것 | 한/글 필요 | 기록된 시간 |
|---|---|---|---|
| 1. 서버·문서 엔진(Node) | 서버 API·변경 추적·메모·실시간·MCP 동작 | 없음 | `npm test` 약 94초(11-03) |
| 2. Rust 엔진 단위 | 엔진 함수 단위 계약 | 없음 | `cargo test --lib` debug 전체 약 391초(11-04) |
| 3. WASM 조판 fixture 회귀 | 저장된 한/글 2022 기준 대비 쪽·줄·개체 상자 | 없음(기준은 저장본) | `test:layout:regression` 두 묶음 약 2분 |
| 4. 한/글 2022 기준 만들기·진단 | 새 기준 생성, 갈라지는 문단 찾기 | 한/글 2022 COM | 문서·묶음 크기에 따름 |
| 5. 한/글 2024 쪽 그림 비교 | 실문서 쪽 그림 실루엣·쪽 수·문단 수 | 기준 PNG 는 이미 있음 | 전체 약 915초(11-05) |
| 6. 저장·왕복 | 저장한 HWPX 를 한/글이 열고 내용·메모·변경을 보존 | 일부 | 수 초 ~ 수 분 |
| 7. 웹 ↔ 한/글 클립보드 | 복사 보드·붙여넣기 결과 | 일부(시스템 클립보드) | 1~2분(UI) |
| 8. 웹 환경·화면 | 기본은 엔진 계산값. 브라우저 고유 동작·사용자 요청만 실제 UI 확인 | 대부분 없음 | 시험마다 다름 |
| 9. 글꼴·특수문자 | face·언어 슬롯·fallback·글리프 모양 | 한/글 2022 COM | 전수는 장시간 |

이 프로젝트에서 **'asan'은 실문서B 문서**(빈 문단 조사, 3절·5절)를 가리킨다. AddressSanitizer·fuzz 같은 크래시 전용 도구는 찾지 못했다.
크래시는 원인 입력을 작은 재현으로 줄여 1·2·3번 시험으로 만든다.

### 8.2 서버·문서 엔진(Node)

- **고르는 때**: `server/`·`engine/`·`web/` 동작, API·MCP·대기열·메모·변경 추적을 바꿨을 때. 무엇을 돌릴지는 2절 표.
  **증명하지 못함**: 한/글 조판·한/글이 연 결과(→ 3~6번).
- **준비**: 프로젝트 루트. `npm test` 에는 WASM 을 쓰는 시험(`layout_fidelity`·`layout_pagesplit`·`asan_empty_paragraph` 등)도 들어 있어 `vendor/rhwp/pkg` 빌드가 있어야 한다.
  API 시험은 임시 data·config·빈 포트 서버(`tests/helpers/server.mjs`)를 스스로 띄운다 — `data/`·`config.json`·:8787 은 건드리지 않는다.
- **명령**: 파일 하나 `node --test tests/<이름>.test.mjs` → 관련 묶음(`npm run test:live`·`test:cr`·`test:mcp` …) → 전체 `npm test`(`--test-concurrency=4`).
- **예시**: 받침 `tests/helpers/live-batch.mjs`(3절), 변경 추적·메모 문서 `tests/fixtures/tool_memo_tracked.hwpx`, 큰 문서 비교 `scripts/check-live-batch.mjs`.
- **판정**: 알려진 기존 실패(6절)와 새 실패를 나눠 보고한다. 11-03 전체 실행 기록은 `docs/COM_REGRESSION_BENCHMARK_2026-11-03.md`(950개 중 2개 실패 — 그때 기록).

### 8.3 Rust 엔진 단위 (`vendor/rhwp`)

- **고르는 때**: `vendor/rhwp/src` 를 고쳤을 때, 고친 모듈의 단위 시험을 먼저 돌린다. **증명하지 못함**: 한/글과 같은 조판(→ 3번), WASM 빌드 반영(→ `build:engine`).
- **준비**: 작업 디렉터리 `vendor/rhwp`, `~/.cargo/bin` 이 PATH 에 있어야 한다. 루트 `.cargo/config.toml` 이 jobs·시험 스레드를 8로 막는다. 몇 분 넘게 돌면 `cpu-cap.ps1` 을 건다.
  target 은 공유 캐시 `target/pr-review` 다.
- **명령**(기록된 형태, `docs/HANCOM_WEB_FIDELITY_CODE_INDEX_2026-11-02.md`):
  `cargo test --locked --lib <모듈::경로::tests> --profile release-test --target-dir target/pr-review`. 전체 `cargo test --lib` 는 영향이 넓을 때만 돌린다.
- **알려진 실패**: 이 사본은 blob 없는 부분 클론이라 `samples/`·`template/` 표본을 읽는 시험 92개가 실패한다(11-04 기록 3,789 통과 · 92 실패,
  분류 `docs/STALE_TESTS_2026-11-04.md`, 전체 표 `artifacts/layout-fix-20261103/reports/stale-rust-tests.md` [PC]). 새 실패만 따로 센다.
- **통합 시험 주의**: `vendor/rhwp/tests/cases/` 에는 로컬 사례 3개(`asan_empty_paragraph.rs`·`nested_table_measurement_owner.rs`·`stored_negative_spacing.rs`)만 있다.
  이 셋은 `Cargo.toml` 의 `[[test]]` 에 등록되어 있지 않다. 등록된 `[[test]]` 경로(`tests/generated/…`, `tests/issue_*.rs`)는 이 사본에 파일이 없다.
  upstream 의 suite 준비 도구(`scripts/rust-test-suite-manifest.mjs`)도 없다. 그래서 통합 시험의 로컬 실행 방법은 **확인되지 않았다**.
  돌렸다고 보고하려면 실제 명령과 결과를 함께 적는다.

### 8.4 WASM 조판 fixture 회귀 (저장된 한/글 2022 기준, 한/글 불필요)

엔진 조판을 바꿨을 때의 기본 회귀다. 모두 `RHWP_PKG`(또는 `--pkg`)로 후보 빌드를 지정할 수 있다(기본 `vendor/rhwp/pkg`).

| 묶음 | 명령(루트) | 고정 자료(입력·한/글 기준) | 고르는 때 |
|---|---|---|---|
| 조판 충실도 | `npm run test:layout` | `tests/fixtures/layout/*.hwpx·*_hangul*.json`(보정 문서 `calib_widths`, 시험지 `probe_objects`, `macro_resized`, 실문서 줄 `plan_/stats_hangul_lines.json`·`big_hangul_rows.json`) | 글자 폭·줄 나눔·그림 배치·쪽 끝 |
| 쪽 나눔 288사례 | `npm run test:layout:pagesplit` | `tests/fixtures/layout/pagesplit/`(`cases.json`, `pagesplit_body_hangul.json`·`_column_hangul.json`, 발견 기록 `pagesplit_known.json`) | 쪽 경계·표 나눔 |
| 조판 회귀 두 묶음 | `npm run test:layout:regression` | `tests/fixtures/layout/regression-20261103/`(8,734사례·17,467검사), `regression-20261104/`(W 개체 폭·F 각주 줄·R 실문서A) — 각 `manifest.json`·`cases.csv`·`inputs/`·`oracle/`·`known-observations*.json`·README | 개체 배치·쪽 나눔·각주·저장 경로 |
| 빈 문단 37조건 | `node scripts/empty-paragraph-regression.mjs check` | `tests/fixtures/layout/empty-paragraph-20261105/`(`manifest.json`·`input-definitions.json`·`native-case.json`·`oracle/`) | 빈 문단·빈 run·공백 문단 |
| 빈 문단 입력 보존 | `node --test tests/asan_empty_paragraph.test.mjs`(`npm test` 안) | 위와 같은 묶음 | 파서·빈 요소 보존 |
| 따옴표 줄 끝·run 없는 빈 문단 | `node --test tests/layout_hangul_probes_20261111.test.mjs`(`npm test` 안) | `tests/fixtures/layout/hangul-probes-20261111/`(한/글 재저장본 3개 + `expected.json`, 저장 줄을 지워 엔진이 새로 조판) — 재현·다시 재기 `artifacts/test-failures-20261111/` | 줄 꼬리·머리 금칙(`"`·`(`·`'`·`“`), 암묵 10pt 빈 줄(vendor/README 77) |
| 나뉜 칸 쪽 끝 줄(28 경계쌍) | `node --test tests/layout_cellcut_hangul.test.mjs`(`npm test` 안, 저장 줄 없는 입력은 `scripts/layout-probe-cellcut.mjs` 로 다시 만듦) | `tests/fixtures/layout/cellcut-20261111/`(`boundary.json`·`saved/`·`hangul_summary.json` 496사례, 한/글 12.0.0.3146 COM) — 다시 재기: `layout-probe-cellcut.mjs` → `layout-probe-cellcut-oracle.py` → `layout-probe-cellcut-engine.mjs` | CELL 표 쪽 끝 줄·통째 수용의 1pt 경계(vendor/README 76) |

- **좁혀 돌리기**: `node scripts/layout-regression.mjs check --dir tests/fixtures/layout/regression-20261103 --only <사례ID,…> --runs <임시 폴더> [--pkg <후보>]`.
  `check` 는 결과를 기본으로 fixture 안 `runs/check-comparison.json` 에 쓴다. 개발 중 실행은 `--runs` 로 fixture 밖에 둔다.
  자료 무결성만 볼 때는 `npm run layout:regression:integrity` 를 쓴다.
- **판정**: `check` 는 발견 기록보다 **새 차이·악화**가 있으면 종료 1 이다. 통과는 "기록보다 나빠지지 않았다"는 뜻이고, 한/글과 같다는 뜻이 아니다
  (11-05 기록으로 운영판에 1,563 + 4,452건이 남아 있다 — `docs/ENGINE_REGRESSION_MISMATCH_REVIEW_2026-11-05.md`, 사례별 색인 `artifacts/engine-mismatch-review-20261105/index.md` [PC]).
  `test:layout:regression:strict` 는 알려진 차이도 모두 실패로 센다(전체 상태 확인용이며 기본 관문이 아니다).
  빈 문단 `check` 는 현재 엔진에서 종료 1 이 정상이다(차이를 허용하는 기준선을 만들지 않았다 — README).
- **대표 예시**: 한/글 쪽 그림과 엔진 SVG 가 함께 있는 사례 `tests/fixtures/layout/regression-20261103/evidence/<사례ID>/`(예: `REAL-police/hancom/41.png`).
  전체 실행 결과 `regression-20261103/runs/tier-full-20261104d.json`(그때 엔진 a6947b43…), 빈 문단 현재 엔진 결과 `empty-paragraph-20261105/runs/current/report.md`.
  구성·판정 기준·실행 방법은 `docs/LAYOUT_REGRESSION_2026-11-03.md`, `docs/LAYOUT_PAGESPLIT_2026-11-03.md`, `docs/EMPTY_PARAGRAPH_REGRESSION_2026-11-05.md` 를 본다.
- **발견 기록 갱신**: pagesplit 은 엔진을 고친 뒤 고쳐진 칸만 빠지는 것을 확인하고 `UPDATE_KNOWN=1 node --test tests/layout_pagesplit.test.mjs` 를 돌린다.
  조판 회귀는 전체 `audit` 다음에 `freeze` 한다. `freeze` 는 이미 있는 기록을 덮어쓰지 않으므로, 갱신 절차는 각 README 와 `LAYOUT_REGRESSION` 8장을 따른다.
  둘 다 8.0 의 갱신 규칙을 지킨다.
- **배치 조합 목록**(`npm run layout:combos`·`layout:matrix` → `tests/fixtures/layout/matrix/`)은 빈칸을 찾는 발견용이며 회귀 관문이 아니다(`docs/LAYOUT_MATRIX_2026-11-03.md`).

### 8.5 한/글 2022 기준 만들기·진단 (COM)

- **고르는 때**: 새 사례의 정답이 필요할 때, 또는 엔진이 한/글과 어디서 갈라지는지 찾을 때. 기존 기준으로 충분하면 다시 만들지 않는다.
- **기준의 종류**: 조판 회귀의 정답은 COM `CreatePageImage` 쪽 그림(색 표식, 96dpi)과 문단 쪽 번호다. 재저장 HWPX 의 줄 정보는 묶음에 따라 보조로 쓴다
  (빈 문단 묶음은 표시 정답으로 쓰지 않는다). PDF 는 `test:layout` 의 일부 실문서 줄 기준과 글꼴 face 추적에 쓴다. 인쇄·PDF 와 쪽 그림을 한 판정에 섞지 않는다.
- **도구**: `tests/hangul_page_images.py`(쪽 그림·재저장, `scripts/hangul-oracle.mjs` 가 부름), `python -I scripts/layout-regression-oracle.py --dir <새 폴더> --resume`,
  `npm run layout:pagesplit -- --hangul`(약 45초), `npm run layout:probe -- --hangul`, `python -I scripts/empty-paragraph-oracle.py`,
  진단 `npm run layout:trace -- <hwpx> --run-hangul [--decisions]`.
- **준비**: 이 PC 의 한/글 2022. 입출력은 임시 폴더에서 하고, 사용자 문서는 사본으로 쓴다. COM 병렬은 2개가 기본이며 3개는 시작 실패 기록이 있다
  (`docs/COM_REGRESSION_BENCHMARK_2026-11-03.md`).
- **예시**: 기준 재측정과 검증 기록 `artifacts/oracle-tables-fix-20261103/verification.json` [PC], 표식 색·쪽 번호 방식은 `COM_REGRESSION_BENCHMARK` 문서에 있다.

### 8.6 한/글 2024 쪽 그림 비교

- **고르는 때**: 실문서(실문서A·실문서B) 쪽 단위 결과를 한/글 2024 기준으로 볼 때. **증명하지 못함**: 글리프 동일성, 이전 엔진보다 나아졌는지(`--baseline` 없이는).
  웹 표시·조판은 8.0절에 따라 엔진 계산값으로 확인하며, 이 비교 자체가 브라우저 실행·캡처 결과는 아니다.
- **기준 [PC]**: `hwp2024/20261105-151602/`(`police/`·`asan/` 300dpi PNG, `execution.json`). 외부 PC 의 한/글 2024 `13.0.0.564` COM `CreatePageImage` 로 만들었다.
  원본 묶음은 `hwp2024/20261105-151602.zip`, 생성 지시는 `hwp2024/HWP2024_PNG_EXPORT_INSTRUCTIONS.md`, 외부 PC 용 꾸러미는 `artifacts/hancom2024-handoff-20261105/` 다.
- **명령**(루트): `python scripts/compare-hwp2024-png.py --reference hwp2024/20261105-151602 --out artifacts/hwp2024-png-regression-<새이름> --pkg <후보 pkg> [--select police:28,69] [--baseline <이전 결과 폴더>]`.
  `--pkg` 가 없으면 실행 중인 서비스(`--base-url` 기본 `http://127.0.0.1:8787`)의 WASM 을 읽어 비교한다 — 운영 반영본 비교이며 후보 빌드 검증이 아니다.
  지표는 `vendor/rhwp/scripts/visual_sweep.py` 의 실루엣 계산을 쓴다. 비교기 자체의 지표 시험은 `tests/hwp2024_png_regression_test.py`(unittest, 엔진 시험이 아니다).
- **판정**: 쪽 수 일치, 문단 수 보존, 모든 쪽 6px 실루엣 90% 이상. 점수는 위치 유사도이며 글꼴 획·대체 글꼴의 영향을 받으므로 오류 개수로 읽지 않는다.
- **예시 결과 [PC]**: `artifacts/hwp2024-png-regression-20261105-151602/`(`REPORT.md`·`pages.csv`·`regression.json`). 그때 운영 WASM `e26c886d…` 의 판정은 **FAIL** 이었다(실문서A 30쪽·실문서B 2쪽이 90% 미만).

### 8.7 저장·왕복

- **고르는 때**: 저장기(서버 `engine/`·rhwp serializer)·내보내기·메모·변경 추적 저장을 바꿨을 때.
- **한/글 없이**: `tests/hwpx_save_roundtrip.test.mjs`(`npm test` 안 — 한/글 2022 가 여는 데 필요한 요소, 규칙 `tests/helpers/hwpx-required.mjs`), `node tests/rhwp_roundtrip.mjs`(엔진 → rhwp → 엔진).
- **한/글 2022**: `npm run test:export:hangul`(임시 서버·모의 AI → 검토본 → 한/글 열기·재저장 → 엔진으로 다시 읽어 메모·변경 비교). 다른 Hwp.exe 가 있으면 최대 120초 기다린 뒤 SKIP 하는데, 이것은 **미검증**이다.
  `tests/hangul_roundtrip.py`, 조판 회귀 O 묶음(HWPX/HWP 저장 왕복 64사례, `regression-20261103`)도 있다.
  메모는 한/글 PDF·쪽 그림에 찍히지 않으므로 재저장 HWPX 를 엔진으로 읽어 확인한다.
- **예시 [PC]**: 한/글로 실제 여는 왕복 `artifacts/layout-fix-20261103/scratch/r5-save/`(`rt-all.mjs`·`hg-open.py`).

### 8.8 웹 ↔ 한/글 클립보드

- **한/글 없이**: `npm run test:clipboard`, `npm run test:hancom-board`(엔진만, 수 초), `npm run test:format-copy`.
- **한/글 2022**: `npm run test:clipboard:hangul`, `npm run test:clipboard:hancom`(실제 Chromium → 시스템 클립보드 → 숨은 한/글 붙여넣기, 한/글 자체 복사와 비교, 1~2분).
  `test:clipboard:hancom` 은 `studio/dist` 를 쓰므로 편집기를 바꿨으면 먼저 `npm run build:studio` 를 한다(`STALE_TESTS` 문서).
- **주의**: 기본은 엔진의 복사 보드·변환·내보내기 결과를 확인한다. 실제 브라우저 클립보드 API나 한/글 붙여넣기를 확인해야 할 때만
  브라우저 예외를 적용한다. 시스템 클립보드는 다른 세션과 같이 쓰므로 조율한 뒤 사용한다.
  자동 시험은 이 PC 한/글 2022 기준이며 다른 판(2018·2024)은 미검증으로 적는다.
- **예시**: 한/글 받침 `artifacts/toc-font-paste-20261103/harness/` [PC](4절), 기대값 판단 기록 `docs/STALE_TESTS_2026-11-04.md`, 서식 정책 `docs/CLIPBOARD_AND_FORMAT_COPY.md`.

### 8.9 화면(브라우저·Android APK)

- **기본**: 웹 표시·조판은 같은 입력·처리 경로의 엔진 계산값으로 확인한다(8.0절). 새 화면이나 화면 관련 변경이라는 이유만으로
  브라우저를 띄우거나 캡처하지 않는다.
- **브라우저를 고르는 때**: 입력·포커스·IME·DOM/CSS·권한·실제 글꼴 로딩·클립보드 API처럼 브라우저 고유 동작이 검사 대상이거나,
  사용자가 실제 브라우저 확인을 명시적으로 요청했을 때만 사용한다. 예외의 이유와 범위를 적고 사용자가 쓴 것과 같은 메뉴·진입 경로로 확인한다.
  다른 경로의 성공으로 대신하지 않는다(예: `STALE_TESTS` 의 'Ctrl+A 가 개체 선택을 남긴 채 복사' — 진입 동작이 원인이었다).
- **예외 실행 준비**: Playwright(Python 1.49)와 `CLAUDE.md` 의 chromium 경로가 필요하다. 시험마다 자기 포트와 임시 서버를 쓴다.
  화면 시험은 `studio/dist` 를 쓰므로 엔진·편집기를 바꿨으면 `build:engine`·`build:studio` 를 먼저 한다.
- **명령 예**: `npm run test:ui:studio`(:8794)·`test:ui:collab`(:8792)·`test:ui:codes`(:8785)·`test:ui:tablekeys`(:8779)·`test:ui:layout`·`test:ui:help`.
- **모바일 웹**: `tests/ui_layout.py` 는 좁은 화면·터치 흉내(980px, `has_touch`)를 확인하는 예다.
  입력·선택·설정 관련 Node 회귀는 `tests/mobile_input.test.mjs`·`tests/touch_selection.test.mjs`·`tests/mobile_settings.test.mjs` 에 있다.
  이 결과를 Android APK나 실물 휴대폰 검증으로 대신하지 않는다.
- **Android APK**: 별도 프로젝트 `mobile-rhwp/README.md` 의 빌드·환경을 먼저 확인한다. 파일 열기 회귀 예시는
  `mobile-rhwp/android/app/src/androidTest/java/kr/hwpx/rhwp/DefaultFilterInstrumentation.java` 다.
  `mobile-rhwp/android` 에서 `gradlew.bat assembleRelease assembleReleaseAndroidTest` 로 후보·시험 APK를 만들고,
  대상이 일회용 에뮬레이터인지 확인한 뒤 두 APK를 설치한다(시험 APK에는 `adb install -r -t` 사용).
  `adb -s <에뮬레이터ID> shell am instrument -w -e case html-input kr.hwpx.rhwp.test/kr.hwpx.rhwp.DefaultFilterInstrumentation` 은
  화면의 `Test document input` 버튼을 눌러 WebView 대체 경로를 확인하는 시험이다. 대화상자가 떠 있는 동안
  `mobile-rhwp/scripts/android-ui.py` 의 tap·capture 절차로 실제 목록을 확인하고 PNG·XML과 instrumentation 종료 결과를 함께 남긴다.
  이 도우미는 에뮬레이터 ID가 고정돼 있으므로 실행 전에 자신의 시험 대상과 맞는지 확인한다.
  과거 실행 예시는 `artifacts/android-default-filter-20261106/` [PC](로그·`validation.json`)와
  `mobile-rhwp/test-results/default-filter-*.png·xml` 이다. `mobile-rhwp/scripts/verify-default-filter.mjs` 는 이 과거 파일명에 의존하므로
  새 후보의 실제 화면을 다시 취득하지 않고 재실행한 것을 새 검증으로 보고하지 않는다.
- **실물 기기**: 실제 휴대폰 확인은 별도로 수행한다. 브라우저의 터치 흉내·에뮬레이터 결과로 대신하지 않으며,
  확인하지 못했으면 미검증으로 적는다. 휴대폰의 외부 ‘내 파일’ 앱을 직접 여는 경로와 우리 APK 안의 선택기를 구분한다.

### 8.10 글꼴·특수문자

- **고르는 때**: 글꼴 선택·대체 글꼴·언어 슬롯·특수문자 폭/모양을 바꿨을 때. 작업 순서는 `AGENTS.md` §4 를 따른다(실제 face·파일·슬롯·fallback 을 먼저 맞춘다).
  웹 표시·조판은 8.0절에 따라 엔진 내부 계산값으로 확인한다. 렌더 경로는 WASM → SVG → Resvg이며 실제 브라우저를 실행한 결과로 보고하지 않는다.
  **증명하지 못함**: HFT 글꼴의 원본 글리프, 크기·자간·장평 조합. 브라우저 고유 기능이 대상일 때만 8.9절 예외로 확인한다.
- **도구**: `scripts/font-symbol-benchmark.py`(+ `scripts/font_symbol_benchmark/`), `npm run font-symbols:prepare|generate|oracle|render|check|status|run`.
  범위는 `--fonts <manifest ID, 예 53,671-672>` 로, 후보 빌드는 `--pkg <폴더>` 로 정한다. 비교기 단위 시험은 `npm run test:font-symbols` 다.
  스크립트가 스스로 잠금으로 동시 쓰기를 막고, generate·oracle·render·run 에서 자기 프로세스에 `cpu-cap.ps1 -Percent 25` 를 건다.
- **출력 폴더 주의**: `--out` 을 주지 않으면 기본값 `output/font-symbol-benchmark-v1/` 에 쓴다. 어느 자료에 이어 쓸지 `--out` 으로 분명히 정한다.
  두 폴더의 정답·결과를 섞어 보고하지 않는다.
- **기준**: 한/글 2022 COM `CreatePageImage` 144dpi. PDF 는 실제 face 추적에만 쓴다. 한 번 만든 정답은 입력 SHA 가 다르면 덮어쓰지 않는다.
- **자료·결과 [PC]**: 두 묶음이 있다.
  - `output/font-symbol-benchmark-20261106/`(`manifest.json`·`benchmark.sqlite`·`status.json`·`last-run.txt`·`reports/<run>/summary.json`).
    Arial 전수 예시는 `reports/e65ebc89783956ce61ec/summary.json` 이다.
  - 기본 출력 `output/font-symbol-benchmark-v1/`: 857개 전체 실행의 자리다(`full-run.log`·`progress.json`·`status.html`).
    `paused.json` 에는 2026-11-06 09:21 에 일시 정지된 부분 결과로 기록되어 있다. 완료된 결과가 아니다. 대표 문서 `output/font-dot-comparison/모든글꼴_한점리더_마침표_50pt.hwpx` 는 원본이고,
  같은 폴더의 `_한글2022정규화`·`_구역정의수정` 은 비교용 사본이다.
- **판정**: `allGlyphsVerified`·`fullFontScope`·전체 예상 건수를 함께 본다. 종료 코드 2 는 불일치 또는 미완료다. `tolerant-match` 는 픽셀 완전 일치가 아니다.
  양쪽 다 빈 출력은 미검증이다. 857개 글꼴 전체 실행은 장시간 작업이다. 이미 돌고 있거나 정지된 실행이 있으면 새로 시작하지 않고, 그 폴더의 `status.json`·`progress.json`·`paused.json` 을 읽어 상태를 본다.
  다시 이어 돌리는 것은 그 작업 담당이나 사용자와 정한다.
  근거와 한계는 `docs/FONT_SYMBOL_BENCHMARK_2026-11-06.md`·`docs/FONT_SYMBOL_MATCHING_2026-11-06.md` 를 본다.
