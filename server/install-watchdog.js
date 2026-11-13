import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { recoveryPaths, atomicJson } from './recovery-state.js';
const execute = promisify(execFile);

export async function installWatchdog({ root, env = process.env } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows 전용 설치입니다. Linux에서는 systemd 서비스를 사용하세요.');
  const paths = recoveryPaths(root, env), script = path.join(root, 'server/watchdog.js');
  const name = `HWPX-Cowork-Recovery-${paths.key}`;
  const psQuote = value => `'${value.replaceAll("'", "''")}'`;
  const inherited = { HWPX_COWORK_CONFIG: paths.configFile, ...(env.HWPX_COWORK_DATA_DIR ? { HWPX_COWORK_DATA_DIR: env.HWPX_COWORK_DATA_DIR } : {}) };
  const vbsPath = path.join(root, 'server/run-watchdog-silent.vbs');
  const vbsEnv = Object.entries(inherited).map(([key,value]) => `sh.Environment("Process")("${key}") = "${value.replaceAll('"','""')}"`).join('\r\n');
  // 고정 HTTPS 주소(https\run-https.mjs — 포터블 묶음엔 없음)가 있으면 같은 작업이 함께 깨운다. 켜져 있으면 바로 끝난다.
  const httpsScript = path.join(root, 'https/run-https.mjs');
  const httpsRun = fs.existsSync(httpsScript) && fs.existsSync(path.join(root, 'https/duckdns-token.txt'))
    ? `sh.Run """${process.execPath.replaceAll('"', '""')}"" ""${httpsScript.replaceAll('"', '""')}"" --background", 0, False\r\n` : '';
  const vbsContent = `Set sh = CreateObject("WScript.Shell")\r\n${vbsEnv}\r\nsh.Run """${process.execPath.replaceAll('"', '""')}"" ""${script.replaceAll('"', '""')}""", 0, False\r\n${httpsRun}`;
  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

  const command = `
    $ErrorActionPreference='Stop'
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psQuote(`"${vbsPath}"`)} -WorkingDirectory ${psQuote(root)}
    $repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $login=New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $null=Register-ScheduledTask -TaskName ${psQuote(name)} -Action $action -Trigger @($repeat,$login) -Settings $settings -Principal $principal -Description 'Recover this HWPX server only while its persisted desired state is running.' -Force
    Start-ScheduledTask -TaskName ${psQuote(name)}
  `;
  let report;
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30000, env });
    report = { mode: 'scheduled-task', taskName: name, intervalSeconds: 60, loginRecovery: true, node: process.execPath, script };
  } catch (error) {
    // No elevation or password prompt: a per-user startup watcher is sufficient
    // to survive the terminal/launcher and is scoped to this installation.
    const startup = path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup');
    fs.mkdirSync(startup, { recursive: true });
    const startupFile = path.join(startup, `${name}.vbs`);
    const invocation = `"${process.execPath}" "${script}" --watch`;
    const vbsEnv = Object.entries(inherited).map(([key,value]) => `sh.Environment("Process")("${key}") = "${value.replaceAll('"','""')}"`).join('\r\n');
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\n${vbsEnv}\r\nsh.Run "${invocation.replaceAll('"', '""')}", 0, False\r\n`;
    fs.writeFileSync(startupFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
    const watcher = spawn(process.execPath, [script, '--watch'], { cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore' });
    watcher.once('error', () => {}); watcher.unref();
    report = { mode: 'user-startup-watcher', startupFile, watcherPid: watcher.pid, intervalSeconds: 15, loginRecovery: true,
      taskRegistrationFailed: true, registrationError: String(error.stderr || error.message).slice(-1200), node: process.execPath, script };
  }
  atomicJson(path.join(paths.runtimeDir, 'watchdog-installation.json'), { ...report, installedAt: new Date().toISOString() });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await installWatchdog({ root: path.resolve(import.meta.dirname, '..') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
