# 공식 Node.js와 npm을 nodejs.org에서 받아 SHA-256 확인 후 runtime\에 넣는다.
# 관리자 권한·시스템 설치·PATH 변경 없음. 지우려면 runtime\ 폴더를 지운다. install-node.bat 가 부른다.
param([Parameter(Mandatory = $true)][string]$Target, [string]$Version = '__NODE_VERSION__')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1 진행 막대는 내려받기를 크게 늦춘다
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "node-v$Version-win-$arch.zip"
$base = "https://nodejs.org/dist/v$Version/"
$work = Join-Path ([IO.Path]::GetTempPath()) ("hwpx-node-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$rc = 1
try {
  Write-Host "  공식 Node.js $Version ($arch) 확인: $base"
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match ("\s" + [Regex]::Escape($name) + "\s*$") } | Select-Object -First 1
  if (-not $line) { throw "SHASUMS256.txt 에 $name 이 없습니다" }
  $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
  $zip = Join-Path $work $name
  Write-Host "  내려받는 중: $name (약 30 MB)"
  Invoke-WebRequest -UseBasicParsing -Uri ($base + $name) -OutFile $zip
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 이 공식 값과 다릅니다 — 받은 파일을 쓰지 않습니다" }
  Write-Host "  SHA-256 확인 완료"
  Expand-Archive -Path $zip -DestinationPath $work -Force
  $src = Join-Path $work ("node-v$Version-win-$arch")
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Copy-Item -Force (Join-Path $src 'node.exe') (Join-Path $Target 'node.exe')
  New-Item -ItemType Directory -Force -Path (Join-Path $Target 'node_modules') | Out-Null
  Copy-Item -Recurse -Force -LiteralPath (Join-Path $src 'node_modules\npm') -Destination (Join-Path $Target 'node_modules')
  foreach ($name in @('npm', 'npm.cmd', 'npx', 'npx.cmd')) {
    if (Test-Path -LiteralPath (Join-Path $src $name)) { Copy-Item -Force -LiteralPath (Join-Path $src $name) -Destination (Join-Path $Target $name) }
  }
  Copy-Item -Force (Join-Path $src 'LICENSE') (Join-Path $Target 'LICENSE')
  Write-Host "  설치 완료: $(Join-Path $Target 'node.exe')"
  $rc = 0
} catch {
  Write-Host "  [오류] Node.js 를 설치하지 못했습니다: $($_.Exception.Message)"
  Write-Host "  인터넷·프록시를 확인하거나 https://nodejs.org 에서 LTS(22 이상)를 직접 설치한 뒤 다시 실행하세요."
} finally {
  $resolvedWork = [IO.Path]::GetFullPath($work)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedWork.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $rc
