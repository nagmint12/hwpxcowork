# vendor/ — 외부 소스(독자 개선)

## vendor/rhwp — 2026-11-10 부터 rhwp v0.9.0 + 우리 fork 병합(브랜치 `merge-090`), 2026-10-27 부터 독자 개선

- 지금(2026-11-10~): rhwp v0.9.0 에 우리 fork 를 git 3-way 병합한 저장소. 원격 `origin` = https://github.com/edwardkim/rhwp(읽기 전용, push 없음),
  브랜치 `merge-090`. 경위·다음 판 받는 법: `docs/RHWP_0.9.0_UPGRADE_2026-11-09.md` §5. 아래 첫 항목들은 0.8.7 시절 기록이다.
- 처음 출처: https://github.com/edwardkim/rhwp (MIT, Edward Kim) · 태그 `v0.8.7` · 커밋 `1a76570e833917d15817415a53c09ad61ab3203f`
- 2026-10-22 에 한 번 내려받아 고정했고(그때는 GitHub 원격을 지웠다 — 0.9.0 병합 때 다시 붙임), **2026-10-27 부터 우리가 직접 고친다**(사용자 결정 — rhwp 를 독자적으로 개선).
- 받은 경로(sparse checkout): `rhwp-studio/`(편집기 TS 소스), `npm/editor/`(호스트 SDK), `npm/hwpctrl-ocx/`(hwpctrl 플러그인), `assets/fonts/`(웹 글꼴), `src/`·`crates/`(Rust 엔진 소스), 루트 파일들(LICENSE, THIRD_PARTY_LICENSES.md, Cargo.* 등). 빌드에 필요해 2026-10-27 에 같은 커밋에서 `saved/blank2010.hwp`(새 문서 틀, `include_bytes!`)를 더 받았다.
- `pkg/` — WASM 엔진 빌드 결과(rhwp.js, rhwp_bg.wasm, *.d.ts, `cowork-engine.json` = 빌드 시각·프로필·고친 파일). `npm run build:engine` 이 만든다. 원본 저장소의 .gitignore 대상이라 git 에는 안 보인다. 원래 npm 배포본 `@rhwp/core@0.8.7` 의 pkg 는 `backups/rhwp_pkg_npm_0.8.7_2026-10-27/`.
- `rhwp-studio/node_modules/` — 빌드 도구(vite, typescript 등). `rhwp-studio/package-lock.json` 그대로 `npm ci` 로 설치.

### 고치는 법
- Rust 엔진: `vendor/rhwp/src` 를 직접 고치고 자리마다 `// [hwpx-cowork]` 주석(왜·한글 실측 근거)을 단다. 바뀐 것은 `git -C vendor/rhwp diff`.
- 빌드: `npm run build:engine`(release, LTO — 수 분) 또는 `npm run build:engine -- --fast`(release-test — 약 2분) → `vendor/rhwp/pkg` → `npm run build:studio` → `studio/dist/`.
  - 필요 도구: rustup(툴체인은 `rust-toolchain.toml` 고정 1.93.1 + wasm32-unknown-unknown), `cargo install wasm-bindgen-cli --version 0.2.127 --locked`(Cargo.lock 의 wasm-bindgen 과 같은 판).
  - `Cargo.toml` 은 스냅샷에 없는 workspace 멤버(tools/·bindings/)와 `vendor/svg2pdf` patch(네이티브 PDF 전용)를 주석으로 뺐다. `Cargo.lock` 은 그에 맞춰 cargo 가 정리했다.
  - 단위 시험(`cargo test`)은 스냅샷에 없는 samples/·tests/ 자료를 `include_bytes!` 로 읽어 컴파일되지 않는다 — 조판 회귀는 `npm run test:layout`(한글 PDF 줄 기준)으로 본다.
- 편집기 TS 쪽은 `studio/`(cowork 통합 층)도 계속 쓴다: 빌드 설정(`scripts/build-studio.mjs`), 빌드 시점 패치(`studio/build/patches.mjs`, 기준 글이 없으면 빌드 실패), studio 플러그인(`studio/plugin/`). 패치 기준 글만 확인: `node scripts/build-studio.mjs --check`.

### 2026-10-27 엔진 개선(조판 충실도 — 저장 LINE_SEG 없는 생성계 HWPX)
`testdata/데이터 분석계획서_재수강분석.hwpx` 가 한글에서는 2쪽(표가 1쪽을 채우고 서명란이 2쪽), rhwp 에서는 표가 한 쪽에 눌리고 칸 글이 겹치던 문제.
1. `height_measurer.rs` — 저장 조판이 전혀 없는 TAC 표는 낡은 `hp:sz height` 로 비례 축소하지 않는다(행은 셀 선언 높이를 최소로 내용만큼 자람).
2. `mod.rs` `kopub_face()` + 사용처(`text_measurement.rs`·`font_metrics_data.rs`·`composer.rs`·`typeset/paragraph.rs`) — `KoPubWorld돋움체/바탕체` 를 KoPub 폭 표로(hmtx 동일). 종전에는 한글 1.0em 휴리스틱.
3. `text_measurement.rs` KoPub 폭 — 전각 기호·※·한자 900, CJK 괄호 450, 바탕 한글 0.94→0.936(hmtx).
4. `paragraph_layout.rs` — 저장 줄 없는 문단은 쪽 맨 위에서도 문단 앞 간격 유지(한글 PDF 실측).
5. `paragraph_layout.rs` 글머리표 Wingdings `q`/`r` → ❑/❒(종전 □ 근사).

### 2026-10-27 엔진 개선 2 — 설치 글꼴 폭 + 한/글 격자 셈법(`tests/samples/2025년_전체종합보고서.hwpx` 59쪽)
한/글 PDF 와 줄(행) 1,293개를 견주어 줄 나눔 불일치·세로 어긋남 2,290 → 0(표지 1쪽 4행 제외)으로 맞췄다.
6. **설치 글꼴 폭 표** `src/renderer/font_metrics_local.rs`(+ 같은 이름 `.json` 목록) — `scripts/gen-font-metrics.mjs`(`npm run gen:font-metrics`)가
   이 PC 의 글꼴 파일(Windows Fonts·사용자 Fonts·한/글 동봉 `HNC/*/Shared/TTF`)의 cmap·hmtx 를 읽어 만든다. 한글 글꼴 전부 + 흔한 영문 글꼴,
   가족 이름은 '보통' 글꼴에(한/글은 진하게도 보통 글꼴 폭으로 전진). **생성물이므로 손으로 고치지 않는다** — 글꼴을 새로 설치했으면 다시 돌리고 엔진을 빌드한다.
7. **한/글 4 HWPUNIT 격자 셈법** `src/renderer/local_font_width.rs` — 보정 문서(`tests/fixtures/layout/calib_widths.hwpx`, 글꼴 5종 × 크기·장평·자간·진하게·공백폭,
   1,428줄)의 한/글 PDF 실측으로 확정. `S=floor(크기HU/4)`, 장평 100% 는 `round(g·S)`, 그 밖은 `floor(g·S·장평)`, 공백은 반각 `round(floor(S/2)·장평)`
   (글꼴 공백폭 사용이면 글꼴 공백 글리프), 자간은 `round_half_away(자연폭·자간%)`, 전진폭 = 4×(자연폭+자간몫). 표에 있는 글꼴은 `char_width_decision` 이
   이 셈법으로 잰다(종전 KoPub 휴리스틱·글자 폭 비례 자간은 표에 없는 글꼴에만). 글꼴에 없는 글자는 한컴바탕 폭(한/글 대체 글꼴).
8. `line_breaking.rs` — 줄 끝 맞춤 판정이 빼는 마지막 글자 자간을 같은 격자 값으로(`local_grid_letter_spacing_px`). ASCII `'` 를 줄 머리·꼬리 금칙에서 뺐고,
   글자 단위 문단의 기호 낱자(`▲` `▼` `'` 등) 뒤도 줄 끝 후보(한/글 `…역량'(▼` | `0.07)임`).
9. `document.rs` — 저장 줄 없는 위/아래 캡션(표·그림) 문단도 로드 때 줄을 합성(종전 400HU 로 쳐서 캡션과 표가 9px 겹쳤다).
   합성 vpos 사다리에 문단 위·아래 간격을 넣는다(한/글 재저장본의 vertpos 규약).
10. `height_cursor.rs` — 앞뒤 문단이 모두 합성 줄이면 vpos 스냅을 하지 않는다(합성 사다리는 한/글 좌표가 아니다 — 자리차지 표가 100~200HU 올라갔다).
- 남은 차이: 표지(1쪽) 첫 문단(자리차지 그림 + 글)의 높이 약 -35px, 글자처럼 취급한 그림 줄 뒤 줄간격(110% 의 10%) 누락으로 그 뒤 1~2px, 대체 글꼴 선택(맑은 고딕의 `◦`).
- 시험: `npm run test:layout` 7건(계획서·기초통계·59쪽 보고서 행 비교·보정 문서 1,428줄 폭·조판 시험지·매크로테스트용 문서 2판).

### 2026-10-28 엔진 개선 3 — 그림 배치·빈 줄·쪽 끝(`testdata/매크로테스트용_다운.hwpx`, 조판 시험지 `tests/fixtures/layout/probe_objects.hwpx`)
편집기·AI 가 넣은 그림(저장 줄 없음)이 한/글은 다음 쪽으로 넘기는데 rhwp 는 쪽 끝에 눌러 담던 문제와, 그림을 글자처럼 취급하지
않을 때 글이 놓이는 자리. 한/글 COM 으로 연 시험지 30쪽(사례 18개)의 재저장 linesegarray·PDF 로 규칙을 확인했다.
11. **글자처럼 그림 줄 높이** `line_breaking.rs` `picture_flow_extra_height_hu` — 그림 + 바깥 위·아래 여백 + 위/아래 캡션(간격+캡션 줄).
    한/글 vertsize 23393 = 21260+850+1000+283. 캡션 줄 합성을 본문 줄보다 먼저(`document.rs`).
12. **쪽 끝 판정** `paragraph/overflow.rs` — 합성 줄의 글자처럼 그림은 60px 넘침 허용(#409, 저장 줄 증거) 대신 엄격히:
    줄 끝이 본문 끝보다 **작아야** 들어간다(시험지 `tac-fit-1` 그 쪽 / `tac-fit+0` 다음 쪽).
13. **끼운 뒤 낡은 저장 줄** `document.rs` — 저장 줄 있는 구역에 저장 줄 없는 문단이 끼면, 그 뒤 저장 줄에 합성 표시를 붙여
    옛 vpos 되감김(쪽 시작)·스냅 근거에서 뺀다(한/글은 열 때 다시 조판). 줄 나눔·높이는 그대로 쓴다. 저장할 때 이 줄들은
    linesegarray 를 내지 않는다(합성 줄과 같은 #5847 규칙 — 낡은 캐시 대신 한/글이 다시 조판).
14. **자동 번호** `parser/hwpx/mod.rs` — HWPX 도 `assign_auto_numbers`(한/글은 열 때 [그림 n]·[표 n] 을 다시 매긴다).
15. **빈 앵커 문단 + 문단 기준 자리차지 개체** — 문단 머리(글머리표·번호)가 있으면 앵커 줄은 개체 **아래** 한 줄(lh+ls)을 차지하고
    글머리표가 그려진다. 머리가 없으면 개체 띠 위에 겹쳐 자리를 차지하지 않는다(한/글은 폭 0 으로 저장 → 로드 때 같은 표지
    `mark_absorbed_empty_anchor_line`). `float_placement.rs` `empty_host_trailing_line_px`·`stored_empty_anchor_band_host_line_advance_hu`,
    쪽을 넘긴 표는 마지막 조각 뒤(`emit_table_fragment`·`layout` PartialTable), 그리기 `layout.rs` `place_headed_empty_anchor_lines`.
16. **쪽 끝의 자리차지 그림** `float_placement.rs` `computed_picture_next_page_placement` — 들어가지 않으면 **그림만** 다음 쪽 맨 위로,
    앵커 줄·뒤 글은 이 쪽에 계속, 다음 쪽 글은 그림 띠 아래부터(저장 증거판 `stored_picture_next_page_placement` 의 합성 짝).
    쪽나누기 문단을 만나면 이월 그림만 있는 쪽을 먼저 닫는다(`section/entry.rs`).
17. **글 뒤 그림** `layout.rs` — 글 있는 host 의 글뒤로 그림이 흐름을 문단 첫 줄로 되감아 다음 문단이 겹치던 것.
18. **그림 크기를 바꾼 뒤 남은 낡은 줄** `document.rs` `drop_stale_tac_picture_line` — 글자처럼 그림 하나뿐인 문단의 저장 줄 높이가
    그림 줄 높이(그림+여백+캡션)와 100HU 넘게 다르면 버리고 다시 잰다(매크로테스트용_저장 v19: 저장 36269 ↔ 한/글 29442, 종전 7쪽 ↔ 한/글 6쪽).
19. **빈 앵커 줄의 글머리표 자리** `layout.rs` `empty_line_marker_x` — 문단 정렬대로 마커 영역을 둔다(가운데 정렬 = 단 가운데, 한/글 385.7px).
    쪽을 넘긴 표는 마지막 조각 뒤에 그 줄을 새로 그린다(`push_trailing_anchor_marker_line`).
- 한/글 확인(v19, 2026-10-28): 글자처럼 취급하지 않은 표(문단 기준·왼쪽 정렬·오프셋 0)는 문단 정렬과 무관하게 **문단 왼쪽 여백 자리**에 놓인다 —
  가운데 정렬 + 여백 0 으로 바꾸면 표가 단 왼쪽(113.06px)으로 8px 옮겨 갈 뿐 가운데로 가지 않는다(rhwp 도 같다).
  가운데 정렬 문단의 글자처럼 그림은 바깥 여백 포함 상자가 가운데에 온다 — 왼쪽 여백 4252 를 같이 주면 28px 오른쪽(앱 `replacePicture` 를 고침).
- 남은 차이(시험지 knownCases): 어울림(Square) 그림 옆 줄 폭·줄 수, 쪽 기준(vertRelTo=PAGE) 자리차지 그림 띠를 글이 건너뛰지 않음.
- 진단 도구: `npm run layout:trace -- <hwpx> --run-hangul|--hangul <폴더>|--oracle <json> [--decisions]` — 문단별 rhwp↔한/글 쪽·y·줄·x/폭,
  그림 상자, 처음 갈라진 문단의 남은 높이·요구 높이, `--decisions` 는 엔진의 쪽 나눔 결정(흐름 높이를 바꾼 소스 줄). 엔진 API
  `getLayoutTrace()`(문단 줄·개체 속성·쪽 항목, `document_core/queries/layout_trace.rs`)·`getLayoutDecisions()`(`renderer/layout_trace_log.rs`,
  `TypesetState` 의 흐름 변경 메서드에 `#[track_caller]`). 시험지 `npm run layout:probe -- --hangul`.

### 2026-10-28 편집 개선 — 조판 부호(자동 번호·새 번호로 시작 등) 지우기·고치기, 표 캡션 경로 편집
rhwp 의 글자 지우기(`Paragraph::delete_text_at`)는 컨트롤을 건드리지 않아 조판 부호를 지울 길이 없었다. 캡션 '[표 1]' 에서 번호 뒤 Backspace 는
자동 번호의 자리표 공백만 지워 저장기가 앞 공백을 자리표로 오인했고(→ '[표1]'), 선택 지우기는 번호를 글 끝으로 옮겼다('…기초통계1').
20. `model/paragraph.rs` — `code_slots`(지울 수 있는 부호 = 자동 번호·새 번호·쪽 번호 위치·감추기·책갈피·찾아보기 표식·홀짝 쪽 시작 — 표·그림·
    구역/단 정의·필드는 아님, 자리표 판별은 저장기와 같은 글자 — 자리표 뒤에 메모 필드가 이어지는 꼴 포함), `remove_code_control`(자리표 글자 + 8유닛
    자리를 함께 닫고 글자 모양·줄·영역 태그·필드 번호를 옮김), `delete_text_with_codes[_at]`(선택 지우기 — 범위 안 자리표·범위 한가운데 부호를 뺀다,
    여러 문단이면 끝 문단 머리·첫 문단 꼬리 부호도). `delete_text_at` 자체는 그대로(미주 번호 그리기 등 내부 호출이 자리표를 글자로 다룬다).
21. `document_core/commands/code_controls.rs`(새) + `wasm_api.rs` — `getCodeControlAt`(캐럿 옆 부호: Backspace 는 앞 글자가 자리표이거나 캐럿 자리
    틈의 부호, 문단 맨 앞이면 부호 대신 문단 합치기 / Delete 는 뒤 글자·캐럿 자리 틈) · `getCodeControls` · `deleteCodeControl` · `setNewNumber`
    (새 번호로 시작 — 쪽·각주·미주·그림·표·수식, 있는 부호 고치기). 번호 부호를 넣고 빼면 캡션 번호를 다시 매긴다(`assign_caption_auto_numbers`).
22. `delete_range_native`(본문·셀)·`delete_range_in_cell_by_path` — 선택 지우기가 21 의 규칙으로 부호를 함께 뺀다.
23. 경로(…ByPath) 접근자 `get_cell_paragraphs_mut_by_path`·`resolve_paragraph_by_path`·`resolve_container_para_count_by_path` 가 표 캡션 센티널
    (cellIndex 65534 — 적중 판정이 캡션 글에 주는 cellPath)을 받는다. 종전에는 표 캡션에서 선택 지우기·Enter·문단 합치기가 '셀 65534 범위 초과'로 실패했다.
24. 편집기 `engine/input-handler.ts` executeOperation `record` — 이미 적용된 변경(그림 끌어 크기·위치 바꾸기, Shift+방향키 크기, 표 옮기기)을
    기록만 하고 `document-mutated` 를 내지 않아 cowork 플러그인이 편집을 몰랐다(자동 저장·실시간 밀어 넣기 없음 → 그림 크기를 줄이고 [저장]·[한글로 저장]
    해도 서버에 안 감). 기록 뒤 `document-mutated('record')` 를 낸다. 서버 쪽 짝은 diffDocs 'object' 덩어리(engine/doc.js — 그림 속성·조판 부호).
25. 캡션 자동 번호 그리기 `layout/paragraph_layout.rs` `apply_auto_numbers_to_composed` — 종전에는 연속 공백("  ") 사이에 번호를 **끼워** 넣어
    자리표 공백이 남았다(캡션이 '[표 1 ]', 글자가 하나 늘어 캐럿·클릭이 한 칸씩 밀림 → ']' 앞 Backspace 가 ']' 를 지움, 앞 공백을 지운 '[표1]' 은
    번호가 안 그려짐). 이제 `code_slots` 의 자리표 글자를 찾아 그 run 을 [앞][자리표][뒤]로 나누고 자리표의 display_text 만 번호로(각주 번호·
    머리말 쪽 번호와 같은 방식 — `show_auto_number_at`). 캐럿·적중의 글자 자리 `cursor_rect.rs`·`cursor_nav.rs` `cursor_positions_for_render_run` 은
    표시 글로 바뀐 한 글자 런을 런 폭 전체로 본다(종전 필드 표식만).
26. 캡션 복사·편집: `clipboard.rs` `copy_selection_in_cell_native` 가 표 캡션(65534)을 받고, 복사 글(바깥에 붙일 글자)은 원문 문단에서 자동 번호를
    번호로 바꿔 센다(`code_controls.rs` `text_range_with_auto_numbers` — 자른 사본은 메모 필드 경계가 바뀌어 자리표를 못 찾는다). `split_/merge_paragraph_in_cell_by_path`
    는 공용 접근자(`get_cell_paragraphs_mut_by_path` — 표 칸·표 캡션·그림 캡션·글상자)로(종전 표 칸만 → 캡션 Enter '셀 범위 초과').
27. 캡션 번호 셈 `parser/mod.rs` `assign_caption_auto_numbers`(HWPX) — 한/글은 캡션의 번호 부호가 아니라 **개체**가 번호를 센다: 번호 종류
    (`numberingType`)가 그림·표·수식인 개체는 캡션이 없어도 번호 하나를 차지하고, 캡션의 hp:autoNum 은 제 개체 번호를 보인다(`NumScope`·
    `object_number_scope`). 종전 rhwp 는 번호 부호만 세어, 캡션 없는 표가 앞에 있거나 캡션 번호를 지우면 뒤 번호가 한/글보다 하나씩 작았다.
    한/글 PDF 실측(매크로테스트용_저장 — 캡션 표 넷·캡션 그림 셋): 첫 표 캡션 통째 빼기 → 남은 표 2·3·4, 번호 부호만 지우기 → 2·3·4,
    첫 표 번호 종류 NONE → 그 캡션 1·다음 표도 1(번호 종류가 다른 개체의 캡션 번호는 셈을 늘리지 않고 다음 번호), 캡션 없는 그림·번호 종류
    그림인 사각형을 앞에 → 뒤 그림 2·3·4. 편집 뒤에도 같게 — `paginate_pass` 가 HWPX 면 캡션 번호를 다시 매기고(표·그림을 넣고 지우면
    뒤 번호가 당겨진다), 캡션 넣기·빼기 뒤의 `assign_auto_numbers`(쪽·각주 번호까지 다시 매김)는 `renumber_auto_numbers` 로(HWPX 는 캡션만).
    서버 `engine/doc.js` `_autoNumberAt`(새 캡션 번호 초깃값)도 같은 셈. HWP·HWP3 는 종전 셈 그대로.
    (2026-11-03) 한/글 2022 COM 실측 시험지(`tests/fixtures/numbering/` — 표 번호 종류 × 캡션 번호 종류 × 본문·칸·글상자 번호 × 새 번호,
    한/글이 다시 저장한 `num` = `hangul_numbers.json`): 개체 **안**(캡션·표 칸·글상자)의 그림·표·수식 번호는 종류와 상관없이 제 개체 번호
    (표 캡션의 그림 번호 = 그 표 번호, 번호 종류 그림인 표의 '표' 번호 = 그 그림 번호), 번호 종류 없음 개체 안은 늘 1(저장값 무시),
    개체 밖 본문 번호는 셈을 늘리지 않는 **지금** 번호(앞에 그 종류가 없으면 0 — 종전 '다음 번호'). 새 표·HTML 붙인 표 = 번호 종류 표,
    새 그림 = 그림, 새 수식 = 수식(종전 표·그림 '없음' — 웹에서 만든 표 캡션이 모두 '표 1'). 캡션 넣기 글은 번호 종류를 따라
    `표 N `·`그림 N `·`수식 N `, 없음이면 빈 캡션(`object_ops/common.rs` `fill_new_caption_paragraph`). 개체 속성 '번호 종류'는
    `numberingType`(NONE·PICTURE·TABLE·EQUATION)으로 get/set(표·그림·도형·수식) — 바꾸면 캡션 번호를 다시 매긴다. 수식 직렬화도
    IR 번호 종류를 쓴다(종전 EQUATION 고정). 편집기 창: `rhwp-studio/src/ui/object-numbering.ts`(표·그림·수식 속성 창의 '번호 종류').
28. (2026-10-29) 표·그림도 조판 부호로 지운다 — `code_controls.rs` `getCodeControlAt` 가 부호가 없으면 개체(`object_at`: 표·그림·도형·수식)를
    돌려준다(`kind:"object"`, `objectType`, `inline`, `label`). 글자처럼 취급한 개체는 캐럿 논리 자리 앞 칸(Backspace)·뒤 칸(Delete), 자리를
    차지하는 개체의 부호는 캐럿 자리 틈 — 한/글은 숨은 부호 뒤에 캐럿을 두므로 Backspace 만 그 부호를 지운다(표 아래 빈 줄에서 Backspace =
    '[표] 를 지울까요?', Delete 는 다음 문단 합치기). 부호 자리는 글자 번호라 캐럿 논리 자리를 `logical_to_text_offset` 으로 바꿔 견준다.
    한/글 COM 실측(2026-10-29, 매크로테스트용_저장): 표 host 문단(s0/p19)에 `SetPos(0,19,0)` 해도 캐럿은 부호 뒤 8 로 붙고 MoveLeft 는 앞 문단
    끝으로 간다(부호 앞 자리가 없다) · 거기서 DeleteBack 은 묻고(아니오면 그대로) 표를 지움 · Delete 는 다음 문단 합치기(표 그대로) ·
    글자처럼 취급한 그림(s0/p12) 뒤 DeleteBack·앞 Delete 는 묻고 지움.
    `label` 은 한/글 이름(`hwpctrl_sets::control_identity` 실측표: 표·그림·수식·번호 넣기·새 번호 지정 …).
    표 아래 빈 줄의 캐럿 자리: 글머리표가 있는 글 없는 표 host 문단은 `place_headed_empty_anchor_lines` 가 빈 글조각(캐럿 자리)을 글머리표로
    **바꿔** 캐럿을 둘 수 없었다(←·클릭이 그 줄을 건너뛰고 표 칸·앞 문단으로 갔다) — 글머리표는 사본으로 그리고 빈 글조각은 본문 시작 자리
    (`empty_line_text_x`)에 남긴다. 쪽을 넘긴 표의 앵커 줄(`push_trailing_anchor_marker_line`)에도 빈 글조각을 넣고, `get_cursor_rect_native`
    폴백·`find_text_scan_pages_for_paragraph` 가 그 줄이 있는 마지막 조각 쪽을 본다.
- 편집기(rhwp-studio): `engine/input-handler-code-delete.ts`(Backspace/Delete 가 부호·개체에 닿으면 한/글 '지우기' 창 —
  `ui/code-delete-dialog.ts` 경고 아이콘 · '[그림] 을 지울까요?'(받침에 따라 을/를) · [지움(Y)] [취소(N)], Y·Enter=지움, N·Esc=취소 — 뒤
  스냅샷 편집 하나로 지운다(되돌리기 한 번). 부호 하나를 지울 때는 조판 부호 보기가 켜져 있어도 늘 묻고, 끌어 고른 범위를 한꺼번에 지울 때만 묻지 않는다
  (사용자 확인 2026-10-29). 캡션처럼 칸 경로가 없는 캐럿의 범위 지우기는 `engine/command.ts` `cellPathJson` 이 flat 필드로 경로를 합성한다(종전 빈 경로라 지워지지 않음). 숨은 부호(자리 차지 개체·새 번호 등)를 [취소]하면 같은
  자리의 다음 지우기는 부호를 건너뛴다 — 한/글이 캐럿을 부호 너머로 옮기는 것과 같은 효과로, 문단 합치기·앞 글자 지우기를 막지 않는다.
  각주 지우기(`input-handler-text.ts`)도 같은 창),
  `ui/new-number-dialog.ts`(번호 종류 고르기 · 캐럿 자리 새 번호 고치기). 한/글 확인(2026-10-28, 매크로테스트용_저장): 첫 표 번호를 지우고 그림 뒤에
  새 번호(표 5)를 넣은 문서를 한/글이 '[표 ] 표' · '[표 5]'·'[표 6]'·'[표 7]' 로 보이고 그대로 다시 저장한다.

### 2026-10-29 쪽·단 나누기 — 한/글 Ctrl+Enter·Backspace 규칙과 나눈 뒤 조판
29. 한/글 COM 실측(2026-10-29, `testdata/매크로테스트용_저장.hwpx` 33문단 7쪽 · `tests/samples/2025년_전체종합보고서.hwpx` 479문단 59쪽,
    `HAction.Run("BreakPage"/"BreakColumn"/"DeleteBack"/"Delete")` 뒤 다시 저장한 HWPX·`PageCount`·문단마다 `CurrentPage`):
    - **넣기**(`text_editing.rs` `insert_break_like_hangul_native` — WASM `insertPageBreak`·`insertColumnBreak` 가 이리로. CLI 의
      `insert_page_break_native` 는 그대로 늘 가른다): 문단 처음(구역·단 정의 문단 아님 — 한/글은 그 문단 처음에 캐럿을 못 둔다, SetPos 0 → 16)이고
      그 문단에 같은 나누기가 없으면 **가르지 않고 그 문단에** 건다(캐럿 그대로) · 문단 끝(뒤로 옮길 글·개체 없음 — `Paragraph::split_tail_is_empty`)이고
      다음 문단에 같은 나누기가 없으면 **다음 문단에** 건다(캐럿 = 다음 문단 처음) · 그 밖(글 가운데·구역 첫 문단·이미 나누기가 있는 자리·마지막 문단
      끝)은 갈라 새 문단에 건다(같은 자리 두 번째 Ctrl+Enter 는 빈 문단 + 나누기 둘). 종전에는 늘 갈라 문단 처음·끝마다 빈 문단이 하나씩 생겨
      쪽 수가 한/글보다 늘었다(세 곳 나누기: 편집기 10쪽 · 한/글 8쪽).
    - **지우기**(`clear_paragraph_break_native` · WASM `getParagraphBreak`·`clearParagraphBreak`, 편집기 `input-handler-text.ts`
      `tryClearParagraphBreak`): 나눈 쪽 첫 문단 처음에서 Backspace · 앞 문단 끝에서 Delete 는 **문단을 합치지 않고 나누기만** 지운다(다음 번이
      합친다). 묻지 않는다(메시지 상자 '아니오' 모드에서도 지워짐). COM 의 DeleteBack 은 문단 처음에서 첫 번은 아무것도 안 하고 둘째에 동작한다
      (나누기 없는 문단 합치기도 같음 — COM 버릇).
    - **나눈 뒤 조판**(`rechain_vpos_from_break`): 한/글은 나누기 문단을 vpos 0 에서 시작해 그 뒤를 새로 조판해 저장한다. 엔진은 저장 vpos 리셋을
      쪽 경계 근거로 쓰므로 옛 자연 쪽 경계가 남으면 가짜 쪽 나눔이 생긴다(글 가운데 나누기 하나에 +1쪽), 나누기를 지워도 vpos 0 이 남아 계속 새 쪽.
      그래서 나누기 문단부터 다음 흐름 경계(다른 나누기·구역/다단 정의 — `Paragraph::starts_flow_zone`) 앞까지: 나누기 문단은 0, 뒤는 저장 간격이
      0 이상이면 그대로(자리차지 표 host 처럼 개체 높이를 담은 간격), 리셋이면 문단 여백으로 잇고 **합성 줄(bit31)로 표시**해 조판이 저장 좌표 근거
      (#409 글자처럼 그림 60px 넘침 허용 등)로 쓰지 않고 높이로 가르게 한다. 나누기 자리가 이미 저장 쪽 맨 위(리셋)였으면 조판이 그대로이므로
      건드리지 않는다(`starts_at_stored_page_top` — 구역 첫 문단 처음에서 가른 경우 등).
      결과(편집기 화면 = 한/글): 매크로테스트용 처음·끝·가운데·셋·두 번·마지막 끝·구역 첫 문단·단 나누기·넣고 지우기 12경우 쪽 수와 문단별 쪽이 같다,
      표본 보고서 넣기·지우기 11경우 쪽 수가 같고 4경우는 문단별 쪽(479문단)까지 같다. 실시간 저장 뒤 다른 창이 여는 서버 작업본(서버는 나누기 문단의
      줄 캐시만 지움)도 같다. **남은 차이**: 합성 줄만인 문단은 저장기가 줄 캐시를 내지 않으므로(#5847) 편집기 내보내기를 그대로 다시 열면(승인 방식의
      내 수정본 다시 열기) 앞쪽 저장 문단의 쪽 끝 판정이 달라질 수 있다(매크로테스트용: 쪽 끝 글자처럼 그림 하나가 앞 쪽에 남아 7 → 6쪽).
    시험 `tests/page_break.test.mjs`(엔진 규칙·쪽 수 = 한/글 실측, 서버 작업본 다시 열기 = 보낸 편집기).

### 2026-10-29 차례 만들기 — 한/글 '도구 > 차례/색인'(차례 만들기·새로 고침·제목 차례 표시·차례 숨기기)
한/글 2022 차례 만들기 대화상자를 UI 자동화(PowerShell UIAutomation + 가속키)로 선택 사항마다 돌려 만든 차례(`tests/fixtures/toc_hangul.json`,
시험지 `tests/fixtures/toc_source.hwpx`)를 정답으로 맞췄다. COM `HAction.Execute("MakeContents")` 는 제목 차례에서 한/글이 죽어서 쓸 수 없다.
30. `document_core/commands/toc.rs`(새) + `wasm_api.rs` `makeTableOfContents`·`getTableOfContentsAt`·`listTablesOfContents`·`updateTableOfContents`·
    `updateAllTablesOfContents`·`setTitleMark`·`getTitleMark`·`findHyperlinkTarget`. 한/글 꼴 그대로의 HWPX 조각을 만들어 엔진 파서로 읽어 끼운다.
    실측 규칙: 캐럿 문단 **뒤**에 넣고(필드로 넣기 + 빈 캐럿 문단이면 그 자리), 첫 문단 '차례 제목'(TABLEOFCONTENTS 필드 시작·`<제목 차례>`),
    목록마다 [`<표 차례>` 등 머리][항목 '차례 N'(개요 수준+1, 코드·스타일로 모은 제목은 1)][바탕글 빈 문단], 마지막 빈 문단에 필드 끝.
    모든 차례 문단은 같은 탭 정의(첫 문단 스타일의 왼쪽 끝 자동 탭 + 단 너비 오른쪽 탭·채움 3 점선 / 또는 오른쪽 끝 자동 탭) — 문단 모양은 스타일
    문단 모양 + 그 탭. 차례 스타일이 없는 문서는 바탕글. 쪽 번호는 넣은 뒤의 보이는 쪽 번호(새 번호로 시작 반영 — 쪽이 맞을 때까지 최대 3번).
    하이퍼링크 `?#<문단 id|개체 id>;0;<1 개요·2 표·3 그림·4 수식>;0;` — 개요로 모은 제목과 표·그림·수식만(코드·스타일로 모은 제목은 링크 없음 —
    한/글 UpdateAllContents 실측), 고유 id 없는 문단은 새 id(최댓값+1). 필드 Command 의 ContentsMake 비트 1 제목·2 표·4 그림·8 수식·16 개요·
    32 스타일·64 코드, ContentsStyles `이름;이름;`(UTF-16 길이). 제목 차례 표시 = `<hp:titleMark ignore="1"/>`(HWP5 Mtit), 차례 숨김 = `ignore="0"`.
    새로 고침은 필드 Command 로 같은 차례를 다시 만든다(차례 안에서 고친 글은 사라진다 — 한/글과 같다). 한/글 확인: 이 엔진이 만든 차례를
    한/글이 열고 UpdateAllContents 하면 같은 차례가 나온다(편집기에서 새로 만든 제목의 id 링크 포함).
31. `serializer/hwpx/context.rs` — 본문 문단의 읽어 온 고유 `<hp:p id>` 를 저장해도 그대로 낸다(`body_para_id`, 카운터는 그 값을 건너뜀). 종전에는
    0,1,2… 로 다시 매겨 한/글이 만든 차례 하이퍼링크(`?#159318310`)도 rhwp 저장 뒤 끊겼다.
32. 수식 캡션 — `Equation.caption`(파서 `parse_equation`·저장기 `render_equation`·캡션 번호 셈 `assign_caption_auto_numbers`). 종전에는 읽지 않아
    편집기에서 저장하면 수식 캡션이 사라졌다. 그리기는 아직 하지 않는다(보존·수식 차례·번호만).
33. 개요·문단 번호 `renderer/layout.rs` `NumberingState::advance` — 건너뛴 상위 수준은 첫 번호(1)로 친다. 한/글 실측: 개요 1·2·2·1·3·2 →
    `1. 가. 나. 2. 1) 나.`, 개요 2·1·3·1·2 → `가. 2. 1) 3. 가.`(종전 rhwp 는 빠진 수준을 0 으로 두어 `가.`·`1.` — 본문 번호와 차례 글이 달랐다).
- 편집기(rhwp-studio): `ui/toc-dialog.ts`(한/글과 같은 항목 — 차례 형식·만들 차례·개요 수준·스타일 여러 개·탭 모양·하이퍼링크, 지난 선택 기억,
  차례 필드가 있으면 '고침/필드 추가'), `command/commands/tool.ts`(도구 > 차례/색인: 차례 만들기·차례 새로 고침·모든 차례 새로 고침·제목 차례 표시·
  차례 숨기기, 우클릭 '차례 고치기'), 우클릭 메뉴(`engine/input-handler-mouse.ts` — 차례 안이면 새로 고침·고치기),
  문서 안 링크 누르면 그 자리로(`engine/input-handler-hyperlink.ts` `followInternalLink`).
- 서버(`engine/doc.js`): 차례·하이퍼링크 필드 시작/끝과 제목 차례 표시를 조판 부호로 옮기고(`paragraphCodes`), 링크가 가리키는 문단 id 를
  옮긴다(`_objectInfo().pid`). 글로 넣은 문단의 탭은 `copyFormattingFrom` 이 source 탭(종류·채움)으로 맞춘다(`<hp:tab/>` 은 한/글이 왼쪽 탭으로 그린다).
- 시험: `npm run test:toc`(엔진 + 서버, 수 초), `npm run test:ui:toc`(화면, :8777).

### 2026-10-29 차례 지우기 · 만들 위치 '새 구역'
34. 다단락 필드 끝(`Paragraph.orphan_field_ends` — 차례 필드 끝)이 문단 편집에서 사라지던 것: `merge_from` 이 이어 받지 않아(빈 마지막 줄은
    통째로 버림) 차례 마지막 줄에서 Backspace 하면 차례 시작만 남았고, `split_at` 은 나눈 뒤쪽으로 옮기지 않았고, `delete_text_at` 은 글자 번호를
    당기지 않았다. 셋 다 고치고 `merge_from`·`split_at` 의 `char_count` 에 컨트롤 없는 칸(필드 끝·제목 차례 표시)도 센다.
    새 메서드 `remove_unclosed_field_begin`·`remove_orphan_field_end`·`add_orphan_field_end`(8유닛 칸째 빼고 넣기)·`insert_leading_extended_controls`.
35. `toc.rs` `toc_marker_ids`·`settle_toc_markers` + `wasm_api.rs` `deleteRange`·`mergeParagraph` 래퍼: 지우기·합치기 전에 범위 안 차례 표지의 필드
    id 를 모으고, 뒤에 지운 자리가 모인 문단 하나만 고친다 — 시작·끝이 그 문단에 있고 사이에 글이 없으면 둘 다 뺀다(차례를 다 골라 지우면 필드째
    없어진다), 끝이 사라졌으면 시작이 그 문단이면 빼고 앞이면 지운 자리에 끝을 둔다(차례가 거기까지로 줄어든다), 시작이 사라졌으면 그 문단의 끝을
    뺀다. 그 문단만 고치므로 선택 지우기의 되돌리기 조각(`restoreDeleteFragment`)이 그대로 맞는다. 짝 시작이 없는 다른 문단의 끝은 저장기가 내지
    않는다(`emit_orphan_field_end` — 문단 머리에 그런 끝이 있으면 한/글이 파일을 못 연다). 종전에는 차례를 끌어 골라 지우면 필드 시작이 남아
    서버 문서에 깨진 차례(»«TABLEOFCONTENTS)가 남았다.
36. 만들 위치 '현재 문서의 새 구역'(`makeTableOfContents` 요청 `newSection`): 한/글 2022 실측(UI 자동화 `out_ns`) — 캐럿 문단 뒤에서 구역을 나눠
    차례만 든 구역을 만들고 그 뒤 문단부터 다시 새 구역(구역 0 ~ 캐럿 문단 · 구역 1 차례 · 구역 2 나머지, 모두 `startNum page="0"` 이어서).
    rhwp 는 한 구역 안의 구역 나누기 문단(SectionDef·ColumnDef 컨트롤 + 나누기 종류 구역)으로 둔다 — 저장하면 같은 section0.xml 안의 둘째·셋째
    `hp:secPr` 이고 한/글은 그것을 구역 셋·5쪽으로 연다(다시 저장하면 section0~2.xml). 쪽 번호는 한/글이 만든 직후 값(구역을 나누기 전 쪽)이 아니라
    한/글 새로 고침 값과 같다. 새로 고침·다시 만들기는 차례 첫 문단의 구역·단 정의를 새 첫 문단으로 옮긴다(`splice_toc_paragraphs`). '새 탭'은
    새 문서와 같아 두지 않는다.

### 2026-10-29 생성계 문서 세로 조판 — 표 아래 주석·쪽 끝·다음 문단과 함께·행 나눔, 큰 그림 복사
저장 줄(linesegarray)이 없는 보고서 생성 문서(`재수강 분석보고서_v4`, 65쪽·표 60·그림 30)를 한/글 2022 재저장본·PDF 와 문단 단위로
견줘 고쳤다(`npm run layout:trace -- <문서> --run-hangul`). 종전: 64쪽(한/글 65), 본문 1쪽 끝 줄이 2쪽으로, 표 아래 주석마다 한 줄 빈칸,
그림 캡션 위에 주석 겹침. 지금: 65쪽, 41쪽(표 40 캡션)까지 모든 문단의 쪽·줄 위치가 한/글과 같다(±5HU).
37. **줄 바꿈만 있는 줄의 글자 크기** `line_breaking.rs` `line_break_char_font_size_px` — 그 줄 바꿈 글자의 글자 모양. `[표][줄 바꿈](1pt)` +
    `주: …(9pt)` 문단의 첫 줄을 9pt(900+92)로 재어 표와 주석 사이에 13px 가 비었다(한/글 textheight 100 · 다음 줄 +112).
38. **앵커 줄의 높이** — 자리차지 개체 앵커 + 줄 바꿈만 있는 줄은 한/글이 vertsize 를 문단 글자(900), 전진을 그 줄 글자(100+12)로 둔다.
    쪽 끝 판정은 vertsize — 표는 들어가도 앵커 줄이 안 들어가면 앵커 줄·글이 다음 쪽 맨 위로. 줄높이 900 + 음수 줄간격(-788)으로 나타낸다.
39. **글 있는 문단의 글자처럼 그림 줄** — 빈 문단과 같이 바깥 여백·캡션(`picture_flow_extra_height_hu`)을 줄 높이에 넣는다(주석이 캡션 위에 겹치던 것).
40. **쪽 끝 4px 여유** `paragraph/fit.rs` — 저장 줄이 하나도 없는 구역은 1HU 만(typeset 과 layout 이 같은 합성 줄이라 드리프트가 없다).
    본문 끝까지 20HU 남은 줄을 다음 쪽으로 넘기던 것. 줄 끝 = 본문 끝이면 넘긴다(`tac-fit+0`).
41. **다음 문단과 함께·문단 보호** `section/heading.rs` `keep_synthetic_paragraph_together` — 저장 줄 없는 문단에만(저장 줄은 한/글의 쪽 나눔을
    따른다). 다음 문단 첫 줄(표 문단이면 위 캡션 + 첫 행)까지 이 쪽에 안 들어가면 이 문단부터 다음 쪽. 종전에는 두 속성을 아예 보지 않았다.
42. **생성계 표를 선언 높이로 누르지 않음** `height_measurer.rs` `table_without_stored_cell_layout` — `fit_measured_table_to_declared_height` 의
    축소와 #5757 비례 축소를 칸에 저장 줄이 없는 표에서 끈다(머리행이 두 줄로 자라 모든 행이 0.967배로 눌려 한 쪽에 담기던 것, 한/글은 행 1112 그대로).
43. **행 단위(CELL) 표 + 글 host**(표가 문단 첫머리, 저장 줄 없음 — `synthetic_rowbreak_host_text_after_px`): 표를 다 놓은 뒤 아래 바깥 여백을 두고
    host 줄을 줄마다 쪽 끝을 보며 놓는다(`emit_synthetic_host_lines_after_table`, 통째 표·끝 조각·typeset 표 뒤 글 세 경로, host 는 '이미 그림'
    표시로 그리기 쪽 대체 그리기를 막는다). 종전에는 쪽 나눔이 끝 조각 뒤 글줄을 세지 않아(그리기만 함) 뒤 흐름이 50px 어긋나 쪽 끝 밖에 그렸다.
    조각마다 아래 바깥 여백까지 쪽 안에 두고(`partial_rowbreak_fragment_spacing_px` 반복 여백), 쪽 맨 위 통째 표의 2px 드리프트 허용(#1831)을 끄며,
    통째 표는 끝이 본문 끝보다 1pt(100HU) 넘게 위여야 담는다(`synthetic_rowbreak_row_guard_px`). 한/글 실측(조판 시험 73사례, 2026-10-29):
    마지막 행 끝이 본문 끝 X HU 앞일 때 여백 57 → X≤156 다음 쪽·X≥160 이 쪽 / 여백 0 → X≤100·X≥130, 앵커 글자 크기·칸 줄간격·세로 병합과 무관.
44. **글 없는 host 표 뒤 아래 여백** — 저장 줄 없는 host 의 자리차지 행 단위 표는 통째·끝 조각 모두 표 뒤에 아래 바깥 여백(한/글 +57)
    (`synthetic_rowbreak_terminal_margin_px`, typeset 표 배치·`emit`·layout `PageItem::Table`/`PartialTable` 이 같은 값).
45. **본문보다 큰 그림의 복사** `clipboard.rs` `mark_oversized_pictures_size_protected` — 한/글은 붙여넣을 때 단 폭보다 큰 그림을 단 폭으로 줄인다
    (한/글 자체 복사·붙여넣기도 같다: 2025 보고서 75668×59865 → 42519×33632). 크기 고정 그림은 줄이지 않으므로(실측) 원본 본문보다 큰 그림만
    복사 조각(Hwp Native 변환 입력·한글 문서모델 둘 다)에서 '크기 고정'으로 싣는다. 결과: 두 경로 모두 원본 쪽과 화소 같음, 나머지 쪽은 한/글 자체
    복사 결과와 화소 같음(15쪽).
- 남은 차이: 표 40 캡션(KoPubWorld바탕체 Light 11pt + 라틴 글자) 한 줄 — 한/글은 두 줄로 나누고 rhwp 는 한 줄(폭 0.4px 차이, 줄바꿈 여유 50HU 안)이라
  그 뒤 쪽이 한 줄씩 어긋난다. 표지 첫 문단 -35px, 차례 표. 다른 생성 문서(착수미팅 71쪽)는 표 하나가 본문 끝 0.5px 밖까지 통째로 놓인다.
- 조판 시험지: `scripts/layout-probe-rowsplit.mjs <틀.hwpx> <out.hwpx>`(보고서 생성 스킬 서식 틀 필요 — 사용자 문서라 저장소에 두지 않았다) →
  `tests/hangul_roundtrip.py` → `layout-trace --hangul`. 고정 시험(`test:layout`)으로 옮기는 것은 다음 일.

### 2026-10-30 메모(MEMO 필드) 지우기

46. `paragraph.rs` `memo_slots`·`remove_memo_field`(시작·끝 표지 8유닛씩 — 끝 틈부터 닫는다, 글은 남김)·`memos_in_deleted_range`. 선택 지우기
    `delete_text_with_codes` 가 붙은 글이 모두 범위 안인 메모(빈 메모는 범위 한가운데·lead/trail 경계 틈)를 먼저 뺀다. `remove_code_control` 은 메모도 받는다.
47. `code_controls.rs` `code_control_at_native`: 붙은 글 없는 메모는 캐럿 자리 틈의 부호(`kind:"memo"`, `memoEnd`, 같은 자리 빈 메모 수 `memoCount`) —
    문단 맨 앞 Backspace 는 다른 부호처럼 합치기가 먼저. 붙은 글이 있는 메모는 조판 부호 보기일 때만(끝 표지 뒤 Backspace·시작 표지 앞 Delete).
48. `paragraph_layout.rs` `layout_click_here_and_bookmark_markers`: 조판 부호 보기에서 붙은 글 없는 메모를 `[메모 시작][메모 끝]`(한/글 2022 표시,
    누름틀 표지와 같은 길). 붙은 글이 있는 메모는 그리지 않는다 — 줄 글 조각이 필드 경계에서 나뉘지 않아 표지가 글과 겹친다.
49. `merge_from`: 글 없이 부호만 있는 문단(메모만 남은 빈 줄)의 글자 모양은 받지 않는다 — 빈 글 조각이 남아 빈 문단의 글자 모양(마지막 조각)이
    바뀌고 공유 문서와 서식이 어긋났다.

59. `serializer/hwpx/field.rs` `field_begin_open_tag`: 메모는 늘 `zorder`(순번 memo_index, 없으면 parameters 의 Number)·`metaTag=""` —
    zorder 가 없으면 한/글이 저장할 때 메모 끝(fieldEnd)을 모두 버린다(실측 19 → 0, 2026-10-30). `text_editing.rs` 세 범위 지우기: 선택이 빈 줄에서
    시작하면 그 줄의 메모를 뺀다(`Paragraph::remove_empty_line_memos` — 한/글: 메모 부호가 든 선택 = 메모째).

### 2026-10-30 도형(그리기 개체) 저장 — 한/글 COM 실측(`tests/fixtures/shapes_hangul.hwpx`·`shapes_hangul_edits.json`)

50. `object_ops/shape.rs` `release_removed_control_slot`: 도형·그림 지우기(`delete_shape_control_native`·`delete_picture_control_native`)가 글자 위치만
    8 당기고 글자 모양 경계(`char_shapes`)·영역 태그·형광펜은 그대로 둬, 지운 개체 뒤 8글자가 앞 run 의 글자 모양을 받았다(보고서 표지 선을 지우면
    공백 8칸이 다른 글꼴로 — 공유 문서에 서식 덩어리가 함께 생김). 같은 자리를 함께 당긴다.
51. `set_shape_properties_native`(본문·칸 경로): 사각형 꼭짓점(`x_coords`·`y_coords`)을 바뀐 크기(sz)가 아니라 로컬 좌표(orgSz, 없으면 sz)로 다시 쓴다.
    한/글은 꼭짓점에 크기/orgSz 배율을 걸어 그리므로 크기를 바꾼 사각형·글상자를 배율 두 번으로 크게 그렸다(9500→12500 이 16447 로). 렌더러는 이 좌표를 쓰지 않는다.
52. `serializer/hwpx/shape.rs` `write_rendering_info`: 행렬이 없는 묶음 안 개체(편집기 '개체 묶기'로 만든 자식)는 transMatrix e3·e6 에 묶음 안 자리
    (offset)를 싣는다. 한/글은 자식 자리·범위를 이 행렬로 재서, 단위 행렬이면 자식들을 묶음 원점에 겹쳐 묶음 크기로 늘여 그렸다(한/글 저장본 실측과 같은 꼴).
남은 것: 범위 지우기(`deleteRange`)는 떠 있는 도형을 지우지 않고 남은 문단으로 옮긴다(공유 문서도 그대로 따라감). 글맵시(hp:textart)는 읽지 못해
내보내기에서 빠진다(서버는 지우지 않고 지킨다). curSz 0 인 묶음을 다시 열면 자식을 늘이지 않는다(서버는 크기 바꾼 묶음에 curSz 를 채워 피한다).

### 2026-10-30 차트(hp:chart + Chart/chartN.xml) — 한글 COM 실측(`tests/fixtures/chart_hangul*.hwpx`, `tests/chart_fidelity.test.mjs`)

한/글은 차트를 `<hp:switch><hp:case …ooxmlchart><hp:chart chartIDRef="Chart/chartN.xml"/></hp:case><hp:default><hp:ole binaryItemIDRef="oleN"/></hp:default></hp:switch>`
와 꾸러미 `Chart/chartN.xml`(매니페스트에 안 올림)·`BinData/oleN.ole`(application/ole)로 쓴다. 맨 hp:chart 도 열고, 다시 저장할 때 대체 OLE 를 만든다.

53. `serializer/hwpx/context.rs` `ole_part_plan`: 지운 차트의 `Chart/chartN.xml`·대체 OLE BinData·매니페스트 항목을 내보내지 않는다(종전엔 개체만 빠지고
    부분이 남았다). 남은 차트 부분은 한/글처럼 문서 차례로 chart1·chart2… 로 다시 매기고(`shape.rs` `write_chart_element` 의 chartIDRef 도), OLE 는
    `oleN`·`.ole`·`application/ole` 로 쓴다. 문서 모델(bin_data_content)은 그대로라 되돌리기 스냅숏·순번 참조가 안전하다.
54. `shape.rs` `write_chart_switch`: 대체 OLE 의 배치·크기·글 감싸기·캡션을 차트와 같게 쓴다(편집기 옮기기·크기가 차트에만 걸려 hp:ole 가 옛 자리로 남았다).
55. `parser/hwpx/mod.rs`: `Chart/chart*.xml` 을 꾸러미 목록으로 다 읽는다(종전 chart1..64 를 차례로 읽다 빠진 번호에서 멈춰 뒤 차트가 빈 개체).
56. `object_ops/chart.rs` `insert_chart_native`(wasm `insertChart`): 차트 넣기 — 맨 hp:chart(글자처럼·위아래·그림 번호, 32250×18750) + 한/글이 다시
    저장하는 꼴 그대로의 Chart/chartN.xml(막대·가로 막대·꺾은선·원형 — 다시 저장본과 바이트 같음). 기본 자료는 한/글(엑셀) 기본 차트(항목 4 × 계열 3).
    값 고치기는 대체 OLE 가 없으면 ①(zip 부분)만 쓴다(종전 `nestedCopyNotFound` 거부).
57. `object_ops/table.rs` `delete_cell_shape_control_by_path_native`(wasm `deleteCellShapeControlByPath`): 표 셀 안 차트·도형 지우기(편집기가 본문 주소로
    보내 표를 가리켜 실패하던 것 — studio `deleteObjectControl`·잘라내기·메뉴 지우기가 셀 경로로).
58. `crates/rhwp-ooxml-chart` 그리기: 값축 고정 최소·최대(`c:scaling`)의 눈금(축 길이에 맞는 1·2·5 간격 — 0~5→1, 0~3→0.5, −5~5→2 …), 범위 밖 값은
    그림 영역 끝에서 자름(막대·누적·꺾은선 — 한/글: 최대 5 에 15 인 막대는 위 끝까지, 선은 끊김), 막대는 0 에서(음수는 아래로), 항목축은 값 0 자리
    (`c:crosses autoZero`), 꺾은선도 고정 범위, 자동 범위는 범위 5% 여유 + 축 길이에 따른 칸 수(세로 약 27px·가로 약 14px 에 한 칸, 3~10칸 — 같은 값
    1·2·5 가 높이 16000 이하 간격 2, 17000 이상 1), 10억 이상 지수 표기(1.0E+09), 눈금 글 폭을 모두 재 왼쪽 여백, 빈 칸(점 생략 `c:pt idx`)은 제자리.
    코퍼스 기준 시험 4개는 400×300px 합성 크기 대신 400×200px(높이 ≈15000)로 그린다(같은 값, 크기만 — 한/글이 크기에 따라 눈금을 바꾸므로).
남은 것: 값 칸이 빈 차트(희소 idx)는 데이터 편집 창이 거부한다(그리기·저장은 됨). 표 셀 안에는 차트를 넣지 못한다(본문만). 항목이 많거나 이름이 길면
한/글은 항목 이름을 기울이거나 건너뛰고 범례를 줄바꿈하는데 편집기는 가로로 겹친다. 계열 12개처럼 범례가 긴 차트는 한/글이 위 여유를 더 둔다
(0~20 대 0~15). 매니페스트 OLE 의 isEmbeded 는 한/글 0, 편집기 1(둘 다 열림), 지운 뒤 남은 OLE 번호는 다시 매기지 않는다(한/글은 ole1 부터).

### 2026-10-30 조판 부호 보기·부호 지우기 — 한/글 2022 실측(숨긴 한글 HAction, `tests/codes_view.test.mjs`)

60. `model/code_gaps.rs`(새): 글자 사이 틈의 폭 없는 부호 목록 `Paragraph::gap_codes`(논리 자리 = 틈 뒤 캐럿 자리, 틈 안 차례 = 글 붙은 필드 끝 먼저,
    그다음 컨트롤 차례 — `control_text_positions` 규약)·숨은 부호 여부·표지/창 이름, 칸 뒤 표지 `slot_labels`(글자처럼 취급한 개체·각주·자동 번호).
61. `renderer/layout/code_labels.rs`(새) `insert_code_labels`: 조판 부호 보기에서 줄을 다 놓은 뒤(줄 나눔은 그대로) 표지를 끼운다 — 틈 부호는 다음 칸
    앞, 칸 표지는 개체 뒤. 부호 자리를 가운데 품은 글 조각은 그 자리에서 나누고(글자 경계값을 `layout_positions` 로 옮김) 논리 차례가 뒤인 노드(글
    조각·그림·수식·각주 표지, 단 노드의 글자처럼 취급한 표·인라인 도형 자리)를 표지 폭만큼 민다. ↵ 는 끝 표지 뒤 빈 조각으로, 틈 끝 캐럿 자리에는
    폭 없는 자리 조각. 표지: #FF8000, 부호 run 의 글자 모양(자간·색 무시), 한글 1em·ASCII 0.5em, `editor_only`. `paragraph_layout.rs` 의 종전 표지
    (`collect_shape_marker_labels`·`layout_click_here_and_bookmark_markers` 의 [누름틀]/[메모]/[책갈피] — 47·48 을 대신함)는 끄고 안내문 자리만
    넘긴다. 글자처럼 취급한 표 문단(`layout_inline_table_paragraph`)은 같은 y 의 조각을 한 줄로 묶어 끼운다.
62. `render_tree.rs` `FieldMarkerType::CodeLabel(논리 자리, 틈 차례)`·`SlotLabel(논리 자리)`(`paint/json.rs` 도). `control_code_label` 은 표·그림·수식·
    사각형·글상자 개체에 붉은 `[표]` 를 개체 왼쪽 위에 더 그리지 않는다(`paint/builder.rs` 그림·수식 표지도) — 글자처럼 취급한 표의 첫 칸 글과 겹쳤고,
    한/글은 부호 자리(앵커·개체 뒤)에만 표지를 그린다. 머리말·꼬리말·각주 영역 표지는 그대로.
63. `cursor_rect.rs`: 보기 켬 기본 캐럿(틈 끝)은 앞 칸 표지·틈 표지 뒤(`get_cursor_rect_native` 뒤처리), 글자처럼 취급한 개체 문단의 캐럿 자리
    (`find_inline_flow_cursor_hit`)를 보기 켬에서도 쓰고 개체 뒤 자리는 표지 뒤, `hit_test_native` 는 표지를 누르면 앞/뒤 틈 자리(`codeGap`).
64. `code_controls.rs`: `getCodeGap`(틈 부호·글머리표 여부·문단 논리 길이), `getCodeDeleteTarget`(한/글 규칙 — 켬: 틈 안 바로 앞/뒤 부호, 끔: 숨은 부호
    건너뜀·글머리표 문단 첫 자리는 부호, 문단 첫 자리 Backspace·끝 Delete 는 부호 아님, 틈 자리를 모르는 캐럿은 글 붙은 메모 표지 건너뜀,
    [지움] 뒤 캐럿 틈 자리), `getCodeGapCaret`(틈 자리 캐럿 = 뒤 표지 왼쪽). 종전 `getCodeControlAt` 은 그대로(메모 시험 등).
65. rhwp-studio: `cursor.ts` 캐럿 틈 자리(`codeGap` — 화살표 한 번에 부호 하나, 끔이면 늘 보이는 부호 앞만), `input-handler-code-delete.ts`
    (엔진 규칙대로 묻고 지움, `skipOnce` 없앰, 머리말/꼬리말은 `deleteHeaderFooter`), `input-handler-text.ts` 합치기 뒤 캐럿(켬: 옮겨 온 부호 앞),
    `code-delete-dialog.ts` 조사(한글 아닌 끝 글자 → 를), `view.ts` 보기 바꿀 때 캐럿 다시 잼, `core/types.ts`·`wasm-bridge.ts`.
66. 표 칸·캡션·글상자: `getCodeGapCaretAt`(경로 틈 캐럿 — 칸 안 표지 왼쪽/오른쪽), `code_label_hit` 이 칸 표지도(칸 경로를 실은 적중),
    studio `cursor.ts` 틈 자리 상태·화살표가 칸 경로에도(`codeControlTarget`). 칸 안 지우기는 본문과 같은 `getCodeDeleteTarget`(숨긴 한/글 실측: 같다).
67. 틈 가운데 글 넣기 `insertTextAtCodeGap`(`code_gaps.rs` `code_gap_insert` — 새 글 스트림 자리 = 틈 끝 − 8 × 캐럿 뒤 부호 수, 캐럿 뒤 필드 시작·캐럿 앞 필드
    끝은 새 글 밖): 넣기 직전 thread_local 로 걸어 두고 `Paragraph::insert_text_at_caret` 이 한 번 꺼내 쓴다(본문·칸·경로 칸 넣기 경로·필드·리플로우 그대로).
    gap 없음(누른 자리)은 글 붙은 필드 끝이 없는 틈이면 틈 끝(종전에는 자리차지 도형 앞 — `inserts_before_inline_control` 이 글자처럼 취급 여부를 보지 않음).
    studio: `insertTextWithMutationEffects`·`replaceTextWithMutationEffects`(IME 조합), 넣은 뒤 캐럿 틈 0, `DeleteTextCommand` 되넣기는 지우기 전 틈 자리,
    `MergeParagraphCommand`·`MergeNextParagraphCommand` 는 이음매에 부호·글자처럼 취급한 개체가 있으면 두 문단 조각(captureDeleteRange)으로 되돌린다.
68. studio `input-handler-text.ts` `removeParagraphHeadAtStart`: 글머리표·문단 번호 문단 첫 자리 Backspace 는 머리 없음(applyParaFormat), 개요는 바탕글
    스타일(applyStyle 0) — 숨긴 한/글 실측, 다음 Backspace 가 합친다.
남은 것: 누름틀 표지 지우기는 종전 길, 각주 문단 끝 캐럿(보기와 상관없는 종전 어긋남), 좁은 칸에서 표지가 칸 밖으로 민 글 위 캐럿은 칸 끝으로 묶인다,
서버(engine/doc.js)는 받은 글을 틈 부호 앞에 넣는다(편집기 머리와 부호 차례가 다를 수 있음 — clean), 붙여넣기는 틈 자리를 따르지 않는다.

69. 문단 모양 '한 줄로 입력'(`hh:breakSetting lineWrap="SQUEEZE"` = ParaShape attr2 bits 0-1 == 1, 2026-10-30): 종전에는 칸(셀)만 보고 문단은
    무시해 표준서식 차례1·차례2 항목(한 줄로 입력)이 줄 정보 없는 문서에서 두 줄로 나뉘고, 한/글이 저장한 한 줄 정보가 있으면 넘친 글이 쪽 번호와
    겹쳤다. `style_resolver.rs` `ResolvedParaStyle.line_wrap_squeeze`, `line_breaking.rs` `squeeze_to_single_line`(다시 나눈 줄을 첫 줄 하나로 —
    강제 줄 바꿈·자리를 차지하는 개체가 든 문단은 그대로, 메모·필드 같은 폭 없는 부호는 괜찮다), `paragraph_layout.rs` 넘친 줄은 글자 폭은 두고
    자간을 고르게 줄인다(오른쪽 탭 줄은 탭을 뺀 글 폭 + 반 칸으로 잼). 한/글 2022 PDF 실측: 글자 상자 폭은 그대로, 글자 사이만 좁아진다(차례
    `[표 46] …` 줄 −1.8pt/글자, 빈칸은 덜). 한/글과 같은 압축량(빈칸 비율·탭 몫)까지는 맞추지 않았다 — 한 줄에 담기고 쪽 번호가 오른쪽 끝에 선다.

70. 표준서식 문서(2026-10-31, 따라하기 설명서를 표준서식으로 만들며 찾음):
    - HWPX 읽기 `parser/hwpx/mod.rs`: 구역의 `<hp:masterPage idRef>` 가 없을 때 매니페스트 차례로 바탕쪽을 짐작해 붙이는 대체 규칙이
      `masterPageCnt="0"`(바탕쪽 없음)을 밝힌 구역에도 걸려, 표준서식 앞부분 구역(표지·차례)이 본문 바탕쪽(머리 띠)을 얻어 차례 둘째 쪽부터
      띠가 그려지고 HWPX 로 저장하면 `masterPageCnt="2"` 가 되었다 → `section.rs` `section_declares_no_master_pages` 면 대체 규칙을 건너뛴다.
    - 차례 새로 고침 `toc.rs` `splice_toc_paragraphs`: 새 차례 문단으로 바꿔 끼울 때 첫 차례 문단의 쪽·단 나누기를 남긴다(구역 정의가 없는
      문단만). 종전에는 `<제목 차례>` 문단의 `pageBreak="1"` 이 사라져 차례가 표지 쪽에 붙어 그려졌다(한/글 새로 고침은 남긴다 — 표준서식
      템플릿의 한/글 저장본이 그 증거). 시험 `tests/manual_seed.test.mjs`.
71. 캔버스 글꼴 치환 기억(2026-10-31, studio `core/wasm-bridge.ts`·`core/local-fonts.ts`): `ctx.font` 를 칠 때마다(글자 조각마다 — 한 쪽에 수천 번)
    `substituteCssFontFamily` 가 대체 글꼴 사슬(`fontFamilyCandidatesForDisplay` → 규칙 셈)을 새로 셈했다. 호스트 글꼴로 바로 잡히지 않는 글꼴
    (빈 새 문서의 함초롬바탕·돋움)은 글자 하나 칠 때마다 쪽을 다시 그리는 데 수백 ms(프로파일: 3.3초 중 2.4초가 이 셈) — 14쪽 322문단 문서
    글자당 240~380ms. 같은 글꼴 문자열·같은 글꼴 상태(`fontLookupStateKey` = 설치 목록 판·호스트 글꼴 세대·수, 감지한 OS 글꼴 수)면 결과를
    다시 쓴다(4000개까지) → 33ms(보통 문서와 같음). 문단 하나에 줄 나눔 321개가 든 같은 문서도 280~490 → 83ms.
72. 그릇(표 칸·글상자) 안 떠 있는 표의 자리(2026-11-03, upstream #8322 칸·#8513 글상자) — 한/글 2022 실측 시험지(바깥 1×1 표 칸·글상자 ×
    자리차지/어울림/글 앞/글 뒤 × 문단/단/쪽/종이 × 왼쪽/가운데/오른쪽 × 오프셋 0·12774, 세로 기준·정렬·넘침·음수·문단 여백 추가 사례, 약 450개):
    - 세로 기준이 문단이면 가로 기준 영역은 문단 = 그릇 글 영역 − 문단 왼·오른 여백, 단·쪽 = 그릇 글 영역, 종이 = 그릇 상자(칸 안 여백·글상자
      안 여백 포함). 왼쪽 = 왼끝 + 바깥 왼여백 + 오프셋, 가운데 = 가운데 + 오프셋, 오른쪽 = 오른끝 − 폭 − 바깥 오른여백 − 오프셋. 배치 방식과
      무관하고, 그릇을 넘어도 당기지 않는다(넘친 부분은 잘린다). 세로 = 문단 위 + 오프셋 + 바깥 위여백(세로 정렬 무시).
    - 자리차지 표가 기준 문단 첫 줄과 겹치면 문단 글(표 앞에 쓴 글까지)이 표 띠 아래에서 시작한다 — 한/글 저장 줄도 그 자리(칸: 1980 + 769 + 283
      + 3400 + 283 = 6715). 글 앞/글 뒤 표는 흐름을 밀지 않는다. 어울림 표는 글이 옆으로 흐른다(미구현).
    - 세로 기준이 쪽·종이이면 그릇을 벗어나 쪽 좌표(가로 단·쪽·종이도 본문 단·본문·용지)로 놓는다(미구현 — 종전 갈래 그대로).
    - 종전 `compute_table_x_position` 중첩 분기의 "칸보다 좁으면 오프셋을 버리고 가운데"(#3308/#3820)와 그 예외들(#5787·#6787·글 앞/뒤)을
      `float_placement.rs` `nested_float_origin_x` 하나로 바꿨다(칸: `nested_float_frame` 을 `layout_horizontal_cell_paragraphs`·
      `layout_partial_table_cells` 가 문단마다 설정, 글상자: `shape_layout.rs` `layout_textbox_content`). 76076(HWP·한/글 재저장 HWPX) 칸 안 표
      15개가 한/글 PDF 와 맞는다(종전 HWPX 는 2.5~4.4px 오른쪽). 남은 일: 측정(`height_measurer`)은 글 앞/뒤 표 높이를 여전히 칸 내용에 넣는다.
73. 실문서A 각주 18·`<표 10>`(2026-11-04, 한/글 2022 쪽 그림·재저장 줄 대조, 본문 16·17·39쪽):
    - 표시가 든 본문 문단이 쪽을 넘고 그 각주의 저장 줄이 다음 쪽에서 다시 시작하면(각주 18: vpos 0·0·1172) 한/글은 앞 조각(첫 줄)을 표시 쪽
      각주 영역 맨 아래에, 나머지를 다음 쪽 각주 맨 위에 둔다. 종전에는 표시 쪽 수용을 각주 **전체** 높이로 견주어 통째로 다음 쪽에 놓았고,
      저장 줄 재시작 때문에 첫째·둘째 줄이 같은 높이에 겹쳤다 → `typeset/notes/footnotes/body.rs` 가 저장 재시작 조각이 있으면 앞 조각 높이로 견준다.
    - 글자 없는 앵커 문단의 문단 기준 어울림 표가 옆에 글이 흐를 자리를 남기지 않으면(표 폭 37133 > 단 36848) 한/글은 빈 줄을 표 바깥 상자 아래로
      내려 저장한다(캡션 끝 7740 → 50862 = 7740 + 283 + 42556 + 283). 표 원점은 문단 위(캡션 바로 아래 315px). 종전에는 저장 줄 스냅을 원점으로
      써서 표가 575px 내려가 쪽 밖으로 잘렸다 → `layout.rs` `stored_empty_square_table_pushdown_hu`(저장 사다리가 거리를 정확히 증명할 때만).
    - 단 기준 왼쪽 정렬 어울림 표도 자리차지 표처럼 바깥 왼쪽 여백만큼 안쪽(155 = 151.2 + 3.8) → `float_placement.rs`
      `square_column_left_outer_margin_left_hu`. 조판 회귀 17,467회: 같음 15,376 → 15,398(B 어울림 표 바깥 여백 사례 22, 같음→차이 0).
    - 남은 차이: 각주와 각주 사이 간격이 한/글보다 약 4px 좁다(한/글 줄 위 간격 16px, 엔진 12px — 종전부터).
74. 각주 줄 겹침(2026-11-04, 보강 회귀 F 96사례·실문서A 한/글 2022 PDF 대조):
    - 각주 문단을 그릴 때 표지 번호(`usize::MAX - 2000 - n`)가 `endnote_para_base` 보다 커서 미주 가상 문단으로 다뤄졌다 — 여러 줄 각주가 저장
      vpos 사다리로 놓여(쪽 첫머리 `0·0` 재시작이면 두 줄이 같은 높이) 겹치고, 마지막 줄간격이 두 번 빠져 다음 각주가 위로 올라왔다 →
      `layout.rs` `is_endnote_virtual_para`(각주 표지 범위 제외), `layout/paragraph_layout.rs` 다섯 곳.
    - 본문 각주 예약 높이를 그리는 값(`estimate_footnote_area_height_with_metrics`)으로 잰다. 저장 줄 높이 합만 쓰면 줄 사이 간격이 빠져
      여러 줄 각주의 실제 영역이 예약보다 커지고 본문 끝 줄과 겹쳤다(`typeset/notes/footnotes/body.rs`; rhwp 단위 시험
      `footnote_area_reserve_uses_section_shape_metrics` 의 기대값도 이 값으로).
    - HWPX 는 빈 꼬리말 밴드 회수(#2559)와 각주 안전 여백(40px)을 쓰지 않는다 — 둘이 서로를 상쇄하던 보정이고, 그리기는 각주 영역을 본문
      바닥에서 위로 잡으므로 본문이 각주 영역 안으로 들어갔다. 한/글 2022 는 각주 끝 줄이 본문 바닥에 닿고 본문 줄은 그 위에 들어갈 때만
      둔다(`typeset/state/notes.rs`, `typeset/section.rs`; HWP5·HWP3 는 종전).
    - 표시 줄을 놓는 때에 각주 자리를 잡는다: 표시 줄 아래 들어가는 만큼(되도록 통째, 아니면 앞 몇 줄) 각주를 두고 표시 문단 뒤 줄은 그 위에
      들어갈 때만 이 쪽(채움 26·각주 3줄 → 각주 3줄 0쪽, 표시 문단 둘째 줄부터 1쪽; 채움 28 → 각주 첫 줄만 0쪽). 한 각주가 나뉘면 같은 쪽
      뒤 각주는 다음 쪽 → `boundary.rs` `first_footnote_reserve_break_line`, 표시 쪽이 이미 끝났으면 `body.rs` 가 그 쪽에 통째 또는 앞 조각.
    - 표시 문단 마지막 줄 뒤 줄간격·문단 아래 간격은 각주 영역과 겹쳐도 된다(F 채움 28 단일 줄, 실문서A 각주 13). 각주 첫 줄도 안 들어가면
      글만 있는 각주는 표시를 두고 통째로 다음 쪽(실문서A 108쪽 제목 문단 표시 78 → 109쪽).
    - 한/글 재저장본에서 각주 저장 줄이 쪽 첫머리 `0 → 0` 으로 다시 시작하면 표시 쪽 경계를 앞 조각 높이로 한 번 더 찾는다(F 채움 28·여러 줄
      표시·각주 3·5줄 재저장본의 겹침).
    - 회귀: 20261103 같음 15,600 그대로, 20261104 같음 7,419 → 7,507. F 겹침 84사례 → 0(본문·각주 영역, 각주 줄끼리), 실문서A 본문·각주 겹침 11쪽 → 4쪽,
      각주 줄 수가 한/글과 다른 쪽 15 → 5(쪽 수 127 = 한/글). 남은 4쪽(12·55·75·81)은 본문 줄 위치가 한/글보다 2~40px 아래인 종전 본문 흐름 차이다.
      각주 안 표가 쪽 끝에 걸린 사례(footNote/tbl straddle 재저장 69)는 한/글이 표를 두 쪽에 나누는데 엔진은 못 나눈다 — 종전에는 각주 영역이
      본문을 덮었고 지금은 표가 다음 쪽 각주로 간다(둘 다 차이, 기록 다시 고정). → 75 에서 나눔 구현.
75. 4차 조판 수정(2026-11-04, 한/글 2022 COM 시험지·재저장 vpos·실문서A PDF, 상세 `docs/LAYOUT_FIX_2026-11-03.md` 7장):
    - 각주 안 쪽 끝 표: HWPX CELL = 행 가운데서도(칸 글은 줄 경계, 한 줄도 안 들면 행 위 경계), TABLE = 행 경계만(첫 행이 안 들면 통째 다음 쪽 각주),
      NONE = 통째. 제목 줄은 다음 쪽 조각에 반복, 뒤 조각은 다음 쪽 각주 맨 위(구분선 아래 + 바깥 위 여백), 세로 오프셋은 앞 조각만, 나뉘는 표 문단은
      위 간격 없음. 칸 안에 개체가 든 행(상자표)은 자르지 않고 통째. 한/글은 나뉜 표의 저장 sz 에 첫 조각 높이를 적는다(예약에 쓰면 안 됨).
      엔진 이름 주의: `CellBreak` = HWPX TABLE, `RowBreak` = HWPX CELL. → `FootnoteFragment.float_cut`, `picture_footnote.rs` `split_footnote_for_capacity`.
    - 본문 쪽 끝 CELL 표 재저장본: 첫 조각 = 본문 끝 − 표 윗변 − 아래 바깥 여백 − 101HU, 밀린 앵커 줄은 끝 조각 끝 + 아래 여백 자리(앞 간격 없음),
      공백만 있는 host 도 한 줄 차지. 앞 간격(textPrev)은 같은 단에 같은 문단 표가 줄보다 먼저 놓였을 때만 뺀다(표만 넘어가는 상자표는 둔다).
    - 쪽 나누기 문단('제X장')이 쪽을 열면 앞 간격을 둔다(쪽 원점 기준). 쪽 넘긴 표의 host 글줄은 표 끝 + 아래 여백 140 + 글줄 + 뒤 간격 한 번.
      글 없는 표 host 의 앵커 줄은 줄 너비 0 이면 표 위 겹침(아래 여백 0 표는 표 뒤 아래 간격 생략), 너비 > 0 이면 표 뒤.
      문단 기준 자리차지 표는 첫 줄 들여쓰기를 더하지 않는다. 본문 각주 번호 = 번호가 든 글자 모양 × 0.75(기준선 줄 위 + 0.643em).
    - 회귀: 20261103 같음 15,615 → 15,806, 20261104 7,532 → 7,914(바탕 대비 같음→차이 0), 기록 다시 고정. 실문서A 본문 줄 dy>1px 253 → 111,
      각주 줄 5 → 0, 겹침 4쪽 → 0. 남은 것: 표 쪽 나눔 연쇄(65~79·111~114쪽), 표 위 −1.8px, 쪽 걸친 어울림 셀 나눔 표.
76. 나뉜 칸(HWPX CELL = 엔진 `RowBreak`)의 쪽 끝 마지막 줄(2026-11-11, 한/글 12.0.0.3146 숨은 COM — `CreatePageImage` 빨간 표지 줄 쪽 +
    재저장 칸 문단 vertpos 되감김, PDF 안 씀. 시험지 `scripts/layout-probe-cellcut.mjs`, 결과 `tests/fixtures/layout/cellcut-20261111/hangul_summary.json` 496사례):
    줄 윗끝에서 본문 끝까지 남은 높이 ≥ **줄 높이(vertsize) + 칸 아래 안여백 + 101HU** 이면 그 줄은 앞 쪽에 남는다(+100 은 다음 쪽).
    줄간격(160·180·300%)과 문단 뒤 간격(0·500)은 필요 없다. 글자 1000·1100·2000, 안여백 0·141·500, 문단 끝 줄 / 문단 가운데 줄(강제 줄 나눔),
    다음이 빈 문단 / 글 문단, 옆 칸이 같이 나뉨(공유) / 안 나뉨, **칸·표의 마지막 줄**(빈 host — 표가 통째로 들어갈 높이여도 나눈다) 모두 같은 문턱.
    75 의 '− 101HU', #7095·#8101 의 비끝 조각 inset 100HU 와 같은 상수.
    고치기 전 엔진(`1a692a7e…`): 저장 줄 없는 입력은 문턱이 1~100HU 이르고(비공유 11pt 는 정확히 +100 에서 남김, 20pt·공유 칸은 inset 없이 줄 높이만),
    표의 마지막 줄은 한/글 재저장본에서도 통째 수용(본문 끝 − 50HU 까지)으로 앞 쪽에 남겼다. Rust `empty_reset_shares_…`(비공유 기대 2)는 실측과 어긋나 3 으로 고침.
    고침(2026-11-11): `rowbreak_page_end_guard_applies`(문단 기준 자리차지·비 TAC·RowBreak·inset>0·native HWP5 저장 조판 제외) 표는
    ① 통째 수용도 표 끝이 본문 끝 − 100.5HU 안이어야 한다(`block/entry.rs` `page_end_guard_rejects_whole`, host 글 표의 기존 `available` 경계와 중복 없음),
    ② 조각 내용 수용 하단 = 본문 끝 − 바깥 아래 여백 − inset − 0.5HU(`rowbreak_fragment_bounds` — 일반 격자도, 저장 줄 표도; NO_LS 글줄은 HWP5 에서도).
    결과: 496/496(입력·재저장 모두), 회귀 시험 `tests/layout_cellcut_hangul.test.mjs`(경계 28쌍). 조판 회귀 두 묶음 29,949검사·pagesplit·`test:layout`
    은 고치기 전 엔진과 판정이 같다(새 차이 0). 표본 문서 74개 중 쪽 수 변화 0, 그림 트리 차이 4문서(REAL-police 65·113쪽, table-options 2개)는 모두
    조각 상자 하단 0.5HU(0.007px) 이동으로 생긴 0.1px 반올림 차이다. 운영 반영 2026-11-11 10:08(`ad6283b0…`).
77. 따옴표 줄 끝·run 없는 빈 문단·없는 글꼴·그림 선(2026-11-11, 한/글 12.0.0.3146 숨은 COM 재저장 줄·쪽 그림, PDF 안 씀 — `artifacts/test-failures-20261111/`,
    회귀 `tests/layout_hangul_probes_20261111.test.mjs` + `tests/fixtures/layout/hangul-probes-20261111/`). HWPX `breakNonLatinWord` 이름은 화면과 반대(KEEP_WORD = 글자 단위).
    - ASCII `"` 는 줄 꼬리 금칙이 아니다(v0.9.0 과 같음): 글자 단위 `가…가 "나다…` 는 `"` 까지 앞 줄(엔진은 `"` 까지 넘겨 1자 일찍 끊었다), 붙은 `가"나` 도 `"` 가 줄 끝.
      단 뒤에 붙은 영문 낱말과는 한 덩이(`가…가 "ABC…` → `"A…` 통째로 넘김, `char_mode_allows_break_after`). 줄 머리 금칙은 그대로(`가"` 는 앞 글자와 함께),
      `(`·`“` 는 꼬리 금칙, `'` 는 금칙 아님(fork 규칙 확인). 어절 단위(BREAK_WORD)는 `"나다…` 낱말을 통째로 넘긴다. 따옴표 57사례 57/57(고치기 전 56/57).
    - run 없는 빈 문단: 바탕글·글자 모양 0 이 7pt·20pt, 문단 스타일이 30pt 여도 줄은 10pt(vertsize 1000) — 한/글 재저장은 run 없이 두고 기본 글자 모양(10pt,
      글꼴 0)을 새로 만든다. 바탕글을 따르지 않으므로 엔진의 암묵 10pt(`materialize_missing_paragraph_defaults`) 유지, Rust `task1592` 기대를 10pt 로 고침.
    - 설치 안 된 글꼴(`Tom's Handwriting`)을 한/글은 한컴바탕 계열 명조로 그린다 — 엔진 체인(요청 face → 한/글 FontDB 기본 대체 → 일반 대체) 기준으로 시험을 고침.
    - 그림 lineShape `DASH` = 코드 3(촘촘한 점, 주기 4px), `DOT` = 코드 2(파선, 주기 7px) — 엔진이 맞고 시험 기대를 고침.

줄바꿈: 이 PC 의 git 설정(core.autocrlf=true) 때문에 작업 폴더 파일은 CRLF 다. 패치는 줄바꿈을 LF 로 맞춘 뒤 비교한다.

### 2026-11-07 HFT 윤곽 배포 종료 — TTF + 차이 있는 위치 정보

현재 웹은 HFT 추출 OTF를 배포하거나 로딩하지 않습니다. 기존 Studio·native 검색·CanvasKit 공급과
빌드 입력의 `fonts/hft`를 제거하고 원본/이전 자산은 `artifacts/hft-ttf-mapping-20261106/preserved/`에 보존했습니다.
`fontdata/`와 `artifacts/hft-native-*` 원본은 유지합니다. 이 작업 완료 당시에는 APK1.0.7을 철회하고 공개1.0.6을 유지했습니다.
그 뒤 사용자 후속 지시로 같은 TTF 위치 정보 엔진의 새 APK1.0.7/versionCode9를 빌드·게시했습니다.
추출 윤곽 없는37,544,484바이트 빌드이며 기존 코드8과 구분합니다. 검증·공개 해시는
`artifacts/apk-1.0.7-ttf-20261107/REPORT.md`에 기록했습니다.

`scripts/gen-hft-ttf-mapping.py`가 기존 Studio/엔진 대응표·FontDB·TTF 메트릭·읽기 전용 추출 자료로
491슬롯 바인딩/280메트릭 조합을 생성합니다. `renderer/hft_ttf_data.json`은 차이 있는370,999행만 가지며,
전진폭·왼쪽 여백 오프셋·기준선 오프셋·표시 문자만 저장합니다. 일치181행은 생략했습니다.
`renderer/hft_ttf.rs`는 측정과 최종 render tree의 공통 결정을 담당하고 TTF 윤곽 크기는 바꾸지 않습니다.
31프로그램의 U+2024는 TTF U+00B7로, SPMJ.HFT의 실제 위 방향 U+21DF는 TTF U+21DE로 그립니다.
원문과 저장 글꼴은 유지합니다. 추출 OTF의 hhea850/−150은 포장용 수치이므로 줄 높이 기준으로 쓰지 않습니다.

운영 WASM SHA256 `8bd810df506b25d366bbfe5fd2646fbd98fc633aaac55858788f4cd37d6d11e4`.
관리 API 정상 재시작과 공개 index→JS→해시 WASM,83파일 무결성, 이전 OTF326주소404를 확인했습니다.
Rust3/3·Node4/4·KoPub14/14동일·4경로20쪽 통과. 한/글2022 저장 기준29,949비교에 기존 차이5,927개가 남으며,
실패로 표시된12사례24경로는 작업 시작 엔진과 동일합니다. 전체 위치값 독립대조·실제 브라우저·native 출력은 미검증입니다.
자세한 수치·대응표·61미지원HFT/266누락TTF/44복합화살표 등 한계는 `artifacts/hft-ttf-mapping-20261106/REPORT.md`를 봅니다.

### 2026-11-06 HFT 원본 기반 오프라인 SFNT — 아래는 철회 전 이력

**당시 배포 상태(2026-11-06 22:13 KST; 현재 상태는 위 11-07 절 참조).** 아래 보류 기록 뒤 사용자가 이 후보의 운영 반영·재시작과 APK 배포를
명시적으로 요청했다. 최종 `bc68af03…`를 운영에 반영하고 관리 API로 정상 재시작했으며,
공개 409파일(추출 OTF326개 포함)의 SHA256을 전부 대조했다. 같은 엔진의 APK1.0.7/versionCode8도 게시했다.
Android15의 실제 오프라인 WebView에서5쪽 로딩·native60개 로딩·그리기·SPJGT/SPSMJ U+2024 중간 높이를 확인했다.
기존 한/글 차이5,927개와 미지원61개 등 한계는 그대로다. 최종 배포/공개 다운로드 근거는
`artifacts/hft-native-20261106/release-check/deploy/completion.json`이다. 아래 미배포·보류 문장은 그때의 이력이다.

`fontdata/구조해독/hft-native-decoder`를 사용해 설치된 한/글 2022 HFT 중 326개에서 Unicode 전진폭 항목
388,461개와 기준선 좌표의 원곡선을 추출했다. `assets/fonts/hft/*.otf`는 3차 곡선을 그대로 보존한 OpenType CFF이며,
`renderer/native_hft_data.json`과 같은 폭을 쓴다. 빌드·실행에서 HFT 원본/Code 표/Python/DLL은 사용하지 않는다.
선택은 명시적 HFT 슬롯·실제 glyph coverage·변형 프로그램으로 결정한다. 미지원 음절은 기존 SFNT 대체를 유지하고,
HY중고딕 TTF에 없는 기호는 사용자 지정 `fontdata/hft-font-policy.json`에 따라 추출 SPJGT를 선택한다.
문서에 저장되는 원래 글꼴 선언은 바꾸지 않는다.

HFT 영문 구두점·합성 Bold·부분 Italic coverage의 측정/paint 연결과, 표의 no-space Justify 말미 공백/N−1 간격을 수정했다.
2022 COM 기준 곡선·폭 360/360, 9쪽 456글자·문맥 77글자·표 132글자의 시작점 모두 1px 이내다.
Rust 29/29, 조판·쪽 나눔 18/18, SFNT 공급 3/3 통과. 전체 29,949 회귀의 새 악화는 작업 전 대비 0이며,
저장 기준 대비 기존 12개 실패는 남아 있다. 미지원 61개·힌팅·전체 glyph COM/실제 브라우저·native Skia는 미검증이다.
후보 WASM `46ba3b1f…`, Studio와 매핑표·무결성 결과는 `artifacts/hft-native-20261106/complete/`,
`extracted/runtime-mapping.csv`, `verification.json`에 있다. 상세 규칙·재생성·검증과 한계는
`docs/FONT_SYMBOL_MATCHING_2026-11-06.md`의 HFT 원본 기반 오프라인 SFNT 절을 본다.

**서버 반영 전 추가 검증 정정(당시 상태).** 후보는 `release-check/ready/engine-pkg`의 `bc68af03…`이며 당시 운영 미반영이었다.
폭 표의 font design 단위와 outline block 단위를 분리하고, Hanja/Symbol의 누락 폭 표와 명시적 0을 구분했다.
현재 326개 SFNT에 389,095개 Unicode 폭이 있다. HFT 누락 글자는 원문 FontDB의 H 경로를 따르며,
`±`의 영문 슬롯을 중립 상속으로 덮던 조판 경로와 `※`의 기호 슬롯을 고쳤다.
새 48개 특수문자 시작점은 저장/재조판 모두 2022 기준 1px 이내이고, 기존 665개 시작점도 통과했다.
29,949개 회귀의 작업 전 대비 새 악화는 0이지만 한/글과의 기존 차이 5,927개(그중 기존 실패 표시 12개)는 남는다.
작업공간 소실 후 사용자 승인으로 새 Ego 작업공간에서 최종 후보를 실제 Chrome156으로 확인했다.
Studio5쪽 로딩 오류0, 실제 Canvas195개 원점 최대 x0.0000151px/y0.0000041px 차이, 추출6개 바이트 해시 일치다.
120항목 중119개 원본 폭 차이는1/64px 이내이며 HY중고딕12pt •의 한컴바탕 내장 bitmap 폭 차이는 구분해 기록했다.
조건부 배포·재시작 요청의 무결성 조건을 충족하지 못해 운영 WASM·Studio·서버 인스턴스를 유지했다.
최신 근거는 `artifacts/hft-native-20261106/release-check/ready/verification.json`과 위 상세 문서의 마지막 절에 있다.

### 2026-11-03 조판 회귀 수정 — 한/글 2022 기준 17,467회 비교(`tests/fixtures/layout/regression-20261103`)

같음 6,144 → 12,948(같음→차이 0). 원인 유형별 수정·근거·남은 차이·측정 문제 후보는 `docs/LAYOUT_FIX_2026-11-03.md`, 축별 근거(한/글 COM 실험 경로)는 `artifacts/layout-fix-20261103/reports/`. 이번에 확인한 한/글 규칙 요약:
- 그리기 채움 `alpha` 는 정수 바이트(128 = 50%). 설치 안 된(폭 표에도 없는) 요청 글꼴은 한컴바탕 폭으로 줄을 나눈다.
- 글상자 `protect=0` 은 넘친 글에 맞춰 위·아래 안 여백 + 글 높이로 늘어난다(줄이지는 않음, 저장 sz=지정·curSz=늘린 높이, HWP 도 같은 짝). 묶음 높이는 자식 범위.
- 한/글 재저장 첫 줄은 문단 첫머리 자리차지 개체 아래로 밀린 줄이다 — 문단 기준 개체 원점은 문단 위. 자리차지·어울림 개체의 음수 세로 오프셋, 단·문단 기준 왼쪽 음수 가로 오프셋은 0.
- 각주 안 개체: 가로는 각주 글 상자 안에서 정렬, 세로 문단 위 + 오프셋, 자리차지 띠가 글을 밀고 각주 높이는 개체 바닥까지. 개체만 넘치면 개체만 다음 쪽 각주 맨 위. 미주는 쪽 첫 미주 줄~본문 바닥 틀.
- 머리말·꼬리말 개체는 모든 기준(종이 포함)을 머리말·꼬리말 틀로 잰다. 바탕쪽은 문단·단·쪽 = 본문, 종이 = 종이, 바탕쪽 글은 본문 위 기준.
- 표 칸·글상자 안 세로 쪽·종이 기준(또는 '쪽 영역 안 제한' 끈) 개체는 그릇을 벗어나 쪽 좌표에 놓이고 그릇 글을 밀지 않는다(본문 글은 민다).
- 쪽(단) 끝에 걸린 나누지 않는 표·그림은 개체만 다음 쪽(단) 맨 위(세로 오프셋 버림), 앵커·뒤 글은 이 쪽. 나뉜 칸에서도 개체만 다음 조각으로.
- 표 pageBreak: HWPX TABLE = HWP 1 = 행 경계에서만(첫 행이 안 들어가면 표만 다음 쪽), CELL = 2 = 행 가운데서도, NONE = 0 = 통째로. 표의 TIGHT/THROUGH 는 SQUARE 와 같이 다뤄진다(엔진 미반영).

### 2026-11-06 글꼴 선택 — 한글 2022 FontDB 우선

`renderer/hancom_fontdb.rs`는 `scripts/gen-hancom-fontdb.py`가 만든 FontDB와 실제 설치 SFNT 정보를 사용한다.
설치 글꼴/글리프 우선, 언어별 2022 대체 경로, KOR 기본 후보를 구분하며 Tahoma 등의 무조건 치환을 제거했다.
문서 substFont는 whole-font 부재와 missing-glyph를 구분하고, Bold 윤곽/일반 advance, Italic,
OS/2 width class를 유지한다. 실제 SFNT의 Canvas/SVG glyph-fit 압축을 중지하고,
전체 스타일명·가족명·실제 굵기/폭 등급을 함께 전달한다. 원본 문서의 fontRef를 고쳐 저장하지 않는다.

같은 857항목 U+2024 입력에서 한글 2022 폭 오차 0.01em 이내는 729 → 822, 새 악화 0건.
추출 가능한 PDF 원본 glyph 윤곽 818건은 선택 파일과 일치한다. HFT 원본 37건과 PDF 추출 실패 2건은 미검증이다.
세부 조건·새 표본 45건·재생성/검증 명령·2024 원본 부재의 한계는
`docs/FONT_SYMBOL_MATCHING_2026-11-06.md` 후속 절, 최종 WASM 해시와 매핑은
`artifacts/fontdb-2022-20261106/verification/engine.json`, `font-map-2022.csv`에 있다.

**2026-11-06 저녁 정정(웹 편집기 글꼴 회귀).** 위 변경의 `missing_glyph_policy::paint_override` 가
요청 글꼴이 가진 글자까지 모두 물리 전체 이름('KoPubWorld돋움체 Light' → 'KoPubWorldDotum Light',
'맑은 고딕' → 'Malgun Gothic', '한컴 고딕' → 'Hancom Gothic Regular')으로 바꿔 그렸다. 웹 글꼴 공급은 문서 이름으로만
글꼴을 준비하므로 편집기가 Noto Sans/Serif KR 로 그렸다. 이제 요청 글꼴의 GDI 가족(Regular/Bold/Italic 연결) 안에서 고른
글자는 문서 이름 그대로 그리고(`GlyphSelection.requested_family`), 요청 글꼴에 없는 글자만 FontDB 물리 이름을 쓴다.
또 `gen-hancom-fontdb.py` 의 `getDebugName(1)` 이 Mac 이름(=타이포 가족)을 골라 38개 face(KoPub*·Nanum*·Candara Light·
SamsungOneUI 등)의 굵기를 한 가족으로 묶었다 — KoPubWorld 돋움체 Light 굵게가 Bold 파일로, 나눔스퀘어 Bold 가 다른 굵기 폭으로
잡혔다. 생성기가 Windows(GDI) 이름 1 을 읽도록 고쳐 다시 생성했다(`full` 은 그대로, `family` 38행만 바뀜).
고친 엔진 `147810ef…`: 857항목 2022 폭 0.01em 이내 822(같음, 새 악화 0), 윤곽 818/0/39(같음), FontDB 표본 45/45,
그리는 글꼴 이름·글자 폭은 아침(07:14) 엔진과 같다(`artifacts/kopub-font-fix-20261106/probe-before.json`·`probe-after.json`).
남은 한계: 요청 글꼴에 없는 글자의 FontDB 대체 글꼴은 여전히 물리 이름('Haansoft Batang' 등)으로 그리며, 웹이 그 이름을 준비하지
않으면 Canvas2D 에서는 Noto 로 보일 수 있다(아침 엔진도 같았음, 미검증).

### 2026-11-12 편집기가 쓰는 값 = 한/글 2022 재저장 값(`research/edit-preservation-20261112/preserve/hangul_values.md`)
편집기 엔진 API 37사례의 내보내기를 한/글 2022 COM 으로 다시 저장해 secPr·그림·표·도형·수식 속성을 견줬다. 한/글이 다시 쓰는 값 중 편집기가 틀리게 쓴 것을 고침:
구역 기본 탭 간격(한/글은 `tabStopVal`(HWPUNIT)을 읽고 `tabStop`=2배 — 직렬화 tabStopVal=tabStop/2, 파서 tabStopVal 우선), 첫 쪽 테두리/배경 감추기 HIDE_FIRST(옛 HIDE_ALL 도 읽음),
회전·배율 행렬 f32 소수 6자리(끝 0 뺌), 타원 intervalDirty·hasArcPr·arcType(HWP5 attr 비트), 연결선 isReverseHV=0 생략, 수식 `hp:sz protect="0"`,
묶음 자식의 `hp:sz`·`hp:pos`·`hp:outMargin` 생략·id 0(한/글 저장본 223개의 묶음 자식 32개 모두 이 꼴 — 옛 꼴은 엔진이 자식 pos 를 offset 위에 한 번 더 더해 그렸다).
고치지 않음(한/글이 다시 계산·같은 뜻): 크기 바꾼 개체의 curSz·배율·회전 중심, 표 hp:sz(E1), 설명 글 CR 표기, 높이 0 선의 -nan 행렬.
남은 것: 이미 저장된 옛 꼴 묶음(자식 hp:pos 있음)은 편집기가 여전히 어긋나 그린다 — 한/글이 그 꼴을 어떻게 그리는지 실측 전(미수정).
