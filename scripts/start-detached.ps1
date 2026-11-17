# 도구 세션(Claude Code·Codex 의 명령 실행)에서 오래 켜 둘 프로세스를 띄울 때 쓴다 — 그 세션의 작업 묶음(job)에서 떼어 새 콘솔 창(또는 창 없이)으로 띄운다.
# 도구가 띄운 프로세스는 도구의 job 에 묶여 세션이 정리될 때 함께 끝날 수 있다(2026-11-12 숨긴 에이전트가 그렇게 꺼졌다 — CREATE_BREAKAWAY_FROM_JOB 로 띄운 것은 남았다).
#   powershell -NoProfile -File scripts\start-detached.ps1 -Command 'cmd.exe /c ""<repo>\start-codex-agent-v2.bat""'
#   powershell -NoProfile -File scripts\start-detached.ps1 -Command '...' -WorkDir <repo> -Hidden
# 띄운 프로세스의 pid 를 한 줄로 낸다. 이 세션이 물려준 표식(CLAUDE*·MCP_CONNECTION_* 환경 변수)은 지우고 넘긴다. job 이 떼어 내기를 막으면 그대로 띄우고 알린다.
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$WorkDir = (Get-Location).Path,
  [switch]$Hidden
)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DetachedStart {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  const uint CREATE_NEW_CONSOLE = 0x10, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_BREAKAWAY_FROM_JOB = 0x01000000, CREATE_NO_WINDOW = 0x08000000;
  // 반환: pid(양수). breakaway 가 막혀 있으면(ERROR_ACCESS_DENIED) 떼지 않고 다시 띄우고 detached = false
  public static int Start(string command, string dir, bool hidden, out bool detached, out int error) {
    uint window = hidden ? CREATE_NO_WINDOW : CREATE_NEW_CONSOLE;
    foreach (bool breakaway in new[] { true, false }) {
      var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      PROCESS_INFORMATION pi;
      uint flags = window | CREATE_UNICODE_ENVIRONMENT | (breakaway ? CREATE_BREAKAWAY_FROM_JOB : 0);
      if (CreateProcessW(null, new System.Text.StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, dir, ref si, out pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); detached = breakaway; error = 0; return pi.dwProcessId;
      }
      error = Marshal.GetLastWin32Error();
      if (!(breakaway && error == 5)) { detached = false; return 0; }
    }
    detached = false; error = 5; return 0;
  }
}
'@
# 이 세션의 표식은 넘기지 않는다(띄운 프로그램이 이 세션의 일부처럼 굴지 않게 — scripts\agent-hidden.ps1 과 같은 무늬)
Get-ChildItem env: | Where-Object { $_.Name -match '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|MCP_CONNECTION_)' } | ForEach-Object { Remove-Item "env:$($_.Name)" }
$detached = $false; $code = 0
$processId = [DetachedStart]::Start($Command, $WorkDir, [bool]$Hidden, [ref]$detached, [ref]$code)
if ($processId -le 0) { throw "프로세스를 띄우지 못했습니다(오류 $code)." }
Write-Output "pid=$processId detached=$detached"
