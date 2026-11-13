import fs from 'node:fs';
import path from 'node:path';

// Official Node archives, npm's own invocation, and distro/PATH installations.
export function findNpmCli(nodeExecutable = process.execPath) {
  const nodeDir = path.dirname(nodeExecutable);
  const candidates = [process.env.npm_execpath, path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    try { candidates.push(fs.realpathSync(path.join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'))); } catch { /* npm not on this PATH entry */ }
  }
  return candidates.find((p) => p && /\.m?js$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
}
