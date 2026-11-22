# HWPX MCP CLI

AI 에이전트나 터미널에서 실행 중인 HWPX 문서 서비스에 연결해 도구를 찾고 실행할 수 있습니다. CLI는 직접 모델을 실행하지 않습니다. 도구 호출 결과는 JSON으로 받습니다.

## 실행

공개 저장소를 내려받아 루트에서 `npm ci`를 실행합니다. 루트 명령은 `npm run mcp:cli -- --help`입니다. Windows 설치판과 포터블의 `resources\payload\app\cli\hwpx-mcp.cmd`는 앱의 내장 Node를 사용합니다.

```powershell
npm.cmd run mcp:cli -- --help
cd cli
node ./hwpx-mcp.mjs --help
```

연결 방법은 하나를 선택합니다.

| 연결 | 옵션 |
| --- | --- |
| 포트 없이 실행 중인 개인 앱 | `--profile <개인 설정 폴더 절대 경로>`. 공식 Windows 설치판은 기본 `%APPDATA%\Hwpx Cowork\personal`이고, 이전 Office Tabs 포터블은 `%APPDATA%\Hwpx Cowork Office Tabs\personal`입니다. 지정한 개인 프로필의 계정을 사용합니다. |
| HTTP로 실행 중인 개인 앱 또는 공동 서버 | `--url <MCP 주소>` 또는 `HWPX_COWORK_URL` 환경 변수. 일반 사용자 토큰은 `HWPX_COWORK_TOKEN`에 둡니다. 원격은 HTTPS가 기본이며, 선택한 사내 HTTP 연결에는 `--allow-http`가 필요합니다. |
| 표준 stdio MCP | `--stdio-command <프로그램>`과 필요한 만큼 `--stdio-arg=<인자>`. 자식 프로세스에 넘길 환경 변수는 이름을 `--env <이름>`으로 지정합니다. |

앱에 로그인한 개인 프로필로 직접 연결할 때는 기존 명명 파이프와 개인 계정 인증을 사용합니다. 공동 서버 연결의 권한은 사용한 토큰에 따릅니다. CLI로 새 서버를 시작하지 않습니다.

## 도구 조회 및 호출

```powershell
$cli = './hwpx-mcp.mjs'
$env:HWPX_COWORK_URL = 'http://127.0.0.1:8799/mcp'
node $cli --mcp 3 --tools all list
node $cli --mcp 3 --tools all describe read
'{"view":"format","at":"s0/p0"}' | node $cli --mcp 3 call read --doc DOCUMENT_ID --stdin
```

1. `list`는 서버가 현재 연결에 공개한 도구와 입력 스키마를 가져옵니다. `describe`는 지정한 도구 하나를 반환합니다.
2. `call`은 목록에 있는 도구를 입력 스키마에 맞춰 호출합니다. 도구가 `doc_id`를 받으면 `--doc` 또는 JSON 인자로 ID를 전달할 수 있습니다.
3. `--args`, `--stdin`, `--args-file` 중 하나로 JSON 객체를 전달합니다. 파일을 쓰면 `--work-dir`에 지정한 작업 폴더 안에 두세요.

`--mcp 1|2|3`, `--tools all|core`, `--lean`은 이 제품의 연결 선택입니다. 오래된 서버나 별도 MCP 서버의 도구 목록은 달라질 수 있습니다. AI 작업을 여러 CLI 호출로 이어갈 때는 `task`, `edit`, `finish`에 같은 `--session`을 사용하고 반환된 `request_id`와 `expected_attempt`를 전달합니다. HTTP MCP 전송 세션은 각 명령의 실행 동안 유지됩니다.

표준 MCP 클라이언트는 연결된 서버가 제공하는 도구를 호출합니다. 다른 MCP 서버에서도 `list`, `describe`, `call`을 쓸 수 있습니다. 해당 서버가 HWPX 편집 도구를 제공할 때 그 도구를 호출할 수 있습니다. HWPX Cowork에서는 일반 문서 외에도 서버가 등록한 표, 서식, 그림, 메모, 검토, 작업 관리 도구를 쓰며 서버의 ACL과 문서 설정이 적용됩니다.

## HWPX 파일 편집

작업 폴더에 `input.hwpx`를 두고, 아래처럼 파일의 문단 주소와 검색할 글을 담은 `edits.json`을 만듭니다. 주소는 문서마다 다릅니다. 모를 때는 `file import`로 사본을 만든 뒤 `call read`의 `view: "text"` 또는 `view: "format"`으로 확인합니다.

```json
[
  { "op": "replace", "at": "s0/p0", "find": "검토 전", "with": "검토 완료" }
]
```

```powershell
node $cli --mcp 3 --tools all --work-dir 'C:\work\report' file edit input.hwpx result.hwpx --ops-file edits.json
```

`file edit`는 입력을 서버의 개인 문서함에 사본으로 등록합니다. 현재 설정으로 생성된 사본을 MCP로 읽고 편집한 뒤, 서버에서 제안의 실제 반영을 확인합니다. 실시간 편집에서 직접 반영 권한이 있으면 필요한 제안에 기존 반영 도구를 사용합니다. 승인이나 반영이 남으면 `doc_id`, `proposal_ids`, `pending_ids`를 돌려주며 출력 파일을 만들지 않습니다. 사본에서 검토하고 승인한 뒤 아래 명령으로 내보낼 수 있습니다. 사본은 문서함에서 계속 볼 수 있습니다.

```powershell
node $cli --work-dir 'C:\work\report' file export DOCUMENT_ID result.hwpx
```

원본과 기존 출력 파일을 보존합니다. 입력과 출력의 실제 경로는 작업 폴더 안에 있어야 하며, 출력 이름은 새 파일이어야 합니다. 먼저 임시 파일 쓰기를 마친 뒤 하드 링크로 결과를 공개합니다. 링크를 지원하지 않는 파일 시스템에서는 완료된 임시 파일을 기존 파일을 덮어쓰지 않는 방식으로 복사합니다. 해당 복사가 끝난 뒤 성공을 반환합니다.

서식·내용·메모를 어떤 형태로 내보낼지는 문서 설정을 따르는 `export`가 기본입니다. `--kind working|tracked|final`로 기존 서버 내보내기 종류를 직접 선택할 수 있습니다. 저장 기록은 `file export ... --kind version --version <기록 번호>`로 내보냅니다. 결과의 `kind`, `fallback`, `version`, `sha256`으로 실제 출력 형태를 확인할 수 있습니다.

## JSON 결과

| 종료 코드 | 의미 |
| --- | --- |
| 0 | 조회, 호출 또는 요청한 파일 저장 성공 |
| 1 | 서버, ACL, 도구 또는 파일 처리 오류 |
| 2 | 명령이나 인자 오류 |
| 3 | `file edit`의 승인 또는 반영 대기 |

도구 호출 결과의 `result`에는 MCP 콘텐츠 블록과 구조화 결과가 있습니다. JSON을 해석할 수 있는 응답은 `data`로도 제공합니다. 오류에는 `error.code`와 `error.message`가 있으며, 작업 사본이 이미 만들어졌다면 가능한 경우 `data.doc_id`도 남깁니다.
