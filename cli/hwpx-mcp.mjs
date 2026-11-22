#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ID, openConnection, openTools, problem } from './connection.mjs';
import { fileCommand, openWorkspace, parseJson, readJson } from './files.mjs';

const string = { type: 'string' };
const flag = { type: 'boolean' };
const multiple = { type: 'string', multiple: true };
const definitions = {
  help: { ...flag, short: 'h' }, url: string, profile: string, 'stdio-command': string, 'stdio-arg': multiple, env: multiple,
  mcp: string, tools: string, agent: string, session: string, lean: flag, 'allow-http': flag, 'timeout-ms': string,
  doc: string, args: string, 'args-file': string, stdin: flag, 'work-dir': string, 'ops-file': string,
  out: string, kind: string, version: string,
};
const usage = `HWPX MCP CLI
  hwpx-mcp [연결 옵션] list
  hwpx-mcp [연결 옵션] describe <도구>
  hwpx-mcp [연결 옵션] call <도구> [--doc <문서 ID>] [--args <JSON> | --stdin | --args-file <JSON>]
  hwpx-mcp [연결 옵션] --work-dir <폴더> file import <입력.hwpx>
  hwpx-mcp [연결 옵션] --work-dir <폴더> file edit <입력.hwpx> <출력.hwpx> --ops-file <JSON>
  hwpx-mcp [연결 옵션] --work-dir <폴더> file export <문서 ID> <출력.hwpx> [--kind <종류>]

연결: --url <MCP 주소> (또는 HWPX_COWORK_URL), --profile <개인 앱의 절대 설정 경로>,
      --stdio-command <실행 파일> [--stdio-arg=<인자>] [--env <환경 변수 이름>]. 셋 중 하나.
HTTP 토큰: HWPX_COWORK_TOKEN. 원격은 HTTPS 기본, 명시적으로 택한 사내 HTTP는 --allow-http.
HWPX 옵션: --mcp 1|2|3, --tools core|all, --agent <이름>, --session <작업 선점 ID>, --lean.
파일: --args-file, --ops-file, 입력·출력은 --work-dir 안에 지정합니다.
      file edit는 원본을 보존하고 작업 사본에서 변경을 검증한 뒤 새 파일을 만듭니다.
      서버 승인 대기 상태에서는 문서와 제안 ID를 반환합니다.
      --kind export|working|tracked|final|version. version은 file export에서 --version <기록 번호>와 함께 사용.
결과: JSON(stdout), 종료 코드 0 성공 / 1 오류 / 2 명령·인자 오류 / 3 승인 또는 반영 대기.`;

function checkOptions(values, keys) {
  const invalid = keys.filter(key => values[key] !== undefined);
  if (invalid.length) throw problem('BAD_USAGE', '이 명령에서 사용할 수 없는 옵션입니다: ' + invalid.map(key => '--' + key).join(', '));
}

async function stdinJson(input) {
  const chunks = [];
  let size = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw problem('FILE_TOO_LARGE', '표준 입력 JSON의 크기 한도를 초과했습니다.');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks, size).toString('utf8'));
}

async function callArgs(tool, values, input) {
  const { args: json, 'args-file': file, stdin, doc } = values;
  if ([json !== undefined, file !== undefined, !!stdin].filter(Boolean).length > 1) {
    throw problem('BAD_USAGE', '--args, --args-file, --stdin 중 하나만 사용하세요.');
  }
  const args = file !== undefined ? await readJson(await openWorkspace(values['work-dir']), file)
    : stdin ? await stdinJson(input) : json !== undefined ? parseJson(json) : {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw problem('BAD_ARGS', '도구 인자는 JSON 객체여야 합니다.');
  if (doc !== undefined) {
    if (!ID.test(doc)) throw problem('BAD_DOC_ID', '올바른 문서 ID를 지정하세요.');
    if (!Object.hasOwn(tool.inputSchema.properties || {}, 'doc_id')) throw problem('BAD_USAGE', '이 도구는 doc_id 인자를 받지 않습니다.');
    if (Object.hasOwn(args, 'doc_id') && args.doc_id !== doc) throw problem('BAD_ARGS', '--doc와 인자의 doc_id가 다릅니다.');
    return { ...args, doc_id: doc };
  }
  return args;
}

function printableError(error, secrets) {
  const code = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.cause?.code) ? error.cause.code : error.code || 'CLI_ERROR';
  let message = error.message || String(error);
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[토큰]');
  return {
    ok: false, error: { code, message, ...(error.status ? { status: error.status } : {}) },
    ...(error.data ? { data: error.data } : {}), ...(error.result ? { result: error.result } : {}),
  };
}

const badUsage = new Set(['BAD_USAGE', 'BAD_URL', 'NO_TARGET', 'BAD_OPTION', 'BAD_ARGS', 'INVALID_JSON', 'WORK_DIR_REQUIRED', 'BAD_DOC_ID', 'BAD_KIND', 'BAD_VERSION']);
const callKeys = ['doc', 'args', 'args-file', 'stdin'];
const fileKeys = ['ops-file', 'out', 'kind', 'version'];

export async function main(argv, { env = process.env, input = process.stdin, output = process.stdout, fetchImpl } = {}) {
  let connection;
  const json = value => output.write(JSON.stringify(value) + '\n');
  try {
    let parsed;
    try { parsed = parseArgs({ args: argv, options: definitions, allowPositionals: true }); }
    catch (error) { throw problem('BAD_USAGE', error.message); }
    const { values, positionals } = parsed;
    const [command, name, ...parameters] = positionals;
    if (values.help || command === 'help') { output.write(usage + '\n'); return 0; }
    if (!['list', 'describe', 'call', 'file'].includes(command) || ((command === 'list') !== (name === undefined)) || (command !== 'file' && parameters.length)) {
      throw problem('BAD_USAGE', 'list, describe <도구>, call <도구>, file <동작>을 사용하세요. --help에서 예를 확인할 수 있습니다.');
    }
    if (command !== 'file') checkOptions(values, fileKeys);
    if (command !== 'call') checkOptions(values, callKeys);
    connection = await openConnection(values, { env, fetchImpl });
    if (command === 'file') {
      const data = await fileCommand(connection, await openWorkspace(values['work-dir']), name, parameters, values, openTools);
      json(data);
      return data.ok ? 0 : data.status === 'pending' ? 3 : 1;
    }
    const tools = await openTools(connection);
    try {
      if (command === 'list') json({ ok: true, server: tools.server, data: tools.items });
      else if (command === 'describe') json({ ok: true, server: tools.server, data: tools.describe(name) });
      else {
        const result = await tools.call(name, await callArgs(tools.describe(name), values, input));
        json(result);
        if (!result.ok) return 1;
      }
    } finally { await tools.close(); }
    return 0;
  } catch (error) {
    json(printableError(error, [connection?.token, env.HWPX_COWORK_TOKEN]));
    return badUsage.has(error.code) ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
