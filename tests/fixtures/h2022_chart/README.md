한/글 2022(12.0.0.3146) COM 실측 2026-11-11 — `tests/fixtures/chart_hangul.hwpx` 를 숨은 한/글로 열고 차트를 골라
`ChangeChart`(ChartObjShape ChartGroup/ChartIndex) 또는 `ChartLayoutList` 를 실행한 뒤 HWPX 로 다시 저장한 `Chart/chart1.xml`.
- hangul_kind_g{G}i{II}.xml: ChangeChart(G, II) 결과
- hangul_resave.xml: 손대지 않고 다시 저장한 꼴(ChartLayoutList 0 과 같다)
- hangul_layout*.xml: 차트 레이아웃(제목·범례·데이터 레이블·축 제목 꼴), hangul_pie_to_col.xml: 원형 → 묶은 세로 막대
- hangul_axis_title_h.xml: Run("PrimaryHorizontalAxisTitle") 뒤 저장본(가로 축 제목)
시험: tests/h2022_chart.test.mjs. 근거: research/hangul2022-features-20261111/impl/ledger_chart.md
