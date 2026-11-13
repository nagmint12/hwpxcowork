// server/fs-safe.js — 한글·공백 경로에서 파일·폴더 지우기(Node 24.11 의 fs.rmSync 는 이런 경로에서 프로세스를 죽인다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeFile, removeTree } from '../server/fs-safe.js';

test('한글·공백 경로의 파일·폴더를 지우고, 없는 대상은 조용히 넘어간다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-fs-safe-'));
  try {
    const dir = path.join(tmp, '새 폴더', '문서 1');
    fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'versions', '1.hwpx'), 'a');
    fs.writeFileSync(path.join(dir, '메모.json'), 'b');
    removeFile(path.join(dir, '메모.json'));
    assert.ok(!fs.existsSync(path.join(dir, '메모.json')));
    removeFile(path.join(dir, '없는 파일.json'));
    removeTree(dir);
    assert.ok(!fs.existsSync(dir));
    removeTree(dir);
    assert.ok(fs.existsSync(path.join(tmp, '새 폴더')), '부모 폴더는 남김');
  } finally {
    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(tmp, { recursive: true, force: true });   // 임시 폴더 이름은 ASCII
  }
});
