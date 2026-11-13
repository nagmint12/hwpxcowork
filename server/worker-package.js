// 참여자에게 필요한 실행기 코드만 포장한다. 설정·문서·토큰·설치된 의존성은 읽거나 포함하지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

export const WORKER_PACKAGE_PREFIX = 'hwpx-ai-worker/';
export const WORKER_PACKAGE_FILES = Object.freeze([
  'server/worker.js', 'server/ai.js', 'server/codex-ai.js', 'server/codex-mcp.js', 'server/claude-cli-ai.js', 'server/google-cli-ai.js', 'server/aimock.js', 'server/bridge.js', 'server/format-schema.js', 'server/table-schema.js', 'scripts/ai-worker.mjs',
  'server/api-mcp-tools.js', 'server/api-responses-agent.js', 'server/api-messages-agent.js', 'server/api-gemini-agent.js', 'server/api-tool-loop.js', 'server/tool-profiles.js', 'server/image-integrity.js', 'engine/picture.js', 'engine/xmlscan.js', 'engine/table-edit.js', 'engine/errors.js',
  'server/editor-instructions.js', 'server/lean.js', 'server/edit-usage.js', 'server/codex-model-selection.js',
  'server/orchestration-worker.js', 'scripts/orchestration-worker.mjs', 'docs/MULTI_AGENT_ORCHESTRATION.md',
  'scripts/codex-agent.mjs',
]);
const DEPENDENCIES = ['@modelcontextprotocol/sdk', 'zod'];   // Claude API 는 SDK 없이 fetch(api-messages-agent)
const ZIP_DATE = new Date('2000-01-01T00:00:00Z');

const README = [
  '# hwpx 개인 AI 자동 처리 실행기', '',
  '이 폴더는 중앙 서버에 맡긴 **내 검토 요청**을 내 PC 의 구독 AI(Codex — ChatGPT 로그인, Claude Code — Claude 로그인) 또는 API 키(사용료 별도)로 처리하는 실행기입니다. 프로그램 전체나 한글 편집기를 설치하거나, 내 PC에서 서버를 시작할 필요가 없습니다.', '',
  '1. Node.js 22 이상을 준비하고 ZIP을 해제합니다. 이 README가 있는 폴더에서 터미널을 열어 `npm install`을 실행합니다. 필요한 라이브러리는 인터넷에서 설치됩니다.',
  '2. 관리자에게 중앙 서버의 MCP 주소와 **본인 사용자 토큰**을 따로 받습니다. 다른 PC의 localhost는 내 PC를 뜻하므로 서버의 LAN/VPN 주소 또는 외부 HTTPS 주소를 사용합니다. MCP 주소는 `/mcp`로 끝나야 합니다.',
  '3. 개인 ChatGPT 구독을 사용하려면 공식 Codex CLI를 설치하고 `codex login`으로 본인 계정에 로그인합니다. 조직 계정이면 Codex 사용 권한도 필요합니다. 아래는 Windows PowerShell 예시입니다.', '',
  '```powershell',
  '$env:HWPX_COWORK_URL = "http://서버주소:8787/mcp"',
  '$env:HWPX_COWORK_TOKEN = "관리자에게-받은-본인-토큰"',
  'npm.cmd run worker -- --provider codex --check',
  'npm.cmd run worker -- --provider codex',
  '```', '',
  'Claude 구독을 쓰려면 Claude Code 를 설치하고 `claude auth login` 으로 로그인한 뒤 `npm.cmd run worker -- --provider claude-code` 로 실행합니다(구독 사용 한도에서 차감, API 키 불필요). `--provider claude` 는 유료 Claude API 입니다.', '',
  '`--check`는 로그인과 서버 도구만 확인하며, 문서를 읽거나 요청을 선점하거나 모델을 호출하지 않습니다. codex 방식은 API 키 없이 로컬 ChatGPT 로그인을 사용하며 ChatGPT/Codex의 사용 한도와 조직 권한을 따릅니다. 모델은 선택 사항이며 계정에서 지원하는 ID를 `--model`로 지정할 수 있습니다. 실행 파일을 찾지 못하면 `--codex-command "C:/경로/codex.exe"`를 지정합니다.', '',
  '개인 API 키를 사용하려면 다음처럼 제공자와 모델을 지정합니다.', '',
  'Gemini CLI 또는 Antigravity CLI도 지원합니다. 먼저 `gemini` 또는 `agy`를 실행해 본인 Google 계정에 로그인한 뒤 `npm.cmd run worker -- --provider gemini-cli` 또는 `npm.cmd run worker -- --provider antigravity`로 실행합니다. `--check`는 CLI 설치·서버 연결을 확인하며 로그인 유효성은 실제 요청에서 확인합니다. CLI 경로는 `--cli-command`, 모델은 `--model`로 지정합니다. 현재 텍스트로 추출된 첨부만 지원하며 이미지·스캔 PDF는 실패로 알립니다. 기존 `--provider gemini`는 API 방식입니다.', '',
  '```powershell',
  '$env:OPENAI_API_KEY = "본인-OpenAI-API-키"',
  'npm.cmd run worker -- --provider openai --model "계정에서-사용할-모델-ID"',
  '```', '',
  'API 제공자는 다음 환경 변수와 provider를 사용합니다. API 방식의 `--model`은 필수입니다. 기존 별칭 `chatgpt`는 호환성을 위해 OpenAI API를 가리키므로, ChatGPT 로그인에는 반드시 `--provider codex`를 사용합니다.', '',
  '| provider | 본인 API 키 환경 변수 |', '|---|---|',
  '| openai | OPENAI_API_KEY |', '| anthropic | ANTHROPIC_API_KEY |', '| gemini | GEMINI_API_KEY 또는 GOOGLE_API_KEY |', '',
  '**API 키**를 쓰면 `--gateway baze`를 붙입니다. 키는 API에서 만든 키 하나를 `BAZE_API_KEY`에 넣고(제공자 키는 API로 보내지 않음), 모델 ID는 API 모델 목록의 이름입니다. 추론 모델은 `--effort low|medium|high`로 추론 강도를 정할 수 있습니다(OpenAI·Claude).', '',
  '```powershell',
  '$env:BAZE_API_KEY = "게이트웨이에서-발급한-API-키"',
  'npm.cmd run worker -- --provider openai --gateway baze --model gpt-6.1-sol --effort medium',
  '# API 작업공간을 지원하는 게이트웨이에서는 아래 옵션으로 자유로운 그래프·생성 파일 회수도 사용합니다(사용료·지원 확인).',
  'npm.cmd run worker -- --provider openai --gateway baze --model gpt-6.1-sol --workspace hosted --effort medium',
  '```', '',
  '브라우저에서 검토 요청을 맡기고 실행기를 켜 두면, 내 요청을 오래된 순서로 받아 제안·의견·요약을 저장합니다. 시작 시 기존 대기 요청과 선점이 만료된 작업도 확인합니다. **본문에 자동 적용하지 않습니다.** 반영은 웹 편집기에서 사람이 결정합니다. 종료하려면 Ctrl+C를 누릅니다. 도움말은 `npm.cmd run worker -- --help`로 확인합니다.', '',
  '개인 PC와 실행기가 켜져 있어야 하며, HWPX의 새 요청은 자동 또는 대기열로 보냅니다. ChatGPT 웹 대화창을 자동으로 조작하는 기능은 아닙니다. Codex와 API는 요청 전문·전체 문서 문맥·서식 목록을 읽고 MCP 편집 도구로 복합 작업을 수행합니다. 실제로 저장한 문단·표·그림·차례와 결과 파일을 확인한 뒤 완료합니다. 그림 원본은 download_attachment_file로 받고 결과를 upload_result_file로 올린 뒤 실행기가 propose_figure로 제안합니다. 모델이 임의로 제안을 승인하지 않으며 기존 자동 반영 설정은 그대로 적용됩니다.', '',
  '사용자 토큰은 중앙 문서 서버의 로그인 수단이고, API 키는 AI 제공자의 별도 인증 수단입니다. 각자 본인 값을 사용하고 ZIP·설정 파일·공유 URL에 넣지 마세요. 개인 API 사용료가 발생하며 ChatGPT·Claude·Gemini 웹 구독과 별도입니다. 문서·첨부 자료는 선택한 AI API로 전달됩니다.', '',
  '연결이 안 되면 중앙 서버 주소·본인 토큰·모델 ID·API 키와 서버가 최신 버전인지 확인합니다. 이 실행기에는 중앙 서버 설정이나 실제 문서가 들어 있지 않습니다.', '',
  '## 멀티에이전트 문서 개선', '',
  '웹 문서함의 **멀티에이전트 협업**에서 내 지휘자와 작업자를 설정하고 문서 개선 작업을 시작합니다. 각 실행기의 agent-id를 프로필 ID에 맞추어 별도 터미널에서 실행합니다. 지휘자는 계획·통합을 수행하고 작업자는 초안·검토를 맡습니다.', '',
  '```powershell',
  'npm run orchestrator -- --agent-id codex --provider codex',
  'npm run orchestrator -- --agent-id api-worker --provider openai --gateway baze --model "사용-가능한-모델-ID"',
  '```', '',
  'Claude Code는 MCP 채널에서 claim_orchestration_task로 참여할 수 있습니다. 자동 개선은 설정한 회차·시간·작업 수 한도 안에서 진행하고 마지막 결과를 기존 문서 제안으로 저장합니다. 자세한 설정과 복구 방법은 docs/MULTI_AGENT_ORCHESTRATION.md를 확인하세요.', '',
].join('\n');

/** 지정된 코드 파일과 최소 manifest만 담은 ZIP 바이트. 파일 목록을 확장할 때 의존 관계를 함께 검토한다. */
export async function createWorkerPackage(root) {
  const base = await fs.realpath(path.resolve(root));
  const read = async (relative) => {
    const file = path.join(base, relative);
    const stat = await fs.lstat(file);
    const resolved = await fs.realpath(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !resolved.startsWith(base + path.sep)) throw new Error('실행기 배포 파일은 프로젝트 내부의 일반 파일이어야 합니다');
    return fs.readFile(file, 'utf8');
  };
  const rootPackage = JSON.parse(await read('package.json'));
  const dependencies = {};
  for (const name of DEPENDENCIES) {
    const version = rootPackage.dependencies?.[name];
    if (typeof version !== 'string' || !version.trim()) throw new Error('실행기에 필요한 의존성 버전을 확인할 수 없습니다');
    dependencies[name] = version;
  }
  const manifest = {
    name: 'hwpx-ai-worker', version: rootPackage.version, private: true, type: 'module',
    description: '중앙 HWPX 서버의 내 검토 요청을 ChatGPT·Claude 구독 로그인 또는 개인 API로 자동 처리하는 실행기',
    engines: { node: '>=22' }, scripts: { worker: 'node scripts/ai-worker.mjs', orchestrator: 'node scripts/orchestration-worker.mjs', 'agent:codex': 'node scripts/codex-agent.mjs' }, dependencies,
  };
  const zip = new JSZip();
  const options = { date: ZIP_DATE, createFolders: true };
  for (const relative of WORKER_PACKAGE_FILES) zip.file(WORKER_PACKAGE_PREFIX + relative, await read(relative), options);
  zip.file(`${WORKER_PACKAGE_PREFIX}package.json`, `${JSON.stringify(manifest, null, 2)}\n`, options);
  zip.file(`${WORKER_PACKAGE_PREFIX}README.md`, README, options);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
