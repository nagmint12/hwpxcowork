// Isolated MCP laboratory. Never loads the installation's config.json or data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Service } from '../../server/service.js';
import { Store } from '../../server/store.js';
import { Hub } from '../../server/hub.js';
import { createDocumentOrchestration } from '../../server/orchestration-service.js';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const marker = '.hwpx-mcp-lab';

export function createLabRuntime({ keep = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-mcp-lab-'));
  const realTempDir = fs.realpathSync(tempDir);
  const nonce = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(tempDir, marker), nonce);
  const makeUser = (name, role) => ({ name, role, token: crypto.randomBytes(24).toString('hex') });
  const users = { owner: makeUser('lab-owner', 'editor'), other: makeUser('lab-other', 'editor'), admin: makeUser('lab-admin', 'admin') };
  const config = {
    root: repoRoot, configFile: path.join(tempDir, 'config.json'), dataDir: path.join(tempDir, 'data'),
    host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1:0', allowAgentApply: true,
    users: Object.values(users), ai: { enabled: false, mock: false, forcedOff: true, keyFile: null },
    attachments: { maxBytes: 52428800, maxTextChars: 200000, maxPerDoc: 100 },
    limits: { mcpResponseChars: 40000 }, agents: { leaseMinutes: 15, othersCanTake: false },
    changeRequests: { requireApprovals: 1, allowDirectApply: true },
    documents: { defaultEditMode: 'realtime' },
  };
  fs.mkdirSync(config.dataDir);
  fs.writeFileSync(config.configFile, JSON.stringify(config, null, 2));
  // A stub, not AiProposer: cannot read a key or launch any paid provider.
  const ai = { enabled: false, mock: false, reason: 'MCP laboratory: model execution belongs to the attached client.',
    run: async () => { throw new Error('The laboratory cannot call a model API.'); } };
  const service = new Service({ store: new Store(config.dataDir), hub: new Hub(), config, ai });
  service.orchestration = createDocumentOrchestration({ service, config });
  let queue = Promise.resolve(), closed = false;
  const runExclusive = fn => {
    const next = queue.then(() => { if (closed) throw new Error('Laboratory is closed'); return fn(); });
    queue = next.catch(() => {});
    return next;
  };
  return { service, config, users, tempDir, runExclusive,
    async close() {
      await queue; closed = true;
      if (!keep) {
        const actual = fs.realpathSync(tempDir);
        if (actual !== realTempDir || !path.basename(actual).startsWith('hwpx-mcp-lab-')
            || fs.readFileSync(path.join(actual, marker), 'utf8') !== nonce) throw new Error('Refusing to remove an unverified lab directory');
        fs.rmSync(actual, { recursive: true, force: true });
      }
    },
  };
}
