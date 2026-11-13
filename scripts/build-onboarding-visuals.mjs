#!/usr/bin/env node
// 시작 카드의 정적 그림: 원본 SVG → resvg PNG → 무손실 WebP. 브라우저·유료 AI 없이 재생성한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web', 'onboarding-assets');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-onboarding-icons-'));
const stroke = 'stroke="#4566b4" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const person = (x, y) => `<circle cx="${x}" cy="${y}" r="12" fill="#fff" ${stroke}/><path d="M${x-21} ${y+43}v-7a21 21 0 0 1 42 0v7" ${stroke}/>`;
const icons = {
  personal: `<rect x="43" y="45" width="114" height="81" rx="10" fill="#fff" ${stroke}/><path d="M82 127v22m36-22v22m-49 0h63" ${stroke}/><path d="M62 63h37" ${stroke}/><rect x="107" y="84" width="39" height="54" rx="7" fill="#f3e9db" stroke="#a67b44" stroke-width="4"/><path d="M117 98h19m-19 10h19m-19 10h13" stroke="#a67b44" stroke-width="3" stroke-linecap="round"/>`,
  shared: `<path d="M100 68v25m-51 12V93h102v12" ${stroke}/><rect x="67" y="31" width="66" height="42" rx="9" fill="#fff" ${stroke}/><circle cx="83" cy="51" r="4" fill="#83b8a1"/><path d="M95 51h22" ${stroke}/>${person(49,123)}${person(100,123)}${person(151,123)}`,
  chatgpt: `<rect x="39" y="39" width="122" height="105" rx="25" fill="#fff" stroke="#35836e" stroke-width="5"/><path d="M65 143l-13 22v-25" fill="#fff" stroke="#35836e" stroke-width="5" stroke-linejoin="round"/><path d="M84 73L65 92l19 19m32-38 19 19-19 19m-11-47-12 57" fill="none" stroke="#35836e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
  claude: `<rect x="39" y="39" width="122" height="105" rx="25" fill="#fffaf4" stroke="#b46b4c" stroke-width="5"/><path d="M65 143l-13 22v-25" fill="#fffaf4" stroke="#b46b4c" stroke-width="5" stroke-linejoin="round"/><path d="M100 61v63m-30-32h60M79 70l43 44m0-44-43 44" stroke="#b46b4c" stroke-width="6" stroke-linecap="round"/>`,
  none: `<path d="M63 35h56l26 28v100H63a10 10 0 0 1-10-10V45a10 10 0 0 1 10-10" fill="#fff" ${stroke}/><path d="M118 36v29h26M74 88h50m-50 19h50m-50 19h29" ${stroke}/><circle cx="144" cy="144" r="26" fill="#77a58b"/><path d="M132 144l8 8 16-18" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
};
try {
  fs.mkdirSync(out, { recursive: true });
  await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  for (const [name, body] of Object.entries(icons)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="212" height="212" viewBox="0 0 200 200"><circle cx="100" cy="100" r="98" fill="${name === 'claude' ? '#f4e9e0' : name === 'chatgpt' ? '#e5f1ec' : '#eaf0fc'}"/><g fill="none">${body}</g></svg>`;
    fs.writeFileSync(path.join(out, `${name}.svg`), svg);
    const image = new Resvg(svg);
    const png = path.join(tmp, `${name}.png`);
    fs.writeFileSync(png, image.render().asPng()); image.free();
    const result = spawnSync('python', ['-I', '-c', 'from PIL import Image;import sys;Image.open(sys.argv[1]).save(sys.argv[2],"WEBP",lossless=True,method=6)', png, path.join(out, `${name}.webp`)], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || 'WebP 변환 실패');
    console.log(`${name}.webp ${fs.statSync(path.join(out, `${name}.webp`)).size} bytes`);
  }
} finally {
  if (!path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('임시 폴더 경로 확인 실패');
  fs.rmSync(tmp, { recursive: true, force: true });
}
