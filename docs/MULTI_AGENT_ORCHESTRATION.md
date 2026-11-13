# 멀티에이전트 문서 개선 실행기

웹 문서함의 **멀티에이전트 협업**에서 본인의 지휘자·작업자 프로필을 설정하고 문서 개선 목표를 입력합니다. 각 실행기의 `--agent-id`는 프로필에 등록한 ID와 정확히 일치해야 합니다. 서버는 작업을 배정하며 실제 모델은 각 사용자의 PC에서 실행합니다.

## 실행 준비

**Codex는 `start-codex-agent.bat` 하나로 일반 요청과 협업 큐를 함께 처리합니다.** `start-codex-agent.bat --check`로 로그인과 두 큐의 준비 상태를 확인할 수 있습니다. Node 명령으로는 `npm run agent:codex`입니다. 프로필에서 Codex 지휘자를 우선 선택하고, 협업 사용이 꺼져 있으면 켤 때까지 기다립니다. Claude Code 작업자는 기존 채널 연결을 유지합니다.

Node.js와 프로젝트 의존성을 준비합니다. 실행기를 배포 ZIP으로 받은 경우 해제한 폴더에서 `npm install`을 실행합니다. PowerShell에서 본인의 서버 주소와 사용자 토큰을 설정합니다.

```powershell
$env:HWPX_COWORK_URL = "https://서버주소/mcp"
$env:HWPX_COWORK_TOKEN = "본인-개인-토큰"
```

지휘자와 작업자마다 별도의 터미널에서 실행합니다. 다음 에이전트 ID는 예시이며 본인 프로필에 맞추어 바꿉니다.

```powershell
# Codex: 먼저 codex login으로 ChatGPT 로그인
npm run orchestrator -- --agent-id codex --provider codex

# Gemini CLI: 먼저 gemini를 실행해 Google 로그인
npm run orchestrator -- --agent-id gemini --provider gemini-cli

# Antigravity CLI: 먼저 agy를 실행해 Google 로그인
npm run orchestrator -- --agent-id antigravity --provider antigravity

# 개인 API 또는 API: 해당 키 환경 변수와 모델 지정
npm run orchestrator -- --agent-id api-worker --provider openai --gateway baze --model "사용-가능한-모델-ID"
```

`--check`를 추가하면 서버 도구·프로필·실행 준비 상태만 점검합니다. 작업을 선점하거나 모델을 호출하지 않습니다. Google CLI의 로그인 유효성과 모델 사용 권한은 실제 요청 때 확인됩니다. 모델은 `--model`로 지정하고, Google CLI 실행 파일은 `--cli-command` 또는 `HWPX_COWORK_GEMINI_COMMAND` / `HWPX_COWORK_ANTIGRAVITY_COMMAND`로 지정합니다. `gemini-cli`와 `antigravity`는 CLI 로그인 방식이고 기존 `gemini`는 API 키 방식입니다.

## 처리와 종료

실행기는 `claim_orchestration_task`로 본인 프로필에 배정된 작업을 선점합니다. 지휘자는 계획과 통합을 수행하며 작업자는 초안·검토 결과를 제출합니다. 통합 결과는 기존 HWPX 제안 흐름으로 발행하며 본문 반영은 편집기에서 결정합니다. 실행 중 임대를 갱신하며 취소·만료 시 늦은 결과를 제출하지 않습니다. 프로필에 지정한 회차·시간·작업 수 한도를 따릅니다.

종료하려면 Ctrl+C를 누릅니다. 재시작 후 같은 통합 검토를 이어가려면 시작할 때 표시된 실행기 세션을 `--session`에 지정합니다. Claude Code 채널도 동일한 오케스트레이션 MCP 도구로 참여할 수 있습니다.

Google CLI 실행기는 현재 문서 문맥과 글이 추출된 첨부를 지원합니다. 이미지·스캔 PDF 첨부는 무시하지 않고 실패로 알립니다. CLI 자식 프로세스에는 HWPX 토큰과 API 키를 넘기지 않으며 문서 내용은 표준 입력으로 전달합니다. Google 계정의 사용 한도와 기관 정책에 따라 실제 요청이 제한될 수 있습니다.

## BAT 실행

`start-codex-agent.bat`는 일반 문단 검토·다듬기와 Codex 협업 작업을 함께 처리합니다. `start-gemini-agent.bat`, `start-antigravity-agent.bat`는 일반 AI 작업 대기열을 처리하며, Google CLI의 협업 참여는 위 `npm run orchestrator` 명령으로 실행합니다.

Google CLI BAT 두 개는 `start-google-agent.bat`를 공통 실행기로 사용하므로 같은 폴더에 보관합니다. 최초 HWPX 토큰 설정은 `setx HWPX_COWORK_TOKEN "본인-개인-토큰"`이며 원격 서버는 `--url`로 지정합니다.

공식 CLI 문서: [Gemini CLI headless](https://geminicli.com/docs/cli/headless/), [Antigravity CLI headless](https://antigravity.google/docs/cli/headless/).

## 멈춘 것처럼 보일 때

문서함의 **멀티에이전트 협업**에서 실행기별 온라인·오류 상태와 최근 보고를 확인합니다. 실행 기록을 선택하면 선행 작업 대기, 작업자 미연결, 작업 선점 대기, 처리 시작·경과 시간과 임대 갱신 시각이 표시됩니다. 실행기 보고가 90초 동안 없으면 미연결로 표시하며, 채널 연결 자체가 모델의 작업 완료를 뜻하지는 않습니다.

자동 지휘자는 연결된 분담 작업자가 없으면 모델을 호출하거나 시도 횟수를 소모하지 않고 기다립니다. Claude Code 등 작업자를 연결하면 다시 진행합니다. 계획에는 현재 연결된 작업자를 우선 사용하여 등록만 된 API 작업자 때문에 중단되는 상황을 줄입니다. 일반 AI 연결만 켜져 있고 협업 지휘자가 없으면 협업 작업은 시작되지 않습니다.

2026-10-30 수정: 기본 프로필의 빈 모델 ID는 Codex CLI 기본 모델로 처리합니다. 문서 크기 한도는 서식 메타데이터가 아닌 실제 본문 20만 자를 기준으로 검사합니다. 실행기는 계획·모델 시작·결과 저장·발행·완료와 30초 단위 대기 경과를 기록하며, 오류는 키·원문 없이 고정 코드로 표시합니다.

실제 연결 검증에서 Codex 계획 → Claude Code 작성·검토 → Codex 통합의 4단계를 완료하고 점검 문서에 삽입 제안 1건을 저장했습니다. 인증값 없는 확인 기록은 `artifacts/actual-agent-check.json`입니다.
