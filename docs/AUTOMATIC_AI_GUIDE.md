# 내 PC의 AI로 요청 자동 처리 — Codex 실행기

2026-10-26 작성, 2026-11-13 개편(사용 설명서와 같은 우선순위). 웹에서 AI에게 맡긴 요청을 **내 PC의 구독 AI**가 바로 처리하게 하는 방법이다. 웹 설명서 `/help.html#agents`가 같은 내용을 그림과 복사 단추로 보여 준다.

## 고르는 순서

| 순서 | 방식 | 한 번 설정할 일 | 처리 | 비용 |
|---|---|---|---|---|
| ① 기본 | 내 PC의 구독 AI — Codex(ChatGPT 구독)·Claude Code(Claude 구독) | 토큰 저장(`setx`), MCP 등록(VS Code·CLI), 실행기 또는 채널 켜기 | 창을 켜 두면 새 요청을 바로 처리. VS Code 대화창에서는 “대기열을 처리해 줘” | 구독 사용량 안 — 추가 비용 없음 |
| ② 고급 | ChatGPT 웹(OAuth, 공개 https 주소 필요) | ChatGPT에 사용자 지정 MCP 서버 추가 | 대화에서 “대기열을 처리해 줘”라고 말할 때 | 구독 사용량 안 |
| ③ 선택 | API 키(문서 목록 **내 AI 키**) | 키 저장·연결 확인 | 서버가 요청자 키로 바로 처리. 설치 없음 | **유료** — 쓴 만큼 API 요금 |

Claude Code는 `claude auth login`으로 구독 로그인한 뒤 `start-claude-worker.bat` 또는 `npm.cmd run worker -- --provider claude-code`로 바로 처리한다(`--check`로 모델 호출 없이 점검). 실행기가 임시 MCP 연결을 준비하므로 사용자 MCP 등록·채널 설정은 필요하지 않다. [Claude Code 실행기·채널 안내](AGENT_SETUP.md)를 참고한다. 이 문서의 아래 절은 Codex 실행기를 다룬다. 관리자 전용 경로(공용 서버 AI, 개인 API 실행기의 제공업체 직접 설정)는 운영 매뉴얼에 있다. ChatGPT 이벤트 구독(MCP Events)·Work 예약 점검은 반응이 느리고 조직 권한상 막아 두어 안내하지 않는다(서버 기능은 남아 있음 — [MCP Events 안내](MCP_EVENTS_GUIDE.md)).

## Codex 실행기 — 한 번 설정

1. Node.js 22 이상과 Codex CLI(`npm.cmd install -g @openai/codex`)를 준비하고 `codex login`으로 본인 ChatGPT 계정에 로그인한다. `codex login status`가 ChatGPT 로그인이어야 한다(API 키 로그인은 이 경로에서 거절한다).
2. HWPX 토큰을 사용자 환경 변수에 한 번 저장한다. 새로 연 창부터 보이므로 터미널·VS Code를 다시 연다.

```powershell
setx HWPX_COWORK_TOKEN "내-토큰"
```

3. (VS Code·대화로도 쓰려면) Codex에 HWPX MCP 서버를 등록한다. Codex CLI와 VS Code 확장이 같은 `~/.codex/config.toml`을 쓴다. 토큰은 파일에 적지 않고 환경 변수 이름만 적힌다.

```powershell
codex mcp add hwpx --url "https://cowork.example.com/mcp?agent=Codex" --bearer-token-env-var HWPX_COWORK_TOKEN
```

주소는 웹 설명서에 이 서버의 실제 주소로 채워져 나온다. 등록한 뒤 Codex 대화창에서 “대기열을 처리해 줘”라고 하면 `claim_next_request`로 쌓인 요청을 오래된 순서로 처리한다(연결만으로 자동 실행되지는 않는다).

## 실행기 켜기 — 실시간 처리

프로그램 폴더가 있으면 그 폴더의 터미널에서 실행하고 창을 켜 둔다. 이 PC의 서버(localhost)에 붙고, 서버가 꺼져 있으면 먼저 켠다. 다른 PC의 서버면 `--url`로 주소를 준다.

```powershell
.\start-codex-agent.bat
.\start-codex-agent.bat --url "https://cowork.example.com/mcp"
```

프로그램 폴더가 없으면 웹 설명서에서 **실행기 ZIP**을 받아 풀고, 그 폴더에서 `npm.cmd install` 뒤 실행한다.

```powershell
$env:HWPX_COWORK_URL = "https://cowork.example.com/mcp"
npm.cmd run worker -- --provider codex --check
npm.cmd run worker -- --provider codex
```

- `--check`는 로그인·서버 계정·필수 도구·재시도 보호만 점검한다. 모델을 부르거나 문서를 읽거나 요청을 선점하지 않는다. `ready: true`, `connected: true`, `toolsReady: true`를 확인한다.
- 켜 두면 문서 화면의 보낼 곳에 **Codex로 보내기**가 보인다. 시작할 때 기존 대기 요청과 선점이 만료된 작업도 확인하고, 새 요청은 알림으로 바로 받는다(연결이 빠지면 30초 점검·재연결로 복구). 한 번에 한 요청씩, 본인 요청만 맡는다.
- 끌 때는 Ctrl+C. 그 뒤 요청은 대기열에서 기다린다. PC를 다시 켜면 실행기도 다시 켠다(시작 프로그램에 자동 등록하지 않는다). 한 사람은 실행기 하나만 켠다.

## 어떻게 처리하나

실행기는 새 요청 감지·선점·임대 갱신을 맡고, Codex가 MCP 도구로 직접 일한다: `get_request`·`list_memos`·`read_document`·`get_formatting`·`get_writing_guide`로 읽고, 글은 제안, 표는 `propose_table_edit`, 서식은 `propose_format`, 그림 교체는 `list_figures → export_figure → download_attachment_file → 작업 → upload_result_file → propose_figure`로 등록한 뒤 `complete_request`로 끝낸다. 본문 반영은 사람이 한다.

- 요청마다 현재 사용자 토큰과 선점 세션으로 MCP를 연결하고, 다른 문서·요청·시도의 변경과 본문 반영 도구는 막는다. 토큰은 환경 변수로만 MCP에 넘기며 명령줄·프롬프트·설정 파일에 쓰지 않는다. 사용자 `config.toml`의 다른 MCP 연결 대신 이 요청의 연결을 명시해 계정·선점이 섞이지 않게 한다.
- 그림·파일 작업은 임시 `work/in`·`work/out`에서 하고 끝나면 정리한다. ChatGPT 웹 대화창을 조작하거나 기존 대화의 문맥·메모리를 이어받지 않는다. ChatGPT 로그인 토큰은 HWPX 서버로 보내지 않는다.
- Codex 실행은 그 계정의 조직 정책과 사용 한도를 따른다. 공식 근거: [Codex 비대화형 실행](https://developers.openai.com/codex/noninteractive), [ChatGPT 로그인](https://developers.openai.com/codex/auth).

## 모델·추론 강도

문서 목록의 **AI 모델·추론 강도**에서 정하면 요청마다 그 값이 우선한다. 실행할 때 `--model "계정에서-허용된-모델-ID"`로 정할 수도 있고, 둘 다 없으면 Codex 기본 모델이다. CLI를 찾지 못하면 `--codex-command "C:/설치경로/codex.exe"` 또는 `HWPX_COWORK_CODEX_COMMAND`(셸 명령이 아니라 실행 파일 경로).

관리자 계정의 Codex 실행기는 기본으로 **Codex가 자동 선택**(2026-11-06): 요청마다 판단용 Codex가 작업 모델·추론 강도를 고르고, `codex debug models` 목록과 대조한 뒤 적용한다. 판단 단계(최대 45초, 문서·명령 도구와 HWPX 토큰 없음)도 사용량에 들어간다. 목록 조회·판단·검증이 실패하면 정한 값으로 이어 간다. 체크를 끄면 수동 설정. 관리자 외 계정과 멀티에이전트 프로필은 기존 방식이다.

## 실패와 복구

로그인 만료·설치 누락·사용 불가처럼 실행 자체의 오류가 나면 지금 요청을 실패로 알리고 실행기를 멈춰 남은 대기열을 지킨다. 로그인·권한·모델을 확인하고 실행기를 다시 켠 뒤 실패한 요청의 **다시**를 누른다. 최종 답변에 완료라고 써도 MCP에 완료 등록이 없으면 실패다. 첨부를 읽지 못했거나 결과 파일을 저장하지 못해도 성공으로 표시하지 않는다.

## 서버 PC에서 창 없이 켜 두기(관리자)

서버의 `config.json`을 읽을 수 있는 로컬 운영자는 아래 명령을 쓴다. `--user`는 HWPX에 등록된 본인 이름이고, 토큰은 설정에서 메모리로만 읽는다. 원격 참여자는 위의 실행기 ZIP을 쓴다.

```powershell
node scripts/local-chatgpt.mjs check --user "내 이름"
node scripts/local-chatgpt.mjs start --user "내 이름"
node scripts/local-chatgpt.mjs status --user "내 이름"
node scripts/local-chatgpt.mjs stop --user "내 이름"
```

`start`는 숨은 실행기를 시작하고(이미 있으면 다시 띄우지 않음), `stop`은 그 실행기만 멈춘다. 상태와 진단 로그는 `artifacts/local-chatgpt-worker/`에 남고 토큰은 저장하지 않는다. CLI 경로가 필요하면 `check`·`start`에 `--codex-command`를 더한다.

## 대화로 처리하기(설치 없이)

HWPX를 연결한 Codex·Claude Code 대화창, 또는 ② ChatGPT 웹 대화에서 “대기열을 처리해 줘”라고 하거나 설명서의 처리 프롬프트를 붙여 넣는다. `claim_next_request`가 none을 돌려줄 때까지 오래된 순서로 처리한다. 말할 때만 처리하므로, 바로 처리가 필요하면 실행기나 채널을 켜 둔다.

## 연결 상태 읽기

`GET /api/automation/status`(설명서의 **내 연결 상태 확인**)는 인증 사용자 기준 채널·서버 AI·대기열 상태를 읽기 전용으로 준다. 토큰, 콜백 URL·서명 키, 남의 요청 원문이나 세션 ID는 주지 않는다.

- 채널 연결: 실행기나 Claude 채널이 알림을 받을 연결을 유지한다는 뜻이다. 실제 처리 성공은 요청 완료 상태로 본다.
- 서버 AI 사용 가능: 구성된 서버 AI를 고를 수 있다는 뜻이다. 실제 키·모델 응답까지 검증한 상태는 아니다.
- 자동 처리 미설정: 자동 경로가 없다. 요청은 대기열에 두고 ①~③ 중 하나로 처리한다.

## 그 밖의 실행기

개인 API 실행기(`--provider openai|anthropic|gemini --model …`)는 그 제공자의 API 키가 필요하고 **유료**다(운영 매뉴얼 §7). 예전 `--provider chatgpt` 별칭은 OpenAI API를 뜻하므로 ChatGPT 구독 로그인에는 `--provider codex`를 쓴다. Gemini CLI·Antigravity CLI는 `--provider gemini-cli`·`--provider antigravity`(실행기 ZIP의 README).
