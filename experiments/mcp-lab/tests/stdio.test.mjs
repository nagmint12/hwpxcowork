import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standalone stdio launcher speaks clean MCP and creates an isolated request', { timeout: 30000 }, async () => {
  const client = new Client({ name: 'stdio-lab-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../serve.mjs', import.meta.url)), '--stdio', '--profile', 'focused'], stderr: 'pipe' });
  let diagnostics = '', workDir;
  transport.stderr.on('data', data => { diagnostics += data.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.ok(tools.tools.length < 20);
    const docs = await client.callTool({ name: 'list_documents', arguments: {} });
    assert.ok(!docs.isError);
    assert.ok(JSON.parse(docs.content[0].text).length > 0);
    for (const line of diagnostics.split('\n')) {
      try { const info = JSON.parse(line); if (info.lab) workDir = info.work_dir; } catch { /* renderer diagnostics are not transport */ }
    }
    assert.ok(workDir, diagnostics);
    assert.ok(fs.existsSync(path.join(workDir, 'connection.json')));
  } finally {
    await client.close();
    if (workDir) {
      const actual = fs.realpathSync(workDir), relative = path.relative(fs.realpathSync(os.tmpdir()), actual);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('hwpx-mcp-lab-'));
      assert.match(fs.readFileSync(path.join(actual, '.hwpx-mcp-lab'), 'utf8'), /^[0-9a-f]{48}$/);
      fs.rmSync(actual, { recursive: true, force: true });
    }
  }
});
