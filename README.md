# hwpx-cowork — 한/글(HWPX) 문서 공동 검토·편집 서버

여러 사람이 같은 HWPX 문서를 **웹 편집기**에서 함께 고치고, 각자 연결한 **AI(ChatGPT·Claude·Gemini·Codex 등)** 가
MCP 로 문서를 읽고 **제안·메모**를 남기는 도구입니다. 파일 자체가 원본이라 한/글에서 열어도 메모와 변경 내용이 그대로 보입니다.

- 웹 편집기: [rhwp](https://github.com/edwardkim/rhwp)(Rust/WASM HWP·HWPX 엔진, MIT) v0.9.0 을 바탕으로 한/글 2022 동작에 맞춰 고친 엔진 + 협업 플러그인
- 실시간 공동 편집·변경 추적(한/글 "변경 내용")·메모 스레드·변경 요청(승인 방식)·문서함 권한
- AI 연결: 내 PC의 구독 Codex·Claude Code로 바로 처리(MCP), ChatGPT 앱 연결(선택·고급), API 키(사용료 별도). 서버가 곧 MCP 서버(`/mcp`, OAuth 2.1 지원) — 기본은 작업 도구 넷(`task`·`read`·`edit`·`finish`)의 새 연결(v2)이고, 예전 연결은 `/mcp?v=1`
- 표·차트·그림·차례·쪽 구성 제안, 한/글로 복사·붙여넣기(설치 없이 문서 모델 전달), 튜토리얼

## 설치 — 두 가지 길

| 이런 분 | 설치 방법 |
|---|---|
| 프로그램을 처음 쓰고, 클릭만으로 설치하고 싶은 분 | **[1. Windows 앱 설치 파일](#1-windows-앱-설치-파일--클릭해서-설치)** — 설치 마법사 → 바탕화면 아이콘 |
| VS Code에서 Codex(ChatGPT)·Claude Code를 쓰는 분 | **[2. VS Code 에이전트에게 맡기기](#2-vs-code-에이전트에게-맡기기--codex--claude-code)** — 문장 하나를 붙여넣으면 에이전트가 설치 |

두 길 모두 AI는 **본인 구독(ChatGPT·Claude) 로그인**으로 연결합니다. API 키나 별도 요금이 필요 없고, 로그인·동의는 본인이 직접 합니다.

Windows 앱이나 GitHub에서 개인 서버 또는 공동 서버를 설치한 뒤 **문서함 → 튜토리얼**에서 실습을 시작할 수 있습니다. **소개 영상**을 누르면 두 편이 이어서 재생됩니다. 실습의 AI 요청은 준비된 예시 응답으로 체험할 수 있습니다.

### 1. Windows 앱 설치 파일 — 클릭해서 설치

Windows 10·11(64비트)용입니다. 관리자 권한이 필요 없습니다.

1. 이 저장소의 **Releases**에서 `HwpxCowork-Setup-<판>.exe`를 받습니다.
2. 받은 파일을 두 번 누릅니다. **"Windows의 PC 보호"** 창이 뜨면 **[추가 정보] → [실행]**을 누릅니다.
   이 설치 파일에는 아직 코드 서명 인증서가 없어서 Windows가 처음 보는 프로그램으로 알리는 것입니다.
3. 설치 마법사에서 **[다음] → [설치] → [마침]**을 누릅니다. 바탕화면과 시작 메뉴에 **Hwpx Cowork** 아이콘이 생깁니다.
4. 처음 실행하면 사용 방식을 고릅니다.
   - **혼자 쓰기**: 이 PC의 한글 문서를 혼자 열고 고칩니다. 메뉴 **[파일 → 문서 폴더 연결]**로 PC 폴더를 연결합니다.
   - **여러 사람과 함께 쓰기**: 이 PC가 공동 작업 서버가 됩니다. 메뉴 **[함께 쓰기 → 참여자 관리]**에서 참여자를 추가합니다.
     다른 PC에서 들어오게 하려면 **[함께 쓰기 → 외부 접속 열기]**를 누릅니다(Cloudflare 무료 임시 주소, 계정 불필요, 앱을 켜 둔 동안만 열림).
   - **AI 실행기만**: 이 PC에 서버를 두지 않고, 이미 있는 서버(공동 작업 서버 등)에 내 구독 AI만 연결합니다.
     문서는 그 서버의 웹 화면에서 엽니다(기본 브라우저).
5. AI를 쓰려면 메뉴 **[AI → 실행기 관리…]**에서 **실행기를 더합니다**(0.6.0부터 — 예전 [AI → ChatGPT·Claude 연결]을 대신합니다).
   - **AI**: Codex(ChatGPT 구독)·Claude Code(Claude 구독)·Gemini CLI·Antigravity(Google 계정) 가운데 고릅니다.
     Codex·Claude Code는 처음 한 번 공식 연결 프로그램을 자동으로 받고(인터넷 필요), 브라우저에서 본인 계정으로 로그인합니다.
   - **서버**: '이 앱의 서버' 또는 '다른 서버'(서버 주소 + 내 토큰). 다른 서버의 토큰은 그 서버에 물어 확인하며(체험 계정은 받지 않음),
     인터넷 주소는 `https://`만 받습니다. 토큰은 Windows 사용자 계정으로 암호화해 이 PC에만 둡니다.
   - 실행기마다 켜기·끄기, 상태(준비·연결됨·처리 중·대기·오류·꺼짐), 최근 기록, 앱을 켤 때 자동 시작을 정합니다.
     연결 방식은 새 연결(v2)이 기본이고, 고급 설정에서 예전 연결(v1)을 고를 수 있습니다.
   - 실행기가 뜻하지 않게 꺼지면 앱이 간격을 늘려 가며(5초·15초·45초·2분·5분) 다시 띄웁니다.

창을 닫으면 저장을 마친 뒤 함께 꺼집니다. 방식은 **[Hwpx Cowork → 운영 방식 바꾸기]**로 바꾸며, 방식마다 문서·설정은 따로 보관됩니다.
지우려면 **설정 → 앱 → Hwpx Cowork → 제거**를 누릅니다. 문서 기록과 설정(`%APPDATA%\Hwpx Cowork`)은 남습니다.

설치 파일 만들기(개발자): `node scripts/package-windows-desktop.mjs` → `artifacts/windows-desktop-<날짜>/installer/`.

### 2. VS Code 에이전트에게 맡기기 — Codex · Claude Code

명령어를 직접 칠 필요가 없습니다. 에이전트가 이 저장소의 `AGENTS.md`(8절)를 읽고 설치 도우미를 실행합니다.
Windows·macOS·Linux 모두 됩니다. Node.js가 없으면 Windows에서는 도우미가 공식 Node를 설치 폴더 안에 받습니다.

**준비**: VS Code에 Codex 또는 Claude Code 확장을 설치하고 로그인합니다.

**설치**: 비어 있는 새 폴더를 VS Code로 열고(**파일 → 폴더 열기**), Codex나 Claude Code 대화창에 아래 문장을 붙여넣습니다.
`[ ]` 안의 두 선택만 바꾸세요.

```text
https://github.com/nagmint12/hwpxcowork 저장소를 이 폴더에 받아서 hwpx-cowork를 설치하고 켜 줘.
운영 방식은 [개인 서버 / 공동 서버], AI는 [ChatGPT 구독(Codex) / Claude 구독(Claude Code) / AI 없음]이야.
AGENTS.md 8절의 설치 도우미를 그대로 써 줘. 이 폴더 밖의 설정·전역 CLI 설정·환경 변수는 바꾸지 마.
구독 로그인이 필요하면 내가 직접 할 명령만 알려 주고, 내가 로그인한 뒤 같은 설치 명령으로 연결을 확인해 줘.
API 키로 바꾸거나 모델을 시험 호출하지 마. 끝나면 열 주소와, 서버·AI 연결이 각각 됐는지 알려 줘.
```

이미 저장소를 받아 둔 폴더라면 첫 줄을 `이 폴더에 hwpx-cowork를 설치하고 켜 줘.`로 바꿉니다.

**설치한 뒤에는 이렇게 말하면 됩니다.**

| 하고 싶은 일 | 에이전트에게 |
|---|---|
| 켜기 | `hwpx-cowork 켜 줘` |
| 끄기 | `hwpx-cowork 꺼 줘` |
| 상태 보기 | `hwpx-cowork 상태 알려 줘` |
| AI 바꾸기 | `hwpx-cowork AI를 Claude 구독으로 바꿔 줘` |
| 최신 판으로 | `hwpx-cowork를 GitHub 최신 판으로 업데이트하고 다시 켜 줘` |
| 안 켜질 때 | `hwpx-cowork가 안 켜져. 로그를 보고 원인을 찾아 줘` |

<details>
<summary>에이전트가 실제로 실행하는 명령(직접 하고 싶을 때)</summary>

```powershell
# Windows — 프로그램 폴더에서
.\scripts\setup-user.bat --mode personal --ai codex --install-cli --start   # 설치·켜기
.\scripts\setup-user.bat --mode personal --status                           # 상태
.\scripts\setup-user.bat --mode personal --stop                             # 끄기
```

```bash
# macOS·Linux — Node.js 22 이상
node scripts/setup-personal.mjs --mode personal --ai codex --install-cli --start
```

공동 서버는 `--mode shared`, Claude 구독은 `--ai claude-code`, AI 없이는 `--ai none`(이때 `--install-cli` 생략)입니다.
도우미는 npm 의존성, 선택한 공식 CLI(`.hwpx-tools/`), 무작위 관리자 토큰, 설정·기록을 설치 폴더 안에만 준비합니다. 시스템 PATH와 기존 CLI 설정은 바꾸지 않습니다.
업데이트(`git pull`) 뒤 같은 명령을 다시 실행하면 바뀐 의존성을 다시 설치합니다. 내용이 0으로 채워지는 식으로 손상된 라이브러리도 찾아 다시 설치합니다.
기본 주소는 `http://localhost:8790`(충돌하면 빈 포트)이고, 설정·기록은 `userdata-personal/`·`userdata-shared/`에 있습니다. `--no-window`를 붙이면 브라우저를 열지 않습니다.
</details>

**알아 둘 점**
- **"설치해 줘"만으로 로그인까지 끝나지는 않습니다.** CLI의 구독 로그인·동의는 본인이 직접 합니다. VS Code 확장에 로그인했다고 CLI까지 로그인된 것은 아닙니다.
- 설치 점검은 모델을 부르지 않습니다. 구독·조직 권한·사용량 제한은 실제 요청 때 적용됩니다.
- 공동 서버도 처음에는 이 PC에서만 열립니다. 관리자 화면에서 참여자를 추가하고, 외부 공유는 HTTPS·접속 정책을 따로 설정합니다(임시 주소는 프로그램 폴더에서 `npm run tunnel`). 연결한 구독 AI는 관리자 본인 요청만 처리하고, 참여자는 각자 본인 토큰과 구독으로 실행기를 연결합니다(아래 '내 구독 AI 연결하기').

## 내 구독 AI 연결하기

새로 설치한 경우에는 위 도우미·앱이 서버 주소와 토큰을 실행기에 전달하므로 아래 수동 등록은 필요하지 않습니다. 아래 절은 **기존 공유 서버에 참여하는 경우**의 연결입니다. 연결은 **① 내 PC의 구독 AI(기본) → ② ChatGPT 앱 연결(선택·고급) → ③ 내 AI 키(API, 사용료 별도)** 순서입니다.

**Windows 앱으로(권장)**: 설치 파일로 앱을 설치하고 처음 실행에서 **AI 실행기만**을 고릅니다(이미 다른 방식으로 쓰고 있으면 그대로 두어도 됩니다).
메뉴 **[AI → 실행기 관리…]**에서 실행기를 더하고 서버를 **'다른 서버'**로 골라 공동 작업 서버 주소와 내 개인 토큰을 적은 뒤 켭니다.

**명령줄로(Windows·macOS·Linux)**: 프로그램 폴더(`npm install` 을 마친 저장소)에서 개인 토큰을 한 번 저장합니다(Windows PowerShell 예).

```powershell
setx HWPX_COWORK_TOKEN "내-개인-토큰"
```

VS Code와 터미널을 완전히 닫았다 다시 엽니다. 설치한 AI의 구독 계정으로 로그인한 뒤 이 프로그램 폴더에서 실행합니다. 두 AI 중 쓰는 쪽 하나만 켜 두세요.

```powershell
# Codex — ChatGPT 구독
codex login
npm run worker -- --provider codex --url 'https://서버주소/mcp' --check
npm run worker -- --provider codex --url 'https://서버주소/mcp'
```

```powershell
# Claude Code — Claude 구독(최신 CLI)
claude auth login
npm run worker -- --provider claude-code --url 'https://서버주소/mcp' --check
npm run worker -- --provider claude-code --url 'https://서버주소/mcp'
```

이 PC의 서버(`http://localhost:8787/mcp`)면 `--url` 을 뺍니다. Windows PowerShell 이 `npm` 실행을 막으면 `npm.cmd run worker …` 로 씁니다. macOS·Linux 는 `export HWPX_COWORK_TOKEN=…` 뒤 같은 명령입니다. 실행기는 새 MCP 연결(v2)이 기본이고, 아직 새 연결을 모르는 옛 서버에는 `--mcp 1`(예전 연결)을 붙입니다. 구독 사용 한도 안에서 처리하고 별도 API 요금은 없습니다. 실행기가 MCP 연결을 준비하므로 대화창용 MCP 등록은 생략해도 됩니다. 웹에서 글을 골라 **AI에게 맡기기**로 보내면 제안이 돌아오고, 반영은 사람이 합니다.

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
| `deploy/desktop/` | Windows 앱(Electron 창 — 서버·편집기·AI 실행기 관리·외부 접속). 설치 파일은 `scripts/package-windows-desktop.mjs` |
| `agent/` | Claude Code 채널 에이전트 작업 공간 본보기(새 연결 지침 `CLAUDE.md`, 예전 연결 지침 `v1/CLAUDE.md`) |
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
2. VS Code → `Git: Clone` → 내 fork 주소. 위 '2. VS Code 에이전트에게 맡기기'대로 에이전트에게 설치를 맡깁니다.
3. 원래 저장소의 새 변경을 받으려면 GitHub 의 **Sync fork** 를 누르거나:
   ```bash
   git remote add upstream https://github.com/nagmint12/hwpxcowork.git
   git fetch upstream && git merge upstream/main
   ```
4. 프로젝트 작업 원칙은 `AGENTS.md`·`CLAUDE.md`(원 개발 환경 메모)에 있습니다.

## 라이선스

MIT — [`LICENSE`](LICENSE) (Copyright (c) 2026 nagmint12). 제3자 고지: [`NOTICE.md`](NOTICE.md).
제3자 구성 요소: rhwp(MIT, `vendor/rhwp/LICENSE`·`THIRD_PARTY*.md`), 편집기 글꼴(`studio/dist/fonts/FONTS.md` — 각 글꼴의 라이선스), npm 의존성(각 패키지 라이선스).

### 한글과컴퓨터 권리 고지

본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. [한컴 HWP·OWPML 문서 형식 공개](https://www.hancom.com/support/downloadCenter/hwpOwpml)

한컴오피스 한/글 프로그램의 저작권은 주식회사 한글과컴퓨터(Hancom Inc.)에 있습니다. [한/글 사용권](https://help.hancom.com/hoffice/multi/ko_kr/hwp/rights/rights.htm)

‘한글’, ‘한컴’, ‘HWP’, ‘HWPX’는 주식회사 한글과컴퓨터의 상표입니다. HWPX는 OWPML(KS X 6101)을 따르는 개방형 문서 형식입니다. [한컴의 HWPX 형식 설명](https://tech.hancom.com/hwpxformat/)
