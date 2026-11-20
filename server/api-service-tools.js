// 서버에 등록한 개인 API 키도 CLI worker와 같은 MCP 도구를 쓴다. 운영 HTTP를 우회해 인메모리 연결만 만든다.
// surface 'v2'(새 MCP 연결 — server/mcp2.js, 2026-11-17): 같은 MCP 서버를 새 연결·도구 범위 core 로 열고(작업 도구 read·edit·finish + 그림·스킬 파일),
// 끝내는 호출(edit 의 done·finish) 뒤 요청 상태를 requestStatus 로 본다(server/api-mcp-tools.js).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isTaskSurface } from './tool-profiles.js';
import { createMcpServer } from './mcp.js';
import { createApiToolContext } from './api-mcp-tools.js';

export async function openServiceApiTools({ service, user, agent, docId, requestId, attempt, assertCurrent, profile, surface = null, requestStatus = null }) {
  const v2 = isTaskSurface(surface);
  const server = createMcpServer({ service, user, agentName: agent, session: `api-${requestId}`, ...(v2 ? { surface, toolset: 'core' } : {}) });
  const client = new Client({ name: 'hwpx-api-agent', version: '0.4.1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const context = await createApiToolContext({
      docId, requestId, attempt, assertCurrent,
      profile, ...(v2 ? { surface, requestStatus } : {}),
      listTools: () => client.listTools(),
      callTool: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120000 }),
      uploadFile: (file) => service.addRequestFile(docId, { ...file, rid: requestId }, user, agent),
    });
    return { context, close: async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); } };
  } catch (e) { await client.close().catch(() => {}); await server.close().catch(() => {}); throw e; }
}
