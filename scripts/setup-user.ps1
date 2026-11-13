# 새 설치 폴더의 Node/npm만 준비한다. 관리자 권한·시스템 PATH·사용자 프로필은 바꾸지 않는다.
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$SetupArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeNode = Join-Path $taskRoot 'runtime\node.exe'
$bundleNode = Join-Path $taskRoot '..\runtime\node.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $runtimeNode) { $runtimeNode } elseif (Test-Path -LiteralPath $bundleNode) { $bundleNode } elseif ($nodeCommand) { $nodeCommand.Source } else { $null }
$validNode = $false
if ($nodePath) {
  & $nodePath -e 'process.exit(parseInt(process.versions.node)>=22?0:1)'
  $validNode = $LASTEXITCODE -eq 0
}
if (-not $validNode) {
  $installer = Join-Path $taskRoot 'deploy\portable\common\install-node.ps1'
  if (-not (Test-Path -LiteralPath $installer)) { $installer = Join-Path $taskRoot 'portable\install-node.ps1' }
  if (-not (Test-Path -LiteralPath $installer)) { $installer = Join-Path $taskRoot 'portable\common\install-node.ps1' }
  if (-not (Test-Path -LiteralPath $installer)) { throw 'Node 설치 도우미가 없습니다. 저장소 전체를 다시 받으세요.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target (Join-Path $taskRoot 'runtime') -Version '24.22.2'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $nodePath = $runtimeNode
}
& $nodePath (Join-Path $PSScriptRoot 'setup-personal.mjs') @SetupArgs
exit $LASTEXITCODE
