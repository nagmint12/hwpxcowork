// Experimental local file bridge. Bytes move between isolated work files and
// request attachments without appearing in model text or overwriting documents.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const ALLOWED = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.xlsx', '.docx', '.pptx', '.hwpx', '.zip', '.skill']);
const canonicalPath = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const within = (root, file) => {
  const rel = path.relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const checkedName = value => {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value) || /[ .]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    fail('BAD_FILE_NAME', 'Use a plain file name without path or device syntax.');
  }
  if (!ALLOWED.has(path.extname(value).toLowerCase())) fail('FILE_TYPE_NOT_ALLOWED', 'This file extension is not allowed in the laboratory.');
  return value;
};
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** Synchronous factory for the gateway. Work directories are made lazily and
 * remain owned by runtime.close(). Every handler rechecks live request access. */
export function createLocalFileTools({ runtime, user, session }) {
  if (!runtime?.tempDir || !runtime.service || !user?.name || typeof session !== 'string' || !session) fail('BAD_CONFIG', 'An isolated runtime, user and bound session are required.');
  const service = runtime.service;
  const ownerHash = hash(JSON.stringify([user.name, user.token])).slice(0, 32);
  const directory = path.join(runtime.tempDir, 'work', ownerHash);
  const maxBytes = Math.min(52_428_800, runtime.config.attachments?.maxBytes || 52_428_800);
  let closed = false;
  function root() {
    if (closed) fail('FILES_CLOSED', 'The file bridge is closed.');
    const temp = fs.realpathSync(runtime.tempDir);
    if (canonicalPath(temp) !== canonicalPath(path.resolve(runtime.tempDir))) fail('OUTSIDE', 'The laboratory directory changed.');
    let current = temp;
    for (const part of ['work', ownerHash]) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath(fs.realpathSync(current)) !== canonicalPath(current)) fail('OUTSIDE', 'Work directories cannot be links.');
    }
    return current;
  }
  function assertPath(file, { regularFile = true } = {}) {
    const base = root();
    if (!within(base, file)) fail('OUTSIDE', 'Only this user’s isolated work directory is accessible.');
    let current = base;
    for (const part of path.relative(base, file).split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('OUTSIDE', 'Symbolic links and directory junctions are not allowed.');
    }
    if (canonicalPath(fs.realpathSync(file)) !== canonicalPath(file)) fail('OUTSIDE', 'The work path resolves elsewhere.');
    const stat = fs.statSync(file);
    if (regularFile && (!stat.isFile() || stat.nlink !== 1)) fail('NOT_FILE', 'Use a regular work file, without hard links.');
    return stat;
  }
  function prepareDirectory(relative) {
    let current = root();
    for (const part of relative) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      assertPath(current, { regularFile: false });
      if (!fs.statSync(current).isDirectory()) fail('NOT_DIRECTORY', 'Work folder is not a directory.');
    }
    return current;
  }
  function bound(args, allowed) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) fail('BAD_ARGS', 'Unexpected file tool arguments.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.doc_id || '') || !Number.isSafeInteger(args.request_id) || args.request_id < 1
      || !Number.isSafeInteger(args.expected_attempt) || args.expected_attempt < 1) fail('BAD_ARGS', 'doc_id, request_id and expected_attempt are required.');
    root();
    service.assertDocRead(args.doc_id, user);
    return { ...user, agentSession: session, agentAttempt: args.expected_attempt };
  }
  function readWorkFile(file) {
    const before = assertPath(file);
    if (!before.size) fail('EMPTY', 'The work file is empty.');
    if (before.size > maxBytes) fail('TOO_LARGE', 'The work file exceeds the attachment size limit.');
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || !opened.isFile() || opened.size !== before.size) fail('FILE_CHANGED', 'The file changed while opening.');
      assertPath(file);
      const bytes = fs.readFileSync(fd);
      if (!bytes.length || bytes.length > maxBytes || bytes.length !== before.size) fail('FILE_CHANGED', 'The file changed while reading.');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  async function download(args) {
    const actor = bound(args, ['doc_id', 'request_id', 'expected_attempt', 'attachment_id']);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.attachment_id || '')) fail('BAD_ARGS', 'A valid attachment ID is required.');
    service.requestFileAccess(args.doc_id, args.request_id, args.attachment_id, actor);
    const { entry, bytes } = await service.getAttachment(args.doc_id, args.attachment_id);
    const name = checkedName(entry.name);
    if (!bytes.length || bytes.length > maxBytes) fail('TOO_LARGE', 'The attachment is empty or exceeds the file size limit.');
    // Recheck after the asynchronous attachment retrieval and before creating a file.
    service.requestFileAccess(args.doc_id, args.request_id, args.attachment_id, actor);
    const sha256 = hash(bytes);
    const incoming = prepareDirectory(['in', args.doc_id, `${args.request_id}-${args.expected_attempt}`]);
    const file = path.join(incoming, `${entry.aid}-${sha256.slice(0, 16)}-${name}`);
    if (fs.existsSync(file)) {
      if (hash(readWorkFile(file)) !== sha256) fail('FILE_CHANGED', 'An existing download differs from its attachment; it was not overwritten.');
    } else fs.writeFileSync(file, bytes, { flag: 'wx' });
    assertPath(file);
    const out_dir = prepareDirectory(['out']);
    return textResult({ path: file, name, size: bytes.length, mime: entry.mime, sha256, out_dir });
  }
  async function upload(args) {
    const actor = bound(args, ['doc_id', 'request_id', 'expected_attempt', 'path', 'file_name']);
    // Validate ownership, current attempt, open request and bound claim before
    // reading local bytes. addRequestFile checks them again inside its write lock.
    service.requestResultFile(args.doc_id, args.request_id, 'lab-preflight', actor, 'MCP Lab');
    if (typeof args.path !== 'string' || !args.path || /\u0000/.test(args.path) || args.path.split(/[\\/]/).includes('..')) fail('OUTSIDE', 'Use a path inside the work directory without parent traversal.');
    const file = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(root(), args.path);
    if (!within(root(), file)) fail('OUTSIDE', 'Only this user’s isolated work directory is accessible.');
    const sourceName = checkedName(path.basename(file));
    const name = checkedName(args.file_name ?? sourceName);
    const extension = value => path.extname(value).toLowerCase().replace('.jpeg', '.jpg');
    if (extension(sourceName) !== extension(name)) fail('FILE_TYPE_MISMATCH', 'The display name must preserve the source file extension.');
    const bytes = readWorkFile(file), sha256 = hash(bytes);
    const saved = await service.addRequestFile(args.doc_id, { rid: args.request_id, sourceFileId: `sha256:${sha256}`, name, bytes }, actor, 'MCP Lab');
    return textResult({ aid: saved.aid, name: saved.name, size: saved.size, mime: saved.mime, sha256, duplicate: saved.duplicate === true });
  }
  const scope = { doc_id: { type: 'string' }, request_id: { type: 'integer', minimum: 1 }, expected_attempt: { type: 'integer', minimum: 1 } };
  return { directory, tools: [
    { name: 'download_attachment_file', description: 'Copy this request’s original/result attachment into your isolated local work folder. Returns a local path and out_dir; bytes do not enter model text. request_id and expected_attempt are required. Client must have access to this server’s local filesystem.',
      inputSchema: { type: 'object', additionalProperties: false, required: [...Object.keys(scope), 'attachment_id'], properties: { ...scope, attachment_id: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, handler: download },
    { name: 'upload_result_file', description: 'Save a real file inside your isolated work folder as this request’s result attachment. Returns aid for propose_figure. Accepts path and optional file_name; bytes bypass model text. Requires current attempt and bound request claim. Does not replace the HWPX document.',
      inputSchema: { type: 'object', additionalProperties: false, required: [...Object.keys(scope), 'path'], properties: { ...scope, path: { type: 'string' }, file_name: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, handler: upload },
  ], close() { closed = true; } };
}
