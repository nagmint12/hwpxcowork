//! [hwpx-cowork] 한/글 2022 서식·쪽 기능 바인딩 (2026-11-11, h2022-format).
//! 본체는 `document_core/commands/h2022_format.rs`.
use super::HwpDocument;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl HwpDocument {
    /// 캐럿 문단에 적용되는 단 정의(구역 가운데 다단 포함)를 읽는다.
    /// `{ok, exists, ownerPara, sectionInitial, columnCount, columnType, direction, sameWidth, spacing,
    ///   widths, gaps, proportional, separatorType, separatorWidth, separatorColor, bodyWidth}`
    #[wasm_bindgen(js_name = getColumnDefAt)]
    pub fn get_column_def_at(&self, section_idx: u32, para_idx: u32) -> Result<String, JsValue> {
        self.core
            .get_column_def_at_native(section_idx as usize, para_idx as usize)
            .map_err(|e| e.into())
    }

    /// 캐럿 문단에 적용되는 단 정의('현재 다단')를 고친다. 빠진 키는 그대로 둔다.
    #[wasm_bindgen(js_name = setColumnDefAt)]
    pub fn set_column_def_at(&mut self, section_idx: u32, para_idx: u32, props_json: &str) -> Result<String, JsValue> {
        self.core
            .set_column_def_at_native(section_idx as usize, para_idx as usize, props_json)
            .map_err(|e| e.into())
    }

    /// 다단 설정 나누기(한/글 BreakColDef, Ctrl+Alt+Enter). `props_json` 이 있으면 새 다단에 얹는다('새 다단으로').
    /// 결과 `{ok, para, charOffset, inserted}` — 새 다단 첫 문단의 캐럿 자리.
    #[wasm_bindgen(js_name = insertColumnDefBreak)]
    pub fn insert_column_def_break(
        &mut self,
        section_idx: u32,
        para_idx: u32,
        char_offset: u32,
        props_json: &str,
    ) -> Result<String, JsValue> {
        self.core
            .insert_column_def_break_native(section_idx as usize, para_idx as usize, char_offset as usize, props_json)
            .map_err(|e| e.into())
    }

    /// 쪽 번호 매기기(PageNumPos) 읽기: `getPageNumberPosition` 결과 + `startNumber`(구역 첫 문단의 쪽 새 번호, 없으면 null).
    #[wasm_bindgen(js_name = getPageNumbering)]
    pub fn get_page_numbering(&self, section_idx: u32) -> Result<String, JsValue> {
        self.core
            .get_page_numbering_native(section_idx as usize)
            .map_err(|e| e.into())
    }

    /// 쪽 번호 매기기(PageNumPos): 위치·번호 모양·줄표 + 시작 번호(0 = 건드리지 않음).
    #[wasm_bindgen(js_name = setPageNumbering)]
    pub fn set_page_numbering(
        &mut self,
        section_idx: u32,
        position: u32,
        format: u32,
        dash: bool,
        start_number: u32,
    ) -> Result<String, JsValue> {
        self.core
            .set_page_numbering_native(
                section_idx as usize,
                u8::try_from(position).unwrap_or(u8::MAX),
                u8::try_from(format).unwrap_or(u8::MAX),
                dash,
                u16::try_from(start_number).unwrap_or(u16::MAX),
            )
            .map_err(|e| e.into())
    }

    /// 번호 정의(1부터)의 수준별 값(번호 서식·모양·시작 번호·정렬·너비·본문과의 거리).
    #[wasm_bindgen(js_name = getNumberingDetail)]
    pub fn get_numbering_detail(&self, numbering_id: u32) -> Result<String, JsValue> {
        self.core
            .get_numbering_detail_native(numbering_id as usize)
            .map_err(|e| e.into())
    }

    /// 문단 번호 사용자 정의 — 수준별 값으로 새 번호 정의를 만든다. 결과 `{ok, id}`.
    #[wasm_bindgen(js_name = createNumberingEx)]
    pub fn create_numbering_ex(&mut self, json: &str) -> Result<String, JsValue> {
        self.core.create_numbering_ex_native(json).map_err(|e| e.into())
    }

    /// 형광펜(한/글 MarkPenShape): 본문 범위(같은 구역, 논리 오프셋)를 `color`(#RRGGBB)로 칠한다. 빈 문자열이면 그 범위를 지운다.
    /// 결과 `{ok, changed}` — 바뀐 문단 수.
    #[wasm_bindgen(js_name = applyMarkpen)]
    pub fn apply_markpen(
        &mut self,
        section_idx: u32,
        start_para: u32,
        start_offset: u32,
        end_para: u32,
        end_offset: u32,
        color: &str,
    ) -> Result<String, JsValue> {
        self.core
            .apply_markpen_native(
                section_idx as usize,
                start_para as usize,
                start_offset as usize,
                end_para as usize,
                end_offset as usize,
                color,
            )
            .map_err(|e| e.into())
    }

    /// 형광펜 — 문단 하나(대상 JSON: path=표 칸·중첩 표·글상자, hf=머리말·꼬리말, note=각주·미주)의 [from, to) 논리 범위.
    #[wasm_bindgen(js_name = applyMarkpenTarget)]
    pub fn apply_markpen_target(&mut self, target_json: &str, from: u32, to: u32, color: &str) -> Result<String, JsValue> {
        self.core
            .apply_markpen_target_native(target_json, from as usize, to as usize, color)
            .map_err(|e| e.into())
    }

    /// 본문 형광펜 범위 목록(형광펜 이동용) `{ok, ranges:[{para,start,end,color}]}`.
    #[wasm_bindgen(js_name = getMarkpenRanges)]
    pub fn get_markpen_ranges(&self, section_idx: u32) -> Result<String, JsValue> {
        self.core
            .get_markpen_ranges_native(section_idx as usize)
            .map_err(|e| e.into())
    }

    /// 형광펜 — 표 칸 문단 한 곳의 범위.
    #[wasm_bindgen(js_name = applyMarkpenInCell)]
    #[allow(clippy::too_many_arguments)]
    pub fn apply_markpen_in_cell(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        cell_para_idx: u32,
        start_offset: u32,
        end_offset: u32,
        color: &str,
    ) -> Result<String, JsValue> {
        self.core
            .apply_markpen_in_cell_native(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                cell_idx as usize,
                cell_para_idx as usize,
                start_offset as usize,
                end_offset as usize,
                color,
            )
            .map_err(|e| e.into())
    }

    /// 번호·개요 문단의 수준을 `delta`(−1 위로, +1 아래로) 바꾼다(ParaNumberBulletLevelUp/Down).
    #[wasm_bindgen(js_name = changeParaNumberLevel)]
    pub fn change_para_number_level(&mut self, section_idx: u32, para_idx: u32, delta: i32) -> Result<String, JsValue> {
        self.core
            .change_para_number_level_native(section_idx as usize, para_idx as usize, delta)
            .map_err(|e| e.into())
    }
}
