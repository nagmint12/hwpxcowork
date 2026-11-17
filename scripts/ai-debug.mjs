// 모델 호출·문서 변경 없이 저장된 수신 원문과 판정 파일을 찾는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (!['--dir', '--doc', '--request', '--session'].includes(args[i]) || !args[i + 1]) throw new Error('사용법: node scripts/ai-debug.mjs --dir <ai-debug 폴더> [--doc <문서ID>] [--request <번호>] [--session <세션ID>]');
  options[args[i].slice(2)] = args[++i];
}
const root = path.resolve(options.dir || 'data/runtime/ai-debug');
let matches = 0;
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
    else if (entry.name === 'events.jsonl') {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); }
        catch (error) { console.error(JSON.stringify({ file, error: 'incomplete-or-invalid-journal-line', message: error.message })); continue; }
        const c = event.context || {};
        if (options.doc && c.docId !== options.doc || options.request && String(c.requestId) !== options.request || options.session && c.session !== options.session) continue;
        const raw = path.join(folder, event.file);
        const actual = fs.readFileSync(raw);
        const actualSha256 = crypto.createHash('sha256').update(actual).digest('hex');
        let stream;
        if (event.kind === 'stream.start' || event.kind === 'stream.end') {
          const info = JSON.parse(actual), streamFile = path.join(folder, info.file), streamBytes = fs.readFileSync(streamFile);
          stream = { file: streamFile, actualBytes: streamBytes.length, complete: event.kind === 'stream.end' && info.complete !== false,
            code: info.code, failure: info.failure, error: info.error,
            integrity: info.sha256 ? crypto.createHash('sha256').update(streamBytes).digest('hex') === info.sha256 && streamBytes.length === info.bytes : null };
        }
        matches++;
        console.log(JSON.stringify({ at: event.at, runId: event.runId, kind: event.kind, context: c, file: raw,
          bytes: event.bytes, complete: event.complete, validator: event.validator, outcome: event.outcome, state: event.state,
          error: event.error, actualBytes: actual.length, sha256: event.sha256, integrity: actual.length === event.bytes && actualSha256 === event.sha256, stream }, null, 1));
      }
    }
  }
}
if (fs.existsSync(root)) walk(root);
if (!matches) { console.error('일치하는 진단 기록이 없습니다. 실행 환경의 저장 폴더와 요청/시도 번호를 확인하세요.'); process.exitCode = 1; }
