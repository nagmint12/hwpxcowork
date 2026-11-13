# 개인용 앱 · PC 폴더 연결 · 함께 검토 (2026-11-10)

사용자 요청(2026-11-10): 지금은 문서를 "서버" 안에서 관리한다. 개인 사용자는 **자기 PC 의 폴더**와 이어 쓰고 싶다 — 탐색기의 파일에 저장하고,
혼자 고칠 때는 중앙 서버에 접속하지 않는다(개인이 서버를 직접 돌려도 좋고 다른 방식이어도 좋다). 토큰을 가진 사람은 지금처럼 특정 서버에 접속해
**모여서 검토**할 수도 있어야 한다. 빌드된 엔진 아래에서 개인이 실행하는 실행기(앱)를 만든다.

구현: `server/local-folders.js`(연결·훑기·파일 맞춤·함께 검토), `server/routes/local.js`(경로), `server/store.js`(정한 id·바이트 그대로 기록·`afterCommit`),
`server/library.js`(비친 폴더), `server/service.js`(목록·만들기·이름·옮기기·지우기·`replaceContent`), 화면 `web/local.js`·`web/app.js`(DocList)·`web/library.js`,
실행기 `deploy/portable/personal.mjs` + `deploy/portable/personal/`(시작 파일·안내), 묶음 `scripts/package-portable.mjs --target personal-lite`.
시험 `npm run test:personal`(= `tests/local_folders.test.mjs` + `tests/personal_app.test.mjs`).

## 1. 방안 검토

| 방안 | 내용 | 판단 |
|---|---|---|
| **A. 개인 PC 에서 서버를 직접 돌리고 PC 폴더를 문서함에 비춘다** (선택) | 개인용 앱이 127.0.0.1 서버(같은 엔진·편집기·MCP)를 켜고, 고른 폴더의 HWPX 를 개인 문서함에 보인다. 고치면 그 파일에 쓰고, 밖에서 바뀐 파일은 다시 읽는다 | 메모·변경 추적·AI 제안·이력·MCP 가 서버 쪽 코드(`service.js` 5천여 줄)에 있어 그대로 쓴다. 문서 파일은 PC 에만 있다. 모여서 검토는 문서를 중앙 서버로 보냈다가 가져온다 |
| B. 브라우저의 폴더 접근(File System Access API)으로 중앙 서버 화면이 내 PC 폴더를 직접 읽고 쓴다 | 서버 없이 브라우저가 파일을 연다 | 검토·AI·이력이 모두 서버에 있어 그 기능을 쓰려면 결국 문서를 서버에 올려야 한다(= 중앙 서버 접속). Chromium 전용이고 폴더 권한을 창마다 다시 물으며, 절대 경로를 알 수 없어 한/글과 같은 파일을 가리킨다는 보장이 약하다 |
| C. 중앙 서버의 개인 문서함 ↔ PC 폴더 동기화 도우미(개인 실행기가 올리고 내려받음) | 문서는 서버에 있고 PC 폴더에 사본을 맞춘다 | "중앙 서버에 접근하지 않는" 요구와 어긋난다(파일이 서버에 남는다). 양쪽 사본의 충돌 처리가 더 복잡하다 |
| D. 확장 프로그램판(`<repo>-local`, 서버 없음) | 브라우저 확장 + 네이티브 메시징으로 내 PC 의 AI | 이미 따로 있다. 서버 기능(실시간·MCP·이력)을 다시 만들어야 해 이 저장소의 기능과 갈라진다. 모여서 검토와 이어지지 않는다 |

A 를 골랐다: 새로 만드는 것은 "PC 폴더 ↔ 문서" 연결 한 층과 실행기뿐이고, 편집기·엔진·검토·AI 는 중앙 서버와 같은 코드를 쓴다. 같은 문서를
중앙 서버에 보내 검토하고 되받는 것도 두 서버가 같은 프로그램이라 REST 두 번이면 된다.

## 2. 구조

```
[개인용 앱 = personal-app.bat → app/portable/personal.mjs]
   ├─ 서버(server/index.js, 127.0.0.1:<포트>, 사용자 1명 = 관리자, config.local.enabled)
   │     ├─ 문서함: 개인 문서함 ▸ [PC] 내 문서 ▸ 하위 폴더 …   ← PC 폴더를 훑어 비춘 것(folders.json 의 local 폴더)
   │     ├─ 문서 기록: userdata-personal/data/docs/<id>/…        ← 연 문서만(이력·메모 묶음·AI 작업)
   │     └─ PC 파일 맞춤: 커밋 → PC 파일 쓰기 / PC 파일 바뀜 → 새 기록
   ├─ 앱 창(Edge·Chrome --app, 전용 프로필 userdata-personal/browser) — 닫으면 앱도 꺼짐
   └─ (선택) AI 실행기 scripts/ai-worker.mjs --url http://127.0.0.1:<포트>/mcp
[중앙 서버] ← 함께 검토: POST /api/docs(내 토큰) → 검토 → GET /api/docs/:id/file → 내 문서·PC 파일
```

- 기능은 `config.local.enabled`(또는 `HWPX_COWORK_LOCAL=1`)일 때만 켜진다. 기본은 꺼짐 — 중앙 서버에서는 켜지 않는다(서버 PC 의 폴더를 여는 기능이다).
- 연결·끊기·폴더 고르기·검토 서버·보내기·가져오기는 **관리자가 이 PC 에서 보낸 요청**만 받는다(`routes/local.js` `isSameMachine`: 소켓이 loopback,
  주소가 localhost, 프록시 머리글 없음, Origin 이 같은 주소). 터널을 거친 요청은 loopback 으로 보여도 거절한다.

## 3. 자료

- `<dataDir>/local-folders.json` `{ links: [{ id, path, name, owner, folderId, addedAt }], remotes: [{ id, name, url, user, token }] }`.
  - 연결 id = `k` + 경로 해시(Windows·macOS 는 대소문자 무시) — 같은 폴더를 다시 연결하면 같은 id 라 예전 문서 기록과 이어진다.
  - 검토 서버 토큰은 AES-256-GCM 암호문(열쇠는 config 옆 `.hwpx-cowork-secret` — 내 AI 키와 같은 파일). API 는 토큰을 돌려주지 않는다
    (그 서버를 여는 주소 `#/t/<토큰>` 만 이 PC 화면에 준다).
- **비친 폴더**: 연결한 폴더와 그 하위 폴더는 주인의 개인 문서함의 폴더 항목이다(`folders.json`, `local: { link, rel }`, id = `f` + 해시(연결 id + 길)).
  훑을 때마다 PC 폴더에 맞춰 만들고 뺀다(`Library.mirrorLocal`). 권한(공유)은 보통 폴더와 같다. HWPX 가 (아래에) 있는 폴더와 빈 폴더만 비춘다
  (깊이 7단계, 연결 하나에 2만 항목까지 — 넘으면 `truncated`). `.`·`~$`·`$` 로 시작하는 이름과 `.tmp`, 심볼릭 링크는 건너뛴다.
- **문서의 연결** `meta.local = { link, rel, size, mtimeMs, hash, version, state, syncedAt }` — `version` 은 PC 파일에 쓴 기록 번호, `hash` 는 그때 파일의 SHA-256.
  `state`: `ok` · `locked`(다른 프로그램이 잡고 있어 못 씀) · `unreadable`(밖에서 바뀐 파일을 읽지 못함). 문서 요약에는 `local: { state, path?(주인·관리자만), syncedAt }`
  — `state` 에 `file`(아직 열지 않은 파일)·`saving`(쓸 기록이 남음)이 더 있다.
- **보낸 곳** `meta.review = { remote, server, url, docId, sentAt, sentVersion, fetchedAt?, fetchedVersion?, fetchedKind? }`.

## 4. 규칙

1. **열 때 등록한다.** 폴더의 HWPX 는 목록에 문서 꼴로 보이지만(id = `L` + 해시(연결 id + 길), version 0, `local.state: 'file'`) 서버 데이터에는 없다.
   그 id 로 처음 부를 때(REST `/api/docs/:id…` 접근 문·MCP `doc_id`) 파일을 읽어 문서로 등록한다(`local.ensure`). 볼 수 없는 사람이 부르면 등록하지 않는다(404).
2. **고치면 PC 파일에 쓴다.** 커밋(`store.commit` → `afterCommit`)마다 그 문서의 맞춤을 예약하고(기본 1.5초 모음 — `local.writeDelayMs`), 문서 큐 안에서
   지금 기록(`current.hwpx`)을 같은 폴더의 임시 파일(`.~cowork-*.tmp`)에 쓴 뒤 바꿔 끼운다. PC 파일 = 문서의 지금 기록과 같은 바이트(메모·변경 추적 포함 — 한/글에서 그대로 열린다).
   서버를 끌 때는 남은 쓰기를 마치고(`flush`), 그러지 못하고 죽었으면 다음에 켤 때 마저 쓴다(`meta.version !== local.version`).
3. **PC 파일이 기준이다.** PC 파일의 크기·시각이 기록과 다르고 내용(SHA-256)도 다르면 밖에서 고친 것(한/글 저장)으로 보고 그 파일을 새 기록으로 **통째로** 읽는다
   (`service._replaceContent` — 그 바이트를 그대로 기록, 사람용 버전 하나, 열린 편집기는 다시 맞춘다). 앱에 아직 쓰지 않은 기록이 있었어도 PC 파일이 이기고,
   앱에서 고친 내용은 이력(기록 파일)에 남는다. 읽을 수 없는 파일이면 문서는 그대로 두고 `unreadable` 로 표시하며, 그 파일을 덮어쓰지 않는다.
   확인 시점: 문서 목록을 읽을 때(1.5초 안에는 다시 훑지 않음), 그 문서를 부를 때(`ensure` → `fresh` — 열면 늘 지금 파일), 열려 있는 문서는 4초마다.
4. **못 쓰면 기다린다.** 한/글이 파일을 열어 둔 동안에는 쓰기용 열기·바꿔 끼우기가 실패한다(EBUSY·EPERM·EACCES) → `locked`, 5초마다(문서 목록을 다시 읽으면 곧바로)
   다시 해 본다. 닫은 뒤 그 파일이 바뀌어 있으면 3번 규칙대로 PC 파일을 읽는다.
5. **탐색기에서 옮긴 파일은 같은 문서다.** 등록된 문서의 파일이 제자리에 없으면 크기와 SHA-256 이 같은 새 파일(같은 이름을 먼저)에 잇는다 — 제목이 옛 파일 이름이었으면
   새 이름으로. 못 찾으면(지운 파일) 그 문서는 목록에서 숨는다. 기록은 지우지 않는다(같은 자리에 파일이 다시 생기면 이어진다).
6. **앱에서 한 일은 PC 폴더에 그대로.** PC 폴더에 올리기·새 문서 = 그 폴더에 파일(같은 이름이면 `이름 (2)`), 문서 이름 바꾸기 = 파일 이름 바꾸기(못 쓰는 글자는 `_`,
   같은 이름이 있으면 409 `NAME_TAKEN`), 옮기기 = 파일 옮기기, 폴더 만들기·이름 바꾸기·옮기기(같은 연결 안)·빈 폴더 지우기 = 실제 폴더.
   서버 문서함 문서를 PC 폴더로 옮기면 그 폴더에 파일로 쓰고 잇는다. **PC 폴더 문서를 서버 문서함으로는 옮기지 않는다**(409 `LOCAL_ONLY` — 파일이 기준이라).
   문서 지우기 = PC 파일도 지운다: Windows 휴지통으로, 안 되면(또는 `local.trash: 'folder'`·`HWPX_COWORK_LOCAL_TRASH`) `<dataDir>/local-trash/` 로 — 완전히 지우지 않는다.
7. **연결 끊기는 문서함에서만 뺀다.** PC 의 파일과 앱의 문서 기록은 그대로 두고, 같은 폴더를 다시 연결하면 이어진다. 연결한 폴더 자체는 지우거나 옮기지 않는다(`LOCAL_ROOT`·`BAD_MOVE`),
   이름표만 바꾼다. 겹치는 폴더(이미 연결한 폴더의 안·밖), 드라이브 전체, 이 앱의 프로그램·데이터·설정 폴더(와 그 안)는 연결하지 않는다. 그것을 품은 폴더
   (앱을 풀어 둔 '문서' 폴더 등)는 연결하되 훑을 때 앱의 폴더만 건너뛴다 — 문서 기록 파일(`data/docs/…/*.hwpx`)이 문서로 보이지 않게.
8. **함께 검토.** 보내기 = 지금 기록(메모·변경 추적 포함)을 검토 서버에 새 문서로 올린다(`POST /api/docs`, `x-space`). 가져오기 = 그 서버 문서를 내려받아 3번과 같은 방식으로
   내 문서를 통째로 바꾼다(`tracked` = 서버 문서 그대로 — `kind=tracked`, `final` = 변경을 받아들인 글 + 메모 — `kind=final&reviews=1`). PC 폴더 문서면 곧 PC 파일에도 쓴다.
   다시 보내면 새 문서가 하나 더 생긴다(앞서 보낸 서버 문서는 그대로).

## 5. 경로

모두 `config.local.enabled` 일 때만 있다. ★ = 관리자 + 이 PC 요청만(403 `ADMIN_REQUIRED`·`SAME_PC_REQUIRED`).

| 경로 | 내용 |
|---|---|
| `GET /api/config` → `local: true|false` | 기능이 켜져 있는가 |
| `GET /api/library` → `local: { canLink, links: [{ id, folderId, name, path, owner, ok, truncated }], remotes: [{ id, name, url, user }] }` | 연결·검토 서버 목록(관리자·주인에게만) |
| `GET /api/local` | 위 `local` 만 |
| `POST /api/local/pick` ★ → `{ path|null }` | 이 PC 화면에 폴더 고르기 창(Windows 폴더 찾아보기 · macOS choose folder · Linux zenity) |
| `POST /api/local/links { path, name? }` ★ → `{ link, local }` | 400 `BAD_PATH` · 404 · 409 `LINKED`·`LINK_OVERLAP` |
| `DELETE /api/local/links/:id` ★ | 연결 끊기 |
| `POST /api/local/rescan` | 지금 다시 훑기 |
| `POST /api/local/remotes { url, token, name? }` ★ → `{ remote, local }` | 그 서버의 `/api/config`·`/api/me` 로 확인한 뒤 저장. 502 `REMOTE_UNREACHABLE`·`REMOTE_AUTH` |
| `DELETE /api/local/remotes/:id` ★ · `GET /api/local/remotes/:id/open` ★ → `{ url }` | 지우기 · 그 서버를 내 토큰으로 여는 주소 |
| `GET /api/docs/:id/review` ★ → `{ review, remote: { title, version, updatedAt, proposals, requests, changed }, openUrl }` | 보낸 서버 문서의 지금 상태 |
| `POST /api/docs/:id/review/send { remote, space }` ★ → `{ review, openUrl }` | 보내기 |
| `POST /api/docs/:id/review/fetch { kind }` ★ → `{ version, review }` | 검토본 가져오기 |

문서 요약(`GET /api/docs`·`/api/library`·`/api/docs/:id`)에 `local`·`review` 가 붙는다. WebSocket `{ type: 'doc', action: 'local', state }` = 파일 맞춤 상태가 바뀜(문서 정보만 다시 읽는다).

## 6. 화면(개인용 앱에서만)

- 문서함 도구 줄: **PC 폴더 연결**(폴더 고르기 · 경로 · 연결, 연결 목록과 [연결 끊기]) · **검토 서버**(주소 · 내 토큰 · 이름 → 등록, [열기]·지우기).
- 나무·목록: 연결한 폴더에 `PC` 꼬리표(올리면 경로), 문서 줄에 `PC`(상태가 있으면 `PC 저장 중`·`PC 쓰기 대기`·`PC 읽기 실패`), 보낸 문서에 서버 이름 꼬리표.
  연결한 폴더 줄은 옮기기·지우기 대신 [연결 끊기]. PC 폴더 문서·폴더의 옮기기 창에는 PC 폴더만 나온다.
- 문서 줄 **함께 검토**(위쪽 화살표): 서버·올릴 곳(개인/공용 문서함) → [보내기], 보낸 뒤 [서버에서 열기]·[검토본 가져오기](그대로/최종본)·`새 내용` 표시.
- 문서 화면 위 `PC` 알약(올리면 경로·저장 시각).
- 처음 연 화면: 기억해 둔 자리가 없으면 첫 연결 폴더를 연다. 설명서 `/help.html#local`.

## 7. 실행기

`personal-app.bat`(Windows — 최소화된 창) / `personal-app.sh` → `app/portable/personal.mjs [폴더 …] [--port] [--name] [--ai "<실행기 인자>"] [--no-window] [--keep]`.

1. 첫 실행: `userdata-personal/config.json` 을 만든다 — `host 127.0.0.1`, 빈 포트(기본 8790), 사용자 한 명(관리자, 무작위 토큰, 이름 = `--name` 또는 PC 사용자 이름),
   `local.enabled`, 실시간 수정·바로 적용, 서버 AI 끔, 체험(튜토리얼) 끔 — 첫 화면이 내 PC 폴더다. 예제 토큰·예제 사용자는 넣지 않는다.
2. 서버를 `server/launcher.js` 의 `startManagedServer` 로 켠다(저장을 마치는 정상 종료·장애 복구는 서버 묶음과 같다).
3. 준 폴더를 연결한다. 처음이고 폴더를 주지 않았으면 폴더 고르기 창을 띄운다.
4. 앱 창: Windows 는 Edge·Chrome 의 `--app` 창을 전용 프로필(`userdata-personal/browser`)로 연다 — 주소 `…/?teaser=0#/t/<토큰>` 이라 소개 영상·로그인이 없다.
   그 창 프로세스가 끝나면(창을 닫음) 앱도 끈다(`--keep` 이면 계속). 4초 안에 끝나면 창을 추적할 수 없는 것으로 보고 계속 켜 둔다. 그 밖의 OS 는 기본 브라우저.
5. 이미 떠 있으면(같은 설정 폴더) 폴더만 더 연결하고 창을 하나 더 열고 끝난다.
6. `--ai "--provider codex"`(또는 config `personal.ai`)면 개인 AI 실행기를 이 서버 주소로 함께 켠다(토큰은 환경 변수로만).
7. 끄기: 앱 창 닫기 · 최소화된 창 닫기 · Ctrl+C · 표준 입력 `quit`.

개발 폴더에서는 `npm run personal -- <폴더>`(설정·기록은 저장소의 `userdata-personal/` — `data/`·`config.json` 을 쓰지 않는다).
묶음: `npm run package:personal`(= `package:portable --target personal-lite`) → `hwpx-cowork-personal-<판>-<날짜>-lite.zip`(서버 묶음과 같은 `app/` + 개인용 시작 파일).

## 8. 확인한 것·하지 않은 것 (2026-11-10)

확인(임시 서버·임시 폴더, 모의 없음 — `npm run test:personal`, Windows 10 · Node 24.11.1): 연결·권한·경로 검사, 열기 전 미복사, 열기·메모·편집기 밀어 넣기 뒤 PC 파일 = 지금 기록,
밖에서 바뀐 파일 다시 읽기·읽을 수 없는 파일, 새 문서·올리기·이름·옮기기·지우기·폴더 동작, 탐색기에서 옮긴 파일 잇기, 연결 끊기·다시 연결, 공유, 죽은 뒤 마저 쓰기,
쓰기 잠김(한/글 대신 읽기만 나누고 파일을 열어 둔 프로세스로 흉내 — `locked` → 닫으면 저장), 두 서버 사이 보내기·가져오기, 실행기의 첫 설정·폴더 연결·두 번째 실행·`quit`·다시 켜기.

따로 한 번 확인(시험 묶음에는 없다):
- 묶음 `hwpx-cowork-personal-0.5.0-20261110-lite.zip` 을 한글·공백 경로에 풀고 그 안의 실행기를 창 없이 켬 → 첫 설정·폴더 연결·문서 열기·화면 파일·MCP `list_documents`·`quit`.
  이때 서버 묶음의 허용 목록에 `experiments/mcp-lab/*`(11-05 부터 `server/admin-mcp.js` 가 불러옴)이 빠져 풀린 서버가 시작하지 못하는 것을 찾아 고쳤다
  (`package-portable.mjs` — 묶기 전에 상대 import 를 따라가 확인하는 `checkRelativeImports` 도 더했다).
- 앱 창 수명(브라우저 고유 동작이라 실제 Edge 로): 전용 프로필 창을 띄운 동안 앱이 켜져 있고, 창에 닫기(WM_CLOSE)를 보내면 앱과 서버가 꺼진다(종료 코드 0).

하지 않은 것(미검증): 실제 한/글이 파일을 열어 둔 동안의 동작(위는 같은 꼴의 잠금 흉내)과 한/글에서 저장한 파일을 다시 읽는 실제 왕복, Windows 휴지통으로 보내기(시험은 폴더로 옮기기),
폴더 고르기 창이 실제로 뜨는 것(스크립트가 해석되고 창 개체를 만드는 데까지만 — 창을 띄우면 이 PC 화면을 막는다), 실제 AI 실행기와 함께 켜기(`--ai` 는 명령 구성만),
macOS·Linux, 화면(문서함의 PC 폴더 연결·검토 서버·함께 검토 창과 꼬리표)의 브라우저 조작 — 화면 코드는 문법 검사와 서버 응답 꼴까지만 봤다.

## 9. 남은 것·결정

- PC 파일에는 문서의 **지금 기록 그대로**(변경 추적·메모 포함)를 쓴다. 개인용 앱의 기본 문서 설정은 실시간·고친 글만이라 보통은 변경 추적이 없다.
  "최종본만 PC 에 쓰기" 같은 선택지는 두지 않았다.
- 여러 사람이 **내 PC 의 앱**에 접속해 검토하는 길(접속 범위 LAN·터널)은 서버 묶음의 기능 그대로 쓸 수 있고 PC 폴더를 폴더 권한으로 공유할 수 있지만,
  개인용 앱의 안내에는 넣지 않았다(모여서 검토는 중앙 서버로 보내기를 기본으로).
- 검토본을 가져올 때 내 쪽에서 그사이 고친 내용과 합치지 않는다(통째로 바꾸고 이력에 남긴다). 양쪽을 합치는 가져오기는 나중 일.
- 숨은 문서 기록(지운 파일·끊은 연결)을 정리하는 화면은 없다.
