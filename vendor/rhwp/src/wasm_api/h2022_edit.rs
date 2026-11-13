//! [hwpx-cowork] 한/글 2022 편집·입력 기능 바인딩(2026-11-11) — 찾기 옵션, 캐럿 자리의 덧말·글자 겹침.
//!
//! 찾기 옵션의 규칙·한/글 실측 근거는 `document_core/queries/h2022_find.rs` 머리 주석에 있다.
//! `options_json`: `{"matchCase","wholeWord","wildcard","severalWords","ignoreSpace","jaso"}`(빠진 것은 끔).
use super::HwpDocument;
use crate::document_core::queries::h2022_find::{with_options, FindOptions};
use crate::document_core::{ComposeHost, DocumentCore};
use wasm_bindgen::prelude::*;

fn options(json: &str) -> Result<FindOptions, JsValue> {
    if json.trim().is_empty() {
        return Ok(FindOptions::default());
    }
    serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("찾기 옵션: {e}")))
}

#[wasm_bindgen]
impl HwpDocument {
    /// `searchText` 에 한/글 찾기 옵션을 더한 판. 결과 꼴은 `searchText` 와 같다.
    #[wasm_bindgen(js_name = searchTextEx)]
    #[allow(clippy::too_many_arguments)]
    pub fn search_text_ex(
        &self,
        query: &str,
        from_sec: u32,
        from_para: u32,
        from_char: u32,
        forward: bool,
        options_json: &str,
        include_cells: bool,
    ) -> Result<String, JsValue> {
        let o = options(options_json)?;
        let case_sensitive = o.match_case;
        with_options(o, || {
            self.core.search_text_native(
                query,
                from_sec as usize,
                from_para as usize,
                from_char as usize,
                forward,
                case_sensitive,
                include_cells,
            )
        })
        .map_err(|e| e.into())
    }

    /// `searchAllText` 의 옵션 판(모든 매치 배열).
    #[wasm_bindgen(js_name = searchAllTextEx)]
    pub fn search_all_text_ex(
        &self,
        query: &str,
        options_json: &str,
        include_cells: bool,
    ) -> Result<String, JsValue> {
        let o = options(options_json)?;
        let case_sensitive = o.match_case;
        with_options(o, || {
            self.core
                .search_all_text_native(query, case_sensitive, include_cells)
        })
        .map_err(|e| e.into())
    }

    /// `replaceAll` 의 옵션 판 → `{"ok":true,"count":n}`. 바꿀 말은 글자 그대로다(아무개 문자도 풀지 않는다).
    #[wasm_bindgen(js_name = replaceAllEx)]
    pub fn replace_all_ex(
        &mut self,
        query: &str,
        new_text: &str,
        options_json: &str,
    ) -> Result<String, JsValue> {
        let o = options(options_json)?;
        let case_sensitive = o.match_case;
        let core = &mut self.core;
        with_options(o, || core.replace_all_native(query, new_text, case_sensitive))
            .map_err(|e| e.into())
    }

    /// 본문 문단 글자 자리에 날짜/시간 코드(한/글 DATE 필드, 기본 형식 `YYYY년 M월 D일`)를 넣고 `text` 를 그 안에 담는다.
    /// → `{"ok":true,"fieldId","charOffset","length"}`
    #[wasm_bindgen(js_name = insertDateCode)]
    pub fn insert_date_code(
        &mut self,
        sec: u32,
        para: u32,
        char_offset: u32,
        text: &str,
    ) -> Result<String, JsValue> {
        self.core
            .insert_date_code_native(sec as usize, para as usize, char_offset as usize, text)
            .map_err(|e| e.into())
    }

    /// 상호 참조 대상 표 목록 → `{"tables":[{"sec","para","ctrlIdx","id","number"}]}`
    #[wasm_bindgen(js_name = getCrossRefTargets)]
    pub fn get_cross_ref_targets(&self) -> Result<String, JsValue> {
        self.core.cross_ref_targets_native().map_err(|e| e.into())
    }

    /// 본문 문단 글자 자리에 상호 참조(한/글 CROSSREF 필드)를 넣는다.
    /// 입력 `{"kind":"table"|"bookmark","targetSec","targetPara","targetCtrl","name","content":"page"|"number"|"updown","text"}`
    #[wasm_bindgen(js_name = insertCrossReference)]
    pub fn insert_cross_reference(
        &mut self,
        sec: u32,
        para: u32,
        char_offset: u32,
        json: &str,
    ) -> Result<String, JsValue> {
        self.core
            .insert_cross_reference_native(sec as usize, para as usize, char_offset as usize, json)
            .map_err(|e| e.into())
    }

    /// 캐럿 자리의 덧말·글자 겹침. 입력 `{"sec","para","cellPath"?,"charOffset"}`(cellPath 는
    /// `insertRubyByPath` 와 같은 경로 JSON) → `{"found":false}` | `{"found":true,"ctrlIdx",…getComposeControl 값}`.
    #[wasm_bindgen(js_name = getComposeControlAt)]
    pub fn get_compose_control_at_caret(&self, json: &str) -> Result<String, JsValue> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            sec: usize,
            para: usize,
            #[serde(default)]
            cell_path: Option<serde_json::Value>,
            char_offset: usize,
        }
        let input: Input = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("캐럿 자리: {e}")))?;
        let path = match &input.cell_path {
            Some(v) if v.as_array().is_some_and(|a| !a.is_empty()) => {
                DocumentCore::parse_cell_path(&v.to_string())?
            }
            _ => Vec::new(),
        };
        let host = if path.is_empty() {
            ComposeHost::Body {
                sec: input.sec,
                para: input.para,
            }
        } else {
            ComposeHost::Cell {
                sec: input.sec,
                parent_para: input.para,
                path: &path,
            }
        };
        self.core
            .compose_control_near(host, input.char_offset)
            .map_err(|e| e.into())
    }
}
