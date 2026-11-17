# 완전 포함 ZIP용 시작 파일. 다운로드·npm 설치·AI 로그인은 시작 경로에서 실행하지 않는다.
param([switch]$NoOpen, [switch]$Stop, [switch]$Status)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install-options.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.mode -notin @('personal','shared') -or $settings.ai -notin @('none','codex','claude-code')) { throw '실행 설정이 올바르지 않습니다. ZIP 전체를 다시 압축 해제하세요.' }
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$app = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath (Join-Path $app 'node_modules\express\package.json')) -or -not (Test-Path -LiteralPath (Join-Path $app 'node_modules\@modelcontextprotocol\sdk\package.json'))) { throw '포함된 실행 파일이나 라이브러리가 없습니다. 인터넷에서 받지 않습니다. ZIP 전체를 다시 압축 해제하세요.' }
$argsList = @((Join-Path $app 'scripts\setup-personal.mjs'), '--mode', $settings.mode, '--ai', 'none')
if ($Stop) { $argsList += '--stop' }
elseif ($Status) { $argsList += '--status' }
else { $argsList += '--start'; if ($NoOpen) { $argsList += '--no-window' } }
& $node @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Stop -or $Status) { exit 0 }
Write-Host '문서함을 준비했습니다. 인터넷 없이 문서 편집·저장을 사용할 수 있습니다.'
if ($settings.ai -ne 'none') {
  Write-Host 'AI 연결용 CLI도 포함되어 있습니다. AI 로그인·요청은 인터넷 연결 뒤 진행하세요.'
  $provider = $settings.ai
  $command = ".\scripts\setup-user.bat --mode $($settings.mode) --ai $provider --start"
  $prompt = "이 app 폴더의 hwpx-cowork에서 내 구독 AI를 연결해 줘. $command 명령을 실행해 줘. Node·라이브러리·공식 CLI는 이미 포함되어 있으므로 설치하거나 다운로드하지 마. 인터넷이 연결되었는지 먼저 확인하고, 구독 로그인이 필요하면 공식 CLI 명령을 안내한 뒤 내가 로그인·동의할 때까지 기다려 줘. 로그인 뒤 같은 명령을 다시 실행하고 실제 연결 상태를 알려 줘. 기존 운영 설정과 문서는 건드리지 말고, API 키나 별도 유료 API로 대체하지 마. 모델 호출로 시험하지는 마."
  $promptFile = Join-Path $PSScriptRoot 'VS Code에 붙여넣기.txt'
  [IO.File]::WriteAllText($promptFile, $prompt, (New-Object Text.UTF8Encoding($true)))
  $workspace = Join-Path $PSScriptRoot 'Hwpx Cowork.code-workspace'
  @{ folders=@(@{path=$app}); settings=@{} } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $workspace -Encoding UTF8
  if (-not $NoOpen) {
    $code = Get-Command code -ErrorAction SilentlyContinue
    $codePath = if ($code) { $code.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd' }
    if (Test-Path -LiteralPath $codePath) { & $codePath '--new-window' $workspace $promptFile }
    else { Invoke-Item -LiteralPath $promptFile }
  }
}
