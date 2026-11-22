// A local MCP host starts this small client with the bundled Node. The desktop
// app is the only writer of its profile. After authentication the pipe carries
// the MCP stdio framing unchanged to the same Service that owns the editor.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readPipeSession, pipeHeader } from './desktop-pipe.js';

async function connect() {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, mcp: { type: 'string' }, tools: { type: 'string' }, agent: { type: 'string' }, lean: { type: 'boolean' } } });
  if (!values.profile || !path.isAbsolute(values.profile)) throw Error('--profile 뒤에 앱의 개인 문서함 설정 경로를 지정하세요.');
  if ((values.mcp && !['1', '2', '3'].includes(values.mcp)) || (values.tools && !['core', 'all'].includes(values.tools))) throw Error('--mcp 1|2|3 및 --tools core|all 중에서 선택하세요.');
  const session = readPipeSession(values.profile);
  const cfg = JSON.parse(fs.readFileSync(path.join(values.profile, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const user = cfg.users?.find(u => u.role === 'admin');
  if (!user?.token || cfg.personal?.app !== true) throw Error('개인용 앱의 문서함을 선택하세요.');
  const query = new URLSearchParams();
  if (values.lean) query.set('lean', '1');
  for (const [key, value] of [['v', values.mcp], ['tools', values.tools], ['agent', values.agent]]) if (value) query.set(key, value);
  const stream = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: session.socketPath, path: '/local/stdio?' + query, headers: {
      Host: 'localhost', Authorization: 'Bearer ' + user.token, [pipeHeader]: session.key, Connection: 'Upgrade', Upgrade: 'hwpx-stdio',
    } });
    const timer = setTimeout(() => req.destroy(Error('앱이 연결 요청에 응답하지 않았습니다.')), 10000);
    req.on('upgrade', (res, socket, head) => { clearTimeout(timer); if (head.length) socket.unshift(head); resolve(socket); });
    req.on('response', r => { clearTimeout(timer); r.resume(); reject(Error('개인 연결을 열 수 없습니다 (' + r.statusCode + ').')); });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
  const finish = () => { process.stdin.unpipe(stream); process.stdin.pause(); stream.destroy(); };
  stream.once('error', finish);
  stream.once('close', finish);
  process.stdin.once('end', () => stream.end());
  process.stdout.once('error', finish);
  process.stdin.pipe(stream);
  stream.pipe(process.stdout);
}

connect().catch(error => {
  const offline = ['ENOENT', 'ECONNREFUSED', 'ENOTDIR'].includes(error.code);
  process.stderr.write((offline ? 'Hwpx Cowork에서 혼자 쓰기 → 포트 없이 편집을 열어 주세요.' : error.message) + '\n');
  process.exitCode = 1;
});
