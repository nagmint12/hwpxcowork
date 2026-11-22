import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const problem = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

// The portable payload contains the same modules under ../server. The source
// overlay can also be run directly from this development tree.
export async function productModule(name) {
  const installed = new URL('../server/' + name, import.meta.url);
  try { await fs.access(installed); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return import(new URL('../../../../server/' + name, import.meta.url).href);
  }
  return import(installed.href);
}

function httpUrl(value, allowHttp) {
  let url;
  try { url = new URL(value); } catch { throw problem('BAD_URL', '올바른 MCP 서버 주소를 지정하세요.'); }
  if (url.username || url.password || url.hash || url.searchParams.has('token') || /\/mcp\/t\//i.test(url.pathname)) {
    throw problem('BAD_URL', '서버 주소의 토큰·사용자 정보·프래그먼트를 빼고 HWPX_COWORK_TOKEN을 사용하세요.');
  }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && (loopback.has(url.hostname) || allowHttp))) {
    throw problem('BAD_URL', 'HTTPS 또는 이 PC의 HTTP 주소를 지정하세요. 필요한 사내 HTTP 연결은 --allow-http로 선택하세요.');
  }
  if (url.pathname === '/') url.pathname = '/mcp';
  return url;
}

async function profileConnection(dir, token) {
  if (!path.isAbsolute(dir)) throw problem('BAD_PROFILE', '--profile에는 실행 중인 개인 앱의 절대 설정 경로를 지정하세요.');
  const { readPipeSession, pipeFetch, desktopOrigin } = await productModule('desktop-pipe.js');
  let cfg;
  try { cfg = JSON.parse((await fs.readFile(path.join(dir, 'config.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw problem('BAD_PROFILE', '개인 앱의 설정을 읽지 못했습니다.', { cause: error }); }
  if (cfg.personal?.app !== true || cfg.host !== '127.0.0.1') throw problem('BAD_PROFILE', '개인 앱의 설정 폴더를 선택하세요.');
  const credential = token || cfg.users?.find(user => user.role === 'admin')?.token;
  if (!credential) throw problem('AUTH_REQUIRED', '개인 앱에서 사용할 토큰을 찾지 못했습니다.');
  try {
    return { url: new URL(desktopOrigin + '/mcp'), token: credential, fetchImpl: pipeFetch(readPipeSession(dir)) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw problem('PROFILE_OFFLINE', '개인 앱을 포트 없이 실행하세요. TCP로 실행한 앱에는 --url과 HWPX_COWORK_TOKEN을 사용하세요.');
  }
}

export async function openConnection(options, { env, fetchImpl = globalThis.fetch } = {}) {
  const fromEnv = options.profile || options['stdio-command'] ? null : env.HWPX_COWORK_URL;
  const address = options.url || fromEnv;
  if ([address, options.profile, options['stdio-command']].filter(Boolean).length !== 1) {
    throw problem('NO_TARGET', '--url, --profile 또는 --stdio-command 중 하나를 지정하세요.');
  }
  if (options.mcp && !['1', '2', '3'].includes(options.mcp)) throw problem('BAD_OPTION', '--mcp는 1, 2, 3 중 하나입니다.');
  if (options.tools && !['all', 'core'].includes(options.tools)) throw problem('BAD_OPTION', '--tools는 all 또는 core입니다.');
  if (options.session && !ID.test(options.session)) throw problem('BAD_OPTION', '--session은 영문·숫자·밑줄·하이픈 64자 이하입니다.');
  if (options.lean && options.mcp && options.mcp !== '1') throw problem('BAD_OPTION', '--lean은 MCP v1에서 사용할 수 있습니다.');
  const timeout = options['timeout-ms'] == null ? 60_000 : Number(options['timeout-ms']);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw problem('BAD_OPTION', '--timeout-ms에는 유효한 양의 밀리초를 지정하세요.');

  if (options['stdio-command']) {
    if (options.mcp || options.tools || options.lean || options.agent || options.session || options['allow-http']) {
      throw problem('BAD_OPTION', 'stdio 서버 설정은 --stdio-arg로 전달하세요.');
    }
    const childEnv = Object.fromEntries((options.env || []).map(name => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || env[name] == null) throw problem('BAD_OPTION', '--env에 지정한 환경 변수를 찾지 못했습니다.');
      return [name, env[name]];
    }));
    const transport = new StdioClientTransport({ command: options['stdio-command'], args: options['stdio-arg'] || [], env: childEnv, stderr: 'inherit' });
    return { transport, timeout };
  }

  if (options['stdio-arg']?.length || options.env?.length) throw problem('BAD_OPTION', '--stdio-arg와 --env는 stdio 서버를 실행할 때 사용합니다.');
  const token = env.HWPX_COWORK_TOKEN?.trim();
  const target = options.profile ? await profileConnection(options.profile, token)
    : { url: httpUrl(address, options['allow-http']), token, fetchImpl };
  if (options.agent) target.url.searchParams.set('agent', options.agent);
  const headers = {
    ...(target.token ? { Authorization: 'Bearer ' + target.token } : {}),
    ...(options.mcp ? { 'X-Hwpx-Mcp': options.mcp } : {}),
    ...(options.tools ? { 'X-Hwpx-Tools': options.tools } : {}),
    ...(options.session ? { 'X-Hwpx-Agent-Session': options.session } : {}),
    ...(options.lean ? { 'X-Hwpx-Lean': '1' } : {}),
  };
  const guardedFetch = (input, init = {}) => target.fetchImpl(input, {
    ...init, redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const transport = new StreamableHTTPClientTransport(target.url, { requestInit: { headers }, fetch: guardedFetch });
  return { ...target, timeout, transport, headers, guardedFetch };
}

export async function restRequest(connection, endpoint, options = {}) {
  const { url, token, headers, guardedFetch } = connection;
  if (!url || !guardedFetch || !/(?:^|\/)mcp(?:\/|$)/.test(url.pathname)) {
    throw problem('PRODUCT_HTTP_REQUIRED', '파일 명령에는 HWPX Cowork의 HTTP MCP 주소나 --profile이 필요합니다.');
  }
  if (!token) throw problem('AUTH_REQUIRED', '파일 명령에는 HWPX_COWORK_TOKEN이 필요합니다.');
  const { apiBaseFrom } = await productModule('bridge.js');
  const response = await guardedFetch(apiBaseFrom(url) + endpoint, { ...options, headers: { ...headers, ...options.headers } });
  if (response.ok) return response;
  const data = await response.json().catch(() => null);
  throw problem(data?.error || 'HTTP_' + response.status, data?.message || '서버 응답 ' + response.status, { status: response.status });
}

export async function verifyProduct(connection) {
  const config = await (await restRequest(connection, '/api/config')).json().catch(() => null);
  if (!config?.features?.mcp2 && !config?.features?.mcp3) {
    throw problem('PRODUCT_HTTP_REQUIRED', 'HWPX Cowork 문서 서비스의 파일 API를 확인하지 못했습니다.');
  }
}

export function dataOf(result) {
  if (result.structuredContent != null) return result.structuredContent;
  const text = result.content?.find(block => block.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return undefined; }
}

function callProblem(name, result, data, product) {
  if (result.isError) {
    const text = result.content?.find(block => block.type === 'text')?.text;
    const code = typeof data?.code === 'string' ? data.code : /(?:오류|Error)\(([A-Z0-9_]+)\)/i.exec(text || '')?.[1];
    return { code: code || 'TOOL_ERROR', message: data?.message || text || name + ' 호출에 실패했습니다.' };
  }
  if (product && name === 'edit' && data && (data.failed?.length || data.rollback_error || data.stopped || data.complete_error)) {
    return { code: 'EDIT_INCOMPLETE', message: data.rollback_error || data.complete_error || '일부 편집을 완료하지 못했습니다. 응답의 실패와 저장 결과를 확인하세요.' };
  }
  return null;
}

export async function openTools(connection) {
  const { transport, timeout } = connection;
  const client = new Client({ name: 'office-tabs-cli', version: '1.0.0' });
  client.onerror = () => {}; // Request errors surface through the awaited call.
  const close = async () => {
    if (transport.sessionId) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  };
  try {
    await client.connect(transport, { timeout });
    const server = client.getServerVersion();
    const items = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      for (const tool of page.tools) items.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw problem('BAD_CATALOG', '서버가 같은 도구 목록 커서를 반복했습니다.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    function describe(name) {
      const tool = items.get(name);
      if (!tool) throw problem('TOOL_NOT_ADVERTISED', '현재 MCP 연결에서 제공하지 않는 도구입니다: ' + name);
      return tool;
    }
    async function call(name, args) {
      const tool = describe(name);
      let validate;
      try { validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema); }
      catch (error) { throw problem('BAD_TOOL_SCHEMA', '서버가 제공한 입력 스키마를 해석할 수 없습니다.', { cause: error }); }
      const input = validate(args);
      if (!input.valid) throw problem('BAD_ARGS', input.errorMessage || '도구의 입력 스키마와 인자가 일치하지 않습니다.');
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      const data = dataOf(result);
      const error = callProblem(name, result, data, server?.name === 'hwpx-cowork');
      return { ok: !error, tool: name, result, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) };
    }
    return { items: [...items.values()], server, describe, call, close };
  } catch (error) { await close(); throw error; }
}
