// 읽기 전용 진단. loadConfig를 쓰지 않으므로 config가 없을 때 파일을 생성하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectionInfo } from '../server/connections.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('사용법: node scripts/connection-info.mjs [--json]\n설정과 실제 네트워크에서 웹·MCP 접속 주소 후보를 읽습니다. 서버를 시작하거나 설정·방화벽을 바꾸지 않습니다.');
} else if (argv.some((arg) => arg !== '--json')) {
  console.error('지원하지 않는 인자입니다. --help로 사용법을 확인하세요.'); process.exitCode = 2;
} else {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = process.env.HWPX_COWORK_CONFIG ? path.resolve(root, process.env.HWPX_COWORK_CONFIG) : path.join(root, 'config.json');
    const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    const raw = JSON.parse(text);
    const publicUrl = process.env.HWPX_COWORK_PUBLIC_URL || raw.publicUrl;
    const cfg = {
      host: process.env.HWPX_COWORK_HOST || raw.host || '127.0.0.1',
      port: Number(process.env.HWPX_COWORK_PORT || (raw.port ?? 8787)),
      publicUrl, publicUrlAuto: !publicUrl,
    };
    const info = buildConnectionInfo(cfg, { interfaces: os.networkInterfaces() });
    if (argv.includes('--json')) console.log(JSON.stringify(info, null, 2));
    else {
      console.log('설정 기준 연결 안내입니다. 서버 실행 여부와 다른 PC의 접속 성공은 확인하지 않았습니다.');
      console.log(`서버 바인딩: ${info.binding.host}:${info.binding.port ?? '(시작 후 확정)'}\n${info.binding.message}`);
      console.log(`서버 PC 웹: ${info.local.webUrl || '(포트 확인 필요)'}`);
      for (const candidate of info.lan) console.log(`LAN 웹 후보 (${candidate.label}): ${candidate.webUrl}\nLAN MCP 후보: ${candidate.mcpUrl}\n  ${candidate.note}`);
      console.log(info.external.configured ? `인터넷 웹(연결 미검증): ${info.external.webUrl}\n인터넷 MCP: ${info.external.mcpUrl}` : info.external.message);
      if (info.recommended.selectionRequired) console.log(info.recommended.message);
      else console.log(`추천 웹: ${info.recommended.webUrl || '(포트 확인 필요)'}\n추천 MCP: ${info.recommended.mcpUrl || '(포트 확인 필요)'}`);
      for (const warning of info.warnings) console.log(`안내: ${warning.message}`);
      for (const guide of info.guidance) console.log(`- ${guide}`);
    }
  } catch {
    console.error('연결 설정을 읽지 못했습니다. 설정 파일의 존재 여부와 JSON 형식을 확인하세요. 파일과 설정을 자동으로 만들거나 변경하지 않았습니다.');
    process.exitCode = 1;
  }
}
