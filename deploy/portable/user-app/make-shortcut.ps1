# 바탕 화면 바로 가기 만들기. -Url 이면 Edge·Chrome 앱 창으로 그 주소를 여는 바로 가기, -Command 면 그 파일(예: 관리자 앱 .bat)을 여는 바로 가기.
# 아이콘은 %LOCALAPPDATA%\hwpx-cowork\ 로 복사해 쓴다(내려받은 폴더를 지워도 바로 가기 아이콘이 남게).
param([string]$Name = 'hwpx-cowork', [string]$Url, [string]$Command, [string]$Icon)
$ErrorActionPreference = 'Stop'
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $iconPath = $null
  if ($Icon -and (Test-Path -LiteralPath $Icon)) {
    $dir = Join-Path $env:LOCALAPPDATA 'hwpx-cowork'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $iconPath = Join-Path $dir 'hwpx-cowork.ico'
    Copy-Item -Force -LiteralPath $Icon -Destination $iconPath
  }
  $shell = New-Object -ComObject WScript.Shell
  if ($Command) {
    $link = $shell.CreateShortcut((Join-Path $desktop "$Name.lnk"))
    $link.TargetPath = $Command
    $link.WorkingDirectory = Split-Path -Parent $Command
    $link.WindowStyle = 7   # 최소화 — 관리자 앱의 콘솔 창은 작업 표시줄에만
    if ($iconPath) { $link.IconLocation = "$iconPath,0" }
    $link.Save()
  } elseif ($Url) {
    $candidates = @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'), (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
    $browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($browser) {
      $link = $shell.CreateShortcut((Join-Path $desktop "$Name.lnk"))
      $link.TargetPath = $browser
      $link.Arguments = "--app=$Url"
      if ($iconPath) { $link.IconLocation = "$iconPath,0" }
      $link.Save()
    } else {
      $lines = @('[InternetShortcut]', "URL=$Url")
      if ($iconPath) { $lines += @("IconFile=$iconPath", 'IconIndex=0') }
      Set-Content -LiteralPath (Join-Path $desktop "$Name.url") -Value $lines -Encoding ASCII
    }
  } else { throw '-Url 또는 -Command 가 필요합니다' }
  Write-Host "  바탕 화면에 '$Name' 바로 가기를 만들었습니다."
  exit 0
} catch {
  Write-Host "  [오류] 바로 가기를 만들지 못했습니다: $($_.Exception.Message)"
  exit 1
}
