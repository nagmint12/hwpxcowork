# hwpx-cowork Windows 실행 도우미(2026-11-16). 시작.bat·종료.bat·AI 연결.bat·외부 접속 열기.bat 이 부른다.
# 이 설치 폴더 안에만 쓴다: runtime\(공식 Node), app\node_modules\(npm 모듈), app\userdata-<방식>\(설정·문서), app\.hwpx-tools\(AI CLI), tools\(cloudflared).
# 관리자 권한·시스템 PATH·다른 설치의 설정은 바꾸지 않는다. Node 는 묶은 판(__NODE_VERSION__)만 쓴다 — PC 에 깔린 Node 판에 따라 달라지지 않게.
param([ValidateSet('Start', 'Stop', 'Status', 'Ai', 'Share')][string]$Action = 'Start', [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$app = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$top = [IO.Path]::GetFullPath((Join-Path $app '..'))
$node = Join-Path $top 'runtime\node.exe'
$setup = Join-Path $app 'scripts\setup-personal.mjs'
$options = Get-Content -LiteralPath (Join-Path $top 'install-options.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$mode = [string]$options.mode
if ($mode -notin @('personal', 'shared')) { throw '설치 정보(install-options.json)가 올바르지 않습니다. ZIP을 새 폴더에 다시 풀어 주세요.' }

function ConvertTo-ArgumentString([string[]]$Arguments) {
  return (@($Arguments | ForEach-Object {
    if ($_ -eq '') { '""' }
    elseif ($_ -notmatch '[\s"]') { $_ }
    else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
  }) -join ' ')
}
# 프로그램을 이 콘솔에 붙여 실행하고 끝날 때까지 기다린다 → 종료 코드.
# 출력을 파이프로 받지 않는다: 서버처럼 뒤에 남는 프로세스가 물려받은 파이프를 쥐고 있으면 여기서 끝나지 않는다.
function Invoke-Exe([string]$File, [string[]]$Arguments) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $File
  $info.Arguments = ConvertTo-ArgumentString $Arguments
  $info.UseShellExecute = $false
  $process = [Diagnostics.Process]::Start($info)
  $process.WaitForExit()
  return $process.ExitCode
}
function Invoke-Node([string[]]$Arguments) { return Invoke-Exe $node $Arguments }
function Invoke-Setup([string[]]$Arguments) { return Invoke-Node (@($setup, '--mode', $mode) + $Arguments) }
function Invoke-Console([string]$File, [string[]]$Arguments) { return Invoke-Exe $File $Arguments }

function Test-Modules {
  if (-not (Test-Path -LiteralPath $node)) { return $false }
  & $node (Join-Path $PSScriptRoot 'install-dependencies.mjs') --check | Out-Null
  return $LASTEXITCODE -eq 0
}

# 처음 한 번: 공식 Node(약 30MB)와 npm 모듈을 인터넷에서 받아 이 폴더에 둔다. 다음부터는 받지 않는다.
function Initialize-Program {
  if (-not (Test-Path -LiteralPath $node)) {
    Write-Host '[처음 한 번] Node.js 받기'
    $rc = Invoke-Exe (Join-Path $PSHOME 'powershell.exe') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'install-node.ps1'), '-Target', (Join-Path $top 'runtime'))
    if ($rc -ne 0 -or -not (Test-Path -LiteralPath $node)) { throw 'Node.js를 받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 실행하세요.' }
  }
  if (-not (Test-Modules)) {
    Write-Host '[처음 한 번] 프로그램 라이브러리 설치(npm, 1~3분)'
    if ((Invoke-Node @((Join-Path $PSScriptRoot 'install-dependencies.mjs'))) -ne 0) { throw '라이브러리를 설치하지 못했습니다. 인터넷·프록시를 확인한 뒤 다시 실행하세요.' }
  }
}

function Get-SetupStatus {
  $text = (& $node $setup --mode $mode --status) | Out-String
  if ($LASTEXITCODE -ne 0) { return $null }
  try { return $text | ConvertFrom-Json } catch { return $null }
}

function Test-ProcessAlive($id) {
  if (-not $id) { return $false }
  return [bool](Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue)
}

function Connect-Ai {
  Write-Host ''
  Write-Host 'AI 연결 — 본인 구독 계정으로 로그인합니다. API 키·유료 API는 쓰지 않습니다.'
  Write-Host '  1) ChatGPT 구독 (Codex)'
  Write-Host '  2) Claude 구독 (Claude Code)'
  Write-Host '  3) AI 연결 끄기'
  $choice = ([string](Read-Host '번호를 입력하세요')).Trim()
  $ai = switch ($choice) { '1' { 'codex' } '2' { 'claude-code' } '3' { 'none' } default { $null } }
  if (-not $ai) { Write-Host '취소했습니다.'; return 0 }
  Initialize-Program
  $status = Get-SetupStatus
  # 다른 AI 실행기가 붙어 있으면 이 설치의 서버를 껐다 켠다(붙어 있는 실행기는 자동으로 바꾸지 않는다)
  if ($status -and $status.running -and $status.ai -ne $ai -and (Test-ProcessAlive $status.workerPid)) {
    Write-Host '연결된 AI를 바꾸려고 서버를 잠시 다시 켭니다.'
    $null = Invoke-Setup @('--stop')
  }
  if ($ai -eq 'none') { return (Invoke-Setup @('--ai', 'none', '--start', '--no-window')) }
  $rc = Invoke-Setup @('--ai', $ai, '--install-cli', '--start', '--no-window')
  if ($rc -ne 0) { return $rc }
  $status = Get-SetupStatus
  if ($status -and $status.workerReady) { Write-Host 'AI 연결 완료. 편집기의 AI 작업 창에서 요청하세요.'; return 0 }
  $cli = Join-Path $app ('.hwpx-tools\' + $(if ($ai -eq 'codex') { 'codex.cmd' } else { 'claude.cmd' }))
  if (-not (Test-Path -LiteralPath $cli)) { Write-Host 'AI 프로그램을 설치하지 못했습니다. 위 메시지를 확인한 뒤 AI 연결.bat을 다시 실행하세요.'; return 1 }
  $answer = ([string](Read-Host '구독 계정 로그인이 필요합니다. 지금 로그인할까요? 브라우저가 열립니다 [Y/N]')).Trim()
  if ($answer -notmatch '^[Yy]') { Write-Host '로그인한 뒤 AI 연결.bat을 다시 실행하세요.'; return 0 }
  $env:PATH = (Join-Path $app '.hwpx-tools') + ';' + (Split-Path $node) + ';' + $env:PATH
  if ($ai -eq 'codex') { $null = Invoke-Console $cli @('login') } else { $null = Invoke-Console $cli @('auth', 'login') }
  $null = Invoke-Setup @('--ai', $ai, '--start', '--no-window')
  $status = Get-SetupStatus
  if ($status -and $status.workerReady) { Write-Host 'AI 연결 완료. 편집기의 AI 작업 창에서 요청하세요.'; return 0 }
  Write-Host 'AI 연결을 아직 확인하지 못했습니다. 로그인을 마친 뒤 AI 연결.bat을 다시 실행하세요.'
  return 1
}

function Find-Cloudflared {
  $local = Join-Path $top 'tools\cloudflared.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  $command = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ($base -and (Test-Path -LiteralPath (Join-Path $base 'cloudflared\cloudflared.exe'))) { return (Join-Path $base 'cloudflared\cloudflared.exe') }
  }
  return $null
}

# Cloudflare 공식 배포 파일만 쓴다: GitHub 공식 저장소에서 받아 Cloudflare 코드 서명을 확인한다.
function Install-Cloudflared {
  $dir = Join-Path $top 'tools'
  $target = Join-Path $dir 'cloudflared.exe'
  $part = "$target.part"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host 'cloudflared 받는 중(Cloudflare 공식, 약 60MB)'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $part
  $signature = Get-AuthenticodeSignature -LiteralPath $part
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O="?Cloudflare') {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    throw 'cloudflared의 Cloudflare 서명을 확인하지 못해 쓰지 않았습니다.'
  }
  Move-Item -LiteralPath $part -Destination $target -Force
  return $target
}

function Open-Share {
  if ($mode -ne 'shared') { Write-Host '외부 접속은 공동 작업용 설치에서만 엽니다.'; return 1 }
  Initialize-Program
  $rc = Invoke-Setup @('--start', '--no-window')
  if ($rc -ne 0) { return $rc }
  $cloudflared = Find-Cloudflared
  if (-not $cloudflared) {
    Write-Host '외부 접속 주소를 만들려면 Cloudflare의 무료 터널 프로그램(cloudflared)이 필요합니다. 계정은 필요 없습니다.'
    $answer = ([string](Read-Host '이 폴더(tools\)에 받을까요? [Y/N]')).Trim()
    if ($answer -notmatch '^[Yy]') { Write-Host '취소했습니다.'; return 0 }
    $cloudflared = Install-Cloudflared
  }
  $env:HWPX_COWORK_CONFIG = Join-Path $app "userdata-$mode\config.json"
  Write-Host ''
  Write-Host '이 창을 켜 둔 동안만 외부에서 접속됩니다. 끝내려면 이 창을 닫거나 Ctrl+C를 누르세요.'
  return (Invoke-Console $node @((Join-Path $app 'scripts\quick-tunnel.mjs'), '--cloudflared', $cloudflared))
}

$code = 0
switch ($Action) {
  'Start' {
    Initialize-Program
    $arguments = @('--start')
    if ($NoOpen) { $arguments += '--no-window' }
    $code = Invoke-Setup $arguments
  }
  'Stop' {
    if (-not (Test-Modules)) { Write-Host '이 폴더에서 실행 중인 서버가 없습니다.' }
    else { $code = Invoke-Setup @('--stop') }
  }
  'Status' {
    if (-not (Test-Modules)) { Write-Host '아직 설치하지 않았습니다. 시작.bat을 실행하세요.' }
    else { $code = Invoke-Setup @('--status') }
  }
  'Ai' { $code = Connect-Ai }
  'Share' { $code = Open-Share }
}
exit $code
