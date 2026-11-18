#!/usr/bin/env node
// hwpx-cowork 아이콘 만들기 — 2026-11-18 부터 사용자가 준 원본 그림 icon/hwpx-cowork.png 로 만든다(예전 도형 아이콘 대신).
//   node scripts/make-icons.mjs
// 실제 그림 작업(자르기·줄이기·팔레트 줄이기·ICO/ICNS 묶기)은 scripts/make-icons.py(Pillow·numpy)가 한다 — 결과 목록은 그 파일 머리에.
// 웹 화면·편집기(/studio/ — scripts/build-studio.mjs)·Windows 앱·PC 묶음·Mac 편집기·Android 앱이 모두 그 결과를 쓴다.
// rhwp 아이콘(rhwp-studio/public 의 favicon·icons)은 쓰지 않는다.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const r = spawnSync(python, ['-I', path.join(root, 'scripts', 'make-icons.py')], { cwd: root, stdio: 'inherit' });
if (r.error) { console.error(`아이콘: ${python} 을 실행하지 못했습니다(Pillow·numpy 가 있는 Python 이 필요합니다) — ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
