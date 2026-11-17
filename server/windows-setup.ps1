# 받은 ZIP 안에서 실행한다. 기존 설치·시스템 설정은 건드리지 않고 이 폴더에만 준비한다.
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install-settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.schema -ne 1 -or $settings.mode -notin @('personal','shared') -or $settings.ai -notin @('codex','claude-code','none')) { throw '설치 선택이 올바르지 않습니다. 시작 안내에서 다시 받으세요.' }
$source = [Uri]$settings.bundle.url
$loopbackTest = $source.Scheme -eq 'http' -and $source.Host -eq '127.0.0.1'
if (($source.Scheme -ne 'https' -and -not $loopbackTest) -or $source.UserInfo -or $source.Query -or $source.Fragment -or $settings.bundle.sha256 -notmatch '^[a-f0-9]{64}$' -or $settings.bundle.bytes -le 0 -or $settings.bundle.topFolder -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw '프로그램 다운로드 정보가 올바르지 않습니다.' }
$installRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'program'))
$markerFile = Join-Path $installRoot 'easy-install.json'
if (Test-Path -LiteralPath $installRoot) {
  if (-not (Test-Path -LiteralPath $markerFile)) { throw 'program 폴더가 이미 있습니다. 기존 파일은 그대로 두었습니다. 설치 ZIP을 다른 빈 폴더에 풀어 실행하세요.' }
  $saved = Get-Content -LiteralPath $markerFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($saved.bundleSha256 -ne $settings.bundle.sha256 -or $saved.mode -ne $settings.mode -or $saved.ai -ne $settings.ai) { throw '다른 설치가 있는 폴더입니다. 새 ZIP을 별도 폴더에 풀어 실행하세요.' }
} else {
  $work = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('.setup-work-' + [Guid]::NewGuid().ToString('N'))))
  New-Item -ItemType Directory -Path $work | Out-Null
  $archive = Join-Path $work 'program.zip'
  Write-Host '[1/3] 프로그램 다운로드 중...'
  Invoke-WebRequest -UseBasicParsing -Uri $source.AbsoluteUri -OutFile $archive
  if ((Get-Item -LiteralPath $archive).Length -ne $settings.bundle.bytes -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $settings.bundle.sha256) { throw '받은 프로그램의 무결성이 다릅니다. 실행하지 않았습니다. 시작 안내에서 다시 받으세요.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extractRoot = Join-Path $work 'expanded'
  $prefix = [IO.Path]::GetFullPath($extractRoot) + [IO.Path]::DirectorySeparatorChar
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/', '\')
      $target = [IO.Path]::GetFullPath((Join-Path $extractRoot $name))
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $name -match ':' -or $unixType -eq 0xA000) { throw '안전하지 않은 ZIP 경로입니다. 설치하지 않았습니다.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extractRoot)
  $unpacked = [IO.Path]::GetFullPath((Join-Path $extractRoot $settings.bundle.topFolder))
  if (-not $unpacked.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath (Join-Path $unpacked 'hwpx-cowork-server\app\scripts\setup-user.bat'))) { throw '설치 도우미가 포함된 프로그램이 아닙니다.' }
  # 절대 경로가 이 설치 ZIP의 작업 폴더 안임을 확인한 뒤, 새 program 폴더로만 옮긴다.
  if (-not $installRoot.StartsWith([IO.Path]::GetFullPath($PSScriptRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '설치 경로를 확인하지 못했습니다.' }
  Move-Item -LiteralPath $unpacked -Destination $installRoot
  @{ bundleSha256=$settings.bundle.sha256; mode=$settings.mode; ai=$settings.ai } | ConvertTo-Json | Set-Content -LiteralPath $markerFile -Encoding UTF8
}
$appRoot = Join-Path $installRoot 'hwpx-cowork-server\app'
$launcher = Join-Path $appRoot 'scripts\setup-user.bat'
if (-not (Test-Path -LiteralPath $launcher)) { throw '설치 실행 파일이 없습니다. 새 폴더에서 다시 설치하세요.' }
$cliArgs = @('--mode', $settings.mode, '--ai', $settings.ai)
if ($settings.ai -ne 'none') { $cliArgs += '--install-cli' }
$cliArgs += '--start'
if ($NoOpen) { $cliArgs += '--no-window' }
$command = '.\scripts\setup-user.bat ' + ($cliArgs -join ' ')
$prompt = "이 폴더의 hwpx-cowork 설치를 마무리해 줘. $command 명령을 실행하고, 구독 로그인이 필요하면 공식 CLI 로그인 명령을 안내하고 내 로그인을 기다린 뒤 같은 명령으로 연결해 줘. 기존 운영 설정과 문서는 건드리지 말고, API 키나 별도 유료 API로 대체하지 마. 끝나면 서버 주소와 실제 AI 연결 상태를 알려 줘. 모델 호출로 시험하지는 마."
$promptFile = Join-Path $PSScriptRoot 'VS Code에 붙여넣기.txt'
[IO.File]::WriteAllText($promptFile, $prompt, (New-Object Text.UTF8Encoding($true)))
$workspace = Join-Path $PSScriptRoot 'Hwpx Cowork.code-workspace'
@{ folders=@(@{path=$appRoot}); settings=@{} } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $workspace -Encoding UTF8
Write-Host '[2/3] Node와 라이브러리 준비 · 문서함 시작...'
& $launcher @cliArgs
if ($LASTEXITCODE -ne 0) { throw '준비를 마치지 못했습니다. 위 오류를 확인한 뒤 설치 시작.bat을 다시 실행하세요.' }
Write-Host '[3/3] 프로그램 준비 완료. 다음에도 설치 시작.bat을 실행하세요.'
if ($settings.ai -ne 'none') {
  Write-Host 'AI 연결이 필요하면 VS Code에 열린 안내 내용을 Codex 또는 Claude Code 대화창에 붙여넣으세요.'
  if (-not $NoOpen) {
    $code = Get-Command code -ErrorAction SilentlyContinue
    $codePath = if ($code) { $code.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd' }
    if (Test-Path -LiteralPath $codePath) { & $codePath '--new-window' $workspace $promptFile }
    else { Invoke-Item -LiteralPath $promptFile }
  }
}
