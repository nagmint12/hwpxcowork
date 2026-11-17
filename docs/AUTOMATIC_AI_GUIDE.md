# 내 PC의 AI로 요청 자동 처리 — Codex 실행기

새 설치에는 Windows에서 `.\scripts\setup-user.bat --mode personal --ai codex --install-cli --start` 한 줄을 권합니다. `shared`는 공동 서버 운영, `claude-code`는 Claude 구독, `none`은 AI 없는 편집입니다. Node·의존성·공식 CLI 준비, 새 설정·무작위 토큰 생성, 서버와 별도 실행기 시작을 돕습니다. 본인 구독 로그인·동의는 직접 완료하고 같은 명령을 다시 실행합니다. 설정은 설치 폴더의 `userdata-personal`/`userdata-shared`, CLI는 `.hwpx-tools`에 두며 전역 설정과 기존 운영 데이터를 바꾸지 않습니다. `--status`로 확인하고 `--stop`으로 이 설치만 끕니다. 구독을 확인하지 못하면 AI 연결을 보류하며 유료 API로 바꾸지 않습니다. 자세한 설치 선택은 [연결 안내](AGENT_SETUP.md#새-설치--두-가지-선택으로-시작)를 보세요. 아래 토큰·MCP 수동 설정은 기존 서버에 참여하거나 대화창을 별도로 연결할 때 사용합니다.

2026-10-26 작성, 2026-11-13 개편(사용 설명서와 같은 우선순위). 웹에서 AI에게 맡긴 요청을 **내 PC의 구독 AI**가 바로 처리하게 하는 방법이다. 웹 설명서 `/help.html#agents`가 같은 내용을 그림과 복사 단추로 보여 준다.

## 고르는 순서

| 순서 | 방식 | 한 번 설정할 일 | 처리 | 비용 |
|---|---|---|---|---|
| ① 기본 | 내 PC의 구독 AI — Codex(ChatGPT 구독)·Claude Code(Claude 구독) | 토큰 저장(`setx`), MCP 등록(VS Code·CLI), 실행기 또는 채널 켜기 | 창을 켜 두면 새 요청을 바로 처리. VS Code 대화창에서는 “대기열을 처리해 줘” | 구독 사용량 안 — 추가 비용 없음 |
| ② 고급 | ChatGPT 웹(OAuth, 공개 https 주소 필요) | ChatGPT에 사용자 지정 MCP 서버 추가 | 대화에서 “대기열을 처리해 줘”라고 말할 때 | 구독 사용량 안 |
| ③ 선택 | API 키(문서 목록 **내 AI 키**) | 키 저장·연결 확인 | 서버가 요청자 키로 바로 처리. 설치 없음 | **유료** — 쓴 만큼 API 요금 |

Claude Code는 `claude auth login`으로 구독 로그인한 뒤 Windows 앱의 [AI → 실행기 관리…] 또는 `npm.cmd run worker -- --provider claude-code`로 바로 처리한다(`--check`로 모델 호출 없이 점검). 실행기가 임시 MCP 연결을 준비하므로 사용자 MCP 등록·채널 설정은 필요하지 않다. [Claude Code 실행기·채널 안내](AGENT_SETUP.md)를 참고한다. 이 문서의 아래 절은 Codex 실행기를 다룬다. 관리자 전용 경로(공용 서버 AI, 개인 API 실행기의 제공업체 직접 설정)는 운영 매뉴얼에 있다. ChatGPT 이벤트 구독(MCP Events)·Work 예약 점검은 반응이 느리고 조직 권한상 막아 두어 안내하지 않는다(서버 기능은 남아 있음 — [MCP Events 안내](MCP_EVENTS_GUIDE.md)).

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

주소는 웹 설명서에 이 서버의 실제 주소로 채워져 나온다. 등록한 뒤 Codex 대화창에서 “대기열을 처리해 줘”라고 하면 인자 없는 `task`로 쌓인 요청을 오래된 순서로 처리한다(연결만으로 자동 실행되지는 않는다). 2026-11-17부터 `/mcp`의 기본은 새 연결(v2 — `task`·`read`·`edit`·`finish`)이다. 예전 도구(`claim_next_request` 등)가 필요하면 주소에 `&v=1`을 붙인다(`…/mcp?agent=Codex&v=1`).

## 실행기 켜기 — 실시간 처리

**Windows 앱(0.6.0부터, 권장).** 메뉴 **[AI → 실행기 관리…]**에서 실행기를 더한다. AI는 Codex, 서버는 '이 앱의 서버' 또는 '다른 서버'(주소 + 내 토큰 — 그 서버에 물어 확인하고, 인터넷 주소는 https 만 받는다)를 고르고 켠다. 상태(준비·연결됨·처리 중·대기·오류·꺼짐)와 최근 기록이 창에 보이고, 앱을 켤 때 자동 시작할 수 있다. 실행기가 뜻하지 않게 꺼지면 앱이 간격을 늘려 가며(5초·15초·45초·2분·5분) 다시 띄운다. 이 PC에 서버가 필요 없으면 앱 처음 실행에서 **AI 실행기만**을 고른다(문서는 그 서버의 웹 화면에서 연다). 다른 서버의 토큰은 Windows 사용자 계정으로 암호화해 이 PC에만 둔다.

**명령줄.** 프로그램 폴더(또는 웹 설명서에서 받은 **실행기 ZIP**을 풀고 `npm.cmd install` 한 폴더)의 터미널에서 실행하고 창을 켜 둔다. 이 PC의 서버(`http://localhost:8787/mcp`)면 `HWPX_COWORK_URL` 줄을 뺀다.

```powershell
$env:HWPX_COWORK_URL = "https://cowork.example.com/mcp"
npm.cmd run worker -- --provider codex --check
npm.cmd run worker -- --provider codex
```

예전 `start-codex-agent.bat`은 2026-11-17에 지웠다(앱의 실행기 관리 또는 위 명령이 대신한다). 프로그램 폴더에서는 `npm.cmd run agent:codex`(= `scripts/codex-agent.mjs`)도 같은 Codex 실행기를 띄운다 — AI 협업(멀티에이전트) 큐까지 처리하려면 `HWPX_COWORK_ORCHESTRATION=1`(기본 꺼짐). 실행기는 새 MCP 연결(v2)이 기본이고, `--mcp 1`(또는 `HWPX_COWORK_MCP=1`)이면 예전 연결이다. 아직 새 연결을 모르는 옛 중앙 서버에 붙으면 시작 점검에서 멈추고 `--mcp 1`을 알린다.

- `--check`는 로그인·서버 계정·필수 도구·재시도 보호만 점검한다. 모델을 부르거나 문서를 읽거나 요청을 선점하지 않는다. `ready: true`, `connected: true`, `toolsReady: true`를 확인한다.
- 켜 두면 문서 화면의 보낼 곳에 **Codex로 보내기**가 보인다. 시작할 때 기존 대기 요청과 선점이 만료된 작업도 확인하고, 새 요청은 알림으로 바로 받는다(연결이 빠지면 30초 점검·재연결로 복구). 한 번에 한 요청씩, 본인 요청만 맡는다.
- 끌 때는 Ctrl+C. 그 뒤 요청은 대기열에서 기다린다. PC를 다시 켜면 실행기도 다시 켠다(시작 프로그램에 자동 등록하지 않는다). 한 사람은 실행기 하나만 켠다.

## 어떻게 처리하나

실행기는 새 요청 감지·선점·임대 갱신을 맡고, Codex가 MCP 도구로 직접 일한다. 새 연결(기본)이면 `task`로 받은 요청 내용(지시·대상·문서 얼개·주변 글)으로 충분할 때 바로, 모자라면 `read`로 필요한 범위만 읽고, 글·표·서식·그림 결과를 `edit`의 ops로 한 번에 내며 `done`(공유 요약)으로 끝낸다(쓰기 없이 끝내면 `finish`). 예전 연결(`--mcp 1`)이면 `get_request`·`list_memos`·`read_document`·`get_formatting`·`get_writing_guide`로 읽고, 글은 제안, 표는 `propose_table_edit`, 서식은 `propose_format`, 그림 교체는 `list_figures → export_figure → download_attachment_file → 작업 → upload_result_file → propose_figure`로 등록한 뒤 `complete_request`로 끝낸다. 본문 반영은 사람이 한다.

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

`start`는 숨은 실행기를 시작하고(이미 있으면 다시 띄우지 않음), `stop`은 그 실행기만 멈춘다. 상태와 진단 로그는 `artifacts/local-chatgpt-worker/`에 남고 토큰은 저장하지 않는다. CLI 경로가 필요하면 `check`·`start`에 `--codex-command`를 더한다. 이 실행기도 2026-11-17부터 새 MCP 연결(v2)이 기본이며, 예전 연결은 `HWPX_COWORK_MCP=1`을 정한 창에서 `start`한다.

## 대화로 처리하기(설치 없이)

HWPX를 연결한 Codex·Claude Code 대화창, 또는 ② ChatGPT 웹 대화에서 “대기열을 처리해 줘”라고 하거나 설명서의 처리 프롬프트를 붙여 넣는다. 인자 없는 `task`(예전 연결 `?v=1`이면 `claim_next_request`)가 none을 돌려줄 때까지 오래된 순서로 처리한다. 말할 때만 처리하므로, 바로 처리가 필요하면 실행기나 채널을 켜 둔다.

## 연결 상태 읽기

`GET /api/automation/status`(설명서의 **내 연결 상태 확인**)는 인증 사용자 기준 채널·서버 AI·대기열 상태를 읽기 전용으로 준다. 토큰, 콜백 URL·서명 키, 남의 요청 원문이나 세션 ID는 주지 않는다.

- 채널 연결: 실행기나 Claude 채널이 알림을 받을 연결을 유지한다는 뜻이다. 실제 처리 성공은 요청 완료 상태로 본다.
- 서버 AI 사용 가능: 구성된 서버 AI를 고를 수 있다는 뜻이다. 실제 키·모델 응답까지 검증한 상태는 아니다.
- 자동 처리 미설정: 자동 경로가 없다. 요청은 대기열에 두고 ①~③ 중 하나로 처리한다.

## 그 밖의 실행기

개인 API 실행기(`--provider openai|anthropic|gemini --model …`)는 그 제공자의 API 키가 필요하고 **유료**다(운영 매뉴얼 §7). 예전 `--provider chatgpt` 별칭은 OpenAI API를 뜻하므로 ChatGPT 구독 로그인에는 `--provider codex`를 쓴다. Gemini CLI·Antigravity CLI는 `--provider gemini-cli`·`--provider antigravity`(실행기 ZIP의 README).
