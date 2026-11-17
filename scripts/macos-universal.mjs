// Windows-hosted counterpart of @electron/universal for our architecture-neutral
// app code. rcodesign's macho-universal-create performs the lipo operation.
// Unlike a ZIP containing two apps, every executable has both native slices and
// editor/WASM/font resources are stored exactly once. Unknown differences fail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { auditMacBinaries } from './macos-binary-audit.mjs';

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshot = /^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/[^/]+\/Resources\/v8_context_snapshot\.(x86_64|arm64)\.bin$/;
const signature = name => name.split('/').includes('_CodeSignature');

function inventory(root) {
  const files = new Map();
  const directories = new Set(['']);
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (signature(name)) continue; // Re-sign the final merged bundle, never keep stale seals.
      const file = path.join(root, name);
      if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file).replaceAll('\\', '/');
        if (path.isAbsolute(link) || !path.resolve(path.dirname(file), link).startsWith(root + path.sep)) {
          throw Error('App symlink escapes bundle: ' + name);
        }
        files.set(name, { file, link });
      } else if (entry.isDirectory()) { directories.add(name); visit(name); }
      else files.set(name, { file, sha256: hash(file) });
    }
  }
  visit();
  // Mac framework directory links extracted on Windows can be file-type reparse
  // points: stat() follows those and fails with EPERM. Resolve the relative link
  // graph from lstat/readdir entries instead of following Windows reparse points.
  function resolveLink(name, depth = 0) {
    if (depth > 32) throw Error('Cyclic app symlink: ' + name);
    const parts = name.split('/');
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join('/');
      const entry = files.get(prefix);
      if (entry?.link !== undefined) {
        return resolveLink(path.posix.normalize(path.posix.join(path.posix.dirname(prefix), entry.link, ...parts.slice(end))), depth + 1);
      }
    }
    return name;
  }
  for (const [name, entry] of files) if (entry.link !== undefined) {
    const target = resolveLink(name);
    if (!directories.has(target) && !files.has(target)) throw Error('Dangling app symlink: ' + name);
    entry.directory = directories.has(target);
  }
  return files;
}

export function mergeMacApps({ x64App, arm64App, outApp, signer, target = '12.1' }) {
  const x64 = path.resolve(x64App), arm64 = path.resolve(arm64App), output = path.resolve(outApp);
  for (const source of [x64, arm64]) {
    if (output === source || output.startsWith(source + path.sep) || source.startsWith(output + path.sep)) {
      throw Error('Universal output must be separate from its inputs');
    }
  }
  if (fs.existsSync(output)) throw Error('Universal output already exists: ' + output);
  const audits = [auditMacBinaries(x64, { arch: 'x64', target }), auditMacBinaries(arm64, { arch: 'arm64', target })];
  const binaryNames = audits.map(a => new Set(a.binaries.map(b => b.file)));
  const lists = [inventory(x64), inventory(arm64)];
  const plan = [];
  for (const name of new Set([...lists[0].keys(), ...lists[1].keys()])) {
    const a = lists[0].get(name), b = lists[1].get(name);
    if (!a || !b) {
      const match = snapshot.exec(name);
      if (!match || (a ? match[1] !== 'x86_64' : match[1] !== 'arm64')) throw Error('Unmatched app resource: ' + name);
      plan.push({ name, source: a ?? b, kind: 'snapshot' });
    } else if (a.link !== undefined || b.link !== undefined) {
      if (a.link !== b.link || a.directory !== b.directory) throw Error('Different app symlinks: ' + name);
      plan.push({ name, source: a, kind: 'link' });
    } else if (binaryNames[0].has(name) || binaryNames[1].has(name)) {
      if (!binaryNames.every(names => names.has(name))) throw Error('Missing matching Mach-O: ' + name);
      plan.push({ name, source: a, other: b, kind: 'binary' });
    } else {
      // @electron/universal permits this Xcode nib serialization difference.
      // All code, WASM, fonts, plists and ASARs must still be byte-identical.
      const nib = path.posix.basename(path.posix.dirname(name)) === 'MainMenu.nib';
      if (a.sha256 !== b.sha256 && !nib) throw Error('Different shared app resource: ' + name);
      plan.push({ name, source: a, kind: nib && a.sha256 !== b.sha256 ? 'nib' : 'shared' });
    }
  }
  // Validate every mismatch before writing. Never overwrite an earlier candidate.
  fs.mkdirSync(output, { recursive: true });
  for (const item of plan.filter(p => p.kind !== 'link')) {
    const destination = path.join(output, item.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (item.kind === 'binary') {
      const result = spawnSync(signer, ['macho-universal-create', '--output', destination, item.source.file, item.other.file], {
        windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw Error(`Universal merge failed: ${item.name}: ${result.error?.message || result.stderr}`);
      fs.chmodSync(destination, 0o755);
    } else {
      fs.copyFileSync(item.source.file, destination, fs.constants.COPYFILE_EXCL);
    }
  }
  // Preserve framework links as relative POSIX links for Finder/Archive Utility.
  for (const item of plan.filter(p => p.kind === 'link')) {
    const destination = path.join(output, item.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(item.source.link, destination, item.source.directory ? 'dir' : 'file');
  }
  const audit = auditMacBinaries(output, { arch: 'universal', target });
  return {
    arch: 'universal', architectures: ['x64', 'arm64'], binaries: audit.binaries.length,
    sharedFiles: plan.filter(p => p.kind === 'shared').length,
    snapshots: plan.filter(p => p.kind === 'snapshot').map(p => p.name),
    nibDifferences: plan.filter(p => p.kind === 'nib').map(p => p.name),
    symlinks: plan.filter(p => p.kind === 'link').length,
  };
}
