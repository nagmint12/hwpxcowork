//! [hwpx-cowork] 한/글 2022 편집·입력 — 날짜/시간 코드와 상호 참조 넣기(필드 + 필드 안 글).
//!
//! 날짜 코드(입력 > 날짜/시간 > 날짜/시간 코드, Ctrl+K,C · `InsertFieldDateTime`) — 한/글 2022 COM 실측(2026-11-11, 빈 문서에
//! `InsertFieldDateTime` 후 HWPX 저장): `<hp:fieldBegin type="DATE" editable="0" dirty="0" …><hp:parameters cnt="4" name="">`
//! `<hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">:1년 2월 3일</hp:stringParam>`
//! `<hp:stringParam name="DateNation">KOR</hp:stringParam><hp:stringParam name="DateFormat">YYYY년 M월 D일</hp:stringParam>`
//! `</hp:parameters></hp:fieldBegin>` + 필드 안 글 `2026년 11월 11일` + `fieldEnd`. 한/글 기본 형식만 넣는다.
//!
//! 상호 참조(입력 > 상호 참조 · `InsertCrossReference`) — 한/글 2022 COM 실측(2026-11-12, 상호 참조 창을 UI Automation 으로 눌러 넣고
//! HWPX 저장): `<hp:fieldBegin type="CROSSREF" editable="0" dirty="0" …><hp:parameters cnt="8" name="">`
//! `Fiexde=1 · Prop=0 · Command="?#<표 id>;<대상 종류 차례>;<참조 내용 차례>;0;0;" · RefPath="?#<표 id>;" · RefType=TARGET_TABLE ·`
//! `RefContentType=OBJECT_TYPE_PAGE|OBJECT_TYPE_NUMBER|OBJECT_TYPE_UPDOWNPOS · RefHyperLink=false · RefOpenType=HWPHYPERLINK_JUMP_CURRENTTAB`
//! + 필드 안 표시 글(쪽 번호 `1`·표 번호 `1`·`위`). 대상 종류 차례는 창의 목록 차례(표 0·그림 1·수식 2·각주 3·미주 4·개요 5·책갈피 6),
//! 참조 내용 차례는 표에서 쪽 번호 0·번호 1·캡션 내용 2·위/아래 3. `#<id>` 는 그 표의 `hp:tbl@id`. 책갈피는 `?<이름>;6;…`·TARGET_BOOKMARK.

use crate::document_core::queries::field_query::insert_field_in_para;
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{Control, Field, FieldType};
use crate::parser::tags;

/// 한/글 2022 기본 날짜 코드의 파라미터(실측 그대로).
const DATE_CODE_PARAMETERS: &str = concat!(
    r#"<hp:parameters cnt="4" name="">"#,
    r#"<hp:integerParam name="Prop">8</hp:integerParam>"#,
    r#"<hp:stringParam name="Command">:1년 2월 3일</hp:stringParam>"#,
    r#"<hp:stringParam name="DateNation">KOR</hp:stringParam>"#,
    r#"<hp:stringParam name="DateFormat">YYYY년 M월 D일</hp:stringParam>"#,
    r#"</hp:parameters>"#,
);

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrossRefInput {
    /// "table" | "bookmark"
    kind: String,
    /// 표: 그 표가 놓인 본문 문단·컨트롤 번호
    #[serde(default)]
    target_sec: usize,
    #[serde(default)]
    target_para: usize,
    #[serde(default)]
    target_ctrl: usize,
    /// 책갈피 이름
    #[serde(default)]
    name: String,
    /// "page" | "number" | "updown"
    content: String,
    /// 필드 안 표시 글(편집기가 셈)
    text: String,
}

impl DocumentCore {
    /// 본문 문단 글자 자리에 필드를 넣고 그 안에 `text` 를 담는다(값 채움 표시는 남기지 않는다 — 한/글 저장 dirty="0").
    fn insert_text_field(
        &mut self,
        sec: usize,
        para: usize,
        char_offset: usize,
        field: Field,
        text: &str,
    ) -> Result<usize, HwpError> {
        if text.is_empty() {
            return Err(HwpError::InvalidField("필드 안 글이 비었습니다".into()));
        }
        let start = {
            let section = self
                .document
                .sections
                .get_mut(sec)
                .ok_or_else(|| HwpError::InvalidField("구역 인덱스 초과".into()))?;
            section.raw_stream = None;
            let paragraph = section
                .paragraphs
                .get_mut(para)
                .ok_or_else(|| HwpError::InvalidField("문단 인덱스 초과".into()))?;
            let (start, ctrl_idx) = insert_field_in_para(paragraph, char_offset, field)?;
            let range_idx = paragraph
                .field_ranges
                .iter()
                .position(|r| r.control_idx == ctrl_idx)
                .ok_or_else(|| HwpError::InvalidField("필드 범위를 찾지 못했습니다".into()))?;
            Self::replace_field_text_model(paragraph, range_idx, text)?;
            if let Some(Control::Field(f)) = paragraph.controls.get_mut(ctrl_idx) {
                f.properties &= !(1 << 15);
            }
            start
        };
        self.reflow_paragraph(sec, para);
        self.recompose_section(sec);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        Ok(start)
    }

    /// 본문 문단 글자 자리에 날짜 코드(DATE 필드)를 넣고 그 안에 `text`(편집기가 만든 오늘 날짜 글)를 담는다.
    /// → `{"ok":true,"fieldId":n,"charOffset":시작,"length":글자 수}`
    pub fn insert_date_code_native(
        &mut self,
        sec: usize,
        para: usize,
        char_offset: usize,
        text: &str,
    ) -> Result<String, HwpError> {
        let field_id = self.next_click_here_field_id();
        let field = Field {
            field_type: FieldType::Date,
            // HWP5 저장의 명령 글도 한/글 파라미터 Command 와 같은 값
            command: ":1년 2월 3일".to_string(),
            properties: 0,
            field_id,
            ctrl_id: tags::FIELD_DATE,
            raw_parameters_xml: Some(DATE_CODE_PARAMETERS.to_string()),
            ..Default::default()
        };
        let start = self.insert_text_field(sec, para, char_offset, field, text)?;
        Ok(format!(
            "{{\"ok\":true,\"fieldId\":{field_id},\"charOffset\":{start},\"length\":{}}}",
            text.chars().count()
        ))
    }

    /// 상호 참조 대상 — 본문 문단에 놓인 표(문서 차례, `number` = 1부터 센 차례, `id` = `hp:tbl@id`).
    /// → `{"tables":[{"sec","para","ctrlIdx","id","number"}]}`
    pub fn cross_ref_targets_native(&self) -> Result<String, HwpError> {
        let mut out = Vec::new();
        let mut n = 0usize;
        for (s, section) in self.document.sections.iter().enumerate() {
            for (p, paragraph) in section.paragraphs.iter().enumerate() {
                for (c, control) in paragraph.controls.iter().enumerate() {
                    if let Control::Table(t) = control {
                        n += 1;
                        out.push(format!(
                            "{{\"sec\":{s},\"para\":{p},\"ctrlIdx\":{c},\"id\":{},\"number\":{n}}}",
                            t.common.instance_id
                        ));
                    }
                }
            }
        }
        Ok(format!("{{\"tables\":[{}]}}", out.join(",")))
    }

    /// 표 instance id 가 0 이면(편집기에서 새로 만든 표 등) 문서에서 겹치지 않는 번호를 준다 → 그 표의 id
    fn ensure_table_id(&mut self, sec: usize, para: usize, ctrl: usize) -> Result<u32, HwpError> {
        let mut max = 0u32;
        for section in &self.document.sections {
            for paragraph in &section.paragraphs {
                for control in &paragraph.controls {
                    if let Control::Table(t) = control {
                        max = max.max(t.common.instance_id);
                    }
                }
            }
        }
        let table = match self
            .document
            .sections
            .get_mut(sec)
            .and_then(|s| s.paragraphs.get_mut(para))
            .and_then(|p| p.controls.get_mut(ctrl))
        {
            Some(Control::Table(t)) => t,
            _ => return Err(HwpError::InvalidField("상호 참조 대상 표를 찾지 못했습니다".into())),
        };
        let assigned = table.common.instance_id == 0;
        if assigned {
            table.common.instance_id = max.saturating_add(1).max(1);
        }
        let id = table.common.instance_id;
        if assigned {
            self.document.sections[sec].raw_stream = None;
        }
        Ok(id)
    }

    /// 본문 문단 글자 자리에 상호 참조(CROSSREF 필드)를 넣고 그 안에 표시 글을 담는다. 입력은 모듈 머리 주석·[`CrossRefInput`].
    /// → `{"ok":true,"fieldId","charOffset","length","command"}`
    pub fn insert_cross_reference_native(
        &mut self,
        sec: usize,
        para: usize,
        char_offset: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        let input: CrossRefInput = serde_json::from_str(json)
            .map_err(|e| HwpError::InvalidField(format!("상호 참조 값: {e}")))?;
        let (path, type_idx, ref_type) = match input.kind.as_str() {
            "table" => {
                let id = self.ensure_table_id(input.target_sec, input.target_para, input.target_ctrl)?;
                (format!("#{id}"), 0, "TARGET_TABLE")
            }
            "bookmark" if !input.name.is_empty() => (input.name.clone(), 6, "TARGET_BOOKMARK"),
            _ => return Err(HwpError::InvalidField("상호 참조 대상은 표·책갈피만 넣습니다".into())),
        };
        let (content_idx, content_type) = match (input.kind.as_str(), input.content.as_str()) {
            (_, "page") => (0, "OBJECT_TYPE_PAGE"),
            ("table", "number") => (1, "OBJECT_TYPE_NUMBER"),
            ("table", "updown") => (3, "OBJECT_TYPE_UPDOWNPOS"),
            _ => return Err(HwpError::InvalidField("참조 내용이 올바르지 않습니다".into())),
        };
        let command = format!("?{path};{type_idx};{content_idx};0;0;");
        let params = format!(
            concat!(
                r#"<hp:parameters cnt="8" name="">"#,
                r#"<hp:booleanParam name="Fiexde">1</hp:booleanParam>"#,
                r#"<hp:integerParam name="Prop">0</hp:integerParam>"#,
                r#"<hp:stringParam name="Command">{cmd}</hp:stringParam>"#,
                r#"<hp:stringParam name="RefPath">?{path};</hp:stringParam>"#,
                r#"<hp:stringParam name="RefType">{rt}</hp:stringParam>"#,
                r#"<hp:stringParam name="RefContentType">{ct}</hp:stringParam>"#,
                r#"<hp:booleanParam name="RefHyperLink">false</hp:booleanParam>"#,
                r#"<hp:stringParam name="RefOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam>"#,
                r#"</hp:parameters>"#,
            ),
            cmd = xml_escape(&command),
            path = xml_escape(&path),
            rt = ref_type,
            ct = content_type,
        );
        let field_id = self.next_click_here_field_id();
        let field = Field {
            field_type: FieldType::CrossRef,
            command: command.clone(),
            properties: 0,
            field_id,
            ctrl_id: tags::FIELD_CROSSREF,
            raw_parameters_xml: Some(params),
            ..Default::default()
        };
        let start = self.insert_text_field(sec, para, char_offset, field, &input.text)?;
        Ok(serde_json::json!({
            "ok": true,
            "fieldId": field_id,
            "charOffset": start,
            "length": input.text.chars().count(),
            "command": command,
        })
        .to_string())
    }
}
