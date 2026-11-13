# rhwp 0.9.0 올리기 — 판단과 계획 (2026-11-09)

upstream `edwardkim/rhwp` 의 v0.9.0(2026-11-08, `c9095c5f67`)을 우리 독자 개선 엔진(`vendor/rhwp`, v0.8.7 `1a76570e8` 기반)에 반영하는 계획이다.
범위와 원칙은 `AGENTS.md` §1·§2·§7 을 따른다(로컬 제품 작업 — upstream 기여 아님).

## 1. 결론: "0.9.0 을 바탕으로, 우리 변경을 git 3-way 병합으로 다시 얹는다"

질문의 두 안 중 **1안(0.9.0 기반 + 우리 이력 재반영)** 으로 간다. 다만 "통째로 바꾼 뒤 손으로 다시 입력"이 아니라,
우리 변경을 v0.8.7 위의 git 커밋으로 만든 뒤 v0.9.0 과 **3-way 병합**한다. 겹치지 않는 부분은 git 이 자동으로 합치고,
사람이 볼 곳은 충돌 덩어리로 정확히 좁혀진다.

| 비교 | upstream 0.8.7→0.9.0 | 우리 fork (0.8.7 위) |
|---|---|---|
| 커밋 | 4,916 | (커밋 없음 — 작업 트리 변경뿐이었다) |
| `src/` | 1,213 파일, +272,471 / −53,184 | 202 수정 파일 +22,742 / −2,851, 새 파일 40개(약 13천 줄, 생성물 제외) |
| `rhwp-studio/` | 396 파일, +45,406 | 30여 파일 |

- **2안(0.8.7 에 0.9.0 변경을 골라 넣기)을 택하지 않는 이유**: 넣어야 할 양이 우리 변경의 약 10배(4,916 커밋)다.
  upstream 이 composer 를 40여 개 하위 모듈로 쪼개는 등 구조를 바꿔서 골라 넣기 자체가 사실상 재구현이 되고,
  다음 판(0.9.x·0.10)마다 같은 비용이 다시 든다.
- **1안이 "호환"에 맞는 이유**: 병합이 끝나면 우리 변경이 upstream 태그 위의 커밋 이력으로 남는다. 다음 판은
  `git fetch` + `git merge <새 태그>` 로 같은 절차를 되풀이하면 된다(§5).

### 시험 병합으로 잰 실제 규모 (2026-11-09)

- 우리 202 수정 파일 중 **75개와 새 파일 40개는 자동 병합**. **127 파일·636 충돌 덩어리**가 남았다(그중 129개는 base 가 빈 '양쪽 추가').
- **JS 공개 API**: v0.8.7 공개 이름 476개 중 0.9.0 에서 **사라진 것 0개**(0.9.0 은 125개 추가). 우리 fork 만의 이름 42개 중
  `setHangul2024Compat`·`deleteCellShapeControlByPath` 두 개는 upstream 도 같은 이름을 새로 만들었다 → 의미를 맞춰야 한다.
  서버·studio 플러그인이 쓰는 이름 중 0.9.0 에서 없어진 것은 없다(`server/`·`studio/`·`scripts/` 검색).
- **studio 빌드 패치**(`studio/build/*.mjs`, 114개): fork 기준 112개가 맞고, 순수 0.9.0 기준 31개의 기준 글이 안 맞는다.
  그중 다수는 우리가 고친 TS 파일(wasm-bridge·input-handler-keyboard·native-clipboard 등)이라 병합본에서 다시 세야 하며,
  `canvas-view.ts`·`main.ts`·`font-loader.ts`·`font-substitution.ts` 쪽 약 15개는 0.9.0 원문이 바뀌어 기준 글을 고쳐야 한다.
- **빌드 구성 변화**: 0.9.0 은 `vendor/`(zune-jpeg·jpeg-encoder·pdf-import-backend·qcms 등 10개 patched crate, 약 26MB)를
  경로 의존성으로 쓰고 기본 기능에 PDF 가져오기가 들어간다. `src` 가 `tests/fixtures`·`samples/`·`mydocs/manual`·`assets/font-rules`·
  `saved/blank2010.hwp` 를 `include_*!` 로 읽는다. 지금의 sparse checkout(src·crates·rhwp-studio 만)으로는 빌드되지 않는다 →
  새 `vendor/rhwp` 는 전체 checkout(또는 이 경로들을 포함한 sparse)으로 둔다. Cargo.toml 의 workspace 축소 수정은 필요 없어진다.

## 2. 작업 장소와 보존

- **현재 `vendor/rhwp` 와 `vendor/rhwp/pkg`·`studio/dist` 는 전환(§4 P6) 전까지 건드리지 않는다.** 운영·시험은 지금 엔진 그대로다.
- 백업: `backups/rhwp_fork_before_0.9.0_2026-11-09/`(`fork_tracked.patch`, `fork_untracked.tar`, `fork_modified_files.tar`, `BASE_COMMIT.txt`).
  지금까지 fork 는 얕은 클론의 커밋 안 된 작업 트리에만 있었다 — 이 백업이 첫 독립 사본이다.
- 작업 저장소: `research/rhwp_upstream`(blobless 전체 이력 클론, `core.autocrlf=false`).
  - `fork087` = v0.8.7 + 우리 작업 트리 스냅샷(줄 끝은 upstream 과 같은 LF 로 맞춤 — 원래 diff 의 CRLF 전체 줄 차이 제거).
  - `merge-090` = `fork087` 과 `v0.9.0` 의 병합 진행 커밋. **diff3 충돌 표시가 남은 WIP 커밋**이며 남은 파일 목록은
    `research/rhwp_merge_tools/conflict_files_initial.txt`, 남은 표시는 `git grep -l '^<<<<<<< '` 로 센다.
  - 도구: `research/rhwp_merge_tools/resolve_hunks.py <파일> both|ours|theirs [덩어리번호]`.
- 이미 푼 것: `Cargo.toml`·`Cargo.lock`(0.9.0 쪽 — 전체 checkout 전제), studio `ko.ts`·`en.ts`(양쪽 추가, 중복 키 0). → 남은 123 파일.

## 3. 충돌 풀이 원칙

1. **바탕은 0.9.0 코드**. 우리 `// [hwpx-cowork]` 변경은 그 근거(주석·`vendor/README.md` 항목·한/글 실측)가 0.9.0 에도 필요한지 보고 0.9.0 코드 위에 다시 얹는다.
2. upstream 이 **같은 문제를 다르게 고쳤으면** 둘 중 한/글 실측에 맞는 쪽을 남긴다. 판단이 안 서면 우리 규칙을 남기고 장부에 "재측정 필요"로 적는다.
   upstream 의 기준은 한/글 2024 인쇄 PDF, 우리 기준은 이 PC 의 한/글 2022 COM 이다 — 두 기준의 차이일 수 있다.
3. 코드가 다른 파일로 옮겨졌으면(예: `composer.rs` → `composer/*.rs`) 우리 변경을 옮겨진 자리로 따라간다.
4. 덩어리마다 장부(`research/rhwp_merge_tools/ledger.md`)에 파일·덩어리·선택(ours/theirs/합침/옮김)·이유를 한 줄로 남긴다.
5. 기준값·기대값을 고쳐 시험을 맞추지 않는다. 새로 생긴 한/글 차이를 받아들일지는 사용자가 정한다(§7).

### 남은 충돌 묶음 (덩어리 수, 괄호 = 파일별)

| 묶음 | 파일 | 덩어리 | 성격 |
|---|---|---|---|
| A studio TS | 14 | 26 | 단축키·명령 등록·wasm-bridge — 작고 기계적 |
| B 모델·파서·저장·편집 명령·wasm API, crates | 50 | 200 | HWPX 저장/읽기·클립보드·문서 명령 — 기능 단위, 저장 왕복 시험으로 확인 |
| C 조판(typeset) | 24 | 69 | 쪽 나눔·표 나눔·각주 — 회귀 묶음으로 확인 |
| D 배치 핵심 | 18 | 279 | `layout.rs`(47)·`paragraph_layout.rs`(42)·`table_layout.rs`(36)·`line_breaking`·`shape_layout`·`mod.rs`·`table_partial`·`style_resolver`·`picture_footnote`·`float_placement`·`height_measurer`·`text_measurement` — 가장 어렵다 |
| E 그리기 백엔드·글꼴 | 17 | 48 | svg·web_canvas·skia·paint — 글꼴 선택 결정(§4 지침) 일치 확인 |

## 4. 단계와 예상 시간

예상은 시험 병합 규모에서 낸 범위다. 가장 큰 불확실성은 P4(한/글 대비 새 차이의 양)이고, P4 결과를 보기 전에는 끝나는 날짜를 약속할 수 없다.

| 단계 | 내용 | 예상 |
|---|---|---|
| P0 ✅ | 백업, fork 커밋화, 시험 병합, API·패치·빌드 구성 조사, 이 계획 | 완료 |
| P1 | 충돌 풀이 A→B→E→C→D 순(작은 것부터, D 는 파일 단위로 집중) | 1~2일 (D 가 절반 이상) |
| P2 | 전체 checkout 으로 `cargo check`(jobs 8) → 컴파일 오류 수정(자동 병합된 우리 코드가 바뀐 upstream 내부 함수를 부르는 곳) → `cargo test --lib` 해당 모듈 | 반나절~1일 |
| P3 | wasm 빌드를 **별도 pkg 경로**로(현재 `vendor/rhwp/pkg` 덮지 않음), studio 패치 기준 글 갱신, `build:studio --engine-pkg <후보>` 를 임시 출력으로 | 2~4시간 |
| P4 | 한/글 기준 회귀: `test:layout` → `test:layout:pagesplit` → `layout-regression check`(각 묶음, `--pkg 후보`) → `test:layout:regression`. 세 엔진(현 fork / 순수 0.9.0 / 병합본)을 같은 기준으로 비교해 새 차이를 upstream 원인·병합 실수·기준 차이로 나눈다 | 측정 반나절, 정리는 차이 양에 따라 1~3일 |
| P5 | Node·편집 경로: `npm test`, `test:objects`, `test:hancom-board`, `hwpx_save_roundtrip`, `test:export:hangul`, 메모 API(0.9.0 #8269 와 우리 메모 경로 비교) → `verifier` | 반나절 |
| P6 | 전환: 현 `vendor/rhwp` 를 백업 폴더로 옮기고 병합본을 git 저장소 그대로 `vendor/rhwp` 로. `build:engine`·`build:studio`. **운영 재시작은 사용자 승인 후** | 1~2시간 + 승인 |

전체: 전환 판단까지 대략 **3~6 작업일**. 진행 중에는 30분을 넘기지 않는 간격으로 남은 충돌 수·빌드·시험 상태를 보고한다.

### 0.9.0 에서 우리와 겹치는 것 (P1·P5 에서 의미를 맞출 것)

- 메모 API(#8269, 읽기·삽입·수정·삭제·HWP/HWPX 왕복) — 우리 서버·studio 메모 경로와 중복 가능.
- `setHangul2024Compat`, `deleteCellShapeControlByPath` — 같은 이름을 양쪽이 새로 만들었다.
- 표 칸 그림 삽입·이동·Undo, 중첩 셀 문단 서식, 글상자 세로 정렬·캡션, 저장 후 재열기 보존(#8725·#8711·#8738·#8741) — 우리 저장·개체 변경과 겹치는 영역.
- 조판: 중첩 표·RowBreak 이어받기·셀 여백·저장 줄·TAC 개체 흐름·머리말 상속·수식/글꼴 대체 — 우리 `vendor/README.md` 항목들과 같은 영역.
- 웹 폰트 지연/무응답 처리 — 우리 font-loader 패치와 겹침.

## 5. 이후 판을 따라가는 구조

- 전환 뒤 `vendor/rhwp` 는 **git 저장소**로 둔다: upstream 원격 `origin`(https://github.com/edwardkim/rhwp, 읽기 전용, push 없음) + 우리 브랜치 `merge-090`
  (병합 커밋 `75b5a2cf25` = 우리 fork `144cd375b0`(v0.8.7 `1a76570e83` 위) + v0.9.0 `c9095c5f67`. 다음 병합의 기준점은 v0.9.0 이 된다).
  (2026-11-13 정정: 처음 계획에 적었던 브랜치 이름 `hwpx-cowork`·원격 이름 `upstream` 은 실제로 쓰지 않았다.)
- 엔진 수정은 작업 단위로 커밋한다(지금처럼 커밋 없는 작업 트리로 두지 않는다). 커밋 메시지에 `vendor/README.md` 항목 번호를 적는다.
- 새 판이 나오면: 백업 → `git -C vendor/rhwp fetch origin tag vX` → `git -C vendor/rhwp merge vX`(diff3) → 이 문서의 P1~P6. 충돌 장부가 다음 병합의 참고가 된다.
  studio 빌드 패치(`studio/build/patches.mjs`)는 upstream 판을 문자열 `'0.9.0'` 로 가려 패치 목록을 고르므로, 새 판에서는 그 목록과 판 검사를 함께 고친다.
- 2026-11-13 점검(공개 저장소 준비): fork 원본은 아직 어디에도 공개하지 않았다 — 공개 저장소에는 빌드 결과(`vendor/rhwp/pkg`·`studio/dist`)만 있다.
  우리 fork 와 v0.9.0 의 차이는 커밋 23개·356파일(+64,663/−3,307), `[hwpx-cowork]` 표시 2,053줄이고 upstream 이 가장 많이 고치는 조판 파일
  (`table_layout.rs`·`layout.rs`·`float_placement.rs`·`paragraph_layout.rs`)에 몰려 있어 판을 올릴 때마다 전문가가 며칠 걸려 병합해야 한다.
  fork 전용 wasm 함수 78개(이 앱이 74개를 씀)는 판을 올려도 지켜야 할 약속이다.
- upstream 에 기여(PR)는 하지 않는다 — 사용자가 명시할 때만(`AGENTS.md` §1).

## 5.1 hwpx-cowork 적합성·임시 반영 판단 (2026-11-09 측정)

| 확인 | 결과 |
|---|---|
| 0.9.0 순수 빌드(이 PC 툴체인 Rust 1.93.1·wasm-bindgen 0.2.127) | **통과** — 툴체인 그대로, release-test 18분(CPU 50% 상한). wasm 34.3MB(현 fork 21.3MB) |
| 0.9.0 순수 — 열기·그리기·저장·다시 열기 표본 149개(tests/fixtures·samples·demo-data) | **치명 오류 0** (panic·예외 없음). 현 fork 와 쪽 수 다른 문서 8개. 처리 시간 37.9s → 43.7s |
| 0.9.0 순수 — 한/글 기준 조판 시험(`test:layout` 3파일 16건) | **7/16 통과**(현 fork 16/16). 59쪽 보고서 줄 나눔, 글자 폭 1,428줄, 그림·표 배치, 조판 시험지 실패 |
| 0.9.0 순수 — 회귀 묶음(`test:layout:regression`) | **실행 불가** — 측정기가 fork 전용 `getLayoutTrace` 를 쓴다(29,949 검사 모두 engine-error) |
| 0.9.0 순수 — 앱이 쓰는 fork 전용 wasm 함수 | **41개 없음** — 차례 만들기·새로 고침(서버 `toc-engine`·AI `propose_toc_update` 포함), 조판 부호 보기·지우기, 모양 복사, 한/글로 붙여넣기용 내보내기, 구역 걸친 지우기·복사, 점진 열기, 조판 추적 |
| 일괄 임시 병합(충돌 덩어리를 한쪽으로 모두 고름, ours/theirs 두 가지) | **컴파일 전 단계에서 실패** — upstream 이 옮긴 함수 경계에서 괄호가 어긋남(`line_breaking.rs`, `table_partial.rs`), 차트 crate 19개 오류 |
| studio 빌드 패치 기준 글(병합 TS 기준) | 114개 중 93개 맞음, 21개 재작성 필요(canvas-view 11, 점진 열기 wasm-bridge 6, main 3, font-loader·font-substitution 3) |

**판단**
- **0.9.0 을 그대로 바꿔 끼우는 임시 반영은 불가.** 엔진 자체는 죽지 않지만 hwpx-cowork 기능 41개가 호출 즉시 실패하고(차례·조판 부호·모양 복사·한/글 붙여넣기 등), 한/글 조판 일치가 크게 후퇴한다(16건 중 9건 실패).
- **기계적 일괄 병합으로 빨리 만드는 길도 없다.** 문법부터 깨진다. 충돌을 덩어리마다 실제로 합쳐야 한다(P1).
- 따라서 **운영은 현 fork 엔진을 유지**하고, P1~P5 를 마친 병합본이 위 시험(조판 16/16, 회귀 묶음 새 차이 없음, 기능 시험)을 통과하면 그때 전환한다.
- 남은 확인: 0.9.0 이 고친 것 중 우리에게 이득인 부분(표·글상자·저장 보존 등)은 병합본 회귀에서 "고쳐짐(fixed)"으로 나타나는지 본다.

## 6. 기록

### Claude 재인계 (2026-11-09 22:10~) — 후보 06 확인과 2차 회귀 수정

- Codex 작업 트리(충돌 0, 154 파일 수정)를 `merge-090` 에 커밋으로 고정: `3311f796ad`(= 후보 06 소스).
- **후보 06**(WASM `4fb0bca9991ef127…`, 빌드 245초) 같은 고정 pkg 로 재검증:
  조판 16/16, 기능 162/162 통과. 쪽 나눔 조합은 **저장 경로 새 차이 body 4·column 3**(생성 경로 새 차이 0, 고쳐짐 body 10·7 / column 10·4).
  전체 회귀(현 fork 재실행 대비): 11-03 **새 차이·악화 1,101 / 고쳐짐 243**, 11-04 **1,638 / 1,164**(후보 03 의 1,314·2,110 에서 줄어듦).
  11-04 묶음 실행 147초. 기록 `artifacts/rhwp090-merged/candidate-06/{checks-summary.json,compared-to-current-fork.json}`.
- 새 차이 묶음(`research/rhwp_merge_tools/clusters-c06/`): K1 나뉜 셀 안 개체(A, 647검사) · K2 글자처럼 취급 개체·표(728) ·
  K3 표 칸 안 떠 있는 개체·표(768) · K4 본문·다단·각주의 떠 있는 개체·표(596) + 쪽 나눔 저장 경로 7건.
- 2차 수정: 묶음별 작업자 4명(high) 병렬. 공통 지침 `research/rhwp_merge_tools/ROUND2_BRIEF.md` — fork 규칙을 0.9 구조 위에 일반 규칙으로 다시 얹고,
  기준·known·기대값은 고치지 않으며, 빌드는 공유 캐시(`vendor/rhwp/target/pr-review`)로 하나씩, 부분 회귀(`--only` + `compare_subset.mjs`)로 확인.
  통합 후보(07)는 메인이 빌드해 조판·기능·쪽 나눔·전체 회귀를 다시 잰다.
- 8790 미리보기는 아직 후보 04 다. 통합 후보가 나오면 바꾼다.
- **2차 수정 결과 — 후보 07**(소스 커밋 `492e87caf3`, WASM `c5739ddae1924cd13909edbcbad9a82367141a6ef182e24573d0757e24854ac3`, release-test):
  - 조판 16/16 + 쪽 나눔 2/2(**저장 경로 새 차이 0**), 기능 162/162, 문서 149개 열기·그리기·저장·다시 열기 오류 0(쪽 수 다른 문서 1: pagesplit_column_saved 244→245).
  - 전체 회귀(현 fork 재실행 대비): 11-03 **새 차이·악화 339 / 고쳐짐 259**, 11-04 **384 / 1,810**. 한/글과 같은 검사 수:
    11-03 fork 15,914 → 후보 07 16,074, 11-04 fork 8,108 → 9,844 (**전체로는 fork 보다 1,896검사 더 한/글과 같다**).
  - 묶음별(현 fork 대비 새 차이): K1 647→282, K2 728→196(그중 148 은 관측 방식 문제 — 아래), K3 768→24, K4 596→221 내외.
    원인·수정은 `research/rhwp_merge_tools/ledger_round2_K{1..4}.md`.
  - **사용자 판단 필요 (1)** K2 anchor-y 148건: 병합본은 다음 문단 y·개체 상자가 한/글과 같아졌으나, 기준은 표만 든 첫 저장 줄을, 엔진은 첫 글 줄을 앵커로 잡아
    값 차이가 커 보인다(fork 도 원래 차이). 작업자 권고는 병합본 유지.
  - **사용자 판단 필요 (2)** 0.9 «같은 서식 머리 작은 표» 묶음 규칙이 쪽 끝 양수 오프셋 표의 host 줄까지 다음 쪽으로 넘김(약 12건, 한/글 2022 는 표만 넘김).
  - 남은 실제 차이(원인 확인·미수정): 칸 안 수식 띠 미모델(61, fork·0.9 공통 공백), 칸 안 중첩 표·래퍼를 0.9 가 쪽 끝에서 쪼갬(92),
    칸 안 어울림 개체(약 36), 넓은 그림 빈 문단 한 줄 더(40), 바깥 여백 변형 straddle 표(약 14) 등.
  - 처리 시간: 문서 149개 37.5s(fork, **release LTO**) → 59.0s(후보 07, **release-test·LTO 없음**). 빌드 방식이 달라 직접 비교가 아니다 — 같은 방식 측정은 미검증.
  - 미검증: Rust `cargo test`, `npm test` 전체, 한/글 COM 내보내기 왕복(`test:export:hangul`), release(LTO) 빌드, verifier.
- **사용자 결정(23:3x)**: "최대한 한/글 2022 와 같게, 비교 방식 문제면 비교 방식을 고친다".
  - **비교 방식 수정** `scripts/layout-regression.mjs`(observe): 문단 첫 줄에 글자처럼 취급(TAC) 개체만 든 줄도 센다(개체 위끝 − 바깥 위 여백,
    표·글상자·머리말·각주 안은 제외, 0.9 가 투명 래퍼를 Table 없이 Cell 로 그리는 경우도 같은 (pi, ci) 로 받음, 다단은 같은 단에서만 대신).
    근거: 한/글 기준은 재저장 linesegarray 첫 줄 vertpos 인데 렌더 트리는 개체만 든 줄에 TextLine 이 없어 엔진 쪽이 둘째 줄을 잡았다
    (W-015fbc7a2894: 한/글 2810 / 엔진 TAC 표 위끝 2807 / 종전 엔진 값 33693 = 한/글 둘째 줄 33690). N 묶음 줄 수 비교(targetLines)는 종전대로 글 줄만.
  - 수정 뒤 두 엔진 재실행(`current-fork/full-regression-m3`, `candidate-07/full-regression-m3`): 한/글과 같음 fork 11-03 15,914·11-04 8,420 /
    후보 07 16,074·10,268. 후보 07 의 현 fork 대비 새 차이·악화 **11-03 339(fork 같음 99) / 11-04 236(fork 같음 74)**, 고쳐짐 259 / 1,922.
  - 3차 수정(작업자 3명 high): R1 나뉜 칸 안 개체, R2 본문·다단 떠 있는 표(0.9 «같은 서식 머리 작은 표» 규칙은 한/글 2022 처럼 표만 넘기게), R3 그림.
    지침 `research/rhwp_merge_tools/ROUND3_BRIEF.md`, 묶음 `clusters-c07/`.
- **3차 수정 결과 — 후보 08**(소스 커밋 `e0caf9a8c8`, WASM `10095a6eb0741be4abb1e56dea6e89c48fb7265373cdb4fa921d388c4330273d`, release-test, 2026-11-10 00:5x):
  - 조판 16/16 + 쪽 나눔 2/2(새 차이 0), 기능 162/162, 문서 149개 오류 0(쪽 수 다른 문서 1: pagesplit_column_saved 244→245, 후보 07 과 같음).
  - 전체 회귀(측정 m3, 현 fork 재실행 대비): 11-03 **새 차이·악화 274(그중 fork 는 한/글과 같던 것 43) / 고쳐짐 261**, 11-04 **150(fork 같음 0) / 1,934**.
    한/글과 같은 검사: 11-03 fork 15,914 → **16,132**, 11-04 8,420 → **10,354**(합 **+2,152**).
  - 3차 원인(장부 `ledger_round3_R{1,2,3}.md`): 쪽·종이 기준 자리차지 그림·도형이 같은 쪽 앞 문단을 미는 fork 규칙 복원, 저장 문서 수식 높이 재측정 제거,
    칸·캡션·미주 TAC 글상자 위끝, 넓은 TAC 그림 빈 문단 끝 표지, 저장 칸 프레임 원점(0.9 원본 버그), `±` 낱말 글자, 어울림 그림 칸 높이,
    **0.9 «같은 서식 머리 작은 표» 규칙 → 한/글 2022(표만 넘김, 사용자 결정)**, 다단 저장 StoredSquareWrap 게시 한 단 한정, 공백 host, 이어지는 조각 바깥 여백 이중 열기.
  - 남은 fork-같음 후퇴 43(11-03): 나뉜 칸 안 자리차지 수식 저장본 29(칸 유닛 원장의 수식 띠 미모델), 미주 쪽 아래 표 8, 글상자 칸 TAC 6.
    나머지 381 은 fork 도 한/글과 달랐던 사례(다단 저장본 흐름 축, 나뉜 칸 중첩 표를 0.9 가 쪼갬 등).
  - 미리보기 8790(= cowork.example.com/test)을 후보 08 로 교체 — 후보 07 미리보기의 문서 3건·설정(같은 접속 토큰)을 복사해 이어 씀. 편집기·서버 WASM `10095a6e…` 확인.
- **4차 수정 시작**(2026-11-10 02:1x, 사용자 지시 «4차를 시작, PC 를 안 쓰니 CPU 75% 이상 자유»): 작업자 4명(S1·S3·S4 xhigh, S2 high),
  지침 `research/rhwp_merge_tools/ROUND4_BRIEF.md`, 묶음 `clusters-c08/`(`split_clusters_r4.mjs`, 지킬 고쳐짐 표본 `fixed_lists_r4.mjs`).
  S1 나뉜 칸 수식(fork 같음 29), S2 미주·글상자 칸·칸 안 어울림 그림(fork 같음 14), S3 나뉜 칸 중첩 표·도형(156), S4 본문·다단 떠 있는 표(158 + pagesplit_column_saved 244→245쪽).
  CPU 50% 상한은 **이번 4차에 한해** 풀었다: 빌드 줄 둘(`target/pr-review`·`target/pr-review-r4b`), 각 `CARGO_BUILD_JOBS=7`(운영 8787 이 같은 PC). `.cargo/config.toml` 은 그대로.
- **4차 수정 결과 — 후보 09**(소스 커밋 `03429019c2`, WASM `13d1848d66ee772ca29a6f0dbccbfc5c9fe4b06e5452e478aa385832b3f25e3d`, release-test, 2026-11-10 04:0x):
  커밋 메시지는 «S4 진행 중»이라 적었지만 S4 마지막 빌드 b8 과 WASM 해시가 같고 커밋 뒤 소스 변경이 없어, 네 작업자의 최종 상태다(예비 이름 candidate-09a → `candidate-09`).
  - 조판 16/16 + 쪽 나눔 2/2(18/18), 기능 162/162, 문서 149개 열기·그리기·저장 오류 0·다시 연 쪽 수 불일치 0.
    쪽 수가 fork 와 다른 문서는 `pagesplit_column_saved.hwpx` 244 → 253 하나(한/글 기준 `pagesplit_column_hangul.json` pages 253 — 한/글과 같아짐).
  - 한/글과 같은 검사: 11-03 fork 15,914 / 후보 08 16,132 / **후보 09 16,619**, 11-04 8,420 / 10,354 / **10,890** (fork 대비 +3,175).
  - 현 fork 대비 새 차이·악화: 11-03 **32**(fork 같음 **0**) / 고쳐짐 705, 11-04 **38**(fork 같음 **0**) / 고쳐짐 2,470. 후보 08 에서 한/글과 같던 검사가 후보 09 에서 달라진 것 **0**(두 묶음), 새로 같아진 것 487·536.
  - 4차 원인(장부 `ledger_round4_S{1,2,3,4}.md`): S1 자리차지·어울림 수식을 나뉜 칸 띠로(측정·원장·미룸·그리기 공통 판정 `cell_flow_object_common`), 칸 밖 개체 띠 없음;
    S2 미주 잉크 판정 측정 틀을 실제 쪽 기하로, 저장 줄 없는 글상자 칸 도형 줄 높이, 칸 어울림 그림 뒤 줄을 그림 아래로;
    S3 나뉜 칸 어울림 개체·나누지 못하는 표는 개체만 다음 조각 맨 위로(0.9 의 16px 채움 유닛 자르기 대신), 앵커 줄 미는 표는 앵커째 넘김, 쪽 기준·글 앞/뒤 표는 칸 흐름에서 제외;
    S4 다단 저장본 흐름 축(문단 끝 줄간격을 흐름에 실음 — `multicolumn_successor_ladder_carries_trailing_spacing`), 공백 host 어울림 표, 생성본 빈 host 전폭 어울림 표 host 간격을 helper 한 곳으로(단 폭 연결), 표 이어지는 조각 뒤 저장 리셋의 이중 단 넘김 방지(`stored_reset_follows_table_continuation`).
  - 남은 70(모두 fork 도 한/글과 다르던 사례): 11-03 B 본문·다단 SQUARE 표 12, A splitCell 쪽 기준(v-PAGE-TOP/INSIDE) 표·래퍼 10(칸 안 쪽 기준 개체의 본문 띠 밀기 미구현), A textboxCell 생성본 8, 미주 래퍼 2;
    11-04 W 다단 SQUARE 표·tblNone 30(textPrev 앞 간격 두 번 등), 본문 SQUARE 표 8. 후보 08 대비로는 나빠진 것이 없다(위 «달라진 것 0»).
  - 문서 149개 시간: 동시 4개로 72.9s(동시 2개였던 후보 08 59s·fork LTO 37.5s 와 조건이 달라 견줄 수 없음 — 속도는 LTO 빌드로 따로 재야 함, 미검증).
  - 미리보기 8790(= cowork.example.com/test)을 후보 09 로 교체(04:04) — 후보 08 미리보기를 멈추고 문서 3건·설정(같은 접속 토큰)을 복사. 편집기 자산 WASM·서버 WASM `13d1848d…`, cowork-server 쿠키 경로 /api/docs 200·문서 3건, 쿠키 없는 운영 / 200 확인.
  - 4차 CPU 상한 완화는 여기서 끝(이후 다시 50%).
- **실문서A 목차 점선 겹침 수정 — 후보 10**(사용자 보고, 소스 커밋 `c483432b66`, WASM `41df1feef40c3bdb5f624dc408c2347c18daefeabe435c4e5c4c0f941a795152`, 2026-11-10 05:3x):
  - 원인: HFT 글자를 대응 TTF 로 그리는 투영(`hft_ttf::project_tree`)이 run 을 글자 조각으로 나누며 run 의 탭 리더를 조각마다 복제 →
    HFT(한양견고딕) 목차 줄마다 점선이 조각 원점만큼 어긋나 여러 번(한 줄 점 288+180개) 그려지고 오른쪽 여백 밖까지 나감. 운영 fork 도 같은 결함(선 여러 개).
    TTF(바탕) 줄은 정상.
  - 한/글 2022 PDF 근거: 점선 리더는 `·`(U+00B7) 글자. HFT 줄의 점 Type3 글리프 = 한양중고딕 영문 HFT ENJGT U+00B7(전진 .381em, 잉크 .149~.233 × .310~.392em) —
    한양견고딕 영문(ENGGT)에 없는 글자라 영문 슬롯 HFT 대체 사슬로 간 것. 설치 글꼴 503개 × 가운뎃점 계열 9코드 중 .005em 안 일치 TTF 없음, 대응 TTF HY중고딕 .008em 차.
  - 수정: 리더는 탭을 소유한 조각에만 두고 그 조각 원점 기준으로 옮김. HFT run 의 점선 점은 같은 `·` 글자 대체 결정(영문 슬롯 HFT 사슬 → 대응 TTF HY중고딕, HFT 칸 가운데 맞춤·글꼴 단위 기준선)의 글자로
    SVG·Canvas 에서 그림(`tab_leader::glyph_run`, 다른 그리기 경로·TTF 줄은 종전 원 근사). 점 위치·개수는 종전 셀 배분 규칙 그대로.
  - 확인(엔진 계산값, 브라우저 미사용): 목차 HFT 6줄 점 개수 90·38·55·57·53·89 = 한/글, 간격 차 ≤ .004pt, 점 중심 +0.14~0.28pt. TTF 줄 원 그대로.
    조판 18/18, 기능 162/162, 전체 회귀 결과 후보 09 와 동일(달라진 검사 0), 문서 149개 오류 0·SVG 길이 동일. 미리보기 8790(cowork-server /test)을 후보 10 으로 교체(사용자 올린 실문서A 원본 포함 문서 4건 유지).
    Canvas 실제 브라우저 그리기·CanvasKit/PDF/Skia 경로의 글자 점(원 유지)은 미검증·미적용.
- **배포 전 검증(사용자 «검증하고 배포» 지시, 2026-11-10 06:00~)** — 배포용 release(LTO) `artifacts/rhwp090-merged/release-10/engine-pkg`(소스 `c483432b66`, WASM `280001119803506565a287ad18f4a35c913fb7b64c4c39e5ee0f5c6720e33129`, 빌드 923초):
  - 조판 18/18, 기능 162/162, 전체 회귀 = 후보 10 과 같은 수치(새 차이·악화 32/38, fork 같음 0, 고쳐짐 705/2,470), 문서 149개 오류 0.
  - 한/글 2022(12.0.0.3146) COM 이 새 엔진 저장본 8개(실문서A 127쪽·메모/변경추적·차트·조판부호·다단·미주·각주·실보고서 59쪽)를 모두 대화상자 없이 열고 쪽 수·텍스트가 운영 엔진 저장본과 같음(verifier).
  - 속도: 문서 149개 열기·그리기·저장·다시 열기 운영 36.1s → 후보 57.7s(같은 조건 두 번씩, 동시 2). 실문서A 127쪽 열기 382→498ms·전 쪽 SVG 1,391→1,876ms·저장 154→87ms. 합성 시험지 일부가 크게 느림(matrix_endnote 열기 28→500ms, calib_widths 152→575ms).
  - **`npm test` 전체(1,349): 운영 엔진 실패 44 → 후보 실패 61, 후보에서만 새로 실패 18**(번호 모양 `numbering_display` 9, HFT 글꼴 결정 진단 `font_b7_hft_ttf` 3, 2024 호환 `layout_2024_*` 4, 그림 선 파선 `asan_empty_paragraph` 1, 빈 host 표 여백 `layout_stored_frame_ownership` 1), 후보에서 고쳐진 것 1.
    → 배포 보류, 작업자 3명(F1 번호, F2 HFT 진단·그림 선, F3 2024·표 여백)이 수정 중(지침 `research/rhwp_merge_tools/DEPLOY_FIX_BRIEF.md`, 장부 `ledger_deployfix_F*.md`).
  - 수정(커밋 `35df426608`): F1 미주 번호 글자 = 구역 미주 모양(fork 규칙·한/글 PDF), F2 글꼴 결정 진단의 문서 슬롯(Latin-1 기호 언어 상속)·영문 측정 슬롯 전환 기록(조판 불변),
    F3 나뉜 표 끝 조각 계획의 빈 host 아래 간격 규칙·2024 투영 host 꼬리. 그림 lineShape 파선은 엔진을 그대로 두고 **시험 기대값을 COM 그림에 맞춰 정정**
    (`tests/asan_empty_paragraph.test.mjs`: 같은 시험지 COM dash.png 주기 4px·dot.png 주기 7px — 종전 기대 DASH `6 3`/DOT `2 2` 는 그림과 반대였다. 병합본 DASH `2 2`/DOT `6 3`).
  - release-11(`35df426608`, WASM `d4da26dfaed6e5030c95763de751252cd6e9ef08723aa0e40ba26678784dd045`): 조판 18/18, 기능 162/162, 전체 회귀 후보 10 과 같음(달라진 검사 0),
    문서 149개 오류 0, **npm test 1,349 중 실패 42 — 운영 기준 44 대비 새 실패 0, 고쳐짐 2**.
  - Rust `cargo test -p rhwp --lib`: 병합 뒤 시험 코드 컴파일 오류 16개로 실행 불가 → **미검증**(배포 뒤 작업자가 시험 코드 수정 중).
- **운영 배포 완료 — 2026-11-10 07:12:39 KST 정상 재시작**(사용자 «검증하고 배포» 지시):
  - `vendor/rhwp` 폴더 자체를 다른 프로세스가 잡고 있어 이름 바꾸기가 실패(되돌림 확인) → 내용물 교체(`artifacts/rhwp090-merged/deploy-20261110/swap_vendor.sh`):
    기존 fork 항목 52개 → `backups/rhwp_vendor_fork087_2026-11-10/`(pkg·.git·venv 포함), 병합 저장소 항목 71개 → `vendor/rhwp/`, 빌드 캐시 `vendor/rhwp/target` 은 그 자리. `research/rhwp_upstream` 은 비워져 지움.
  - `vendor/rhwp/pkg` = release-11 pkg 복사, `npm run build:studio`(패치 117) → `studio/dist`(검증한 release-11 studio-dist 와 `cowork-build.json` 외 124파일 해시 동일). 이전 studio/dist 백업 `backups/studio_dist_fork087_2026-11-10/`.
  - `POST /api/admin/restart` 정상 재시작 1회(`deploy-20261110/restart.mjs`, 보고 `restart-report.json`): instance `9f2c9cc278bcb4c8` → `6db91fa6fd0c94c9`, 서버 PID 85320(실행기 60660 유지),
    `/vendor/rhwp-core`·편집기 자산 WASM 모두 `d4da26df…`, `/`·`/studio/`·`/api/config`·`/vendor/rhwp-editor/index.js` 200, config.json 해시 불변, 공개 cowork-server 200.
  - 배포 뒤 기본 경로 빠른 조판 18/18, 그림 선 시험 통과. 되돌리기: 백업 두 곳을 원래 자리로 + 재시작(`deploy-20261110/rollback.sh`, 실행 안 함).
- **배포 뒤 확인과 후속(07:15~)**:
  - `test:export:hangul` 통과(한/글 2022, 메모 6/6·변경 4/4). `test:ui:studio` 216/217 — **실시간 표 칸 Enter 회귀**(다른 편집기가 다시 열림).
    원인: 0.9.0 `grown_table_heights` 가 내보낼 때 표 `hp:sz@height` 를 내용 높이로 키워 적는데, 서버 diffDocs 표 뼈대 지문(`engine/doc.js` `tableSkeleton`)이 이 값을 비교해
    칸 글 고침을 «표 고침»으로 판정 → 칸 접기 대신 표째 옮김. 수정: 지문에서 표 자신의 `hp:sz` 높이만 뺌(근거 `docs/TABLE_VARIABLES_2026-11-04.md` E1 — 한/글이 조판에 안 쓰고 재저장 때 고쳐 씀),
    `tests/engine6.test.mjs` 회귀 시험 추가. `test:ui:studio` 226/226, `test:ui:collab` 153 통과·1 실패(MCP `no_changes_reason` — 서버 규칙과 시험의 기존 불일치, 엔진 무관).
    07:34:51 정상 재시작으로 반영(instance `6db91fa6…` → `3a165651…`, 엔진·편집기 해시 그대로, config 불변).
  - 배포 뒤 기본 경로 `npm test`: 1,345 중 실패 67 — 운영 전 기준 대비 새 실패 25 는 모두 편집기 원본을 직접 묶는 시험(`studio_font_fallback` 13·`studio_canvas_metric_scope` 6·
    `studio_font_performance` 4·`studio_typing_performance` 패치 기준 글 1·`progressive_open_bridge` 1). 배포 전 후보 시험은 엔진 pkg 만 바꿔 돌려 이 묶음을 못 봤다(검증 빈틈).
    실제 빌드는 `studio/build/rhwp090-patches.mjs` 로 117개를 모두 적용하므로 시험 하네스 불일치인지 실제 번들 결함인지 작업자 G2 가 가리는 중.
  - Rust `cargo test -p rhwp --lib`: 시험 코드만 고쳐(커밋 `bde399b50c`) 3,810 통과·66 실패(표본 없음 56, 내용 10)·12 무시. 내용 실패 10 중 병합 회귀 의심
    (거대 칸 커서 2, 빈 문단 HWPX 왕복 글자 모양 1, 빈 붙여넣기 출처 1, 나뉜 칸 컷 1, 줄끝 금칙 `"` 1, 글꼴 체인 1)을 작업자 G1 이 수정 중.
  - 편집기 시험 25(G2, 장부 `ledger_postfix_G2.md`): 18 은 시험 하네스가 0.8.7 패치 목록을 쓴 것 → `studio/build/patches.mjs` `patchesForStudio`(원본 판으로 패치 선택, 빌드·시험 공통).
    **실제 번들 결함 1**: 0.9.0 은 `registerLoadedLocalFontFace` 로 등록된 face 만 설치 원본으로 인정 → cowork local() 정확 face(KoPubWorld·HY·한컴 계열)가 Noto 로 그려짐 → 등록 콜백 연결(`studio/fonts/exact-local-faces.ts`, `rhwp090-patches.mjs`).
    **정책 되돌림**: 0.9.0 은 로컬 글꼴 감지 동의 전엔 폭 탐지 설치 글꼴(맑은 고딕·Arial 등)을 안 씀 → «우리 기능 유지» 지시에 따라 fork 동작으로(패치 `rhwp090-installed-face-probe-before-consent`·`rhwp090-canvas-engine-chain-before-consent`).
    남은 2: 실패한 웹폰트 재시도(0.9.0 은 재시도 안 함, 대체 표시 정상) — 사용자 결정 대기.
    운영 반영 08:07: `npm run build:studio`(패치 119) → `studio/dist`(G2 후보 b2 와 `cowork-build.json` 외 동일, 정적 파일이라 재시작 없음, 서빙 확인), 이전 번들 백업 `backups/studio_dist_rhwp090_0712_2026-11-10/`.
    studio_*·progressive·mobile_input 63 중 61, `test:ui:studio` 226/226(b2). 실제 브라우저의 글꼴 그리기 모양은 미검증.
  - Rust 내용 실패 10(G1, 장부 `ledger_postfix_G1.md`): 11-07 fork 시험 실행 파일로 다시 돌려 보니 거대 칸 커서 2·task1592·글꼴 체인은 **fork 에서도 같은 실패**(병합 회귀 아님).
    고침(커밋 `f032d61a17`): `hft_ttf::project_tree` 가 글자 없는 run(빈 줄·빈 칸 문단의 캐럿·문단 끝 앵커)을 쪽 트리에서 지우던 fork 결함 → 그대로 둠(HFT 문서 커서; issue_2021 통과),
    `paragraph::inherit_inserted_text_controls` 빈 원본 붙여넣기 출처 소실(병합 회귀) → fork 규칙. lib 3,812 통과·64 실패(새 실패 0), 전체 회귀 release-11 과 같음.
    결정 대기: task1592(빈 문단 암묵 10pt 글자 모양 — fork 의도 규칙 vs upstream 시험), 나뉜 칸 컷(0.9 일반 규칙 — 11-11 한/글 COM 실측으로 0.9 결과가 맞음 → 시험 기대값 고침·엔진 쪽 끝 1pt 경계 일반화, vendor/README 76), 줄끝 `"`(한/글 근거 못 찾음 — 53,768 HWPX 전수 조사 판별 사례 0),
    0.9 새 단언 2개(b7 ‘’ 폭·U+2024 대체 — fork 사용자 정책 유지 권고), 거대 칸 HFT 글자 캐럿 1px(그리기 오프셋을 논리 상자에 씀 — fork 11-07 부터).
- **엔진 재배포 — 2026-11-10 08:59:42 정상 재시작**: release-12(커밋 `f032d61a17`, WASM `82df198def4e2d45ee4435b6c9c778121d877633ee9185b52436b24aed1d2421`, 빌드 645초).
  배포 전: 조판 18/18, 기능 162/162, 전체 회귀 release-11 과 결과 동일(달라진 검사 0), 문서 149개 오류 0, `npm test` 1,350 — 운영 전 기준 대비 새 실패 2(실패 웹폰트 재시도, 사용자 결정 대기)·고쳐짐 2.
  반영: 이전 pkg → `backups/rhwp_pkg_release11_2026-11-10/`, 편집기 → `backups/studio_dist_rhwp090_0807_2026-11-10/`, `build:studio`(패치 119), 재시작 instance `3a165651…` → `8e5a1008…`,
  엔진·편집기 WASM `82df198d…`, config 불변, 주요 경로·공개 주소 200. 배포 뒤 기본 경로 빠른 조판 18/18, `test:ui:studio` 226/226(headless — 편집기 번들 확인).
  남은 결정: 실패 웹폰트 재시도, task1592·나뉜 칸 컷·줄끝 `"`·0.9 새 단언 2개, 속도(실문서 약 1.3배·미주 많은 시험지 최대 18배), `/test` 미리보기 끄기, APK·포터블 미갱신.
- **사용자 결정(09:1x)**: ① `/test` 끄기 → Caddyfile 을 미리보기 전 백업으로 되돌리고 `caddy reload`(쿠키 요청도 운영, `/test` 404), 8790 미리보기 종료(미리보기 데이터는 `artifacts/rhwp090-merged/candidate-10/preview-data` 에 남김).
  ② «글꼴 모양이 다르고 로드가 안 됨 → 기존 방식으로 무조건 로드» → 0.9.0 글꼴 경로를 fork 방식으로 되돌리는 작업 진행(장부 `research/rhwp_merge_tools/ledger_fontfix.md`).
  ③ «0.9.0 이 새로 넣은 시험 2개가 기존 글꼴 폭 규칙과 충돌하면 기존 시험 유지» → `test_b7_advance_follows_the_font_table_only_when_trusted`(fork087 본문 그대로)·
  `issue_2809_negative_letter_spacing_does_not_compress_canvas_glyph`(fork087 단언을 바뀐 API `canvas_cluster_fit` 로)로 되돌림. 두 시험 통과, 커밋 `fc020a48e2`(시험만).
- **글꼴 fork 방식 복원 — 운영 반영 09:40(편집기만, 재시작 없음)**(장부 `research/rhwp_merge_tools/ledger_fontfix.md`):
  - 모양이 달랐던 주 원인: 0.9 엔진 Canvas 글꼴 체인 맨 앞의 내부 별칭 `'__rhwp_ttf__<이름>'`·`'__rhwp_intrinsic__<이름>'`(호스트 공급자만 등록, 웹엔 없음)을
    우리 패치 `noto-sans-kr-for-unavailable-font` 가 «쓸 수 없는 글꼴»로 보고 Noto 를 맨 앞에 둠 → HY·KoPub·함초롬·굴림체·휴먼명조 문서가 Noto 로 그려짐(실문서A 표지 포함).
  - 안 불러와진 원인: 0.9 로더의 fetch+blob 등록·5초 제한·실패 파일 영구 제외(7초 지연 시험에서 운영 번들 요청 2개 ABORTED·미등록).
  - 수정: `studio/overrides/rhwp090/font-loader.ts`(fork 로더 본문 + 0.9 가 쓰는 export) 를 빌드 load 단계에서 0.9 `src/core/font-loader.ts` 대신 끼움(`studio/build/patches.mjs`
    `sourceOverridesForStudio`), `rhwp090-patches.mjs` 에 `fontfix-*` 6개(내부 별칭을 원래 이름으로 → fork 병합, 치환 기억, 빠진 글자 대체 순서 fork, 0.9 선언 글꼴 환경 끔). 패치 124.
  - 확인: 실제 브라우저(headless, 감지 동의 없음) 문서 6개 fork vs 새 번들 — 그린 글꼴 이름 4/6 완전 일치(나머지: 설치된 Haansoft Batang 사용·굵게 표기 차이), 불러온 글꼴 집합·상태 같음, 실패 요청 0,
    7초 지연에도 로드. studio 시험 64/64, `test:ui:studio` 226/226(이 번들 제공 확인 — `tests/ui_studio.py` 가 이제 `HWPX_COWORK_STUDIO_DIR` 를 넘김; 그 전 G2 화면 시험은 실제론 `studio/dist` 였을 수 있음).
  - 반영: 이전 번들 백업 `backups/studio_dist_rhwp090_0859_2026-11-10/`, `npm run build:studio` → 후보 b1 과 `cowork-build.json` 외 동일, 서빙 확인. 미검증: 감지 동의 뒤 경로, 실제 원격·휴대폰.
- **굵은 글씨 굵기 실측(사용자 요청, 코드 수정 없음 — `ledger_fontfix.md` 덧붙임, 자료 `artifacts/rhwp090-merged/boldcheck/`)**: 40pt 시험지(보통|굵게)를 한/글 2022 PDF(300dpi)·fork·현 운영 편집기(headless 300dpi)로.
  한/글 방식: Bold 파일 있으면 그 파일, 없으면 같은 글꼴 `2 Tr` 윤곽 `w = 0.02×Tf`(새 엔진 `HANCOM_FAUX_BOLD_STROKE_EM` 0.02 와 같음), 이름이 굵은 face 는 더하지 않음.
  획 두께 증가(em) 한/글/fork/새: 맑은 고딕 .0463/.0462/.0462, 함초롬바탕 .0305/.0262/.0262, Arial .0437/.0458/.0458, 굴림체 .0186/.0234/.0225, **HY중고딕 .0183/.0338/.0225**,
  KoPubWorld돋움체 Bold 0/0/0, KoPubWorld돋움체 Medium+굵게 .0215/.0339/.0339. 실문서 노원소방서(굴림체 굵게) 한/글 대비 −6% → −2.5%.
  판정: 바뀐 것(Bold 파일 없는 글꼴)은 한/글 방식으로 바뀌어 가까워짐. 남은 차이: «Medium 등 굵기 이름 face + 굵게» 는 fork·새 모두 한/글보다 굵음(원인 `font_metrics_data.rs`
  `find_metric_decision` — 굵기 접미사를 떼어 가족 Bold 를 찾아 CSS bold 합성; 제안: 그 경우 0.02em 윤곽으로, 폭 측정 소비 지점 확인 후).
- **문서 열기 속도 개선(사용자 요청, 장부 `ledger_perf_P1.md`·`ledger_perf_P2.md`, 지침 `PERF_BRIEF.md`) — release-13 준비 완료, 운영 반영 대기**:
  - 원인(Node `--cpu-prof`, 59쪽 점진 열기 회당 fork 347 / 운영 1,162ms): 글리프 선택 `hancom_fontdb::select_glyph` 글자마다 선형 탐색, 렌더 정규화가 문단마다 `ResolvedStyleSet` 복제, 점진 열기 마무리 pass 의 정규화 재계산(None 미캐시).
  - P1 수정: select_glyph 결과 기억, 정규화 스타일 작업본 재사용, 마무리 pass 의 None 결과 재사용. P2: 웹 WASM 에서 PDF 불러오기 feature 끔·name 섹션 제거(`scripts/build-engine.mjs` 기본값, `--with-pdf`·`--keep-names`),
    여러 구역 문서 점진 열기(첫 쪽 예산 구역에서 멈춤)·미리보기 중 본문 쪽번호 필드 settle 미룸, 편집기 로그 실제 상태.
  - release-13(커밋 `24ac98b1cc`, WASM `1a692a7e4132b02927c99aa077bfc2a71cb58046ce1bb2a6f509a01d9c0d37b8`, 26.1MB — 38.6MB 에서): 조판 18/18, 기능 162/162,
    전체 회귀 release-12 와 검사별 29,949/29,949 같음, 문서 149개 전 쪽 SVG·쪽 수 같음(미리보기 쪽 수만 다구역 10문서에서 바뀜 — 의도), npm test 운영 대비 새 실패 0·고쳐짐 2.
  - 브라우저(이 PC, 재방문, 운영 → release-13): 59쪽 첫 화면 1.53~1.65 → 1.14~1.18초·편집 가능 2.31~2.42 → 1.56~1.59초, 127쪽 실문서A 첫 화면 1.93~2.05 → 1.07~1.17초(미리보기 생김)·
    편집 가능 2.14 → 1.78~1.90초, 작은 문서 0.87~0.92 → 0.83~0.88초.
  - 운영 반영(pkg 교체·build:studio·재시작)은 자동 실행 권한 판정에서 한 번 막혀 사용자 확인을 받음(«반영해줘»).
  - **운영 반영 13:19:39 정상 재시작**: 이전 pkg → `backups/rhwp_pkg_release12_2026-11-10/`, 편집기 → `backups/studio_dist_rhwp090_0940_2026-11-10/`, `build:studio`(패치 124 — release-13 studio-dist 와 `cowork-build.json` 외 동일),
    instance `a6ac9154…`(08:59 이후 다른 재시작이 있었음) → `fc299e7d…`, 엔진·편집기 WASM `1a692a7e…`, config 불변, 주요 경로·공개 주소 200. 배포 뒤 빠른 조판 18/18, `test:ui:studio` 226/226.
- **나뉜 칸 쪽 끝 1pt 경계 — 운영 반영 2026-11-11 10:08:36 KST 정상 재시작**(사용자 «운영서버 재시작해줘»): 엔진 커밋 `3c3f7cab6d`(vendor/README 76),
  release WASM `ad6283b02df7c87e7ab9fe558cde1e3daefeb26b80c8e71705b6c0617f8c189f`(빌드 602초). 이전 pkg → `backups/rhwp_pkg_release13_2026-11-11/`,
  편집기 → `backups/studio_dist_release13_2026-11-11/`, `build:studio`(패치 124), instance `a4b95257…` → `a36596ed…`, config 불변, 주요 경로·공개 주소 200
  (보고 `artifacts/cellcut-20261111/restart-report.json`). 배포 전 release: 나뉜 칸 56/56·조판 16/16·쪽 나눔 2/2·표본 74문서 빠른 빌드와 같음,
  빠른 빌드로 전체 회귀 29,949검사 판정 기준 엔진과 같음. 배포 뒤 기본 경로 나뉜 칸 56/56·조판 16/16.
- **따옴표 줄 끝·시험 기대값(엔진 커밋 `879109463f`, vendor/README 77) — 2026-11-11 편집기만 반영, 서버 재시작 보류**: release WASM
  `1044376149f821d1123dd02c60b4f433e2b7256718e46a48fd9f0cc8b792824f`(빌드 630초, 따옴표·빈 줄 3/3·나뉜 칸 56/56·조판 16/16·쪽 나눔 2/2·표본 74문서 빠른 빌드와 같음).
  pkg 교체(이전 → `backups/rhwp_pkg_cellcut_2026-11-11/`)·`build:studio`(패치 124, 이전 → `backups/studio_dist_cellcut_2026-11-11/`) 뒤 정상 재시작 요청이 401 로 멈춤:
  11:03:45 에 Docker Desktop 이 `artex-local-artex-1`(<로컬 경로> restart=unless-stopped)을 띄우며 **127.0.0.1:8787** 을 잡아,
  localhost·Caddy(`reverse_proxy 127.0.0.1:8787`)·공개 주소가 그 컨테이너로 간다. 운영 서버(PID 72032, 0.0.0.0:8787)는 LAN 주소로 정상(200).
  재시작 시 포트를 다시 못 잡을 위험이 있어 재시작하지 않았다(사용자 결정 대기). 서버 쪽 엔진은 아직 `ad6283b0…`.
  → 사용자 지시로 `docker stop artex-local-artex-1`(12:22, 127.0.0.1:8787 해제 — 공개 주소 hwpx-cowork 로 복귀) 뒤 **12:23:15 정상 재시작**:
  instance `a36596ed…` → `44e3ed78…`, 서버·편집기 WASM `10443761…`, config 불변, 주요 경로·공개 주소 200(보고 `artifacts/test-failures-20261111/restart-report.json`).
  배포 뒤 기본 경로 따옴표·빈 줄 3/3·나뉜 칸 56/56·조판 16/16.
- **cowork.example.com/test 연결**(사용자 요청, 23:4x): `https/Caddyfile` 에 쿠키 갈래 추가 후 `caddy reload`(백업 `backups/Caddyfile.before-test-preview-2026-11-09`).
  앱이 `/api`·`/studio`·`/ws` 절대 경로를 써서 경로 접두로는 못 나누므로, `/test` 를 연 브라우저에 `hwpx_preview` 쿠키(12시간)를 주고 그 쿠키가 있는
  요청만 127.0.0.1:8790 으로 보낸다. `/test/off` 로 해제. 쿠키 없는 사용자·MCP·운영 8787 은 그대로. 확인: /test 302+쿠키, 쿠키 요청에 `X-Hwpx-Preview` 머리·
  미리보기 편집기 번들·`/api/docs` 200·엔진 WASM 41,962,226B, 쿠키 없는 /studio/ 는 운영 번들. 같은 출처라 브라우저 저장소(토큰 등)를 운영과 나눠 쓴다 —
  시크릿 창·다른 프로필 권장.
- **8790 미리보기를 후보 07 로 교체**(23:23): 후보 04 미리보기(launcher 75576·server 64932, 문서 0건)를 멈추고 같은 포트에 후보 07 번들을 띄움.
  편집기 자산 WASM·서버 엔진 WASM 모두 `c5739dda…` 확인. 접속 주소(토큰 포함)는 `artifacts/rhwp090-merged/candidate-07/preview-runtime.json`.

### Codex 인계 후 진행 상황 — 독립 서버 후보

- **2026-11-09 21:45 KST 재검증**: 다섯 번째 후보 빌드 통과(265초),
  WASM SHA-256 `a6c12ebda91fcc5a72613410b702dac12911265767047f211a0b340a950ff85f`.
  같은 고정 패키지로 **조판 16/16, 기능 162/162, API 호환·점진 열기 통과**를 확인했다.
  기능에는 차례·모양 복사·붙여넣기·메모 삭제·개체 번호·조판 부호·저장 왕복을 포함한다.
  표 포함 각주 3사례×생성/한글 재저장 6검사는 5통과/1실패로 아직 수정 중이다.
  로그: `artifacts/rhwp090-merged/candidate-05/{layout.log,functional.log,targeted-notes/check.json}`.
- **전체 회귀는 아직 실패**: 세 번째 후보로 11-03 묶음 17,467검사, 11-04 묶음
  12,482검사를 실행했다. 현 fork를 별도 고정 복사·재실행한 결과와 비교하면 각각
  새 차이/악화 1,314·2,110검사다. 저장 기준 대비 수치는 각각 1,312·2,110이며,
  현 fork에도 저장 기준 대비 11-04 묶음 12건이 이미 존재한다. 원래 있던 차이와
  병합으로 생긴 차이를 구분해 수정한다. 전체 회귀 결과는 세 번째 후보의 기록이며,
  다섯 번째 후보의 전체 회귀 통과로 인용하지 않는다. 전체 실행은 당시 CPU 배분에서 약 12분이었다.
- 원인별 병렬 수정 재개(high 3명): 표 셀·중첩 표, 본문/표 host 흐름, 각주/미주.
  메인은 계산 개체의 다단 이월과 통합 빌드·시험을 담당한다. 각 worker는 독립 근거와
  실제 출력 소비 지점을 확인하며, 기준/허용치/known 사례는 변경하지 않는다.
- **독립 시험 서버 기동 완료**: `http://localhost:8790/` — 네 번째 후보(0.9.0 병합본),
  SHA-256 `14bce1ac341f686e6309c55922a9b8e117aa398f2339e971f6acc795dd59cbfb`.
  별도 config/data, 모의 AI로 실행하며 HTTP·버전·JS/WASM 배포 해시를 확인했다.
  접속 토큰은 `candidate-04/preview-runtime.json`의 URL에서 확인한다.
  이 서버는 회귀 수정 중인 후보다. 운영 전환 기준을 충족했다는 뜻은 아니다.
- 웹 조판 확인은 엔진 트레이스·메트릭·렌더 트리로 수행했다. 브라우저 실행·화면 캡처나
  한/글 새 출력은 실행하지 않았다. 운영 `vendor/rhwp/pkg`·`studio/dist`·config/data는 유지했다.

아래 16:18~16:51 항목은 인계 당시의 과거 실행 기록이다.

- **16:51 재개 작업**: 메인이 직접 수정 중이며 세 번째 후보를 빌드 중이다. 두 번째 후보는
  빌드 290초, SHA-256 `448b4a6bbbc3809515d6c11ccb6cba1449abccab25413828c1fad31c700cd923`.
  조판 12/16(글자 폭 오류 19→2, probe 경계 오류 해소·줄 frame 폭 1건 잔존), 기능 122/138,
  각주 표 생성 3/3·한/글 재저장본 0/3 통과. 이후 수정 효과는 새 후보로 재확인한다.
- 재개 후 원인 수정: 번호 자리표 뒤 필드 슬롯의 소유 위치/분할, 표 미편집 저장 크기 보존,
  가상 Bold 메트릭의 실제 face/굵기 선택, 회전 도형의 원본 sz/anchor 보존, 표 끝 host 줄의
  최종 흐름 소비, inline 줄의 ink 폭과 물리 frame 분리, 개체 각주의 text-only reset 분할 제외,
  hwpjson `hypen` 읽기/쓰기, 개체 번호 저장 캐시, 실제 글줄 높이 기반 고정 차트 눈금 밀도.
- 서버의 같은 글자 위치에 있는 빈 필드 복사에서, 유지된 앞뒤 부호의 LCS 순서를 기준으로
  삽입하여 순차/중첩 경계를 보존했다. 기존 차례 빈 줄 병합 시험은 두 번째 후보로 통과.
  공유 시험 입력의 구역 수를 실제 spine과 맞추고, 하이픈 철자는 같은 제어의 두 표기를 세며,
  차트는 이전 transform 또는 0.9의 실제 0축 좌표를 확인한다. 독립 기대값은 유지했고
  0.8.7로 관련 시험 **45/45 통과**를 확인했다. 편집기 TS 원본/패치 적용본 오류는 모두 0이다.

- **2026-11-09 16:18 KST 상태 확인**: 마지막 병합 관련 산출물은 13:05경이다. 현재 실행 중인
  하위 에이전트·이 작업의 빌드·시험은 없고, 8790 포트도 열리지 않았다. 작업자 사용량 제한으로
  병렬 작업이 중단된 상태이며, 아래는 마지막 완료된 실행 결과다.
- 첫 병합 후보 `candidate-01/engine-pkg` 빌드 **통과**(386초, WASM 40.1MB).
  SHA-256: `70c9dcf8e5a4ced1d05720453a3aa7bde9b881152af8afeef869a2ac9552b47c`.
  API·실제 점진 열기 3개 입력은 통과했으나, 조판 16건은 **12통과/4실패**, 선택한 기능 시험
  138건은 **118통과/20실패**다. 각주 표 회귀의 생성/재저장 6검사는 모두 새 차이가 발생했다.
  로그: `research/rhwp_merge_tools/candidate01_layout.log`,
  `artifacts/candidate01/functional.log`, `research/rhwp_merge_tools/candidate01_targeted_notes.log`.
- 후속 코드 수정 일부는 소스에 반영됐지만 두 번째 후보를 아직 빌드하지 않았다. 따라서
  표 뒤 host 줄 흐름·개체 포함 각주 분할 등 수정 효과는 **미검증**이다. 글자 폭·쪽 경계·개체/저장
  관련 실패도 남아 있다. 전체 저장 회귀·쪽나눔·149개 문서 시험은 병합 후보로 아직 확인하지 않았다.
- 독립 실행 준비 코드는 작성했으나 **독립 서버 제공은 아직 미완료**다. 운영 8787의
  포트 리스닝만 확인했으며 운영 기능 정상 여부를 이 확인으로 판단하지 않는다.

- 운영 `vendor/rhwp/pkg`·`studio/dist`·8787 서버·운영 config/data는 전환하지 않았다.
  병합 소스는 `research/rhwp_upstream`, 출력 후보는 `artifacts/rhwp090-merged/`로 분리한다.
- 하위 에이전트 3명(high)과 메인이 기존 부분 병합을 이어 남은 diff3 충돌을 모두 해소했다.
  담당별 선택·이동·대체·미검증은 `research/rhwp_merge_tools/ledger_codex_*.md`에 있다.
  충돌 표시 0과 rustfmt 구문 확인은 통합 컴파일·동작 통과를 뜻하지 않는다.
- 첫 WASM `cargo check`는 오류 87건으로 실패했다. 기록:
  `research/rhwp_merge_tools/codex_check_wasm1_utf8.log`. 새 구조체 필드·이동한 생산자·호출 서명·중복 API가
  주된 원인이다. 사용량 제한으로 중단된 오류 수정은 새 작업자 3명(high)으로 이어 진행한다.
- 두 번째 WASM `cargo check`는 **통과**(1분 18초). 차트의 미사용 함수/메서드 경고 2개가 남았다.
  기록 `codex_check_wasm2.log`. 이후 삽입 metadata의 실제 위치와 최종 정렬 폭 shadow를 최소 보정하고
  첫 고정 후보 `artifacts/rhwp090-merged/candidate-01/engine-pkg`를 빌드 중이다(CPU50%, 공유 캐시).
- 공개 API 정적 감사 정정: 현재 fork 패키지와 순수0.9 패키지 대조에서 fork 전용 이름은 **40개**,
  양쪽 공통 추가 이름은 **2개**다. 40+2의 wrapper와 실제 core 대상은 모두 존재한다.
  과거 §5.1의 41개는 당시 조사 기록이며, 실제 후보 기능 통과를 의미하지 않는다.
- 독립 빌드 소스(`--source`)·artifacts 출력·서버 엔진 패키지(`HWPX_COWORK_ENGINE_PKG`)를 추가했다.
  `scripts/run-engine-preview.mjs`는 별도 config/data·모의 AI·localhost·8787 이외 포트를 사용하고,
  편집기/서버 JS·WASM 해시와 버전이 같을 때만 실행한다. 아직 병합 엔진 서버는 띄우지 않았다.
- 0.9 편집기 패치 117/117 적용 기준 확인 및 번들 빌드 통과. 빌드 입력 WASM은 순수 0.9.0으로,
  병합 엔진의 실행 검증이 아니다. 점진 열기 소유권 시험은 0.9 패치 함수로 6/6 통과했다.
  verifier: 격리 서버·배포 글꼴 정책·기본 0.8.7 점진 열기 12/12, 0.8.7 패치114/114 확인 통과.
- 0.9 새 글꼴 16개는 동봉 font-notices의 이름·SHA-256·저작권·라이선스 전문 존재를 대조한 뒤
  생성기로 배포 허용 목록에 추가했다. 기존 허용·제외 fingerprint를 유지했다. 글리프 일치 검증과 별개다.
- 다음 순서: 통합 오류 수정 → 별도 WASM 빌드(공유 캐시·CPU50%) → 후보 해시 고정 →
  조판16건 → 기능·저장 왕복 → 쪽나눔·저장된 회귀 묶음 → 독립 서버 기동/응답/배포 해시 확인.
  한/글 재출력·전체 글꼴 전수검사는 아직 실행하지 않았다. 결과와 비용을 먼저 제시하고 필요 범위를 정한다.

- 2026-11-09: P0 완료. `research/rhwp_upstream` 클론(blobless, 조사 중 blob 을 많이 받아 `.git` 약 9.5GB). `merge-090` WIP 커밋 `75b5a2cf25`.
  Cargo.toml·Cargo.lock·ko/en.ts 해결 → 남은 123 파일.
- 2026-11-09: P1 묶음 A(studio TS 14 파일) 해결, 커밋 `77d71aaf55`. 결정은 `research/rhwp_merge_tools/ledger.md`.
  남은 충돌: **109 파일 · 596 덩어리**(B·C·D·E). 아직 컴파일·tsc·시험은 하지 않았다.
