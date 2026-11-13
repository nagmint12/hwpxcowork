import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLabRuntime, repoRoot } from './runtime.mjs';
import { createLabGateway, createLabInstructionStore } from './gateway.mjs';
import { importAllowlistedSkill } from './instructions.mjs';
import { startLabHttp } from './http.mjs';

export function parseOptions(argv) {
  const options = { profile: 'focused', stdio: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--stdio') { options.stdio = true; continue; }
    if (flag === '--help') { options.help = true; continue; }
    const names = { '--profile': 'profile', '--port': 'port', '--document': 'document', '--instruction': 'instruction', '--skill-dir': 'skillDir' };
    if (!names[flag] || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[names[flag]] = argv[++i];
  }
  options.port = Number(options.port);
  if (!['focused', 'full'].includes(options.profile)) throw new Error('profile must be focused or full');
  return options;
}

export async function seedLab(runtime, options = {}) {
  const source = options.document ? path.resolve(options.document) : path.join(repoRoot, 'tests', 'fixtures', 'tool_memo_tracked.hwpx');
  const user = runtime.users.owner;
  const document = await runtime.service.createDocument({ fileName: path.basename(source), bytes: fs.readFileSync(source),
    title: 'MCP 실험 사본', user, location: { space: 'private' } });
  const doc = await runtime.service.store.doc(document.id);
  const first = doc.paragraphs({ nested: false, view: 'final' })[0];
  const instruction = options.instruction || '선택 문장의 표현을 검토하고 필요한 수정 한 건을 제안해줘.';
  const request = (await runtime.service.createRequest(document.id, { kind: 'instruct', route: 'queue', target: { ref: first.ref }, instruction }, user)).request;
  const store = runtime.instructionStore ||= createLabInstructionStore(runtime);
  const selected = [];
  if (options.skillDir) {
    const directory = fs.realpathSync(path.resolve(options.skillDir));
    const references = [];
    const walk = relative => {
      const absolute = path.join(directory, relative);
      if (!fs.existsSync(absolute)) return;
      for (const e of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = path.join(relative, e.name);
        if (e.isDirectory()) walk(child);
        else if (e.isFile() && /\.(md|txt)$/i.test(e.name)) references.push(child.replaceAll('\\', '/'));
      }
    };
    walk('references'); walk('reference');
    const skill = await importAllowlistedSkill({ store, userId: user.name, skillId: 'selected-skill', allowlist: {
      'selected-skill': { directory, name: path.basename(directory), source: 'user-selected-local-skill', references },
    } });
    selected.push(skill.skill_id);
  }
  await store.setTaskGuidance(user.name, { doc_id: document.id, request_id: request.rid,
    user_instruction: request.instruction, selected_skills: selected });
  return { doc_id: document.id, request_id: request.rid, selected_skills: selected };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log('node experiments/mcp-lab/serve.mjs [--stdio] [--profile focused|full] [--port 0] [--document COPY.hwpx] [--instruction TEXT] [--skill-dir DIRECTORY]');
    return;
  }
  const runtime = createLabRuntime({ keep: true }); let endpoint;
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await endpoint?.close(); await runtime.close(); };
  try {
    const seed = await seedLab(runtime, options);
    if (options.stdio) {
      endpoint = await createLabGateway({ runtime, profile: options.profile });
      await endpoint.server.connect(new StdioServerTransport());
      endpoint.server.onclose = () => { void stop(); };
    } else endpoint = await startLabHttp(runtime, { profile: options.profile, port: options.port });
    const connectionFile = path.join(runtime.tempDir, 'connection.json');
    fs.writeFileSync(connectionFile, JSON.stringify({ lab: true, production: false, profile: options.profile,
      transport: options.stdio ? 'stdio' : 'streamable-http', url: endpoint.base ? `${endpoint.base}/mcp` : null,
      bearer_token: options.stdio ? null : runtime.users.owner.token, ...seed }, null, 2));
    const summary = JSON.stringify({ lab: true, production: false, work_dir: runtime.tempDir, connection_file: connectionFile,
      ...(endpoint.base ? { url: `${endpoint.base}/mcp` } : {}), ...seed });
    if (options.stdio) process.stderr.write(`${summary}\n`); else process.stdout.write(`${summary}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
