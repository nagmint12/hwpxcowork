// Local Codex connector: credentials stay in the existing server configuration.
// The remote transport remains the server's HTTPS administrator-only MCP route.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, installShutdown } from './bridge.js';
import { ADMIN_MCP_PATH } from './admin-mcp.js';
import { createDebugStdioTransport } from './ai-debug.js';

export function adminConnection({ configFile, adminName, filesDir, full = false } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const file = configFile || path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const admin = config.users?.find(user => user.role === 'admin' && user.token && (!adminName || user.name === adminName));
  if (!admin) throw new Error('지정한 관리자 계정을 찾을 수 없습니다.');
  const url = new URL(config.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('관리자 실험 연결에는 기존 공개 HTTPS 주소가 필요합니다.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${ADMIN_MCP_PATH}${full ? '/full' : ''}`;
  return { url: url.href, token: admin.token, agent: 'Codex Admin Test',
    filesDir: filesDir || path.join(process.env.LOCALAPPDATA || os.homedir(), 'hwpx-cowork', 'admin-mcp-files') };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = { '--config': 'configFile', '--admin': 'adminName', '--files-dir': 'filesDir' }[argv[i]];
    if (argv[i] === '--full') { options.full = true; continue; }
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('관리자 MCP 실행 옵션을 확인하세요.');
    options[name] = argv[++i];
  }
  const bridge = await createBridge({ ...adminConnection(options), channel: false, forwardToolListChanges: true,
    log: () => {} }); // Do not echo configuration, credentials or document content.
  installShutdown(bridge);
  await bridge.start(createDebugStdioTransport(StdioServerTransport, { context: { route: 'admin-mcp-wire', session: bridge.session } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('[hwpx admin MCP] 연결 설정 또는 서버 상태를 확인하세요.\n'); process.exitCode = 1; });
}
