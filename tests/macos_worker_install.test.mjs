// macOS의 OS/CPU와 다운로드만 모의하고 배포 셸·체크섬·압축 해제·Node 선택 경로는 실제 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const posix = (p) => p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const source = (file) => fs.readFileSync(path.join(root, 'deploy/portable', file), 'utf8');
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-macos-worker-'));
  const bin = path.join(dir, 'mock-bin');
  const downloads = path.join(dir, 'downloads');
  const install = path.join(dir, 'worker with spaces');
  for (const p of [bin, downloads, install]) fs.mkdirSync(p);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }); };
  write(path.join(install, 'install-node.sh'), source('common/install-node.sh').replaceAll('__NODE_VERSION__', '24.22.2').replaceAll('__MACOS_COMPAT_NODE_VERSION__', '22.23.5'));
  write(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo "$MOCK_ARCH";; -s) echo "$MOCK_OS";; esac\n');
  write(path.join(bin, 'sw_vers'), '#!/bin/sh\necho "$MOCK_MACOS"\n');
  write(path.join(bin, 'curl'), '#!/bin/sh\n# installer: curl -fsSL -o <file> <url>\necho "$4" >> "$MOCK_LOG"\ncp "$MOCK_DOWNLOADS/${4##*/}" "$3"\n');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const env = { ...inherited, PATH: `${posix(bin)}:/usr/bin:/bin`, MOCK_OS: 'Darwin', MOCK_ARCH: 'arm64', MOCK_MACOS: '14.0', MOCK_DOWNLOADS: posix(downloads), MOCK_LOG: posix(path.join(dir, 'fetch.log')) };
  delete env.HWPX_COWORK_NODE_VERSION;
  // Git for Windows가 시작할 때 붙이는 /usr/bin보다 모의 명령이 먼저 오도록 셸 안에서 고정한다.
  const run = (script, extra = {}) => spawnSync(shell, ['-c', `PATH=${quote(env.PATH)}; export PATH; ${script}`], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const archive = (version, platform, arch, broken = false) => {
    const name = `node-v${version}-${platform}-${arch}`;
    const base = path.join(dir, name);
    write(path.join(base, 'bin/node'), broken ? '#!/bin/sh\nexit 86\n' : `#!/bin/sh\necho v${version}\n`);
    for (const f of ['lib/node_modules/npm/package.json', 'bin/npm', 'bin/npx', 'LICENSE']) write(path.join(base, f), '{}\n');
    const tar = run(`tar -czf ${quote(posix(path.join(downloads, name + '.tar.gz')))} -C ${quote(posix(dir))} ${quote(name)}`);
    assert.equal(tar.status, 0, tar.stderr);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(downloads, name + '.tar.gz'))).digest('hex');
    fs.writeFileSync(path.join(downloads, 'SHASUMS256.txt'), `${hash}  ${name}.tar.gz\n`);
    return name;
  };
  const cleanup = () => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, bin, downloads, install, write, run, archive, cleanup };
}

for (const [macos, arch, version] of [
  ['11.7.10', 'x86_64', '22.23.5'], ['12.7.6', 'arm64', '22.23.5'],
  ['13.4.1', 'x86_64', '22.23.5'], ['13.5', 'arm64', '24.22.2'], ['14.0', 'x86_64', '24.22.2'],
]) test(`macOS ${macos} ${arch}: 호환 런타임 선택→체크섬→설치`, () => {
  const f = fixture();
  try {
    const name = f.archive(version, 'darwin', arch === 'x86_64' ? 'x64' : 'arm64');
    const r = f.run(`sh ${quote(posix(path.join(f.install, 'install-node.sh')))}`, { MOCK_MACOS: macos, MOCK_ARCH: arch });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SHA-256 확인 완료/);
    assert.ok(fs.readFileSync(path.join(f.dir, 'fetch.log'), 'utf8').includes(name + '.tar.gz'));
    assert.ok(fs.readFileSync(path.join(f.install, 'runtime/bin/node'), 'utf8').includes(version));
  } finally { f.cleanup(); }
});

test('Linux: 기본 Node 24 설치 경로 유지', () => {
  const f = fixture();
  try {
    f.archive('24.22.2', 'linux', 'x64');
    const r = f.run(`sh ${quote(posix(path.join(f.install, 'install-node.sh')))}`, { MOCK_OS: 'Linux', MOCK_ARCH: 'x86_64' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { f.cleanup(); }
});

test('macOS 10.15 및 구형 Mac의 Node 24 강제 지정: 다운로드 전 거절', () => {
  const f = fixture();
  try {
    for (const extra of [{ MOCK_MACOS: '10.15.7' }, { MOCK_MACOS: '12.7.6', HWPX_COWORK_NODE_VERSION: '24.22.2' }]) {
      const r = f.run(`sh ${quote(posix(path.join(f.install, 'install-node.sh')))}`, extra);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /macOS .*Node.js/);
      assert.equal(fs.existsSync(path.join(f.dir, 'fetch.log')), false);
    }
  } finally { f.cleanup(); }
});

test('체크섬 불일치 또는 실행 불가 다운로드: 기존 runtime 보존', () => {
  const f = fixture();
  try {
    const node = path.join(f.install, 'runtime/bin/node');
    f.write(node, '#!/bin/sh\necho preserved\n');
    f.archive('24.22.2', 'darwin', 'arm64', true);
    let r = f.run(`sh ${quote(posix(path.join(f.install, 'install-node.sh')))}`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /실행할 수 없습니다/);
    assert.match(fs.readFileSync(node, 'utf8'), /preserved/);
    fs.writeFileSync(path.join(f.downloads, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v24.22.2-darwin-arm64.tar.gz\n`);
    r = f.run(`sh ${quote(posix(path.join(f.install, 'install-node.sh')))}`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SHA-256/);
    assert.match(fs.readFileSync(node, 'utf8'), /preserved/);
  } finally { f.cleanup(); }
});

test('find-node: 실행 불가·구형 local Node를 건너뛰고 PATH Node 22 선택', () => {
  const f = fixture();
  try {
    const finder = path.join(f.dir, 'find-node.sh');
    f.write(finder, source('common/find-node.sh'));
    f.write(path.join(f.bin, 'node'), '#!/bin/sh\necho 22\n');
    for (const local of ['#!/bin/sh\nexit 86\n', '#!/bin/sh\necho 20\n']) {
      f.write(path.join(f.install, 'runtime/bin/node'), local);
      const r = f.run(`HERE=${quote(posix(f.install))}; . ${quote(posix(finder))}; printf '%s' "$NODE"`);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, posix(path.join(f.bin, 'node')));
    }
    f.write(path.join(f.install, 'runtime/bin/node'), '#!/bin/sh\necho 24\n');
    const r = f.run(`HERE=${quote(posix(f.install))}; . ${quote(posix(finder))}; printf '%s' "$NODE"`);
    assert.equal(r.stdout, posix(path.join(f.install, 'runtime/bin/node')));
  } finally { f.cleanup(); }
});

test('start-worker: CLI에도 선택한 runtime PATH를 전달하고 인자를 보존', () => {
  const f = fixture();
  try {
    f.write(path.join(f.install, 'start-worker.sh'), source('worker/start-worker.sh'));
    f.write(path.join(f.install, 'app/portable/find-node.sh'), source('common/find-node.sh'));
    f.write(path.join(f.install, 'worker-settings.txt'), 'HWPX_COWORK_URL=https://example.test/mcp\r\nWORKER_ARGS=--provider codex\r\n');
    f.write(path.join(f.install, 'runtime/bin/node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo 22; else printf "%s\\n" "$PATH" "$HWPX_COWORK_URL" "$@"; fi\n');
    const r = f.run(`sh ${quote(posix(path.join(f.install, 'start-worker.sh')))} --check`, { HWPX_COWORK_TOKEN: 'mock-only' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.ok(lines[0].startsWith(posix(path.join(f.install, 'runtime/bin')) + ':'));
    assert.equal(lines[1], 'https://example.test/mcp');
    assert.deepEqual(lines.slice(-3), ['--provider', 'codex', '--check']);
  } finally { f.cleanup(); }
});
