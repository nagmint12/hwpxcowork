// 서버에 등록한 개인 API 키도 CLI worker와 같은 MCP 도구를 쓴다. 운영 HTTP를 우회해 인메모리 연결만 만든다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import { createApiToolContext } from './api-mcp-tools.js';

export async function openServiceApiTools({ service, user, agent, docId, requestId, attempt, assertCurrent, profile }) {
  const server = createMcpServer({ service, user, agentName: agent, session: `api-${requestId}` });
  const client = new Client({ name: 'hwpx-api-agent', version: '0.4.1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const context = await createApiToolContext({
      docId, requestId, attempt, assertCurrent,
      profile,
      listTools: () => client.listTools(),
      callTool: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120000 }),
      uploadFile: (file) => service.addRequestFile(docId, { ...file, rid: requestId }, user, agent),
    });
    return { context, close: async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); } };
  } catch (e) { await client.close().catch(() => {}); await server.close().catch(() => {}); throw e; }
}
