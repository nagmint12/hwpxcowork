# hwpx-cowork — 한/글(HWPX) 문서 공동 검토·편집 서버

여러 사람이 같은 HWPX 문서를 **웹 편집기**에서 함께 고치고, 각자 연결한 **AI(ChatGPT·Claude·Gemini·Codex 등)** 가
MCP 로 문서를 읽고 **제안·메모**를 남기는 도구입니다. 파일 자체가 원본이라 한/글에서 열어도 메모와 변경 내용이 그대로 보입니다.

- 웹 편집기: [rhwp](https://github.com/edwardkim/rhwp)(Rust/WASM HWP·HWPX 엔진, MIT) v0.9.0 을 바탕으로 한/글 2022 동작에 맞춰 고친 엔진 + 협업 플러그인
- 실시간 공동 편집·변경 추적(한/글 "변경 내용")·메모 스레드·변경 요청(승인 방식)·문서함 권한
- AI 연결: 내 PC의 구독 Codex·Claude Code로 바로 처리(MCP), ChatGPT 앱 연결(선택·고급), API 키(사용료 별도). 서버가 곧 MCP 서버(`/mcp`, OAuth 2.1 지원)
- 표·차트·그림·차례·쪽 구성 제안, 한/글로 복사·붙여넣기(설치 없이 문서 모델 전달), 튜토리얼

## 빠른 시작

필요한 것: [Node.js](https://nodejs.org/) 22 이상(24 LTS 권장), Git. Windows·macOS·Linux.

```bash
git clone https://github.com/nagmint12/hwpxcowork.git
cd hwpxcowork
npm ci
cp config.example.json config.json      # Windows: copy config.example.json config.json
# config.json 의 users[].token 을 각자 긴 무작위 값으로 바꾼 뒤
npm start                               # Windows: start-server.bat 두 번 클릭
```

브라우저에서 `http://localhost:8787` 을 열고 `config.json` 에 적은 관리자 토큰으로 로그인합니다.
그 뒤의 사용자 추가·토큰 발급·서버 설정은 웹 상단 **[관리자]** 에서 합니다. 문서는 `data/` 에 저장됩니다.

## 내 구독 AI 연결하기

연결은 **① 내 PC의 구독 AI(기본) → ② ChatGPT 앱 연결(선택·고급) → ③ 내 AI 키(API, 사용료 별도)** 순서입니다. 먼저 서버를 켜고, VS Code 터미널(PowerShell)에서 개인 토큰을 한 번 저장합니다.

```powershell
setx HWPX_COWORK_TOKEN "내-개인-토큰"
```

VS Code와 터미널을 완전히 닫았다 다시 엽니다. 설치한 AI의 구독 계정으로 로그인한 뒤 이 프로그램 폴더에서 실행합니다. 두 AI 중 쓰는 쪽 하나만 켜 두세요.

```powershell
# Codex — ChatGPT 구독
codex login
.\start-codex-agent.bat --check
.\start-codex-agent.bat
```

```powershell
# Claude Code — Claude 구독(최신 CLI)
claude auth login
.\start-claude-worker.bat --check
.\start-claude-worker.bat
```

다른 PC의 서버면 시작 명령 끝에 `--url 'https://서버주소/mcp'`를 붙입니다. 구독 사용 한도 안에서 처리하고 별도 API 요금은 없습니다. 실행기가 MCP 연결을 준비하므로 대화창용 MCP 등록은 생략해도 됩니다. 웹에서 글을 골라 **AI에게 맡기기**로 보내면 제안이 돌아오고, 반영은 사람이 합니다.

사람이 보는 짧은 설명과 WebP 그림, **VS Code에 붙여넣을 내용** 복사 상자는 웹의 **사용 설명서 → 내 PC의 구독 AI**에 있습니다. 대화창에서도 쓰려면 그곳의 MCP 등록 명령·설정을 복사합니다. ChatGPT 웹의 URL·OAuth 안내는 접힌 고급 안내에서 펼쳐 봅니다. API 키는 구독과 별도 과금이므로 마지막에 고릅니다.

자세한 안내: [운영·AI 연결 매뉴얼](docs/DEPLOYMENT_AND_AI_GUIDE.md) · [개인 에이전트 연결](docs/AGENT_SETUP.md) ·
[자동 처리 선택](docs/AUTOMATIC_AI_GUIDE.md) · [API 실행기](docs/API_MCP_AGENT.md) · [멀티에이전트](docs/MULTI_AGENT_ORCHESTRATION.md) ·
[문서함 권한](docs/LIBRARY_SPEC.md) · [설계 계약](docs/V4_SPEC.md)

## 보안 — 꼭 지켜 주세요

- **토큰은 길고 무작위로.** 토큰이 곧 로그인입니다. 관리자 화면의 '자동' 단추가 32자 이상 무작위 토큰을 만듭니다.
  서버는 틀린 토큰 시도를 세지 않으므로 짧은 토큰은 추측당할 수 있습니다.
- `config.json`·`data/`·`.hwpx-cowork-secret`(개인 AI 키 암호 열쇠)은 저장소에 올리지 않습니다(`.gitignore` 에 들어 있음).
- 인터넷에 열 때는 HTTPS 뒤에 두고(`deploy/Caddyfile.example`), 서버 자체는 `host: "127.0.0.1"` 로 묶는 것을 권합니다.
- 관리자 AI(서버 API 키·튜토리얼에서 나눠 쓰는 관리자 AI)는 관리자가 '사용자' 탭에서 체크한 계정만 씁니다.

## 폴더 구성

| 폴더 | 내용 |
|---|---|
| `server/` | Express 서버 — REST·WebSocket·MCP·OAuth·AI 실행 |
| `engine/` | Node 쪽 HWPX 처리(메모·변경 추적·표·서식·차이 계산) |
| `web/` | 웹 화면(Vue 3, 빌드 없음 — 저장하면 바로 반영) |
| `studio/` | 편집기 빌드: rhwp-studio 에 덧대는 패치(`build/`)·협업 플러그인(`plugin/`)·**빌드 결과 `dist/`** |
| `vendor/rhwp/` | 엔진·편집기 **원본**(rhwp fork 가운데 빌드에 필요한 것: `src/`·`crates/`·`vendor/`·`rhwp-studio/`·`rhwp-shared/`·`npm/`·`assets/fonts/`)과 **빌드 결과**(`pkg/` WASM), rhwp 라이선스 |
| `deploy/portable/` | 설치형 묶음(서버·개인 AI 실행기·참여자 앱) 시작 파일 |
| `agent/` | Claude Code 채널 에이전트 작업 공간 본보기 |
| `scripts/` | 빌드·묶음·실행기·점검 도구 |
| `tests/` | 시험(`npm test`) |
| `tutorial/`·`docs/manuals/` | 튜토리얼·설명서 문서(가상 자료) |

## 엔진(rhwp) — 빌드 결과와 원본

엔진은 [rhwp](https://github.com/edwardkim/rhwp) v0.9.0(커밋 `c9095c5f67`)에 우리 수정(`// [hwpx-cowork]` 표시)을 git 3-way 병합한 fork 입니다.
`vendor/rhwp/pkg`(엔진 WASM)와 `studio/dist`(편집기)는 **미리 빌드한 결과**라서 Rust 없이 바로 실행됩니다.
`vendor/rhwp` 에는 그 fork 가운데 **엔진·편집기 빌드에 필요한 원본만** 들어 있습니다 — upstream 의 문서·시험 자료(`mydocs`·`samples`·`tests` 등)와 git 이력은 없습니다.

직접 고쳐 빌드하기(Rust 1.93.1 — `vendor/rhwp/rust-toolchain.toml` 이 고정, `rustup target add wasm32-unknown-unknown`, `cargo install wasm-bindgen-cli --version 0.2.127 --locked`):

```bash
npm run build:engine      # vendor/rhwp → vendor/rhwp/pkg (release, LTO — 처음엔 수십 분. --fast 는 LTO 없이)
npm run build:studio      # vendor/rhwp/rhwp-studio + studio/(패치·플러그인) → studio/dist
npm test
```

rhwp 새 판 받기(수동 병합 — 우리 수정이 upstream 의 조판 파일에 많아 충돌 풀이가 필요합니다):

1. upstream 을 받아 v0.9.0 에서 작업 브랜치를 만듭니다: `git clone https://github.com/edwardkim/rhwp && git -C rhwp switch -c cowork v0.9.0`
2. 이 저장소의 `vendor/rhwp` 를 그 위에 덮어쓰고 커밋합니다 → 우리 수정이 v0.9.0 위의 커밋 하나가 됩니다.
3. `git -C rhwp merge v<새 판>` 으로 합치고 충돌을 풉니다(원칙·지난 기록: [docs/RHWP_0.9.0_UPGRADE_2026-11-09.md](docs/RHWP_0.9.0_UPGRADE_2026-11-09.md)).
   편집기 패치(`studio/build/patches.mjs`)는 upstream 판을 `'0.9.0'` 으로 가려 고르므로 함께 고칩니다(맞는 자리가 없으면 빌드가 멈춰 알려 줍니다).
4. 결과의 빌드용 폴더를 다시 `vendor/rhwp` 로 복사한 뒤 위의 빌드·시험을 합니다.

엔진 Rust 시험(`cargo test`) 가운데 일부는 실제 문서로 만든 비공개 자료를 읽으므로 이 저장소에서는 컴파일되지 않습니다.

## 시험

```bash
npm test            # 단위·API·MCP 시험(임시 data 폴더·빈 포트, 모의 AI — 유료 API 를 부르지 않음)
```

화면 시험(`tests/ui_*.py`, Playwright)과 한/글 COM 시험은 해당 프로그램이 있어야 합니다.
실제 문서로 만든 조판 회귀 자료(한/글 PDF·쪽 그림 기준)는 저작권·개인정보 때문에 이 저장소에 넣지 않았습니다.

## 내 저장소로 가져가 고치기(VS Code)

1. GitHub 에서 이 저장소를 **Fork** 합니다.
2. VS Code → `Git: Clone` → 내 fork 주소. 위 '빠른 시작'대로 실행합니다.
3. 원래 저장소의 새 변경을 받으려면 GitHub 의 **Sync fork** 를 누르거나:
   ```bash
   git remote add upstream https://github.com/nagmint12/hwpxcowork.git
   git fetch upstream && git merge upstream/main
   ```
4. 프로젝트 작업 원칙은 `AGENTS.md`·`CLAUDE.md`(원 개발 환경 메모)에 있습니다.

## 라이선스

MIT — [`LICENSE`](LICENSE) (Copyright (c) 2026 nagmint12). 제3자 고지: [`NOTICE.md`](NOTICE.md).
제3자 구성 요소: rhwp(MIT, `vendor/rhwp/LICENSE`·`THIRD_PARTY*.md`), 편집기 글꼴(`studio/dist/fonts/FONTS.md` — 각 글꼴의 라이선스), npm 의존성(각 패키지 라이선스).
