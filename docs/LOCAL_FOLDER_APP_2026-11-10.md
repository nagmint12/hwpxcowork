# 개인용 앱 · PC 폴더 연결 · 함께 검토 (2026-11-10)

사용자 요청(2026-11-10): 지금은 문서를 "서버" 안에서 관리한다. 개인 사용자는 **자기 PC 의 폴더**와 이어 쓰고 싶다 — 탐색기의 파일에 저장하고,
혼자 고칠 때는 중앙 서버에 접속하지 않는다(개인이 서버를 직접 돌려도 좋고 다른 방식이어도 좋다). 토큰을 가진 사람은 지금처럼 특정 서버에 접속해
**모여서 검토**할 수도 있어야 한다. 빌드된 엔진 아래에서 개인이 실행하는 실행기(앱)를 만든다.

구현: `server/local-folders.js`(연결·훑기·파일 맞춤·함께 검토), `server/routes/local.js`(경로), `server/store.js`(정한 id·바이트 그대로 기록·`afterCommit`),
`server/library.js`(비친 폴더), `server/service.js`(목록·만들기·이름·옮기기·지우기·`replaceContent`), 화면 `web/local.js`·`web/app.js`(DocList)·`web/library.js`,
실행기 `deploy/portable/personal.mjs` + `deploy/portable/personal/`(시작 파일·안내), 묶음 `scripts/package-portable.mjs --target personal-lite`.
시험 `npm run test:personal`(= `tests/local_folders.test.mjs` + `tests/personal_app.test.mjs`).

## Mac의 전체 Cowork 앱으로 통합 — 0.5.1 후보 (2026-11-14)

사용자가 Safari의 개선 기능과 설치 앱의 기능이 다르다고 확인했다. 원인은 같은 WASM 여부보다 **제품 구성**이었다.
1.0.3 `Hwpx Editor`는 `originalEditorUI:true`, `coworkPlugin:false`인 별도 로컬 편집기이며 웹 보완 124개 중 66개만 포함했다.
그러므로 앞 절차의 입력 성능 수정·Universal화만으로 웹과 같은 제품이 되었다고 볼 수 없다. 사용자는 자동 저장을 허용하고
개선된 전체 웹 기능을 Mac 앱에 담도록 요청했다. 기존 `deploy/desktop` 개인용 서버 앱을 사용해 `web/`·cowork 플러그인·
같은 WASM과 웹 보완 전체를 패키징한다. 웹의 문서함·메모·변경 추적·검토 기능이 이 경로에 포함된다.

- `package:macos`의 기본값은 Intel·Apple Silicon 공용 Universal ZIP 하나다. 앱 버전은 0.5.1이며 기존 1.0.3 standalone과는
  제품 계열이 다르다. Electron 43.8.10·Node 22.23.5, 최소 OS/모든 Mach-O 검사 대상은 12.1이다.
- `--studio-dir`·`--engine-pkg`로 artifacts의 동결 후보를 사용한다. 운영 `studio/dist`는 덮어쓰지 않는다.
  `desktop-product-audit.mjs`는 웹 파일의 바이트, cowork 플러그인, 현재 웹 패치 전체, 서버/화면 WASM 해시를 대조한다.
  데스크톱 호스트도 한 번 복사한 `desktop-source`로 양쪽 CPU를 빌드한다. 첫 후보는 빌드 중 호스트 소스가 달라져
  엄격한 공통 자원 검사에서 실패했으며 그 자료를 보존했다.
- 글꼴은 앱의 같은 출처 편집기 iframe에만 Local Font Access를 허용한다. 파일을 열 때 설치 글꼴을 자동 준비하고,
  나중에 처음 선택한 글꼴도 실제 클라이언트의 family/fullName/PostScript·굵기 기록으로 등록한 뒤 측정/그리기를 갱신한다.
  알려진 카탈로그나 실제 설치 기록만 사용하므로 기존 Arial·HFT 대체 규칙은 유지한다. 입력 한 글자마다 전체 글꼴을 재검사하지 않는다.
- 저장 경고에서 ‘변경 내용 버리기’를 고르면 동기 `will-prevent-unload` 응답으로 원래 닫기/새로고침을 허용한다.
  취소는 창과 편집 상태를 유지한다. 이미 자동 저장된 내용은 삭제하지 않는다.

검증 도구는 `scripts/verify-desktop-native.mjs`다. `--verification-profile`로 **아직 없는 새 폴더**를 만들고,
표본 HWPX의 사본만 연결하며 실제 앱·편집기에서 입력/Chromium 조합·글꼴·자동 저장·메모·재열기·종료를 확인한다.
외부 HTTP(S) 요청은 차단하고 앱의 루프백 서버만 허용한다. 이는 물리적 네트워크 분리나 OS 한글 입력기 시험은 아니다.
Windows에서는 동결된 호스트와 payload를 Electron으로 실행한다. Mac에서는 실제 `.app`의 실행 파일을 그대로 사용한다.

```sh
# Mac에서: 앱 안의 Node를 사용한다. OUT은 새 폴더이고 FIXTURE는 시험용 HWPX다.
"Hwpx Cowork.app/Contents/Resources/runtime/bin/node" scripts/verify-desktop-native.mjs \
  --app "Hwpx Cowork.app/Contents/MacOS/Hwpx Cowork" --out "$OUT" \
  --fixture "$FIXTURE" --archive "$RELEASE_ZIP"
node scripts/macos-release-readiness.mjs --package macos-apps.json --out readiness.json \
  --native intel/native-result.json,silicon/native-result.json --manual intel/manual.json,silicon/manual.json
```

`macos-release-readiness.mjs`는 같은 ZIP/WASM의 **macOS 12.1 x64·arm64 실제 실행**, 위 자동 검사,
codesign/Gatekeeper 결과와 실제 테스트 담당자의 OS 한글 IME·Finder·장시간 작업 기록을 요구한다.
수동 기록은 `{platform,arch,macos,archiveSha256,wasmSha256,tester,testedAt,checks}`이며 checks의
`nativeKoreanIme`·`finderLaunch`·`longSession` 각각에 `{status:'pass',notes:'실제 시험 내용'}`이 있어야 한다.
없는 결과, 다른 OS/해시, 개발용 실행, Windows 결과, Chromium 조합 시험을 Mac 통과로 바꾸지 않는다.
전체 안정성을 보증하는 도구가 아니라 명시된 배포 검사 범위를 확인하는 도구다.

현재 연결할 Mac이 없으므로 macOS 12.1 실기·OS IME·Finder·Gatekeeper·장시간 시험은 **미검증**이다.
Developer ID 서명·Apple 공증도 없다. 0.5.1은 로컬 후보이며 기존 공개 다운로드 1.0.3을 이 후보로 교체하지 않았다.
검증 로그와 패키지: `artifacts/macos-parity-20261114/`. 최종 결과는 아래 기록을 따른다.

최종 후보: `final/package/hwpx-cowork-server-0.5.1-20261114-macos-universal-app.zip`,
378,875,474바이트, SHA-256 `cc28f272fc191f35d991dc65f23e607e696e0f23f1b7191a7d6d9cbe8269a471`.
독립 검증에서 ZIP 9,030항목 CRC, Mach-O 16개(내장 Node 포함)의 양 CPU·최소 OS·서명 내부 코드 페이지,
웹 파일 259개 해시·웹 패치 131개·cowork 플러그인·동결 호스트 ASAR 13파일을 확인했다.
이는 Apple의 codesign/Gatekeeper 실기 검증이 아니다. WASM은 이전과 같은
`3324762a9e8f0c8b3d8c397859eec9846ebdd3e97ec8d1c43a5db61985507fd3`이다.

Windows Electron 43.8.10의 실제 전체 앱에서 자동 접속·문서함·플러그인·연속 입력/Chromium 조합 129자·
미사용 설치 글꼴 Segoe Print의 선택/로딩·HWPX 사본의 글/글꼴 저장·메모 API/화면·새로고침 후 복원·정상 종료
9개 검사가 통과했다(`final/native-windows-5/native-result.json`). 최초 하네스의 잘못된 DOM 선택자,
자동 접속/첫 쪽 미리보기 완료 전 조작, 외부 파일 저장 완료 전 읽기를 고쳐 정상 사용 시점부터 확인했고 실패 로그를 보존했다.
닫기 취소·새로고침 취소·버린 뒤 새로고침(앱 유지)·버린 뒤 종료도 별도 Windows Electron 검사 4개 통과했다
(`final/close-native-2/result.json`, 네이티브 대화상자 선택은 시험 스텁).
글꼴 관련 17개·권한/종료 2개와 Studio 타입 검사도 통과했다. 출시 판정 도구의 경계 시험은 2/2이며,
현재 후보의 `final/macos-readiness.json`은 실제 Mac 자료가 없어서 **ready:false**다.

## 로컬 편집기 1.0.3 — Universal·입력·종료 수정 (2026-11-14, 이전 standalone 배포 기록)

사용자가 확인한 증상은 Safari 웹 편집기가 아니라 설치한 **Hwpx Editor 오프라인 로컬 앱**의 연속 입력 끊김이다.
Rust/WASM을 다른 엔진으로 바꾸지 않는다. 웹 `studio/dist`·원본 `vendor/rhwp/pkg`·동결 후보·완성 앱의 문서 WASM SHA-256은
모두 `3324762a9e8f0c8b3d8c397859eec9846ebdd3e97ec8d1c43a5db61985507fd3`이다.

- **입력 경로**: desktop 빌드가 글꼴 패치만 선택해 웹의 `PERFORMANCE_PATCHES`를 빠뜨렸다. 같은 서식의 반복 갱신 100회에서 불필요한 DOM 쓰기 2,100회·글꼴 이름 정규화 32,600회가 발생하고, 문단 변경도 전체 문서의 Canvas 측정을 수집했다. `studio/build/standalone-editor-patches.mjs`로 웹과 같은 성능·측정 패치를 재사용한다. 빌드와 회귀시험이 같은 선택을 사용하고, 패치 누락은 빌드 실패로 처리한다. 본문·서식·조판 기대값은 변경하지 않는다.
- **한 파일**: 기본 `npm run package:macos:local`은 Intel과 Apple Silicon을 지원하는 Universal `.app` 하나가 든 ZIP 하나를 만든다. 문서 WASM·편집기·글꼴은 한 번만 포함한다. `rcodesign macho-universal-create`로 네이티브 실행파일 15개의 양쪽 CPU 코드를 합치고 최종 번들을 다시 ad-hoc 서명한다. 모든 Mach-O에 두 CPU가 있고 실제 최소 OS가 12.1 이하인지 검사한다. 한쪽 CPU의 V8 snapshot도 빠뜨리지 않는다. Electron은 Monterey를 지원하는 43.8.10을 유지한다([공식 지원 변경](https://www.electronjs.org/blog/electron-44-0), [공식 Universal 구조](https://github.com/electron/universal)).
- **패키징 수정**: Windows에서 Mac framework의 디렉터리 symlink를 `stat`으로 따라가다 실패하는 경로를 링크 그래프로 처리하고, Electron Packager가 ASAR 무결성 키에 넣는 Windows 임시 절대경로를 실제 헤더 해시와 `Resources/app.asar`로 정규화한다. 공통 파일은 양쪽 해시 일치를 요구한다. 이전 앱 위에 ASAR를 얹던 `--refresh` 대신 새 출력 폴더를 사용한다. 중단된 현재 후보의 `--reuse-web --reuse-apps`는 코드·자원·버전을 대조한 뒤에만 가능하다.
- **저장하지 않고 종료**: 미저장 상태에서 ‘취소’와 ‘저장하지 않고 종료’를 제공한다. 기본/ESC는 취소다. 명시적으로 버리기를 선택했을 때만 창을 파기해 편집기 `beforeunload`가 두 번째로 막지 않게 한다. 파일 저장을 호출하지 않으며, 취소는 편집 상태를 유지한다. 연속 종료 요청에는 확인창을 중복 띄우지 않는다.

검증 자료는 `artifacts/macos-universal-20261114/`에 보존한다. 수정 전 standalone 검사 9개 중 4개 실패,
수정 후 standalone 입력/글꼴/비동기 측정 21/21 통과. Windows Electron 43.8.10의 production main/preload/renderer에서
연속 입력 84자와 Chromium 한글 조합 24음절이 정확히 한 번 들어갔고 원본 저장·사본 저장·저장취소·종료취소·저장하지 않고 종료를 확인했다.
작은 문서의 동일 입력에서 전체 측정 수집 181회가 3회로 줄고 문단 수집 178회로 바뀌었다. 초기 시험은 문서 열기 완료를 기다리지 않아
입력 도중 초기화와 경합할 수 있었다. 해당 실패는 보존하고, 실제 입력 가능 상태까지 기다리는 동일 전후 시험으로 교정했다.
60쪽 시험 보고서도 같은 입력을 보존했고 전체 수집 180→4회, 문단 수집 0→176회였다. 같은 CPU25% 제한 아래 입력 중앙값 31.21→5.26ms,
95백분위 34.82→7.68ms, 조합 갱신 중앙값 31.90→5.69ms로 줄었다. 최대값 약157~177ms의 긴 처리도 남았으며 측정값은 이 Windows 표본의 관측이지 Mac 성능 보장이 아니다.
독립 검증은 기본 웹/파일 저장/Mac/Universal 29/29, ZIP 안의 Mach-O 15개·CodeDirectory 30개의 코드 페이지/특수 슬롯·리소스 봉투 9개·symlink 14개·ASAR 원본 7파일·무결성 키가 일치했다.
`rcodesign verify` 자체는 15개 모두 ad-hoc의 빈 CMS 오류로 실패했고, 도구도 오판 가능 경고를 출력했다. 원문을 `verifier/signature-*.log`에 보존하고 별도 해시 계산을 확인했다. 이를 Apple 서명 검사 통과로 보고하지 않는다.
창 닫기와 종료 메뉴(`app.quit`) 모두 취소/버리기 경로를 확인했다.
입력/IME/종료는 AGENTS §2.1의 예외로 실제 Electron 입력 이벤트를 검사했으며 조판 화면 캡처는 하지 않았다.
이 결과를 macOS의 실제 OS IME나 Safari와의 완전한 동작 일치로 확대하지 않는다. 실제 macOS 12.1·Finder·Gatekeeper와 Developer ID/Apple 공증은 미검증이다.
사용자의 게시 승인 후 1.0.3을 공개 다운로드에 반영했다. `https://cowork.example.com/download`의 Hwpx Editor는
Intel·Apple Silicon 공용 버튼 하나이며, 기종 선택 안내는 별도 개인 서버 앱에만 남긴다. 이전 1.0.2 두 파일은 이전 버전으로 옮기고
기존 22개 파일·주소를 보존했다. `server/download-page.js`의 표시 변경은 지원되는 정상 재시작으로 적용했고 운영 설정은 바이트 그대로 보존했다.
공개 HTTPS에서 ZIP 전체 265,536,875바이트와 SHA-256 `43d42375c45af7aa5446f1f84201fb2a3a207f12a6f0e83bc9d7aae58d2a758e` 일치,
23개 파일의 HEAD 응답·크기, 공개 명세·체크섬·공용 버튼을 확인했다. 다운로드 회귀시험은 4/4 통과했다.
실제 브라우저나 Mac에서 실행한 검사는 아니며 앞의 macOS 실기기·서명 관련 미검증 상태는 그대로다.
배포 근거는 같은 자료 폴더의 `publication.json`, `ui-deployment.json`, `public-verification.json`, `verifier/publication-review.json`이다.

## macOS 12.1 호환판 (2026-11-14)

현재 Mac 로컬 편집기 **1.0.1**과 개인 서버 앱은 Electron **43.8.10**으로 묶는다. Electron 44부터 macOS 13이 필요하므로, 단순한 Info.plist 숫자 변경 대신 런타임 자체를 교체했다. 공식 앱의 최소 대상은 12.0이며 배포 지원 목표는 **macOS 12.1 이상**이다. 개인 서버의 별도 Node는 22.23.5(최소 11.0)를 사용한다. 두 기종·두 앱 안의 모든 Mach-O CPU/최소 OS를 확인하는 `scripts/macos-binary-audit.mjs`를 패키징 필수 검사로 넣었다. 기존 배포 파일은 보존한다.

macOS 12의 개인 서버 앱은 문서 편집·문서함·공동 검토를 제공한다. **구독 AI 연결은 macOS 13 이상**에서 지원한다. Mac12에서 실행 가능한 구형 CLI를 조사했지만 현재 서버의 필수 연결·격리 옵션을 지원하지 않아 채택하지 않았다. 해당 OS에서 AI 메뉴·설정 진입·자동 연결·설치 및 로그인 실행을 막고, 다른 OS의 현행 CLI와 격리 요구는 유지한다. 로컬 편집기는 원래 서버·AI 기능이 없어 이 제한과 관계없다.

실제 macOS 12.1 기기·Finder·Gatekeeper는 미검증이며 Developer ID 서명·Apple 공증 전이다. Windows의 동일 Electron43에서 네이티브 파일 IPC 저장 경로를 확인했고 개인 서버 payload는 공식 Node22의 임시 서버 검사로 확인한다. 조사·실패 후보·빌드·검증·게시 근거는 `artifacts/macos121-20261114/`에 보존한다.

## 서버 없는 Mac 로컬 편집기 추가 (2026-11-14)

기존 개인 서버 앱은 유지하며 **Hwpx Editor.app**을 별도로 추가했다. `deploy/local-editor/`가 Electron의 전용 보안 스킴으로 내장 편집기를 읽고, 사용자가 고른 파일만 불투명 ID로 연결한다. HTTP 서버·자식 Node 서버·로그인·협업·AI는 필요하지 않다. ZIP을 풀고 앱을 더블클릭해 **파일 → 열기**로 문서를 고른다.

**저장**은 열린 파일을 갱신하고 **다른 이름으로 저장**은 새 위치를 고른다. 새 위치에 저장한 뒤의 저장은 그 사본을 갱신한다. 임시 파일을 완성한 뒤 원자적으로 교체하고, 열기 이후 외부에서 파일이 바뀌거나 읽기 전용이면 덮어쓰기를 거부한다. 취소·쓰기 실패 때 수정 상태를 유지한다. 1.0.3부터 미저장 상태에서 닫으면 취소 또는 저장하지 않고 종료를 선택한다. 선택하지 않은 경로를 renderer가 임의로 읽거나 쓸 수 없다.

- 최초판은 Apple Silicon·Intel 별도 ZIP, macOS 13 이상이었다. 1.0.1부터 macOS 12.1을 대상으로 하며 1.0.3 후보는 Universal ZIP 하나다. 앱 이름·번들 ID가 기존 서버 앱과 달라 함께 둘 수 있다.
- 빌드: `npm run package:macos:local`, `scripts/package-macos-local.mjs`. 내장 편집기 빌드와 허용 글꼴·라이선스 검사, POSIX 실행 권한·framework symlink, ad-hoc 서명을 포함한다.
- 실제 Mac·Finder·Gatekeeper·공증은 미검증이다. Developer ID 서명·Apple 공증 전이며 첫 실행 시 macOS의 앱 실행 허용 확인이 필요할 수 있다.
- 검증: 파일/핸들 단위 4건 및 Windows의 동일 Electron 45에서 production main/preload/renderer로 원본 저장·사본 저장·취소 뒤 수정 상태 보존을 확인했다. 저장 XML에서도 원본/사본의 입력 내용을 구분했다. 이는 실제 Mac 실행이나 한/글 조판 일치 검증이 아니다. 기록: `artifacts/local-editor-20261114/`.

Android 1.0.8(코드11)도 쓰기 가능한 열린 원본 저장을 지원한다. 자체 Android 15 에뮬레이터에서 이전 APK 위 업데이트, 열기·편집·원본 저장·사본 저장을 확인했으며 실물 휴대폰과 문서 제공자별 URI 쓰기는 미검증이다. 기존 APK와 Mac 서버 앱은 보존하고 다운로드 목록 첫 항목은 Windows 통합 ZIP으로 둔다.

## macOS 앱 배포 (2026-11-13, 당시 배포 기록 — 현재 후보는 위 0.5.1절)

개인 **AI 실행기**는 기존 서버에 연결하는 별도 프로그램이다. 이 절의 개인용 **서버 앱**은 각자 자기 Mac에서 서버와 편집기를 함께 켠다.
`deploy/desktop/`의 Electron 창이 기존 `portable/personal.mjs --no-window`를 내장 Node로 시작하며, 처음 실행하면 무작위 관리자 토큰·빈 포트·127.0.0.1 전용 서버를 자동 준비하고 문서함을 연다.
사용자가 Node·npm·Rust를 설치하거나 명령·서버 주소·토큰을 입력할 필요가 없다. 앱의 [파일 → 문서 폴더 연결]에서 폴더를 고른다.
기본은 AI 없이 편집·저장이고 [AI → ChatGPT·Claude 연결]에서 선택한 공식 CLI를 사용자 설정 폴더에 자동 준비하고 브라우저로 구독 로그인을 진행한다. 앱 시작이나 연결 점검만으로 모델을 호출하지 않는다.

- 배포 형식: Apple Silicon과 Intel 각각의 ZIP 안에 `Hwpx Cowork.app`, 짧은 안내, 빌드 정보. Electron 45.3.1·Node 22.23.5·npm·서버 운영 의존성·미리 빌드한 엔진·편집기·허용 글꼴과 원문 라이선스를 포함한다.
- 최소 실행 대상: 공식 Electron 45의 Info.plist와 Mach-O 기준 macOS 13.0(14 포함). Node 22의 11.0 대상과 구분한다. Mac 앱의 최소값을 11로 소개하지 않는다.
- 설정·기록: 사용자 `Library/Application Support/Hwpx Cowork/personal`에 보존한다. 앱을 옮기거나 새 ZIP으로 교체해도 이 경로는 유지된다. 연결한 PC 원본·기존 운영 `config.json`·`data/`는 새 설치로 복사하지 않는다.
- 종료: 편집기의 미저장 경고를 먼저 존중하고, 창이 닫히면 소유 서버·AI 실행기를 IPC로 정상 종료한다. 부모 앱의 비정상 종료도 자식의 disconnect 처리로 정리한다. 다른 설치나 사용자의 프로세스는 종료하지 않는다.
- 빌드: `npm run package:macos`(`--out`, `--arch arm64|x64`, 기존 본인 후보의 소스 수정 후 `--refresh`). `scripts/package-portable.mjs --target personal-lite`의 허용 목록과 비밀·글꼴 검사를 재사용한다. Windows에서 ZIP을 만들 때 Mach-O/shebang 파일은 0755, 일반 파일은 0644, framework symlink는 POSIX 구분자와 120777로 기록한다.
- 서명: `apple-codesign 0.29.0`으로 실행 파일·중첩 framework·리소스를 ad-hoc 서명한다. **Developer ID 서명·Apple 공증은 아니다.** macOS의 첫 실행 확인이 필요할 수 있으며 실제 Mac의 Finder 더블클릭·Gatekeeper·AI 로그인은 미검증으로 남긴다. 보안 기능 해제나 터미널 우회 명령을 설치 절차로 제공하지 않는다.

검증·배포 기록은 `artifacts/personal-macos-20261113/`과 `docs/CHANGELOG.md`에 이어 적는다. Windows의 동일 Electron 앱 문서함은 UIA 텍스트로 확인했으며 화면 캡처는 도구 시간 초과로 확인하지 못했다. 실제 Mac 실행이나 엔진의 Mac 화면 일치를 검증한 것으로 확대하지 않는다.

## 1. 방안 검토

| 방안 | 내용 | 판단 |
|---|---|---|
| **A. 개인 PC 에서 서버를 직접 돌리고 PC 폴더를 문서함에 비춘다** (선택) | 개인용 앱이 127.0.0.1 서버(같은 엔진·편집기·MCP)를 켜고, 고른 폴더의 HWPX 를 개인 문서함에 보인다. 고치면 그 파일에 쓰고, 밖에서 바뀐 파일은 다시 읽는다 | 메모·변경 추적·AI 제안·이력·MCP 가 서버 쪽 코드(`service.js` 5천여 줄)에 있어 그대로 쓴다. 문서 파일은 PC 에만 있다. 모여서 검토는 문서를 중앙 서버로 보냈다가 가져온다 |
| B. 브라우저의 폴더 접근(File System Access API)으로 중앙 서버 화면이 내 PC 폴더를 직접 읽고 쓴다 | 서버 없이 브라우저가 파일을 연다 | 검토·AI·이력이 모두 서버에 있어 그 기능을 쓰려면 결국 문서를 서버에 올려야 한다(= 중앙 서버 접속). Chromium 전용이고 폴더 권한을 창마다 다시 물으며, 절대 경로를 알 수 없어 한/글과 같은 파일을 가리킨다는 보장이 약하다 |
| C. 중앙 서버의 개인 문서함 ↔ PC 폴더 동기화 도우미(개인 실행기가 올리고 내려받음) | 문서는 서버에 있고 PC 폴더에 사본을 맞춘다 | "중앙 서버에 접근하지 않는" 요구와 어긋난다(파일이 서버에 남는다). 양쪽 사본의 충돌 처리가 더 복잡하다 |
| D. 확장 프로그램판(`<repo>-local`, 서버 없음) | 브라우저 확장 + 네이티브 메시징으로 내 PC 의 AI | 이미 따로 있다. 서버 기능(실시간·MCP·이력)을 다시 만들어야 해 이 저장소의 기능과 갈라진다. 모여서 검토와 이어지지 않는다 |

A 를 골랐다: 새로 만드는 것은 "PC 폴더 ↔ 문서" 연결 한 층과 실행기뿐이고, 편집기·엔진·검토·AI 는 중앙 서버와 같은 코드를 쓴다. 같은 문서를
중앙 서버에 보내 검토하고 되받는 것도 두 서버가 같은 프로그램이라 REST 두 번이면 된다.

## 2. 구조

```
[개인용 앱 = personal-app.bat → app/portable/personal.mjs]
   ├─ 서버(server/index.js, 127.0.0.1:<포트>, 사용자 1명 = 관리자, config.local.enabled)
   │     ├─ 문서함: 개인 문서함 ▸ [PC] 내 문서 ▸ 하위 폴더 …   ← PC 폴더를 훑어 비춘 것(folders.json 의 local 폴더)
   │     ├─ 문서 기록: userdata-personal/data/docs/<id>/…        ← 연 문서만(이력·메모 묶음·AI 작업)
   │     └─ PC 파일 맞춤: 커밋 → PC 파일 쓰기 / PC 파일 바뀜 → 새 기록
   ├─ 앱 창(Edge·Chrome --app, 전용 프로필 userdata-personal/browser) — 닫으면 앱도 꺼짐
   └─ (선택) AI 실행기 scripts/ai-worker.mjs --url http://127.0.0.1:<포트>/mcp
[중앙 서버] ← 함께 검토: POST /api/docs(내 토큰) → 검토 → GET /api/docs/:id/file → 내 문서·PC 파일
```

- 기능은 `config.local.enabled`(또는 `HWPX_COWORK_LOCAL=1`)일 때만 켜진다. 기본은 꺼짐 — 중앙 서버에서는 켜지 않는다(서버 PC 의 폴더를 여는 기능이다).
- 연결·끊기·폴더 고르기·검토 서버·보내기·가져오기는 **관리자가 이 PC 에서 보낸 요청**만 받는다(`routes/local.js` `isSameMachine`: 소켓이 loopback,
  주소가 localhost, 프록시 머리글 없음, Origin 이 같은 주소). 터널을 거친 요청은 loopback 으로 보여도 거절한다.

## 3. 자료

- `<dataDir>/local-folders.json` `{ links: [{ id, path, name, owner, folderId, addedAt }], remotes: [{ id, name, url, user, token }] }`.
  - 연결 id = `k` + 경로 해시(Windows·macOS 는 대소문자 무시) — 같은 폴더를 다시 연결하면 같은 id 라 예전 문서 기록과 이어진다.
  - 검토 서버 토큰은 AES-256-GCM 암호문(열쇠는 config 옆 `.hwpx-cowork-secret` — 내 AI 키와 같은 파일). API 는 토큰을 돌려주지 않는다
    (그 서버를 여는 주소 `#/t/<토큰>` 만 이 PC 화면에 준다).
- **비친 폴더**: 연결한 폴더와 그 하위 폴더는 주인의 개인 문서함의 폴더 항목이다(`folders.json`, `local: { link, rel }`, id = `f` + 해시(연결 id + 길)).
  훑을 때마다 PC 폴더에 맞춰 만들고 뺀다(`Library.mirrorLocal`). 권한(공유)은 보통 폴더와 같다. HWPX 가 (아래에) 있는 폴더와 빈 폴더만 비춘다
  (깊이 7단계, 연결 하나에 2만 항목까지 — 넘으면 `truncated`). `.`·`~$`·`$` 로 시작하는 이름과 `.tmp`, 심볼릭 링크는 건너뛴다.
- **문서의 연결** `meta.local = { link, rel, size, mtimeMs, hash, version, state, syncedAt }` — `version` 은 PC 파일에 쓴 기록 번호, `hash` 는 그때 파일의 SHA-256.
  `state`: `ok` · `locked`(다른 프로그램이 잡고 있어 못 씀) · `unreadable`(밖에서 바뀐 파일을 읽지 못함). 문서 요약에는 `local: { state, path?(주인·관리자만), syncedAt }`
  — `state` 에 `file`(아직 열지 않은 파일)·`saving`(쓸 기록이 남음)이 더 있다.
- **보낸 곳** `meta.review = { remote, server, url, docId, sentAt, sentVersion, fetchedAt?, fetchedVersion?, fetchedKind? }`.

## 4. 규칙

1. **열 때 등록한다.** 폴더의 HWPX 는 목록에 문서 꼴로 보이지만(id = `L` + 해시(연결 id + 길), version 0, `local.state: 'file'`) 서버 데이터에는 없다.
   그 id 로 처음 부를 때(REST `/api/docs/:id…` 접근 문·MCP `doc_id`) 파일을 읽어 문서로 등록한다(`local.ensure`). 볼 수 없는 사람이 부르면 등록하지 않는다(404).
2. **고치면 PC 파일에 쓴다.** 커밋(`store.commit` → `afterCommit`)마다 그 문서의 맞춤을 예약하고(기본 1.5초 모음 — `local.writeDelayMs`), 문서 큐 안에서
   지금 기록(`current.hwpx`)을 같은 폴더의 임시 파일(`.~cowork-*.tmp`)에 쓴 뒤 바꿔 끼운다. PC 파일 = 문서의 지금 기록과 같은 바이트(메모·변경 추적 포함 — 한/글에서 그대로 열린다).
   서버를 끌 때는 남은 쓰기를 마치고(`flush`), 그러지 못하고 죽었으면 다음에 켤 때 마저 쓴다(`meta.version !== local.version`).
3. **PC 파일이 기준이다.** PC 파일의 크기·시각이 기록과 다르고 내용(SHA-256)도 다르면 밖에서 고친 것(한/글 저장)으로 보고 그 파일을 새 기록으로 **통째로** 읽는다
   (`service._replaceContent` — 그 바이트를 그대로 기록, 사람용 버전 하나, 열린 편집기는 다시 맞춘다). 앱에 아직 쓰지 않은 기록이 있었어도 PC 파일이 이기고,
   앱에서 고친 내용은 이력(기록 파일)에 남는다. 읽을 수 없는 파일이면 문서는 그대로 두고 `unreadable` 로 표시하며, 그 파일을 덮어쓰지 않는다.
   확인 시점: 문서 목록을 읽을 때(1.5초 안에는 다시 훑지 않음), 그 문서를 부를 때(`ensure` → `fresh` — 열면 늘 지금 파일), 열려 있는 문서는 4초마다.
4. **못 쓰면 기다린다.** 한/글이 파일을 열어 둔 동안에는 쓰기용 열기·바꿔 끼우기가 실패한다(EBUSY·EPERM·EACCES) → `locked`, 5초마다(문서 목록을 다시 읽으면 곧바로)
   다시 해 본다. 닫은 뒤 그 파일이 바뀌어 있으면 3번 규칙대로 PC 파일을 읽는다.
5. **탐색기에서 옮긴 파일은 같은 문서다.** 등록된 문서의 파일이 제자리에 없으면 크기와 SHA-256 이 같은 새 파일(같은 이름을 먼저)에 잇는다 — 제목이 옛 파일 이름이었으면
   새 이름으로. 못 찾으면(지운 파일) 그 문서는 목록에서 숨는다. 기록은 지우지 않는다(같은 자리에 파일이 다시 생기면 이어진다).
6. **앱에서 한 일은 PC 폴더에 그대로.** PC 폴더에 올리기·새 문서 = 그 폴더에 파일(같은 이름이면 `이름 (2)`), 문서 이름 바꾸기 = 파일 이름 바꾸기(못 쓰는 글자는 `_`,
   같은 이름이 있으면 409 `NAME_TAKEN`), 옮기기 = 파일 옮기기, 폴더 만들기·이름 바꾸기·옮기기(같은 연결 안)·빈 폴더 지우기 = 실제 폴더.
   서버 문서함 문서를 PC 폴더로 옮기면 그 폴더에 파일로 쓰고 잇는다. **PC 폴더 문서를 서버 문서함으로는 옮기지 않는다**(409 `LOCAL_ONLY` — 파일이 기준이라).
   문서 지우기 = PC 파일도 지운다: Windows 휴지통으로, 안 되면(또는 `local.trash: 'folder'`·`HWPX_COWORK_LOCAL_TRASH`) `<dataDir>/local-trash/` 로 — 완전히 지우지 않는다.
7. **연결 끊기는 문서함에서만 뺀다.** PC 의 파일과 앱의 문서 기록은 그대로 두고, 같은 폴더를 다시 연결하면 이어진다. 연결한 폴더 자체는 지우거나 옮기지 않는다(`LOCAL_ROOT`·`BAD_MOVE`),
   이름표만 바꾼다. 겹치는 폴더(이미 연결한 폴더의 안·밖), 드라이브 전체, 이 앱의 프로그램·데이터·설정 폴더(와 그 안)는 연결하지 않는다. 그것을 품은 폴더
   (앱을 풀어 둔 '문서' 폴더 등)는 연결하되 훑을 때 앱의 폴더만 건너뛴다 — 문서 기록 파일(`data/docs/…/*.hwpx`)이 문서로 보이지 않게.
8. **함께 검토.** 보내기 = 지금 기록(메모·변경 추적 포함)을 검토 서버에 새 문서로 올린다(`POST /api/docs`, `x-space`). 가져오기 = 그 서버 문서를 내려받아 3번과 같은 방식으로
   내 문서를 통째로 바꾼다(`tracked` = 서버 문서 그대로 — `kind=tracked`, `final` = 변경을 받아들인 글 + 메모 — `kind=final&reviews=1`). PC 폴더 문서면 곧 PC 파일에도 쓴다.
   다시 보내면 새 문서가 하나 더 생긴다(앞서 보낸 서버 문서는 그대로).

## 5. 경로

모두 `config.local.enabled` 일 때만 있다. ★ = 관리자 + 이 PC 요청만(403 `ADMIN_REQUIRED`·`SAME_PC_REQUIRED`).

| 경로 | 내용 |
|---|---|
| `GET /api/config` → `local: true|false` | 기능이 켜져 있는가 |
| `GET /api/library` → `local: { canLink, links: [{ id, folderId, name, path, owner, ok, truncated }], remotes: [{ id, name, url, user }] }` | 연결·검토 서버 목록(관리자·주인에게만) |
| `GET /api/local` | 위 `local` 만 |
| `POST /api/local/pick` ★ → `{ path|null }` | 이 PC 화면에 폴더 고르기 창(Windows 폴더 찾아보기 · macOS choose folder · Linux zenity) |
| `POST /api/local/links { path, name? }` ★ → `{ link, local }` | 400 `BAD_PATH` · 404 · 409 `LINKED`·`LINK_OVERLAP` |
| `DELETE /api/local/links/:id` ★ | 연결 끊기 |
| `POST /api/local/rescan` | 지금 다시 훑기 |
| `POST /api/local/remotes { url, token, name? }` ★ → `{ remote, local }` | 그 서버의 `/api/config`·`/api/me` 로 확인한 뒤 저장. 502 `REMOTE_UNREACHABLE`·`REMOTE_AUTH` |
| `DELETE /api/local/remotes/:id` ★ · `GET /api/local/remotes/:id/open` ★ → `{ url }` | 지우기 · 그 서버를 내 토큰으로 여는 주소 |
| `GET /api/docs/:id/review` ★ → `{ review, remote: { title, version, updatedAt, proposals, requests, changed }, openUrl }` | 보낸 서버 문서의 지금 상태 |
| `POST /api/docs/:id/review/send { remote, space }` ★ → `{ review, openUrl }` | 보내기 |
| `POST /api/docs/:id/review/fetch { kind }` ★ → `{ version, review }` | 검토본 가져오기 |

문서 요약(`GET /api/docs`·`/api/library`·`/api/docs/:id`)에 `local`·`review` 가 붙는다. WebSocket `{ type: 'doc', action: 'local', state }` = 파일 맞춤 상태가 바뀜(문서 정보만 다시 읽는다).

## 6. 화면(개인용 앱에서만)

- 문서함 도구 줄: **PC 폴더 연결**(폴더 고르기 · 경로 · 연결, 연결 목록과 [연결 끊기]) · **검토 서버**(주소 · 내 토큰 · 이름 → 등록, [열기]·지우기).
- 나무·목록: 연결한 폴더에 `PC` 꼬리표(올리면 경로), 문서 줄에 `PC`(상태가 있으면 `PC 저장 중`·`PC 쓰기 대기`·`PC 읽기 실패`), 보낸 문서에 서버 이름 꼬리표.
  연결한 폴더 줄은 옮기기·지우기 대신 [연결 끊기]. PC 폴더 문서·폴더의 옮기기 창에는 PC 폴더만 나온다.
- 문서 줄 **함께 검토**(위쪽 화살표): 서버·올릴 곳(개인/공용 문서함) → [보내기], 보낸 뒤 [서버에서 열기]·[검토본 가져오기](그대로/최종본)·`새 내용` 표시.
- 문서 화면 위 `PC` 알약(올리면 경로·저장 시각).
- 처음 연 화면: 기억해 둔 자리가 없으면 첫 연결 폴더를 연다. 설명서 `/help.html#local`.

## 7. 실행기

`personal-app.bat`(Windows — 최소화된 창) / `personal-app.sh` → `app/portable/personal.mjs [폴더 …] [--port] [--name] [--ai "<실행기 인자>"] [--no-window] [--keep]`.

1. 첫 실행: `userdata-personal/config.json` 을 만든다 — `host 127.0.0.1`, 빈 포트(기본 8790), 사용자 한 명(관리자, 무작위 토큰, 이름 = `--name` 또는 PC 사용자 이름),
   `local.enabled`, 실시간 수정·바로 적용, 서버 AI 끔, 체험(튜토리얼) 끔 — 첫 화면이 내 PC 폴더다. 예제 토큰·예제 사용자는 넣지 않는다.
2. 서버를 `server/launcher.js` 의 `startManagedServer` 로 켠다(저장을 마치는 정상 종료·장애 복구는 서버 묶음과 같다).
3. 준 폴더를 연결한다. 처음이고 폴더를 주지 않았으면 폴더 고르기 창을 띄운다.
4. 앱 창: Windows 는 Edge·Chrome 의 `--app` 창을 전용 프로필(`userdata-personal/browser`)로 연다 — 주소 `…/?teaser=0#/t/<토큰>` 이라 소개 영상·로그인이 없다.
   그 창 프로세스가 끝나면(창을 닫음) 앱도 끈다(`--keep` 이면 계속). 4초 안에 끝나면 창을 추적할 수 없는 것으로 보고 계속 켜 둔다. 그 밖의 OS 는 기본 브라우저.
5. 이미 떠 있으면(같은 설정 폴더) 폴더만 더 연결하고 창을 하나 더 열고 끝난다.
6. `--ai "--provider codex"`(또는 config `personal.ai`)면 개인 AI 실행기를 이 서버 주소로 함께 켠다(토큰은 환경 변수로만).
7. 끄기: 앱 창 닫기 · 최소화된 창 닫기 · Ctrl+C · 표준 입력 `quit`.

개발 폴더에서는 `npm run personal -- <폴더>`(설정·기록은 저장소의 `userdata-personal/` — `data/`·`config.json` 을 쓰지 않는다).
묶음: `npm run package:personal`(= `package:portable --target personal-lite`) → `hwpx-cowork-personal-<판>-<날짜>-lite.zip`(서버 묶음과 같은 `app/` + 개인용 시작 파일).

## 8. 확인한 것·하지 않은 것 (2026-11-10)

확인(임시 서버·임시 폴더, 모의 없음 — `npm run test:personal`, Windows 10 · Node 24.11.1): 연결·권한·경로 검사, 열기 전 미복사, 열기·메모·편집기 밀어 넣기 뒤 PC 파일 = 지금 기록,
밖에서 바뀐 파일 다시 읽기·읽을 수 없는 파일, 새 문서·올리기·이름·옮기기·지우기·폴더 동작, 탐색기에서 옮긴 파일 잇기, 연결 끊기·다시 연결, 공유, 죽은 뒤 마저 쓰기,
쓰기 잠김(한/글 대신 읽기만 나누고 파일을 열어 둔 프로세스로 흉내 — `locked` → 닫으면 저장), 두 서버 사이 보내기·가져오기, 실행기의 첫 설정·폴더 연결·두 번째 실행·`quit`·다시 켜기.

따로 한 번 확인(시험 묶음에는 없다):
- 묶음 `hwpx-cowork-personal-0.5.0-20261110-lite.zip` 을 한글·공백 경로에 풀고 그 안의 실행기를 창 없이 켬 → 첫 설정·폴더 연결·문서 열기·화면 파일·MCP `list_documents`·`quit`.
  이때 서버 묶음의 허용 목록에 `experiments/mcp-lab/*`(11-05 부터 `server/admin-mcp.js` 가 불러옴)이 빠져 풀린 서버가 시작하지 못하는 것을 찾아 고쳤다
  (`package-portable.mjs` — 묶기 전에 상대 import 를 따라가 확인하는 `checkRelativeImports` 도 더했다).
- 앱 창 수명(브라우저 고유 동작이라 실제 Edge 로): 전용 프로필 창을 띄운 동안 앱이 켜져 있고, 창에 닫기(WM_CLOSE)를 보내면 앱과 서버가 꺼진다(종료 코드 0).

하지 않은 것(미검증): 실제 한/글이 파일을 열어 둔 동안의 동작(위는 같은 꼴의 잠금 흉내)과 한/글에서 저장한 파일을 다시 읽는 실제 왕복, Windows 휴지통으로 보내기(시험은 폴더로 옮기기),
폴더 고르기 창이 실제로 뜨는 것(스크립트가 해석되고 창 개체를 만드는 데까지만 — 창을 띄우면 이 PC 화면을 막는다), 실제 AI 실행기와 함께 켜기(`--ai` 는 명령 구성만),
macOS·Linux, 화면(문서함의 PC 폴더 연결·검토 서버·함께 검토 창과 꼬리표)의 브라우저 조작 — 화면 코드는 문법 검사와 서버 응답 꼴까지만 봤다.

## 9. 남은 것·결정

- PC 파일에는 문서의 **지금 기록 그대로**(변경 추적·메모 포함)를 쓴다. 개인용 앱의 기본 문서 설정은 실시간·고친 글만이라 보통은 변경 추적이 없다.
  "최종본만 PC 에 쓰기" 같은 선택지는 두지 않았다.
- 여러 사람이 **내 PC 의 앱**에 접속해 검토하는 길(접속 범위 LAN·터널)은 서버 묶음의 기능 그대로 쓸 수 있고 PC 폴더를 폴더 권한으로 공유할 수 있지만,
  개인용 앱의 안내에는 넣지 않았다(모여서 검토는 중앙 서버로 보내기를 기본으로).
- 검토본을 가져올 때 내 쪽에서 그사이 고친 내용과 합치지 않는다(통째로 바꾸고 이력에 남긴다). 양쪽을 합치는 가져오기는 나중 일.
- 숨은 문서 기록(지운 파일·끊은 연결)을 정리하는 화면은 없다.
