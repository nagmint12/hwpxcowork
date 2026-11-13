# 기존 공개 주소를 이 컴퓨터로 이전하기

> 2026-10-30: ngrok 한도가 소진되어 ngrok 주소는 쓰지 않습니다. 개발은 로컬(`http://localhost:8787`)로 하고, 인터넷 임시 주소는 `start-tunnel.bat`(Cloudflare Quick Tunnel)으로 엽니다 — [운영 매뉴얼 §4.B](DEPLOYMENT_AND_AI_GUIDE.md). 아래 ngrok 절차는 기록으로 남깁니다.

2026-10-26 기준입니다. 이 컴퓨터의 공유기 외부 IP는 `203.0.113.10`입니다. 기존 환경의 `147.47.*` 주소는 사용하지 않습니다.

앱은 기존 `config.json`과 `data/`만 사용합니다. 관리자·참여자 토큰을 새로 만들거나 변경하지 않습니다. 별도 로컬 전용 설정·계정·시작 기능은 제거했습니다. 이 PC 안에서 확인하는 `http://localhost:8787`은 같은 서버를 가리킵니다.

현재 `config.json.publicUrl`은 `https://keg-bannister-emerald.ngrok-free.dev`입니다. 이 주소를 유지하려면 도메인을 보유한 **같은 ngrok 계정**으로 새 PC를 연결합니다. ngrok 터널 방식에서는 `203.0.113.10`을 앱 설정에 넣거나 공유기 포트 포워딩을 설정할 필요가 없습니다. [ngrok 연결 구조](https://ngrok.com/docs/gateway/agent/connectivity)

## 1. 이전 컴퓨터에서 종료

1. 편집 중인 문서를 저장합니다.
2. 개인 AI 실행기가 있으면 정상 종료합니다. `local-chatgpt.mjs`로 실행했다면 해당 사용자로 `node scripts/local-chatgpt.mjs stop --user "사용자 이름"`을 실행합니다.
3. hwpx-cowork 서버 창에서 `Ctrl+C`를 눌러 종료합니다.
4. ngrok 창에서도 `Ctrl+C`를 눌러 기존 터널을 종료합니다. 서비스로 설치했다면 해당 서비스도 중지합니다.

현재 앱의 관리자 API는 재시작만 지원합니다. 공개 웹 주소로 이전 PC의 서버·터널을 종료하는 기능은 없습니다. 이전 PC에 직접 또는 원격 데스크톱 등으로 접속하여 위 작업을 해야 합니다.

## 2. 문서 보관

이전 PC를 종료한 뒤 `data/` 전체를 보관합니다. 문서뿐 아니라 OAuth 연결의 `oauth-state.json`, 이벤트 구독의 `mcp-events.json`도 이 폴더에 있습니다. 현재 PC의 `config.json`은 유지합니다.

현재 PC의 `data/`에도 기존 문서가 있으므로 양쪽 폴더를 먼저 백업하고, 같은 문서의 내용·수정 기록을 비교한 뒤 옮깁니다. 공개 서버와 이 PC의 같은 문서가 서로 다른 기록 번호를 가진 경우가 확인되어, 이번 복구 작업에서는 기존 `data/`를 원격 자료로 덮어쓰지 않았습니다.

별도 로컬 환경에 사용자가 올린 실제 문서 2개는 기존 `data/docs/`에 파일 그대로 복사하고 해시를 대조했습니다. 시험용 문서는 폐기했습니다.

## 3. 이 컴퓨터에서 실행

앱 실행:

```powershell
cd <repo>
.\start-server.bat
```

`http://localhost:8787`에서 기존 `config.json`의 관리자 토큰으로 로그인합니다. 서버 창을 계속 켜 둡니다.

이 PC에는 ngrok 실행 파일과 인증 설정이 확인되지 않았습니다. [공식 Windows 설치 안내](https://ngrok.com/download/windows?tab=download)에 따라 설치합니다. Microsoft Store 설치 명령은 다음과 같습니다.

```powershell
winget install ngrok -s msstore
```

새 PowerShell에서 기존 도메인을 가진 ngrok 계정으로 인증하고 터널을 엽니다.

```powershell
ngrok config add-authtoken "ngrok 계정 토큰"
ngrok http http://127.0.0.1:8787 --url https://keg-bannister-emerald.ngrok-free.dev
```

ngrok 계정 토큰은 앱 관리자 토큰과 다릅니다. 이 인증은 터널 도구에만 필요하며 앱 `config.json`에는 넣지 않습니다. [공식 CLI](https://ngrok.com/docs/gateway/agent/cli)

`ERR_NGROK_334`가 나오면 이전 터널이 같은 주소를 사용 중인지 확인합니다. 이번 이전에는 두 컴퓨터를 섞어 연결하는 `--pooling-enabled`를 사용하지 않습니다. [중복 엔드포인트 오류](https://ngrok.com/docs/errors/err_ngrok_334)

## 4. 연결 확인

```powershell
$here = Invoke-RestMethod http://localhost:8787/api/config
$public = Invoke-RestMethod https://keg-bannister-emerald.ngrok-free.dev/api/config
$here.nonce -eq $public.nonce
```

`True`이면 공개 주소가 이 PC에서 실행한 서버에 연결된 것입니다. `False`이면 아직 다른 서버에 연결되어 있습니다.

```powershell
npm.cmd run oauth:check -- --url https://keg-bannister-emerald.ngrok-free.dev
```

공개 웹 주소는 `https://keg-bannister-emerald.ngrok-free.dev/`, MCP 주소는 `https://keg-bannister-emerald.ngrok-free.dev/mcp`입니다. 문서에서 글을 선택한 뒤 **AI 요청 → 표 만들기** 또는 **서식 요청**을 사용합니다. 대기열 자동 처리를 쓰려면 기존 계정으로 개인 AI 실행기 또는 이벤트 구독도 연결해야 합니다. MCP 주소 등록만으로 자동 처리가 시작되지는 않습니다.
