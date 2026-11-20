// 서버·AI 연결 없이 MCP v3 본문 전체를 표준 출력으로 보낸다.
import { readFile } from 'node:fs/promises';
import { HwpxDoc } from '../engine/doc.js';
import { textLines } from '../server/mcp2/views.js';
import { pageTsvLines } from '../server/mcp2/tsv-view.js';

const args = process.argv.slice(2);
if (args.length !== 1 || ['--help', '-h'].includes(args[0])) {
  process.stderr.write('사용법  node scripts/preview-mcp-v3.mjs "문서.hwpx"\n');
  process.exitCode = args.length === 1 ? 0 : 2;
} else {
  try {
    const doc = await HwpxDoc.load(await readFile(args[0]));
    const { lines } = textLines(doc, { surface: 'v3' });
    const page = pageTsvLines(lines, { maxChars: Infinity });
    process.stdout.write(page.text + '\n');
  } catch (error) {
    process.stderr.write(`HWPX 본문을 읽을 수 없습니다. ${error.message}\n`);
    process.exitCode = 1;
  }
}
