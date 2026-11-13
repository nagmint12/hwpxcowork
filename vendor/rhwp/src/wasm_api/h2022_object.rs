//! [hwpx-cowork] 한/글 2022 개체 기능 바인딩 (2026-11-11) — 본체는 `document_core/commands/h2022_object.rs`.
//!
//! 개체 주소: 구역·본문 문단·cellPath(JSON, 본문 개체는 "")·컨트롤 차례 — 편집기 `PictureRef` 와 같다.
use super::HwpDocument;
use crate::document_core::DocumentCore;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl HwpDocument {
    /// 개체 정보 — {kind, locked, zOrder, rank, count, textWrap, treatAsChar, width, height}.
    #[wasm_bindgen(js_name = getObjectInfoH2022)]
    pub fn get_object_info_h2022(
        &self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core.h2022_object_info_native(&a).map_err(|e| e.into())
    }

    /// 개체가 보호됐는가(주소가 틀리면 false) — 편집기 클릭 적중이 보호 개체를 건너뛴다.
    #[wasm_bindgen(js_name = isObjectLockedH2022)]
    pub fn is_object_locked_h2022(&self, sec: u32, ppi: u32, cell_path_json: &str, ci: u32) -> bool {
        match DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize) {
            Ok(a) => self.core.h2022_object_locked_native(&a),
            Err(_) => false,
        }
    }

    /// 개체 순서 — operation: front | back | forward | backward. 칸 안 개체도 된다(본문은 changeShapeZOrder 와 같다).
    #[wasm_bindgen(js_name = changeObjectZOrderH2022)]
    pub fn change_object_z_order_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
        operation: &str,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_change_z_order_native(&a, operation)
            .map_err(|e| e.into())
    }

    /// 개체 보호하기/풀기 — {before, locked}.
    #[wasm_bindgen(js_name = setObjectLockH2022)]
    pub fn set_object_lock_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
        locked: bool,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_set_object_lock_native(&a, locked)
            .map_err(|e| e.into())
    }

    /// 모든 보호 개체 해제하기 — {count}.
    #[wasm_bindgen(js_name = unlockAllObjectsH2022)]
    pub fn unlock_all_objects_h2022(&mut self) -> Result<String, JsValue> {
        self.core
            .h2022_unlock_all_objects_native()
            .map_err(|e| e.into())
    }

    /// 글 앞으로(InFrontOfText) / 글 뒤로(BehindText) — {changed, before}.
    #[wasm_bindgen(js_name = setObjectWrapH2022)]
    pub fn set_object_wrap_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
        wrap: &str,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_set_object_wrap_native(&a, wrap)
            .map_err(|e| e.into())
    }

    /// 개체 모양 복사 — 보관함에 넣는다. {kind, line, fill, size, shadow, picEffect}.
    #[wasm_bindgen(js_name = copyObjectFormatH2022)]
    pub fn copy_object_format_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_copy_object_format_native(&a)
            .map_err(|e| e.into())
    }

    /// 개체 모양 보관함 상태 — {has, …}.
    #[wasm_bindgen(js_name = getObjectFormatClipH2022)]
    pub fn get_object_format_clip_h2022(&self) -> String {
        self.core.h2022_object_format_clip_native()
    }

    /// 개체 모양 붙이기 — flags_json {line, fill, size, shadow, picEffect}. {applied:[…]}.
    #[wasm_bindgen(js_name = pasteObjectFormatH2022)]
    pub fn paste_object_format_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
        flags_json: &str,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_paste_object_format_native(&a, flags_json)
            .map_err(|e| e.into())
    }

    /// 그림 바꾸기 — 틀 크기·배치는 그대로, 그림 자료와 자르기·원래 크기만 새 그림으로(한/글 PictureChange).
    #[wasm_bindgen(js_name = changePictureH2022)]
    #[allow(clippy::too_many_arguments)]
    pub fn change_picture_h2022(
        &mut self,
        sec: u32,
        ppi: u32,
        cell_path_json: &str,
        ci: u32,
        image_data: &[u8],
        natural_width_px: u32,
        natural_height_px: u32,
        extension: &str,
    ) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize)
            .map_err(JsValue::from)?;
        self.core
            .h2022_change_picture_native(&a, image_data, natural_width_px, natural_height_px, extension)
            .map_err(|e| e.into())
    }

    /// 여러 개체 맞춤·간격 같게·크기 같게 — targets_json [{sec,ppi,ci}](마지막 = 기준 개체),
    /// mode: left|center|right|top|middle|bottom|hspace|vspace|width|height|size. {moved, skipped}
    #[wasm_bindgen(js_name = alignObjectsH2022)]
    pub fn align_objects_h2022(&mut self, targets_json: &str, mode: &str) -> Result<String, JsValue> {
        let v: Vec<serde_json::Value> = serde_json::from_str(targets_json)
            .map_err(|e| JsValue::from_str(&format!("targets JSON: {}", e)))?;
        let targets: Vec<_> = v
            .iter()
            .filter_map(|t| {
                DocumentCore::h2022_addr(
                    t["sec"].as_u64()? as usize,
                    t["ppi"].as_u64()? as usize,
                    "",
                    t["ci"].as_u64()? as usize,
                )
                .ok()
            })
            .collect();
        self.core
            .h2022_align_objects_native(&targets, mode)
            .map_err(|e| e.into())
    }

    /// 그림 효과 읽기 — {shadow, glow, softEdge, reflection}(없으면 null).
    #[wasm_bindgen(js_name = getPictureEffectsH2022)]
    pub fn get_picture_effects_h2022(&self, sec: u32, ppi: u32, cell_path_json: &str, ci: u32) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize).map_err(JsValue::from)?;
        self.core.h2022_picture_effects_native(&a).map_err(|e| e.into())
    }

    /// 그림 효과 바꾸기 — json 의 키만(null = 없앰).
    #[wasm_bindgen(js_name = setPictureEffectsH2022)]
    pub fn set_picture_effects_h2022(&mut self, sec: u32, ppi: u32, cell_path_json: &str, ci: u32, json: &str) -> Result<String, JsValue> {
        let a = DocumentCore::h2022_addr(sec as usize, ppi as usize, cell_path_json, ci as usize).map_err(JsValue::from)?;
        self.core.h2022_set_picture_effects_native(&a, json).map_err(|e| e.into())
    }
}
