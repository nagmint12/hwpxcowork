# 제3자 구성 요소 고지

## rhwp (MIT)

이 저장소의 `vendor/rhwp`(엔진·편집기 빌드에 필요한 원본 — `src`·`crates`·`vendor`·`rhwp-studio`·`rhwp-shared`·`npm`·`assets/fonts` 등)와
그 빌드 결과(`vendor/rhwp/pkg`, `studio/dist` 안의 WASM·편집기)는 [rhwp](https://github.com/edwardkim/rhwp)(Copyright (c) 2025-2026 Edward Kim, MIT)를
바탕으로 **고친 판**입니다. `vendor/rhwp/vendor/` 의 crate 들은 rhwp 가 들여온 제3자 코드로 각자의 라이선스를 따릅니다(각 폴더의 LICENSE).

- 바탕: rhwp v0.9.0(커밋 `c9095c5f67`)에 hwpx-cowork 의 수정(한/글 2022 동작 맞춤 — 소스에 `// [hwpx-cowork]` 표시)을 git 3-way 병합한 fork.
- rhwp 원저작자와 upstream 프로젝트는 이 수정판을 만들거나 보증하지 않았습니다. 문제는 이 저장소로 알려 주세요.
- 라이선스 전문: `vendor/rhwp/LICENSE`, rhwp 가 쓰는 구성 요소: `vendor/rhwp/THIRD_PARTY.md`·`vendor/rhwp/THIRD_PARTY_LICENSES.md`.

## 편집기 글꼴

`studio/dist/fonts/` 의 웹 글꼴은 각 글꼴의 배포 허용 라이선스(SIL OFL 등)를 따릅니다 — 목록과 라이선스: `studio/dist/fonts/FONTS.md`, `studio/dist/fonts/licenses/`.
배포가 허용되지 않은 글꼴 파일은 넣지 않았습니다(`scripts/font-distribution-policy.*` 로 검사).

## npm 의존성

`package.json` 의 의존성은 `npm ci` 로 받으며 각 패키지의 라이선스를 따릅니다(Vue·Express·MCP SDK 등).
