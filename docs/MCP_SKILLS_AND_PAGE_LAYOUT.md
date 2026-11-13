# 스킬 첨부와 쪽 구성 MCP

## 스킬 전달

기존 `.skill` 첨부는 `kind=other`, `text=null`로 저장되어 요청에는 이름·첨부 ID만 표시됐고 `read_attachment`에서 스킬 본문을 읽지 못했다. 원본 ZIP 자체는 첨부에 남아 있었다. 로컬 SKILL.md를 셸로 읽다가 실행 정책으로 거절된 문제와 별개이다.

이제 `.skill`에서 `SKILL.md`와 내부 자료 목록을 추출한다. 과거에 올린 첨부도 원본을 읽어 처리하므로 재첨부할 필요가 없다. 시스템의 셸·승인 정책은 바꾸지 않는다.

1. `get_request`에서 첨부 ID와 `skillGuide`를 확인한다.
2. `read_skill_resource(doc_id, attachment_id)`로 SKILL.md를 읽는다. 반환된 `resources`가 내부 자료 목록이다.
3. `next_from`이 있으면 `from`으로 끝까지 이어 읽는다. 참조 문서는 `resource="reference/서식명세.md"`처럼 묶음 안의 경로를 준다.
4. 템플릿·스크립트 원본은 `export_skill_resource(resource, request_id, expected_attempt)`로 꺼낸다. 반환된 `aid`는 기존 `download_attachment_file` 또는 `get_attachment_file`로 받는다.

사용자가 적용을 요청한 스킬만 지침으로 쓴다. 파일을 로컬 경로에 풀지 않으며 상위 경로·절대 경로를 거절한다. 파일 500개, 묶음 해제 크기 32MB, 읽는 자료 하나 8MB 한도를 적용한다.

## 새 문서

「새 문서로 시작」은 `server/templates/blank.hwpx`를 사용한다. 체험용 결과보고서의 표준 스타일 23개를 승계하고 본문·표·그림·머리말·꼬리말·바탕쪽·쪽 번호를 비운 한 구역/빈 문단 문서다. 이미 만든 문서의 내용은 바꾸지 않는다.

## 쪽 구성 편집

`get_page_layout(doc_id)`가 구역별 현재 값을 반환한다. `propose_page_layout(doc_id, ops, request_id, expected_attempt)`는 아래 작업을 순서대로 미리 검증하여 제안으로 남긴다. 단위는 mm, 구역·문단 번호는 0부터이다.

| op | 편집 내용 |
| --- | --- |
| `paper` | `width_mm`, `height_mm`, `orientation`, `margins`(left/right/top/bottom/header/footer/gutter) |
| `section` | `page_start`, `starts_on`, 첫쪽 머리말·꼬리말·바탕쪽·번호 감추기 |
| `split_section` | `before_ref` 문단 앞에서 구역 나누기 |
| `merge_section` | `section` 다음 구역과 합치기. 앞 구역 설정 사용 |
| `header`, `footer` | `text`, 문단 `style`, `apply_to`(BOTH/EVEN/ODD), `clear` |
| `page_number` | `position`, `format`, `side_char`, `start`, `clear` |
| `master_page` | `text`, 문단 `style`, 용지 전체 배경 그림 `attachment_id`, `apply_to`, `clear` |

```json
{
  "doc_id": "문서-ID",
  "request_id": 1,
  "expected_attempt": 1,
  "ops": [
    {"op":"paper","section":0,"orientation":"landscape","margins":{"left":20,"right":20}},
    {"op":"footer","section":0,"text":"대학혁신센터","style":"&꼬리말(홀)"},
    {"op":"page_number","section":0,"position":"BOTTOM_CENTER","start":3}
  ]
}
```

`clear=true`에서 `apply_to` 생략은 해당 구역의 해당 요소를 모두 제거한다. 구역 나누기 뒤 번호가 바뀌므로 뒤따르는 op에는 새 구역 번호를 쓴다. 변경은 기존 승인·직접 적용 권한과 이력을 따른다. 쪽 구성은 수정본에 텍스트로 반영하지 않고 「문서에 바로 적용」한다. 적용 직후 문서 상태가 그대로일 때 복구할 수 있고, 이후 문서·제안이 바뀌면 덮어쓰지 않도록 STALE을 반환한다. 이때 전체 이력 복구를 사용한다.

Codex 자동실행기의 MCP 허용 목록·준비 검사·작업 지침에 이 도구들을 연결했다. 문서·요청·시도 제한과 취소 검사는 그대로 적용된다. 서버 코드 변경 뒤 서버를 재시작하고 MCP 클라이언트를 다시 연결한다. 실행 중인 Codex BAT도 다시 실행하면 새 지침을 읽는다.

## 검증

`node --test tests/page_layout_skill.test.mjs` 및 `node tests/api_newdoc.mjs`.

한글 COM에서 빈 문서가 내용 없는 1쪽으로 열리고 표준 스타일 23개를 유지함을 확인했다. 가로 용지·여백·머리말·꼬리말·시작 번호 3·그림 바탕쪽을 설정한 파일도 한글 재저장 후 값이 유지되고 PDF에서 실제로 표시됐다. 재검증 도구는 `python -I tests/hangul_roundtrip.py <입력.hwpx> <임시출력폴더> --pdf`다.
