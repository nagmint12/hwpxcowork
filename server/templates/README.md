# 새 문서 기본 양식

`blank.hwpx`는 `tutorial/결과보고서.hwpx`(체험 문서 「결과보고서 — test1」의 원본)의 서식 정의를 승계한 빈 대학혁신센터 표준서식이다.

- 23개 문단 스타일과 글자·문단·표 서식, 본문 구역의 용지·여백을 유지한다.
- 본문은 바탕글(Noto Sans KR, 10pt)로 시작하는 빈 문단 하나이며 구역은 하나이다.
- 본문 내용, 표·그림과 바이너리, 머리말·꼬리말, 바탕쪽, 쪽 번호, 미리보기와 문서 제목 메타데이터를 제거한다.
- `mimetype`, `version.xml`은 첫 두 항목이며 무압축이다.

재생성: `node scripts/build-blank-template.mjs`

주의: 구역 정의(secPr)·단 정의(colPr)는 텍스트 없는 전용 run에 둔다. 같은 run에 빈 hp:t를 넣으면 실제 한글이 용지·여백·시작 쪽 번호·바탕쪽을 초기화한다. `tests/page_layout_skill.test.mjs`와 한글 COM 재저장/PDF 출력으로 확인했다.
