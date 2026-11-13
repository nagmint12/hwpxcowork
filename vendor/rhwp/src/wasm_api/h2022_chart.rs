//! [hwpx-cowork] 한/글 2022 차트 디자인 바인딩 — 차트 종류 변경·차트 구성 추가(제목·범례·데이터 레이블·축·축 제목·눈금선).
//! 저장 꼴은 한/글 COM 실측(`crates/rhwp-ooxml-chart/src/format.rs`). 주소는 문서 순번(`listCharts` 의 index).
use super::HwpDocument;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl HwpDocument {
    /// 차트 구성 상태: `{ok, chart, group, index, plots[], title:'none'|'top'|'overlay', titleText, legend, dataLabels,
    /// hasAxes, horizontalAxis:{kind,visible,majorGrid,minorGrid,title,titleText}|null, verticalAxis, series[], kinds[{group,index,name}]}`
    #[wasm_bindgen(js_name = getChartFormatByIndex)]
    pub fn get_chart_format_by_index(&self, index: u32) -> Result<String, JsValue> {
        self.core
            .get_chart_format_by_index_native(index as usize)
            .map_err(|e| e.into())
    }

    /// 차트 구성 편집: `{kind:{group,index}, title:{mode,text}, legend, dataLabels, horizontalAxis:{…}, verticalAxis:{…}}`(필요한 것만).
    /// 반환 `{ok, chart, wrote[], changed}` 또는 `{ok:false, invalid[]}`.
    #[wasm_bindgen(js_name = setChartFormatByIndex)]
    pub fn set_chart_format_by_index(&mut self, index: u32, ops_json: &str) -> Result<String, JsValue> {
        self.core
            .set_chart_format_by_index_native(index as usize, ops_json)
            .map_err(|e| e.into())
    }
}
