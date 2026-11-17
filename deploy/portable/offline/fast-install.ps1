# 빠른 설치(완전 포함 ZIP). 받은 ZIP 에는 파일 몇 개와 setup-files\payload.zip 만 있어 압축 해제가 바로 끝나고,
# 프로그램 본문(파일 수천 개)은 여기서 .NET 으로 한 번에 푼다. 탐색기 내장 압축 풀기는 파일 하나하나가 느리고
# 260자 넘는 경로에서 멈추므로 그 일을 탐색기에 맡기지 않는다(2026-11-16 실측: 탐색기 206초·36개 누락 → 여기 15초).
# Windows 내장 tar 는 쓰지 않는다 — 맨 위 폴더를 떼는 옵션에서 이름을 시스템 코드 페이지로 바꿔 '—' 같은 글자를 '_' 로 만든다.
# 인터넷에서 받지 않고, 이 폴더 밖은 건드리지 않는다. 묶는 쪽: scripts/package-windows-offline-fast.mjs
$ErrorActionPreference = 'Stop'
$setup = $PSScriptRoot
$root = Split-Path -Parent $setup
$payload = Join-Path $setup 'payload.zip'
$listFile = Join-Path $setup 'files.txt'
$doneFile = Join-Path $setup 'installed.txt'

function Stop-Install([string]$message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Yellow
  exit 1
}

# 설치가 끝난 뒤 설치용 파일만 지운다(프로그램·문서는 그대로). 잠겨서 남은 파일은 다음 실행 때 다시 지운다.
function Remove-SetupFiles {
  $left = 0
  foreach ($name in 'payload.zip', 'files.txt', 'install.ps1') {
    $file = Join-Path $setup $name
    try { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } } catch { $left++ }
  }
  if ($left -eq 0) {
    try { [IO.File]::Delete($doneFile); [IO.Directory]::Delete($setup) } catch { }
  }
}

if (Test-Path -LiteralPath $doneFile -PathType Leaf) { Remove-SetupFiles; exit 0 }
if (-not (Test-Path -LiteralPath $payload -PathType Leaf) -or -not (Test-Path -LiteralPath $listFile -PathType Leaf)) {
  Stop-Install '설치 파일이 모자랍니다. 받은 ZIP 전체를 새 폴더에 다시 압축 해제한 뒤 설치 시작.bat을 실행하세요.'
}

# files.txt: 첫 줄 = 형식<TAB>payload 바이트<TAB>payload 안 맨 위 폴더<TAB>파일 수<TAB>풀린 바이트, 그 뒤 "크기<TAB>상대 경로"(빈 폴더는 "D<TAB>경로")
$lines = [IO.File]::ReadAllLines($listFile, [Text.Encoding]::UTF8)
$head = if ($lines.Length) { $lines[0].Split("`t") } else { @() }
if ($head.Length -lt 5 -or $head[0] -ne 'hwpx-fast-install-1') { Stop-Install '설치 목록을 읽지 못했습니다. 받은 ZIP 전체를 다시 압축 해제하세요.' }
$payloadBytes = [long]$head[1]
$prefix = if ($head[2]) { $head[2] + '/' } else { '' }
$totalBytes = [long]$head[4]
$names = New-Object 'System.Collections.Generic.List[string]'
$sizes = New-Object 'System.Collections.Generic.List[long]'
$emptyDirs = New-Object 'System.Collections.Generic.List[string]'
$maxFile = 0; $maxDir = 0
for ($i = 1; $i -lt $lines.Length; $i++) {
  if (-not $lines[$i]) { continue }
  $tab = $lines[$i].IndexOf("`t")
  if ($tab -lt 1) { Stop-Install '설치 목록이 손상되었습니다. 받은 ZIP 전체를 다시 압축 해제하세요.' }
  $kind = $lines[$i].Substring(0, $tab); $rel = $lines[$i].Substring($tab + 1)
  if ($rel.StartsWith('/') -or $rel.Contains('\') -or $rel.Contains(':') -or ('/' + $rel + '/').Contains('/../')) { Stop-Install '설치 목록에 허용하지 않는 경로가 있습니다.' }
  if ($kind -eq 'D') {
    $emptyDirs.Add($rel); if ($rel.Length -gt $maxDir) { $maxDir = $rel.Length }
  } else {
    $names.Add($rel); $sizes.Add([long]$kind)
    if ($rel.Length -gt $maxFile) { $maxFile = $rel.Length }
    $slash = $rel.LastIndexOf('/'); if ($slash -gt $maxDir) { $maxDir = $slash }
  }
}
if ($names.Count -ne [int]$head[3]) { Stop-Install '설치 목록이 손상되었습니다. 받은 ZIP 전체를 다시 압축 해제하세요.' }

# Windows 경로 한도: 파일 259자, 폴더 247자. 넘으면 일부 파일을 만들거나 실행·삭제할 수 없으므로 풀기 전에 멈춘다.
$rootLength = $root.TrimEnd('\').Length
$over = [Math]::Max($rootLength + 1 + $maxFile - 259, $rootLength + 1 + $maxDir - 247)
if ($over -gt 0) {
  Stop-Install ("이 폴더의 경로가 너무 깁니다(지금 {0}자, {1}자 이하여야 합니다).`r`n폴더를 통째로 C:\HwpxCowork 처럼 짧은 위치로 옮기거나 폴더 이름을 줄인 뒤 설치 시작.bat을 다시 실행하세요.`r`n지금 폴더: {2}" -f $rootLength, ($rootLength - $over), $root)
}
if ((Get-Item -LiteralPath $payload).Length -ne $payloadBytes) {
  Stop-Install '받은 파일이 완전하지 않습니다(크기가 다릅니다). ZIP을 다시 받아 전체를 압축 해제하세요.'
}
try {
  $free = (New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($root))).AvailableFreeSpace
  if ($free -lt $totalBytes + 50MB) { Stop-Install ("디스크 공간이 모자랍니다. {0:N0} MB 가 필요합니다(지금 {1:N0} MB)." -f (($totalBytes + 50MB) / 1MB), ($free / 1MB)) }
} catch { }   # 네트워크 폴더처럼 남은 공간을 알 수 없는 곳은 그대로 진행한다

# 아직 없거나 크기가 다른 파일만 푼다 — 풀다가 끊긴 폴더에서 다시 실행하면 남은 것만 채운다.
$missing = New-Object 'System.Collections.Generic.HashSet[string]'
function Find-Missing {
  $missing.Clear()
  for ($i = 0; $i -lt $names.Count; $i++) {
    $info = [IO.FileInfo]::new([IO.Path]::Combine($root, $names[$i].Replace('/', '\')))
    if (-not $info.Exists -or $info.Length -ne $sizes[$i]) { [void]$missing.Add($names[$i]) }
  }
}

Write-Host '프로그램 파일을 준비합니다. 처음 한 번만 하며 보통 1분 안에 끝납니다...'
try {
  Find-Missing
  if ($missing.Count -gt 0) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $want = $missing.Count; $done = 0
    $zip = [IO.Compression.ZipFile]::OpenRead($payload)
    try {
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.EndsWith('/')) { continue }
        if ($prefix) { if (-not $name.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }; $name = $name.Substring($prefix.Length) }
        if (-not $missing.Contains($name)) { continue }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name.Replace('/', '\')))
        if (-not $target.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw '설치 폴더 밖을 가리키는 항목이 있습니다.' }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        $done++
        if ($done % 100 -eq 0) { Write-Progress -Activity '프로그램 파일을 푸는 중' -Status "$done / $want" -PercentComplete ([int](100 * $done / $want)) }
      }
    } finally { $zip.Dispose() }
    Write-Progress -Activity '프로그램 파일을 푸는 중' -Completed
    Find-Missing
  }
  foreach ($rel in $emptyDirs) { [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($root, $rel.Replace('/', '\'))) }
} catch {
  Stop-Install ("프로그램 파일을 풀지 못했습니다: {0}`r`n이 폴더의 서버가 켜져 있으면 종료.bat으로 끄고, 백신이 파일을 막지 않았는지 확인한 뒤 설치 시작.bat을 다시 실행하세요." -f $_.Exception.Message)
}
if ($missing.Count -gt 0) {
  $sample = ($missing | Select-Object -First 5 | ForEach-Object { '  ' + $_ }) -join "`r`n"
  Stop-Install ("프로그램 파일 {0}개를 풀지 못했습니다.`r`n{1}`r`n백신이 파일을 막았거나 디스크 공간이 모자랄 수 있습니다. 확인한 뒤 설치 시작.bat을 다시 실행하세요." -f $missing.Count, $sample)
}

[IO.File]::WriteAllText($doneFile, 'ok')
Remove-SetupFiles
Write-Host '프로그램 파일 준비를 마쳤습니다.'
exit 0
