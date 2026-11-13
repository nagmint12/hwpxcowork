// [hwpx-cowork 포터블] 시작 도우미가 부르는 첫 실행 준비·앱 창 열기. 배포물에서는 app/portable/portable.mjs 에 놓인다.
//   node app/portable/portable.mjs init   → userdata/config.json 이 없으면 만들고(관리자 토큰 새로 뽑음) 접속 안내를 보인다.
//                                            이미 이 서버가 켜져 있으면 종료 코드 3(시작 도우미는 창만 연다)
//   node app/portable/portable.mjs open   → 서버가 답할 때까지 기다렸다가 사용자 앱 창(Edge/Chrome --app) 또는 기본 브라우저로 연다
//   node app/portable/portable.mjs port   → 쓸 포트만 출력
// 서버에는 시작 도우미가 HWPX_COWORK_CONFIG 로 userdata 안의 config.json 을 넘긴다. 이미 있는 config.json 은 고치지 않는다.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { userDir, configFile, readConfig, portOf, ensureConfig, prepareConfig, portState, adminToken, openWindow, TOKEN_RE, TOKEN_RULE } from './portable-lib.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 첫 실행이고 사람이 보는 창이면 관리자 토큰을 직접 정하게 묻는다(비우면 자동). 서비스·HWPX_COWORK_ADMIN_TOKEN 이면 묻지 않는다 */
async function askAdminToken() {
  if (fs.existsSync(configFile) || process.env.HWPX_COWORK_ADMIN_TOKEN || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log(` [처음 실행] 관리자 로그인 토큰을 정하세요(${TOKEN_RULE}).`);
    for (;;) {
      const answer = (await rl.question('  관리자 토큰(비워 두면 자동으로 만듭니다): ')).trim();
      if (!answer || TOKEN_RE.test(answer)) return answer;
      console.log(`  형식이 맞지 않습니다 — ${TOKEN_RULE}`);
    }
  } finally { rl.close(); }
}

async function init() {
  const { token, cfg, moved } = await prepareConfig(await askAdminToken());
  const port = portOf(cfg);
  if (moved) console.log(`포트 ${moved.from} 을 다른 프로그램이 쓰고 있어 이 서버는 ${moved.to} 을 씁니다(userdata\\config.json 의 port).`);
  const state = await portState(port, adminToken(cfg));
  if (state === 'ours') {
    console.log(`이미 켜져 있습니다: http://localhost:${port}/  (끄려면 stop-server 또는 관리자 앱)`);
    return 3;
  }
  if (state !== 'free') {
    console.log(`[오류] 포트 ${port} 을 ${state === 'other' ? '다른 hwpx-cowork 서버(예: 개발용 서버)가' : '다른 프로그램이'} 쓰고 있습니다.`);
    console.log(`       그 프로그램을 끄거나, ${configFile} 의 "port" 를 바꾸거나, 관리자 앱의 [빈 포트로 켜기]를 쓰세요.`);
    return 4;
  }
  console.log('');
  console.log(' hwpx-cowork 포터블 서버');
  console.log(`  - 설정·문서 폴더: ${userDir}`);
  console.log(`  - 이 PC에서 열기: http://localhost:${port}/`);
  console.log(`  - MCP 주소(AI 연결): http://localhost:${port}/mcp`);
  console.log(`  - 접속 범위: ${cfg.host === '127.0.0.1' || cfg.host === 'localhost' ? '이 PC만(관리자 화면에서 LAN·외부 공유로 바꿀 수 있음)' : cfg.host}`);
  if (token) {
    console.log('');
    console.log('  [처음 실행] 관리자 계정을 만들었습니다.');
    // 서비스 로그(journald 등)에 토큰이 남지 않게, 사람이 보는 창일 때만 보여 준다
    if (process.stdout.isTTY) console.log(`  관리자 로그인 토큰: ${token}`);
    else console.log(`  관리자 로그인 토큰은 ${configFile} 의 users[0].token 에 있습니다.`);
    console.log('  이 토큰으로 로그인한 뒤 [관리자]에서 참여자 계정을 만드세요.');
  }
  console.log('');
  return 0;
}

async function open() {
  if (!fs.existsSync(configFile)) { console.log('아직 서버를 켠 적이 없습니다. 관리자 앱(admin-app) 또는 start-server 로 먼저 켜세요.'); return 1; }
  const cfg = readConfig();
  const port = portOf(cfg);
  const url = `http://localhost:${port}/`;
  const waitMs = Number(process.env.HWPX_COWORK_OPEN_WAIT_MS || 60000);
  for (const started = Date.now(); Date.now() - started < waitMs; await sleep(500)) {
    if (await portState(port, adminToken(cfg)) === 'ours') {
      if (!openWindow(url)) console.log(`브라우저에서 여세요: ${url}`);
      return 0;
    }
  }
  console.log(`서버가 답하지 않습니다(${url}). 관리자 앱(admin-app) 또는 start-server 로 먼저 켜세요.`);
  return 1;
}

const command = process.argv[2] || 'init';
try {
  if (command === 'init') process.exitCode = await init();
  else if (command === 'open') process.exitCode = await open();
  else if (command === 'port') { ensureConfig(); console.log(portOf(readConfig())); }
  else { console.error('사용법: portable.mjs init|open|port'); process.exitCode = 2; }
} catch (error) {
  console.error(`[hwpx-cowork] 포터블 준비 실패: ${error.message}`);
  process.exitCode = 1;
}
