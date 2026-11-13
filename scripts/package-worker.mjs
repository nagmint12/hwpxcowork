import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPackage } from '../server/worker-package.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/package-worker.mjs [--out <ZIP 경로>]\n기본 출력: artifacts/hwpx-ai-worker.zip\n실행기 코드만 포장하며 설정·토큰·문서·node_modules는 포함하지 않습니다.');
} else {
  try {
    let output;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== '--out' || !argv[i + 1] || argv[i + 1].startsWith('--') || output) throw new Error('BAD_ARGS');
      output = argv[++i];
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const destination = output ? path.resolve(output) : path.join(root, 'artifacts', 'hwpx-ai-worker.zip');
    const bytes = await createWorkerPackage(root);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
    console.log(`개인 AI 실행기 ZIP 생성: ${destination} (${bytes.length}바이트)`);
  } catch (error) {
    console.error(error.message === 'BAD_ARGS' ? '지원 옵션은 --out <ZIP 경로>, --help 입니다.' : '실행기 ZIP을 만들지 못했습니다. 배포 코드·의존성 버전·출력 경로 권한을 확인하세요.');
    process.exitCode = 1;
  }
}
