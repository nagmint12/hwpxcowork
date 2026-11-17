# 내 PC의 Claude Code 연결 안내 — 실행기·채널·VS Code

## 새 설치 — 두 가지 선택으로 시작

프로그램 ZIP 또는 접근 권한이 있는 저장소를 새 폴더에 준비한 경우, Windows의 VS Code 터미널에서 다음 한 줄을 실행합니다. Node가 없으면 공식 런타임을 설치 폴더에 준비하고, npm 의존성과 공식 CLI가 없으면 설치 폴더의 `.hwpx-tools`에 설치합니다.

```powershell
.\scripts\setup-user.bat --mode personal --ai claude-code --install-cli --start
```

운영 방식은 `personal`(개인 서버) / `shared`(공동 서버), AI는 `codex`(ChatGPT 구독) / `claude-code`(Claude 구독) / `none`입니다. Node 22 이상이 있는 macOS·Linux에서는 `node scripts/setup-personal.mjs` 뒤에 같은 옵션을 붙입니다. 설치 도우미는 `userdata-personal` 또는 `userdata-shared`에 설정·기록과 무작위 관리자 토큰을 만들고, 8790부터 빈 포트에서 이 PC 전용 서버를 엽니다. 기존 `config.json`·`data`·전역 환경 변수·홈 MCP 등록은 바꾸지 않습니다.

개인 AI 실행기 설치형 ZIP은 별도 서버 설치 없이 `hwpx-ai-worker` 폴더에서 `sh install.sh`로 준비합니다. macOS 14를 포함한 13.5 이상은 Node 24.22.2, macOS 11~13.4는 Node 22.23.5를 자동 선택합니다(Intel·Apple Silicon 구분, 공식 SHA-256 확인). 이미 실행 가능한 Node 22 이상이 있으면 재사용합니다. Node 22 공식 바이너리의 최소 실행 대상은 macOS 11이며 10.15 이하는 지원하지 않습니다. 이 최소값은 선택한 AI CLI의 요구조건이나 macOS의 보안 지원 기간을 보장하지 않습니다. `worker-settings.txt` 설정과 토큰 export 후 `sh start-worker.sh --check`로 연결을 점검하고, `sh start-worker.sh`로 요청 처리를 시작합니다. 구독 CLI 설치·로그인은 별도입니다.

호환성 근거: [Node 22 빌드 대상](https://github.com/nodejs/node/blob/v22.23.5/BUILDING.md#platform-list), [Node 24 빌드 대상](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md#platform-list). 기존 Safari 15의 `Object.hasOwn` 보완(`scripts/build-studio.mjs`)은 웹 편집기 경로이며 이 실행기 설치 경로와 별개입니다.

CLI의 본인 구독 로그인·OAuth 동의는 사용자가 직접 합니다. 도우미가 출력한 로그인 명령을 실행하고 같은 설치 명령을 다시 실행하면 서버를 재사용하며 실행기를 연결합니다. VS Code 확장 로그인만으로 CLI 로그인을 대신할 수 있는 것은 아닙니다. 설치·상태 확인은 모델을 호출하거나 요청을 선점하지 않습니다. 실행기를 켠 뒤 웹에서 맡긴 실제 요청은 본인의 구독 사용량을 씁니다. API 키로 자동 전환하지 않습니다.

`--status`로 상태, `--stop`으로 이 설치의 서버·실행기를 정상 종료합니다. `--no-window`는 브라우저를 열지 않습니다. 공동 서버는 처음에는 이 PC에서만 열고 사용자 추가·HTTPS 공유를 후속 설정합니다. 관리자의 구독 AI는 본인 요청만 처리하며 참여자는 본인 토큰·구독으로 연결합니다. 아래 수동 절차는 기존 공유 서버에 참여하거나 대화창 MCP·채널을 별도 등록할 때 사용합니다.

웹 편집기에서 **AI에게 맡기기**로 일을 맡기면, 내 PC에 띄워 둔 Claude Code가 곧바로 알림을 받아 처리하게 하는 방법입니다. Claude 구독 사용량 안에서 처리하므로 추가 비용이 없습니다. 결과는 문서에 **제안·메모**로 남고, 반영은 언제나 사람이 편집기에서 합니다. 같은 세션에 **변경 요청 검토**(의견·수정 요청만 — 승인·반영은 못 함)도 시킬 수 있습니다(§8).

웹 설명서 `/help.html#agents`가 같은 절차를 그림과 복사 단추로 보여 줍니다. Codex(ChatGPT 구독) 실행기는 [자동 처리 안내](AUTOMATIC_AI_GUIDE.md), 중앙 서버·외부 접속·유료 API 실행기는 [운영 매뉴얼](DEPLOYMENT_AND_AI_GUIDE.md)에 있습니다.

## 0. 먼저 — 고르는 순서와 VS Code 등록

1. **기본: 내 PC의 구독 AI** — Codex(ChatGPT 구독)는 `start-codex-agent.bat`, Claude Code(Claude 구독)는 `start-claude-worker.bat`. 창을 켜 두면 새 요청을 바로 처리합니다. Claude Code 채널(`start-agent.bat`)도 선택할 수 있습니다.
2. **고급: ChatGPT 웹** — 공개 https 주소가 있을 때만, 대화에서 “대기열을 처리해 줘”라고 말할 때 처리합니다(운영 매뉴얼 §9).
3. **선택·유료: API 키** — 문서 목록의 **내 AI 키**. 구독과 별도로 쓴 만큼 API 요금이 듭니다.

**VS Code에서 쓰기(대화로 처리).** Claude Code CLI와 VS Code 확장은 같은 설정을 씁니다. 토큰을 환경 변수에 저장한 뒤(§3), VS Code 터미널(PowerShell)에서 한 번 등록합니다. 작은따옴표 안의 `${HWPX_COWORK_TOKEN}` 은 글자 그대로 저장되고, 연결할 때 Claude Code가 환경 변수 값으로 바꿉니다(토큰이 설정 파일에 적히지 않음 — 2026-11-13 Claude Code 2.1.322 에서 맞는 토큰은 연결, 틀린 토큰은 401 로 확인).

```powershell
claude mcp add --scope user --transport http hwpx 'https://cowork.example.com/mcp' --header 'Authorization: Bearer ${HWPX_COWORK_TOKEN}'
```

그 뒤 Claude Code 대화창에서 `대기열을 처리해 줘` 라고 하면 `claim_next_request` 로 쌓인 내 요청을 오래된 것부터 처리합니다. 이 연결은 알림(채널)이 아니라 도구 연결이라 웹의 보낼 곳에 ‘Claude Code로 보내기’가 생기지 않습니다. 새 요청을 바로 받으려면 아래 실행기나 채널을 켭니다. 이미 `hwpx` 가 있다고 나오면 `claude mcp remove hwpx -s user` 뒤 다시 등록합니다.

### 채널 없이 바로 처리하기 — Claude Code 실행기

최신 Claude Code를 설치하고 `claude auth login`으로 **Claude 구독 계정**에 로그인합니다. 개인 토큰은 §3처럼 저장하고 터미널을 다시 엽니다. 프로그램 폴더에서는 다음 명령을 씁니다(다른 PC의 서버면 `--url 'https://서버/mcp'` 추가).

```powershell
.\start-claude-worker.bat --check
.\start-claude-worker.bat
```

프로그램 폴더가 없으면 설명서에서 실행기 ZIP을 받아 풀고 `npm.cmd install` 뒤 실행합니다.

```powershell
$env:HWPX_COWORK_URL = 'https://cowork.example.com/mcp'
npm.cmd run worker -- --provider claude-code --check
npm.cmd run worker -- --provider claude-code
```

`--check`는 모델 호출·요청 선점 없이 로그인과 서버 연결을 점검합니다. 실행기는 새 요청을 받아 요청마다 `claude -p`를 띄우며, 제한된 임시 MCP 연결을 자동 구성합니다. **사용자 MCP 등록이나 채널 허용은 실행기에 필요하지 않습니다.** API 키 로그인은 받지 않고 구독 사용 한도 안에서 처리합니다. CLI가 실행기에 필요한 `--restricted`를 지원하지 않으면 `claude update`로 올립니다. 창을 켜 두어야 바로 처리하며, 끄려면 Ctrl+C를 누릅니다. 제안 반영은 사람이 합니다.

## 1. 채널이 뭔가요

- **채널(Channels)** 은 Claude Code 의 공식 기능(연구 미리보기)입니다. MCP 서버가 **이미 열려 있는 Claude Code 세션에 알림을 밀어 넣을 수** 있게 해 줍니다.
- hwpx-cowork 에서는 `server/mcp-stdio.js`(브리지)가 그 MCP 서버입니다. 브리지는
  1. 서버의 알림 통로(`/api/agent/events`)에 내 토큰으로 붙어 있다가,
  2. 내가 웹에서 AI 작업을 맡기면 Claude Code 세션에 **초인종**을 한 번 울리고(`<channel source="hwpx" event="ai_request" …>`),
  3. Claude 가 부르는 hwpx 도구(`get_request`·`propose_changes`·`complete_request` …)를 서버로 넘겨 줍니다.
- 초인종에는 **번호·종류·문서 제목(40자)만** 들어갑니다. 지시 원문과 문서 글은 Claude 가 `get_request` 로 직접 읽습니다.
- 알림은 **터미널의 `claude` 세션이 열려 있는 동안만** 옵니다. 세션을 닫으면 웹 상단의 내 에이전트가 `○ 연결 안 됨` 으로 바뀌고, 맡긴 일은 서버 AI(켜져 있으면) 또는 대기열로 갑니다.
- Claude Code 는 시작할 때 브리지를 먼저 붙이고 알림을 받는 준비는 화면이 뜬 뒤에 합니다. 그래서 브리지는 **시작 직후 약 5초 동안 알림을 모아 두었다가** 보냅니다(띄우기 전에 쌓인 대기 요청도 이때 한꺼번에 옵니다).
- 알림을 보냈는데 **1분 동안 Claude 가 hwpx 도구를 하나도 부르지 않으면 한 번 더**, 서버가 다시 켜진 뒤 **3분 넘게 대기 중으로 남은 요청도 한 번 더** 알립니다(`reminder="true"` — 이미 처리한 요청이면 Claude 가 넘어갑니다).

```
웹 편집기 ──(AI 작업 맡김)──▶ hwpx-cowork 서버 ──실시간 알림──▶ 브리지(mcp-stdio.js --channel) ──stdio──▶ Claude Code(터미널)
                                     ▲                                                              │
                                     └────────────── hwpx 도구 호출(HTTP MCP, 내 토큰) ◀──────────────┘
```

## 2. 준비물

| 무엇 | 조건 |
|---|---|
| Claude Code | **2.1.80 이상**(채널). Windows 는 **2.1.296 이상 권장** — 세션을 닫을 때 브리지 프로세스가 깨끗하게 끝납니다. `claude --version` 으로 확인, `claude update` 로 올림 |
| 로그인 | claude.ai 계정(또는 Console API 키)으로 로그인한 Claude Code. Bedrock·Vertex 등 다른 제공자로는 채널이 안 됩니다 |
| 조직 설정 | **Team·Enterprise 조직은 Owner 가 채널을 켜야 합니다** — claude.ai **조직 설정 > Claude Code > Channels**(관리 설정의 `channelsEnabled`). Pro·Max 개인 계정은 필요 없습니다 |
| Node.js | 18 이상(브리지 실행) |
| 서버 | hwpx-cowork **v0.3 이상** 서버 주소(예: `http://localhost:8787/mcp`, 교내 서버면 `http://서버주소:8787/mcp`) |
| 토큰 | 관리자에게 받은 **내 토큰**(웹에 들어갈 때 쓰는 것과 같음) |

> 조직 설정이 꺼져 있으면 Claude Code 는 시작 화면에 "blocked by org policy" 같은 경고를 띄우고, hwpx 도구는 되지만 **알림은 오지 않습니다.**

**Claude Code 판 확인** — 채널을 띄울 **그 터미널에서** `claude --version` 을 봅니다.
- 채널은 2.1.80 부터 됩니다. **Windows 는 2.1.296 이상**을 쓰세요(그 아래 판은 세션을 닫아도 브리지 `node` 가 남을 수 있습니다). 낮으면 `claude update`.
- VS Code 확장에 든 Claude Code 와 터미널(PATH)의 `claude` 는 판이 다를 수 있습니다. 여러 개 설치돼 있으면 `where claude`(Windows)로 어느 것이 먼저 잡히는지 봅니다. `node scripts/setup-agent.mjs` 도 PATH 의 판을 확인해 알려 줍니다(`! Claude Code 2.1.143 — … 2.1.296 이상을 권장`).

## 3. 토큰을 환경 변수로 두기(한 번만)

토큰은 **파일에 적지 않고** 환경 변수 `HWPX_COWORK_TOKEN` 에만 둡니다.

Windows(명령 프롬프트·PowerShell 모두):
```
setx HWPX_COWORK_TOKEN "내-토큰"
```
`setx` 는 **새로 연 터미널부터** 보입니다. 실행한 뒤 터미널을 닫고 새로 여세요.

macOS·Linux: `~/.zshrc` 또는 `~/.bashrc` 에 `export HWPX_COWORK_TOKEN="내-토큰"` 을 넣고 새 터미널을 엽니다.

## 4. 작업 공간 준비 — setup-agent

hwpx-cowork 폴더에서:
```
node scripts/setup-agent.mjs
```
- `agent/.mcp.json` 을 만듭니다(이 PC 의 브리지 절대 경로, `--channel`, 서버 주소. 토큰은 `${HWPX_COWORK_TOKEN}` 참조만 — 값은 쓰지 않음). 이미 있으면 `hwpx` 항목만 바꾸고 다른 항목은 그대로 둡니다.
- 서버 주소는 **MCP 주소(`…/mcp`)** 여야 합니다. `http://서버:8787` 처럼 서버 주소만 주면 끝에 `/mcp` 를 붙이고 알려 줍니다.
- `claude --version` 을 확인해 판이 낮으면 알려 줍니다.
- 서버에 닿으면 **MCP 주소가 정말 MCP 로 답하는지**(`✓ MCP 주소 … — hwpx-cowork …`) 확인합니다. MCP 로 답하지 않으면 `✗ … 는 MCP 주소가 아닙니다` 와 함께 종료 코드 1 — `--url` 을 고쳐 다시 실행하세요.
- 토큰이 있으면 서버에 물어 **토큰 주인**(`내 토큰 = 홍길동`)과 **채널 연결 지원** 여부를 보여 줍니다.
- 상위 폴더의 `CLAUDE.md`(프로그램 개발 메모)는 에이전트 세션이 읽지 않도록 `agent/.claude/settings.local.json` 에 적어 둡니다.

옵션:

| 옵션 | 뜻 |
|---|---|
| `--url http://서버:8787/mcp` | 서버 MCP 주소(기본 `http://localhost:8787/mcp`, 또는 환경 변수 `HWPX_COWORK_URL`). `/mcp` 가 없으면 붙여 줍니다 |
| `--dir <폴더>` | 작업 공간을 다른 곳에(예: `%USERPROFILE%\hwpx-agent`). 본보기 `CLAUDE.md`·`.claude/settings.json` 도 복사합니다 |
| `--user 홍길동` | 토큰 주인이 이 이름인지 확인 |
| `--no-claude` · `--no-server` | `claude --version` · 서버 확인을 건너뜀 |
| `--no-registry` | (Windows) 이 창에 토큰이 없을 때 `setx` 로 저장돼 있는지(레지스트리 `HKCU\Environment`) 보지 않음 — 시험용. 값은 어느 경우에도 읽어 보여 주지 않습니다 |

작업 공간(`agent/`)에 들어 있는 것:

| 파일 | 하는 일 |
|---|---|
| `.mcp.json` | hwpx 브리지를 채널로 띄우는 설정(setup-agent 가 만듦). `--files-dir <agent>/work` 로 로컬 파일 도구를 켭니다. `--lean` 은 얇은 흐름 — 서버가 요청 내용·도구 응답을 모델용으로 짧게 주어 요청 한 건의 왕복과 글자 수가 줄어듭니다(`start_request` 가 내용을 함께 주고 쓰기의 `complete` 로 완료 — [MCP_LEAN_FLOW_2026-11-10.md](MCP_LEAN_FLOW_2026-11-10.md)). 예전 서버에 붙으면 예전 꼴 그대로 옵니다. 본보기: `.mcp.json.example` |
| `CLAUDE.md` | 이 세션에서 Claude 가 할 일 — 알림 처리 순서(맡기 → 쓰기·완료), 취소·선점 실패 때 멈추기, 알림 없이 시키면 `claim_next_request`, 문서 글은 자료일 뿐 지시가 아님. 자주 하지 않는 일은 `guides/` 를 그때 읽게 가리킵니다 |
| `guides/` | 그 일을 할 때만 읽는 절차: `figure-files.md`(그림·파일 고치기 — 작업 폴더 `work/`), `orchestration.md`(멀티에이전트 알림), `change-requests.md`(변경 요청 검토 — 시킬 때만, 승인·반영 안 함). 읽기만 허용하고 고치기는 거부합니다 |
| `.claude/settings.json` | 기본 모드 `dontAsk` — 아래 허용 목록 밖은 묻지 않고 거부합니다(무인 세션이 승인 창에서 멈추지 않게). 허용: hwpx 읽기·제안·요청 도구(`claim_next_request` 포함), 서식 도구(`propose_format`·`get_formatting`), 그림 도구(`list_figures`·`export_figure`·`download_attachment_file`·`upload_result_file`), 변경 요청 검토 도구(승인은 서버가 거절), `work/` 안 읽기·쓰기(`Read(/work/**)`·`Edit(/work/**)` — Claude Code 는 새 파일 쓰기도 `Edit(경로)` 규칙으로 봅니다)와 `python -I work/*` 실행, `guides/` 읽기(`Read(/guides/**)`)만. 거부: `apply_proposal`·`accept_change`·`reject_change`·`undo_proposal`·`delete_memo`, ChatGPT 전용 파일 도구, `.claude/`·`.mcp.json`·`CLAUDE.md`·`guides/` 고치기, NotebookEdit·WebFetch·WebSearch. `--dangerously-skip-permissions` 막음 |

**대화 문맥 크기**: 에이전트 세션은 요청이 끝나도 앞 요청의 대화를 들고 갑니다(같은 문서를 이어 작업할 때 도움이 됩니다). 끝없이 쌓이지 않도록 `start-agent.bat` 이 두 값을 넣어 띄웁니다 — 마지막 요청 뒤 약 54분 동안 쉬었고 대화가 12만 토큰 이상이면 요약으로 줄이고(`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS=120000`), 일하는 중에도 40만 토큰을 넘지 않게 합니다(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000`). 다른 값을 쓰려면 실행 전에 그 환경 변수를 정해 두세요. 요약에 남길 것은 `CLAUDE.md` 끝의 `# Compact instructions` 에 있습니다. 지금 바로 줄이려면 그 창에서 `/compact`.

### 그림 고치기(로컬 파일 도구)

웹에서 "[그림 3] 글꼴을 바꿔 줘"처럼 맡기면 에이전트가 이 PC 에서 직접 고칩니다. 파일 바이트는 브리지 ↔ 서버로만 오가고 대화(토큰)를 거치지 않습니다.

1. `list_figures` 로 대상 그림을 고르고 `export_figure` 로 문서 그림을 요청 첨부로 꺼냅니다.
2. `download_attachment_file` 이 `agent/work/in/<문서>/` 에 원본을 내려받습니다.
3. Claude 가 `work/<스크립트>.py` 를 쓰고 `python -I work/<스크립트>.py` 로 실행해 `work/out/` 에 결과를 만듭니다(Pillow·matplotlib·pandas·openpyxl).
4. `upload_result_file` 이 결과를 요청 결과 첨부로 올리고, `propose_figure(attachment_id, replace_ref)` 로 교체 제안을 남깁니다. 캡션·번호·자리는 그대로이고, 반영은 사람이 편집기에서 합니다.

Claude Desktop·Cowork 처럼 로컬 MCP 를 띄우는 다른 앱도 브리지에 `--files-dir <폴더>`(또는 `HWPX_COWORK_FILES_DIR`)를 주면 같은 도구가 생깁니다 — 그 폴더를 앱의 작업 폴더로 연결하면 앱의 도구로 파일을 열고 고칩니다.

## 5. Claude Code 띄우기 — 터미널에서

**VS Code 확장 패널에서는 채널 플래그를 줄 수 없습니다**(패널에서는 §0 의 한마디로 처리). 서버 PC 의 프로그램 폴더라면 `start-agent.bat`(두 번 클릭, 또는 터미널에서 `.\start-agent.bat`)이 아래를 대신하고 서버 주소·작업 공간도 맞춥니다. 다른 PC 의 서버에 붙을 때는 Windows 터미널·PowerShell(또는 VS Code 의 *터미널* 창)에서:
```
cd <프로그램 폴더>\agent
claude --dangerously-load-development-channels server:hwpx
```
- 처음 한 번: 개발 채널 경고 화면에서 **I am using this for local development**, 새 MCP 서버 확인에서 **Use this MCP server** 를 고릅니다.
- 시작 배너 아래 `Channels (experimental) messages from server:hwpx inject directly in this session …` 이 보이면 채널이 등록된 것입니다.
- `-p`(비대화형)나 Agent SDK 에서는 이 플래그가 무시됩니다. 대화형 터미널 세션이어야 합니다.
- hwpx 는 아직 Anthropic 승인 목록에 없는 자체 채널이라 `--channels` 가 아니라 `--dangerously-load-development-channels server:hwpx` 로 띄웁니다.
- **플래그 없이 `claude` 만으로 띄우면** hwpx 도구는 되지만 초인종은 오지 않습니다 — 그런데도 웹에는 `● 연결됨` 으로 보입니다(아래 §6 주의).

## 6. 연결 확인

1. **웹 편집기 상단의 내 에이전트**가 `○ 연결 안 됨` 에서 **`● Claude Code`(연결됨)** 로 바뀝니다.
2. Claude Code 에서 **`/mcp`** → `hwpx` 가 connected, 도구 목록이 보입니다.
3. 웹 편집기에서 문단을 골라 **AI에게 맡기기** → 비워 두고 [보내기](검토) → 터미널에 `← hwpx: 웹 편집기에서 맡긴 AI 작업 #3(AI 검토)이 대기 중입니다…` 가 뜨고 Claude 가 `get_request → start_request → 제안·메모 → complete_request` 로 처리합니다. 웹 레일의 AI 작업 카드가 `전달됨 → 처리 중 → 완료` 로 바뀝니다. 띄운 직후라면 첫 알림은 5초쯤 뒤에 옵니다.

> **주의 — `● 연결됨` 인데 초인종이 안 오는 경우.** `.mcp.json` 은 브리지를 언제나 `--channel` 로 띄우므로, Claude Code 를 `--dangerously-load-development-channels server:hwpx` **없이** 띄워도 브리지는 서버 알림 통로에 붙고 웹 상단은 `● Claude Code` 가 됩니다. 하지만 그 세션은 채널 알림을 받지 않습니다(Claude Code 가 버림). 그래서 웹에서 '자동'으로 맡긴 일은 내 에이전트로 보내져 **`전달됨`(대기)에 머뭅니다** — 브리지의 다시 알림(1분 뒤)도 같은 이유로 닿지 않습니다.
> - 확인: 시작 배너 아래 `Channels (experimental) messages from server:hwpx …` 줄이 없으면 플래그 없이 띄운 것입니다.
> - 고치기: 그 세션을 닫고 위 명령(플래그 포함)으로 다시 띄웁니다. 쌓인 대기 요청은 다시 붙을 때 한꺼번에 알려 옵니다.
> - 그 세션을 그대로 쓰려면: `대기 중인 hwpx 요청 처리해줘`(한 번) 또는 `/loop 2m 대기 중인 hwpx 요청 처리해줘` — Claude 가 `claim_next_request` 로 오래된 것부터 맡아 처리합니다. 웹 요청 창의 '보낼 곳'을 `서버 AI`·`대기열`로 골라도 됩니다.
> - 같은 사람이 세션을 여러 개 띄우면 알림은 **가장 최근에 붙은 채널 세션 하나**에만 갑니다 — 플래그 없이 띄운 세션이 가장 최근이면 알림이 그쪽으로 가서 사라집니다. 쓰지 않는 세션은 닫으세요.

## 7. 채널을 못 쓸 때(대안)

- **VS Code·Claude Code 대화창에서 한마디**: §0 처럼 `claude mcp add` 로 등록하고 `대기열을 처리해 줘`.
- **`/loop`**: 채널 없이 Claude Code 를 띄우고(`claude`, 이 작업 공간에서) `/loop 2m 대기 중인 hwpx 요청 처리해줘` — 2분마다 `claim_next_request`(가장 오래된 내 대기 요청을 맡고 내용을 줌, 없으면 `{ none: true }`)로 확인해 처리합니다. 한 번만이면 `대기 중인 hwpx 요청 처리해줘`.
- **[프롬프트 복사]**: 웹의 AI 작업 창에서 [프롬프트 복사]로 문장을 복사해, hwpx MCP 를 연결한 아무 Claude(데스크톱·웹·Claude Code)에 붙여 넣습니다.
- **채널 없이 바로 처리**: §0의 `start-claude-worker.bat` 또는 `npm.cmd run worker -- --provider claude-code`. 사용자 MCP 등록 없이 실행기가 연결을 준비합니다.
- **서버 AI**(유료 — 관리자가 켜고 계정마다 허용한 경우): 내 에이전트가 없을 때 서버가 대신 처리합니다.
- 도구만 쓰는 예전(v0.2) 방식도 그대로 됩니다: `node server/mcp-stdio.js --url http://서버:8787/mcp`(토큰은 `HWPX_COWORK_TOKEN`) — 알림 없이 도구만 중계(Claude Desktop 은 §9).

## 8. 변경 요청 검토 맡기기

변경 요청(사람이 편집기에서 고친 **수정본**을 검토 단위로 올린 것 — GitHub 풀 리퀘스트처럼)은 **알림이 오지 않습니다.** 내 에이전트 세션에 직접 시킵니다:
```
「분석 보고서」의 변경 요청 #3 검토해 줘
```
- Claude 는 `list_change_requests` → `get_change_request`(덩어리가 많으면 `nextFrom` 으로 이어 읽기) → 덩어리마다 `comment_change_request`(의견, 기존 의견엔 답글) → 끝에 `review_change_request` 한 번(`comment` 의견만 / `changes` 수정 요청)으로 남깁니다. 작성자 표기는 `홍길동(Claude Code)`.
- **에이전트는 승인·반영을 못 합니다.** `review_change_request` 에 `approve` 를 보내면 서버가 `AGENT_CANNOT_APPROVE` 로 거절하고, 반영(merge) 도구는 없습니다. 승인 수는 사람이 직접 남긴 검토만 셉니다(에이전트의 '수정 요청'은 그 사람이 나중에 직접 판단하면 그 판단으로 바뀝니다).
- 남긴 의견은 웹의 **변경 요청** 탭·검토 레일에 바로 보이고, '한글로 저장 ▾ 검토본'의 검토 메모 '의견:' 줄에도 들어갑니다.

## 9. Claude Desktop 에서 쓰기 — 도구만(채널 없음)

Claude Desktop 은 채널(초인종)을 받지 못합니다. v0.2 때 쓰던 **stdio 브리지 설정이 그대로 됩니다**(브리지는 `--channel` 이 없으면 예전처럼 도구만 중계). 새 도구(`claim_next_request`, 변경 요청 검토 4개)는 서버에서 목록을 받아 오므로 설정을 고칠 필요가 없습니다.

`%APPDATA%\Claude\claude_desktop_config.json`(설정 > 개발자 > 구성 편집):
```json
{ "mcpServers": { "hwpx-cowork": {
  "command": "node",
  "args": ["C:/hwpx-cowork/server/mcp-stdio.js", "--url", "http://localhost:8787/mcp"],
  "env": { "HWPX_COWORK_TOKEN": "내-토큰" }
} } }
```
- **`--channel` 은 넣지 마세요.** 넣으면 브리지가 알림 통로에 붙어 웹이 `● 연결됨` 으로 바뀌고 AI 작업이 이 세션으로 보내지지만, Claude Desktop 은 알림을 보이지 않아 요청이 `전달됨`(대기)에 머뭅니다.
- 토큰은 `args` 의 `--token` 보다 `env` 에 두세요(명령줄은 작업 관리자 등 다른 프로그램에 보입니다). 이 설정 파일은 내 계정 폴더에만 두고 다른 사람과 나누지 않습니다. 예전처럼 `--token` 으로 준 설정도 그대로 됩니다. 설정을 바꾸면 Claude Desktop 을 완전히 끝냈다가(알림 영역 아이콘 > 끝내기) 다시 띄웁니다.
- 채널 세션이 없으면 웹 상단은 `○ 연결 안 됨` 이고, 맡긴 일은 서버 AI(켜져 있으면) 또는 대기열로 갑니다. 대화창에서 `대기 중인 hwpx 요청 처리해줘` 라고 하면 `claim_next_request` 로 하나씩 처리하고, 변경 요청 검토도 §8 처럼 시킬 수 있습니다.
- Claude Desktop 에는 `agent/.claude/settings.json` 같은 허용·거부 목록이 없습니다 — 도구를 쓸 때마다 묻는 창에서 `apply_proposal`·`accept_change`·`reject_change`·`delete_memo` 같은 반영·삭제 도구는 허용하지 마세요.

## 10. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 시작 화면에 "blocked by org policy" | 조직 Owner 가 **조직 설정 > Claude Code > Channels** 를 켜야 합니다 |
| `/mcp` 에서 hwpx 가 failed | 새 터미널인지(setx 반영), `node` 가 PATH 에 있는지, `.mcp.json` 의 서버 주소. `claude --debug --dangerously-load-development-channels server:hwpx` 로 띄우면 `~/.claude/debug/<세션 id>.txt` 에 브리지 로그(stderr)가 남습니다 |
| `/mcp` 에서 hwpx 가 failed 이고, Claude Code 경고 `Missing environment variables: HWPX_COWORK_TOKEN` · 브리지 로그 `환경 변수 HWPX_COWORK_TOKEN 이(가) 브리지에 전달되지 않았습니다(.mcp.json 의 ${HWPX_COWORK_TOKEN} 참조가 풀리지 않고 글자 그대로 옴)` | claude 를 띄운 터미널에 `HWPX_COWORK_TOKEN` 이 없습니다(Claude Code 는 없는 변수를 글자 그대로 넘기고, 브리지는 그 값을 토큰으로 쓰지 않고 바로 끝냅니다). setx 를 **같은 창에서** 했거나 setx **전에 연** 터미널입니다. 새 터미널을 열고(VS Code 의 터미널이면 VS Code 를 완전히 닫았다가 다시 열고) claude 를 다시 띄우세요 |
| 브리지 로그에 `토큰이 필요합니다` | `.mcp.json` 에 `env` 의 `HWPX_COWORK_TOKEN` 항목이 없거나 값이 비었습니다 — `node scripts/setup-agent.mjs` 로 다시 만드세요 |
| `HTTP 401 — 토큰이 올바르지 않습니다` | 토큰이 그 서버 것인지, 그리고 **claude 를 띄운 그 터미널**에 새 값이 들어 있는지(setx 로 토큰을 바꿨으면 새 터미널). 그 터미널에서 `node scripts/setup-agent.mjs` 를 돌리면 `내 토큰 = …` 줄로 확인됩니다(값은 보이지 않음) |
| `/mcp` 에서 hwpx 는 connected 인데 도구가 없음 | `.mcp.json` 의 `--url` 이 `…/mcp` 로 끝나는지 — 서버 주소만 있으면 알림은 와도 도구가 모두 실패합니다. `node scripts/setup-agent.mjs --url http://서버:8787/mcp` 로 다시 만드세요(MCP 주소를 확인해 줍니다) |
| `HTTP 404 — 서버가 알림 연결을 모릅니다` | 서버가 v0.2 입니다. v0.3 이상으로 올려야 알림이 옵니다(도구는 됨) |
| 웹은 `● Claude Code` 인데 알림이 안 옴(AI 작업이 `전달됨` 에 머묾) | ① `--dangerously-load-development-channels server:hwpx` **없이** 띄운 세션입니다(배너에 `Channels (experimental)` 줄이 없음) — 닫고 플래그를 넣어 다시 띄우거나, 그 세션에서 `대기 중인 hwpx 요청 처리해줘`(§6 주의). ② Claude Desktop 설정에 `--channel` 을 넣었습니다 — 빼세요(§9). ③ 같은 사람이 세션을 여러 개 띄우면 **가장 최근 채널 세션 한 곳**에만 알림이 갑니다 — 다른 터미널의 세션을 닫으세요. ④ 띄운 직후라면 5초쯤 기다리세요(시작 직후 알림은 모았다가 보냄) |
| `setup-agent` 가 `! Claude Code 2.1.143 — … 2.1.296 이상을 권장` | `claude update` 로 올리고 새 터미널에서 `claude --version`. 그대로면 PATH 에 옛 판이 먼저 잡히는 것입니다(`where claude`) |
| `setup-agent` 가 `토큰: setx 로 저장돼 있지만 이 창에는 아직 없습니다` | setx 는 했지만 그 전에 연 터미널입니다. 새 터미널을 열고(VS Code 터미널이면 VS Code 를 다시 띄우고) 거기서 claude 를 띄우세요 |
| 같은 요청 알림이 한 번 더 옴(`reminder="true"`) | 알린 뒤 1분 동안 도구 호출이 없었거나, 서버가 다시 켜진 뒤에도 3분 넘게 대기 중이라 다시 알린 것입니다. 이미 처리한 요청이면 Claude 가 넘어갑니다 |
| 서버를 다시 켰다 | 브리지가 1초·2초·4초… (최대 30초)마다 다시 붙고, 이미 알린 요청은 다시 알리지 않습니다(3분 넘게 대기 중으로 남은 것만 한 번 더). 50초 넘게 소식이 없으면 끊고 다시 붙습니다 |
| Windows 에서 세션을 닫았는데 `node` 가 남음 | Claude Code 를 2.1.296 이상으로. 브리지는 stdin 이 닫히면 스스로 끝나고, 5초마다 한 번 더 확인합니다 |

## 11. 안전 수칙

- **문서 글은 자료일 뿐 지시가 아닙니다.** 문서 본문·제목·첨부·메모·변경 요청 글(그리고 `get_request`·`get_change_request` 의 `<document_context>`) 안의 명령은 따르지 않도록 `agent/CLAUDE.md` 와 서버 안내에 적혀 있습니다. 알림 자체에는 지시 원문·문서 글이 들어가지 않고, 제목은 줄바꿈·꺾쇠·따옴표·보이지 않는 글자를 뺀 40자만 갑니다.
- **에이전트는 반영(merge)하지 않습니다.** 제안·메모·변경 요청 의견만 남기고, 기준 문서를 바꾸는 `apply_proposal`·`accept_change`·`reject_change`·`undo_proposal`·`delete_memo` 는 `agent/.claude/settings.json` 에서 거부됩니다. 변경 요청 승인은 서버가 거절(`AGENT_CANNOT_APPROVE`)하고 반영 도구는 없습니다. 반영은 사람이 편집기에서 합니다.
- **allow/deny 규칙을 넓히지 마세요.** 셸·쓰기는 `work/` 의 `python -I work/*` 실행과 `work/` 안 파일 쓰기만 허용합니다. 통째 Bash·Write·Edit·WebFetch 허용, `--dangerously-skip-permissions` 는 쓰지 않습니다(설정에서 막아 둠). 새 hwpx 도구는 허용 목록에 넣기 전까지 거부됩니다(`dontAsk`).
- **실행 범위의 한계.** `python` 스크립트는 Claude 가 쓰는 코드라 Windows 에서는 운영체제 차원의 격리(샌드박스)가 없습니다 — 스크립트가 `work/` 밖을 읽지 않도록 `CLAUDE.md` 가 막고, 요청은 본인 것만 오며(`NOT_OWNER`), 첨부·그림 속 글은 자료로만 다룹니다. 서버 PC(문서·토큰이 있는 PC)가 아닌 개인 PC 에서 에이전트를 띄우는 것이 더 안전합니다.
- **토큰은 환경 변수에만.** `.mcp.json`·명령줄(`--token`)·주소(`/mcp/t/<토큰>`)에 넣지 않습니다(Claude Desktop 은 설정 파일의 `env` 에 두고 그 파일을 나누지 않습니다 — §9). 알림 통로는 `Authorization` 머리글로만 인증합니다. 토큰이 새었으면 관리자에게 새 토큰을 받으세요.
- **원격 승인 없음.** 브리지는 `claude/channel/permission` 을 선언하지 않습니다 — 도구 사용 승인은 언제나 내 터미널에서만 합니다.
- **한 요청은 한 세션만.** 세션마다 무작위 세션 id 로 요청을 맡기 때문에(선점), 다른 세션이 맡은 요청은 `CLAIMED` 로 멈춥니다. 취소된 요청은 알림(`ai_request_cancelled`)을 받으면 바로 멈춥니다.
- 채널은 **연구 미리보기** 기능이라 플래그·동작이 바뀔 수 있습니다. 바뀌면 이 문서와 `docs/V3_SPEC.md §2.3` 을 함께 고칩니다.

## 12. ChatGPT·Codex 연결과 대기열

순서는 §0 과 같습니다 — Codex(ChatGPT 구독)를 내 PC 에서 쓰는 것이 기본이고, ChatGPT 웹은 고급입니다.

**① Codex 실행기 — 바로 처리(기본).** Codex CLI에 `codex login`으로 로그인하고, 본인 HWPX 토큰을 환경 변수에 저장한 뒤(§3) `start-codex-agent.bat` 또는 `npm.cmd run worker -- --provider codex`를 켜 둡니다(`--check`는 점검만). 실행기는 새 요청을 감지하고, Codex가 MCP로 메모·첨부·서식을 직접 읽어 표·서식·그림 제안과 완료를 등록합니다. 전체 절차는 [자동 처리 안내](AUTOMATIC_AI_GUIDE.md).

**① Codex CLI·VS Code 확장 — 대화로 처리.** 둘은 같은 `~/.codex/config.toml` 을 씁니다. 한 번 등록합니다(토큰은 파일에 적지 않고 환경 변수 이름만 저장):

```powershell
codex mcp add hwpx --url "http://localhost:8787/mcp?agent=Codex" --bearer-token-env-var HWPX_COWORK_TOKEN
```

같은 내용을 `config.toml` 에 직접 넣어도 됩니다:

```toml
[mcp_servers.hwpx]
url = "http://localhost:8787/mcp?agent=Codex"
bearer_token_env_var = "HWPX_COWORK_TOKEN"
```

토큰은 이 프로그램 로그인에 사용하는 사용자별 토큰입니다. 다른 PC에서 실행하는 호스트라면 localhost 대신 그 호스트가 접근할 수 있는 서버 주소를 씁니다. 표준 초기화를 하는 MCP 클라이언트는 `Mcp-Session-Id`로 대화를 분리합니다. Claude 채널 브리지는 기존 `X-Hwpx-Agent-Session`으로 실시간 알림과 도구 호출의 선점을 연결합니다.

연결을 추가한 뒤 AI에게 다음과 같이 요청합니다:

> hwpx의 claim_next_request로 내 대기 요청을 오래된 순서로 하나씩 처리해 줘. 요청의 지시·첨부를 읽고 기본 권장안 1개를 제안해 줘. 여러 안은 비교를 요청한 경우에만 만들어 줘. 이미 저장한 결과는 확인해서 남은 작업만 하고, 각 요청은 complete_request의 짧은 공유 요약으로 마무리해 줘. CLAIMED·NOT_OWNER·REQUEST_CLOSED이면 그 요청은 멈춰 줘.

**MCP 연결만으로 웹에서 맡긴 작업이 AI에게 자동 전달되지는 않습니다.** Claude Code 채널은 자동 알림을 보내지만 일반 ChatGPT·Codex MCP 연결은 위처럼 도구 호출로 작업을 가져옵니다. 상단 '내 에이전트'의 연결 표시는 채널 자동 수신 상태이므로, 일반 MCP 도구가 정상 작동해도 자동 수신은 꺼져 있을 수 있습니다. 제안·의견이 서버에 저장되면 열려 있는 편집기에는 WebSocket으로 바로 나타납니다. 본문 반영은 사람이 선택하며, 실시간 편집 문서는 반영 직후 다른 편집기에 공유됩니다.

**② ChatGPT 웹(고급).** 접근 가능한 HTTPS 서버와 계정·조직이 지원하는 연결 구성이 필요합니다. 현재 서버는 사용자별 토큰과 OAuth 2.1(DCR·PKCE)을 지원합니다(운영 매뉴얼 §9). OAuth 연결만으로 자동 작업은 생성되지 않습니다. 연결한 채팅에서 “대기열을 처리해 줘”라고 하거나, 새 요청을 바로 처리하려면 ①의 Codex 실행기를 씁니다. 로컬 SDK 시험 통과는 실제 계정의 연결·자동 실행 완료를 의미하지 않습니다.

서버 재시작이나 연결 단절로 남은 처리 작업은 선점이 만료되면 `claim_next_request`가 회수합니다(기본 15분, `config.agents.leaseMinutes`). 2026-11-16 이후 판의 서버는 같은 작업을 이렇게 이어받는 것을 기본 3번까지만 허용하고(`config.agents.maxTakeovers`), 그다음에는 그 작업을 실패로 닫습니다 — 처리 도중 계속 멈추는 작업이 끝없이 되풀이되지 않게 하는 장치이며, 편집기에서 '다시 요청'하면 처음부터 다시 셉니다(그 전 판의 서버에는 횟수 제한이 없습니다). `existingResults`에는 이미 저장한 제안·의견 ID가 있으므로 `list_proposals`·`list_memos`로 확인하고 이어서 처리합니다. 완료 호출 재전송은 중복 저장하지 않지만, 응답 유실 뒤 같은 제안·의견을 다시 보내는 경우까지 정확히 한 번 저장하는 보장은 없습니다.

격리 검증: `npm run test:mcp`, `npm run test:memo`, `npm test`. 이 시험은 임시 문서·토큰·포트만 사용합니다.

## 부록: 브리지 명령줄

```
node server/mcp-stdio.js [--channel] [--v2 [--tools core|all]] [--lean] [--url <MCP 주소>] [--token <토큰>] [--agent <이름>] [--no-tools]
```
| 인자 | 뜻 |
|---|---|
| `--url` | 서버 MCP 주소(기본 `http://localhost:8787/mcp`, 또는 `HWPX_COWORK_URL`) |
| `--token` | 토큰(권장: 환경 변수 `HWPX_COWORK_TOKEN` — 명령줄은 다른 프로그램에 보일 수 있음) |
| `--agent` | 에이전트 이름(기본: MCP 클라이언트 이름, `claude-code` → `Claude Code`) — 메모 작성자 `홍길동(Claude Code)` 에 쓰임 |
| `--channel` | 채널 알림 켜기(없으면 v0.2 처럼 도구만 중계) |
| `--lean` | 얇은 흐름 — 요청 내용·도구 응답을 모델용으로 짧게 받는다(`start_request` 가 내용을 함께 줌, 쓰기의 `complete` 로 완료). `--no-lean` 으로 끈다. 주소에 `?lean=1` 을 붙여도 같다 |
| `--v2` | 새 연결(2026-11-16 — [MCP_REDESIGN_2026-11-16.md](MCP_REDESIGN_2026-11-16.md)): 작업 도구 넷 `task`(맡기 + 요청 내용)·`read`(글과 주소만)·`edit`(ops 를 한 번에, `done` 으로 완료)·`finish`. 주소에 `?v=2` 를 붙여도 같다. `--tools core` 는 작업 도구와 그림·스킬 파일 도구만, `all`(기본)은 사람이 정할 일·변경 요청·멀티에이전트 도구까지. 서버가 새 연결을 알아야 한다(옛 서버는 예전 도구로 답한다) |
| `--no-tools` | 도구는 중계하지 않고 알림만(`--channel` 과 함께, 도구는 다른 hwpx MCP 연결을 쓸 때) |

작업 공간을 새 연결로 바꾸려면 `node scripts/setup-agent.mjs --v2` — `.mcp.json` 의 브리지 인자를 `--v2` 로, `CLAUDE.md` 를 새 연결용(`agent/v2/CLAUDE.md`)으로 바꾸고(예전 지침은 `CLAUDE.v1.md` 로 남김) 허용 목록에 작업 도구 넷을 더한다. 되돌리기는 `--v1`. 바꾼 뒤 에이전트 세션을 다시 띄워야 적용된다. 프로그램 소스 폴더(시험·묶음 스크립트가 함께 있는 개발용 폴더)에서는 그 안의 `agent/` 가 배포 묶음의 본보기이므로 그 자리에서 바꾸지 않고 다른 폴더에 만든다(`node scripts/setup-agent.mjs --dir agent-v2 --v2` — 그 폴더에서 Claude Code 를 띄운다). **서버가 새 연결을 알 때만 쓴다** — `setup-agent` 의 서버 확인에 "이 서버는 새 연결(--v2)을 모릅니다"가 나오면 그 서버는 예전 도구로 답해 새 지침과 맞지 않으므로 `--v1` 로 되돌린다.

일반 안내 로그는 stderr로 나갑니다(stdout은 MCP 통로). AI 수신 원문은 실행 폴더의 `logs/ai-debug/`에 별도 보존하며 `HWPX_COWORK_DEBUG_DIR`로 위치를 고정할 수 있습니다. 서버 MCP 기록은 서버의 `<dataDir>/runtime/ai-debug/`에 남습니다. Claude 채널은 `.claude/ai-debug-hook.mjs`와 `.claude/settings.json`의 hook으로 마지막 답변과 transcript도 저장합니다. `setup-agent`는 hook 파일을 준비하고 기존 권한·다른 hook을 보존하면서 누락된 진단 hook만 병합합니다. 기존 세션에는 다시 실행한 뒤 적용됩니다. 경로·검사 단계·원문 확인 명령은 [AI 수신 원문과 오류 판정 기록](DEPLOYMENT_AND_AI_GUIDE.md#ai-수신-원문과-오류-판정-기록2026-11-14)을 보세요.
