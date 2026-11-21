# Preflight for the per-user NSIS installer. Exit 0 when files are free,
# 10 when a running installation was found, and 1 when it cannot be closed.
param(
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$Previous,
    [ValidateSet('Check','Close')][string]$Action = 'Check'
)
$ErrorActionPreference = 'Stop'
$roots = @(@($Previous, $Destination) | ForEach-Object {
    $folder = [IO.Path]::GetFullPath($_).TrimEnd('\')
    if ((Test-Path -LiteralPath (Join-Path $folder 'Hwpx Cowork.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $folder 'resources\payload\app\portable\personal.mjs') -PathType Leaf)) { $folder }
} | Sort-Object -Unique)
if (!$roots.Count) { exit 0 }
$apps = @($roots | ForEach-Object { Join-Path $_ 'Hwpx Cowork.exe' })
$nodes = @($roots | ForEach-Object { Join-Path $_ 'resources\runtime\node.exe' })
$setups = @($roots | ForEach-Object { Join-Path $_ 'resources\payload\app\scripts\setup-personal.mjs' })
$session = (Get-Process -Id $PID).SessionId

function Get-InstalledProcesses {
    Get-CimInstance Win32_Process -Filter "Name='Hwpx Cowork.exe' OR Name='node.exe'" |
        Where-Object { $_.ExecutablePath -in $apps -or $_.ExecutablePath -in $nodes }
}

# The previous uninstaller can match paths by prefix. Do not let it close
# another running copy in a similarly named directory during an upgrade.
foreach ($process in Get-CimInstance Win32_Process -Property ExecutablePath) {
    $file = $process.ExecutablePath
    if ($file -and $file.StartsWith($Previous, [StringComparison]::OrdinalIgnoreCase) -and
        !$file.StartsWith($Previous.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Write-Error 'Another running program has a path that the previous uninstaller could match.'
    }
}
$active = @(Get-InstalledProcesses)
if (!$active.Count) { exit 0 }
if ($Action -eq 'Check') { exit 10 }

# Close the editor's unowned window even when its child runner window is in
# front. The editor retains its normal save/discard/cancel dialog.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CoworkSetup {
    delegate bool Visit(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visit callback, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string cmd, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    public static bool RequestClose(uint target) {
        bool sent = false;
        EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid != target || !IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
            var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() == "Chrome_WidgetWin_1")
                sent |= PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return sent;
    }
    public static string[] Arguments(string cmd) {
        int count; var ptr = CommandLineToArgvW(cmd, out count);
        if (ptr == IntPtr.Zero) throw new InvalidOperationException("Invalid process command line");
        try {
            var args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i * IntPtr.Size));
            return args;
        } finally { LocalFree(ptr); }
    }
}
"@

function Request-SetupStop($process) {
    $argv = [CoworkSetup]::Arguments($process.CommandLine)
    if ($argv.Length -lt 4 -or $argv[1] -notin $setups -or $argv -notcontains '--serve') { return }
    $index = [array]::IndexOf($argv, '--user-dir')
    if ($index -lt 0 -or $index + 1 -ge $argv.Length) { return }
    $dir = $argv[$index + 1]
    if (![IO.Path]::IsPathRooted($dir)) { return }
    $lock = Get-Content -LiteralPath (Join-Path $dir 'setup-runtime.lock') -Raw | ConvertFrom-Json
    if ($lock.pid -ne $process.ProcessId) { return }
    # Use the setup helper's own IPC file. It drains its worker and server.
    $stop = Join-Path $dir 'setup-stop.json'
    if (Test-Path -LiteralPath $stop) { return }
    $tmp = Join-Path $dir ('setup-stop-' + [guid]::NewGuid() + '.tmp')
    try {
        [IO.File]::WriteAllText($tmp, ('{"pid":' + $process.ProcessId + '}'))
        [IO.File]::Move($tmp, $stop)
    } finally {
        if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
    }
}

$requested = @{}
$limit = [datetime]::UtcNow.AddSeconds(90)
do {
    foreach ($process in $active) {
        if ($process.SessionId -ne $session) { continue }
        $id = "$($process.ProcessId)/$($process.CreationDate.Ticks)"
        if ($requested.ContainsKey($id)) { continue }
        if ($process.ExecutablePath -in $apps -and $process.CommandLine -notmatch '\s--type=') {
            if ([CoworkSetup]::RequestClose($process.ProcessId)) { $requested[$id] = $true }
        } elseif ($process.ExecutablePath -in $nodes -and $process.CommandLine -match 'setup-personal\.mjs') {
            Request-SetupStop $process
            $requested[$id] = $true
        }
    }
    Start-Sleep -Milliseconds 500
    $active = @(Get-InstalledProcesses)
    if (!$active.Count) { exit 0 }
} while ([datetime]::UtcNow -lt $limit)
exit 1
