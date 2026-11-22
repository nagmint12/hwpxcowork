# HWPX Cowork

한/글 문서를 웹에서 함께 편집하고, 각자의 구독 AI로 검토하는 HWPX 공동 작업 도구입니다. [rhwp](https://github.com/edwardkim/rhwp) 엔진을 바탕으로 한/글 호환성과 편집 성능을 개선했습니다.

![개인 구독 AI의 제안을 검토하는 화면, 한/글과 HWPX Cowork 사이의 양방향 복사, 80쪽 문서의 Enter 입력 시 엔진 처리 시간 개선 전 93ms와 개선 후 33ms](docs/assets/readme-overview.webp)

**[다운로드](https://github.com/nagmint12/hwpxcowork/releases)** · **[설치 안내](#설치--두-가지-길)** · **[상세 문서](docs/INSTALL_AND_DEV_GUIDE.md)**

## rhwp 기반으로 더한 세 가지

### 1. 각자의 구독 AI로 문서 함께 검토

각자 PC에서 **Codex**(ChatGPT 구독) 또는 **Claude Code**(Claude 구독)에 로그인해 연결합니다. 별도 API 키 없이 문서의 글이나 표를 AI에게 맡기고, 돌아온 제안과 메모를 검토할 수 있습니다. 공동 문서는 실시간으로 편집하거나 승인 후 변경을 반영할 수 있습니다. [구독 AI 연결 안내](docs/AUTOMATIC_AI_GUIDE.md)

### 2. 한/글 ↔ HWPX Cowork 복사·붙여넣기

글자 서식과 함께 **표의 병합 칸, 그림, 캡션**을 옮길 수 있습니다. 웹에서 한/글로 붙여넣을 때는 별도 도우미가 필요 없습니다. 한/글에서 웹으로 원본 구조를 가져오는 방식은 Windows 복사 도우미를 사용합니다. [환경별 지원 범위](docs/CLIPBOARD_AND_FORMAT_COPY.md#실행-환경별-지원)

### 3. 한/글 조판 호환성 및 엔진 성능 개선

한/글 2022 실측을 바탕으로 줄·쪽 나눔, 중첩 표와 개체 배치를 보완했습니다. 긴 문서의 편집에서는 이전 조판 결과를 재사용합니다. 예를 들어 80쪽 문서에서 Enter를 입력했을 때 엔진 처리 시간이 개선 전 **93ms**에서 개선 후 **33ms**로 줄었습니다. [조판과 성능 검증 기록](vendor/README.md)

## 설치 — 두 가지 길

- **Windows 설치 파일** · [Releases](https://github.com/nagmint12/hwpxcowork/releases)에서 `HwpxCowork-Setup-*.exe`를 내려받고 첫 실행에서 사용 방식을 고르세요.
- **VS Code의 Codex·Claude Code에 설치 맡기기** · Windows, macOS, Linux에서 [설치 요청문](docs/INSTALL_AND_DEV_GUIDE.md#2-vs-code-에이전트에게-맡기기--codex--claude-code)을 복사해 사용하세요.

설치한 앱의 **튜토리얼**에서 예시 응답으로 AI 검토 흐름을 연습할 수 있습니다.

[공동 서버 운영](docs/DEPLOYMENT_AND_AI_GUIDE.md) · [명령줄 편집](cli/README.md) · [엔진 빌드와 시험](docs/INSTALL_AND_DEV_GUIDE.md#엔진rhwp--빌드-결과와-원본)

[MIT 라이선스](LICENSE) · [제3자 고지](NOTICE.md) · [한글과컴퓨터 권리 고지](docs/INSTALL_AND_DEV_GUIDE.md#한글과컴퓨터-권리-고지)
