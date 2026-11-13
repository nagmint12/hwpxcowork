# hwpx-cowork 서버 (Linux · Ubuntu 22.04 기준)

HWPX(한글) 문서를 브라우저에서 함께 열고 메모·변경 추적·AI 제안(MCP)으로 공동 검토하는 서버입니다. 미리 빌드한 편집기·엔진(WASM)이 들어 있어 npm 설치·빌드가 필요 없습니다.

**Node.js 22 이상**이 필요합니다. 이미 설치되어 있으면 그것을 쓰고(lite 판), 없으면 `./install-node.sh` 한 번으로 공식 Node.js 를 이 폴더 `runtime/` 에 받습니다(약 30 MB, SHA-256 확인, 시스템 변경 없음). **Ubuntu 22.04 의 `apt install nodejs` 는 12판이라 쓸 수 없습니다.** `-linux-x64` 판에는 `runtime/bin/node` 가 이미 들어 있습니다(인터넷이 막힌 서버용). glibc 2.28 이상(Ubuntu 20.04/22.04/24.04, Debian 11+, RHEL 8+)에서 실행됩니다.

## 1. 바로 켜 보기(앞에서 실행)

```sh
tar -xzf hwpx-cowork-server-*-lite.tar.gz           # 또는 *-linux-x64.tar.gz → hwpx-cowork-server/
cd hwpx-cowork-server
./install-node.sh                                   # Node 22+ 가 없을 때만(curl 또는 wget 필요)
HWPX_COWORK_HOST=0.0.0.0 ./start-server.sh          # LAN 에서 바로 접속할 때만 HOST 지정
```

처음 실행하면 관리자 로그인 토큰을 직접 정하라고 묻습니다(비워 두면 무작위). `HWPX_COWORK_ADMIN_TOKEN=원하는-토큰` 으로 미리 줄 수도 있습니다. 그다음 `userdata/config.json`(계정·설정)과 `userdata/data/`(문서)를 만듭니다. 브라우저에서 `http://서버주소:8787/` 로 접속해 로그인한 뒤 **[관리자]** 에서 참여자 계정을 만듭니다. Ctrl+C 로 끕니다.

## 2. 서비스로 운영(권장)

```sh
sudo useradd --system --home-dir /var/lib/hwpx-cowork --shell /usr/sbin/nologin hwpx
sudo tar -xzf hwpx-cowork-server-*-lite.tar.gz -C /opt               # → /opt/hwpx-cowork-server
sudo /opt/hwpx-cowork-server/install-node.sh                         # Node 22+ 가 없을 때만
sudo install -d -o hwpx -g hwpx -m 700 /var/lib/hwpx-cowork          # 설정·문서 폴더(프로그램과 분리)
sudo cp /opt/hwpx-cowork-server/deploy/hwpx-cowork.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hwpx-cowork
sudo cat /var/lib/hwpx-cowork/config.json        # 첫 실행 관리자 토큰(users[0].token) 확인
journalctl -u hwpx-cowork -f                       # 로그
```

서비스는 `127.0.0.1:8787` 에서만 듣습니다. 외부 접속은 같은 서버의 HTTPS 프록시로 엽니다.

## 3. HTTPS 공개(Caddy) — ChatGPT 연결에 필요

```sh
sudo apt install -y caddy
sudoedit /etc/caddy/Caddyfile          # deploy/Caddyfile.example 처럼: hwpx.기관도메인 { reverse_proxy 127.0.0.1:8787 }
sudo systemctl reload caddy
```

도메인의 DNS 가 이 서버를 가리키고 방화벽에서 80·443 이 열려 있어야 인증서가 자동 발급됩니다. 그다음 웹 **[관리자] → 외부 공유 주소** 에 `https://hwpx.기관도메인` 을 저장·재시작합니다(OAuth·MCP 주소가 이 값을 씁니다).

## 4. AI 연결

| 클라이언트 | 연결 |
|---|---|
| ChatGPT 웹 | 설정에서 사용자 지정 MCP 커넥터 추가(주소 `https://도메인/mcp`, 인증 OAuth) → 본인 hwpx 토큰으로 승인. 메뉴 이름은 계정·버전마다 다르고 워크스페이스 관리자의 허용이 필요 |
| Claude Code | `claude mcp add --transport http hwpx https://도메인/mcp --header "Authorization: Bearer <내 토큰>"` |
| Codex CLI 등 | 같은 MCP 주소 + `Authorization: Bearer <내 토큰>` |
| 자동 처리 | 참여자 PC 에서 `hwpx-ai-worker`(개인 AI 실행기) 실행 |

## 5. 선택 기능

```sh
sudo apt install -y python3-matplotlib fonts-nanum     # 차트 그림(propose_figure chart). 없으면 차트만 안 됨
```

## 6. 업데이트·백업

- 업데이트: `sudo systemctl stop hwpx-cowork` → 새 tar 를 풀어 `/opt/hwpx-cowork-server` 를 바꿈 → `start`. `/var/lib/hwpx-cowork` 는 그대로 둡니다.
- 백업: `/var/lib/hwpx-cowork` 를 통째로(서비스를 끄거나 스냅샷으로). 토큰·암호화 비밀 파일이 들어 있으니 접근을 제한합니다.

## 7. 사양(Ubuntu 22.04 컨테이너, 1 vCPU·1 GiB 제한에서 실측)

- 디스크: 프로그램(app) 118 MiB + Node 런타임 116 MiB(install-node 또는 포함판) + 문서 데이터(HWPX 7 MB 두 건 → 17 MiB, 편집 이력만큼 증가)
- 관리자 앱(켜기·끄기 창)은 Windows 데스크톱용입니다. 리눅스 서버는 `systemctl start|stop|restart hwpx-cowork` 로 관리합니다.
- 메모리(RSS): 대기 약 150 MiB(관리 프로세스 48 + 서버 105), 큰 보고서 2건을 올리고 MCP 로 40번 읽은 뒤 약 280 MiB
- 권장: 시범·소규모(10명 안팎) 1 vCPU·2 GB·디스크 20 GB(OS 포함), 부서 단위 동시 편집 2 vCPU·4 GB 이상
