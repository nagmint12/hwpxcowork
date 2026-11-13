//! [hwpx-cowork] 구역을 넘는 편집의 구역 구조 — 합치기·나누기 (docs/SECTIONS.md).
//!
//! 구역 = `document.sections` 한 칸(HWPX `Contents/sectionN.xml` 하나). 구역 나누기 = 구역 첫 문단 머리의 구역·단 정의
//! (SectionDef + ColumnDef). 파일 안 구역 나누기 문단(차례 '새 구역')도 같은 꼴이라 한/글은 같은 구역 나누기로 읽는다.
//!
//! 한/글 2022 실측(tests/fixtures/sections/):
//!  - 구역 경계를 넘는 지우기(앞 구역 끝 Delete·뒤 구역 첫머리 Backspace 포함)는 두 구역을 하나로 합친다 — 앞 구역 설정이 남고
//!    뒤 구역 정의(용지·바탕쪽 등)는 사라진다.
//!  - 구역을 넘는 복사는 넘는 구역 나누기를 뒤 구역의 실제 정의째 싣고, 붙이면 그 자리에서 구역이 나뉜다 — 붙인 자리 뒤의 글은
//!    마지막으로 나뉜 구역에 든다.

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::Section;

/// 구역 section 의 문단 para_idx 가 여는 구역 나누기의 구역·단 정의(복사에 싣는 꼴). 구역 첫 문단이면 구역 정의는
/// `section.section_def`(바탕쪽까지 든 실제 정의 — 문단 안 사본보다 믿을 만하다), 파일 안 구역 나누기면 그 문단의 정의.
pub(crate) fn section_break_defs(section: &Section, para_idx: usize) -> Vec<Control> {
    let Some(para) = section.paragraphs.get(para_idx) else {
        return Vec::new();
    };
    let lead = para
        .controls
        .iter()
        .take_while(|c| matches!(c, Control::SectionDef(_) | Control::ColumnDef(_)));
    if para_idx == 0 {
        let mut defs = vec![Control::SectionDef(Box::new(section.section_def.clone()))];
        defs.extend(lead.filter(|c| matches!(c, Control::ColumnDef(_))).cloned());
        defs
    } else {
        lead.cloned().collect()
    }
}

impl DocumentCore {
    /// 구역 수를 바꾼 뒤 파생 상태(문단 구성·쪽 나눔·구역별 캐시)를 새 구역 목록으로 다시 만든다.
    pub(crate) fn rebuild_after_section_structure_change(&mut self) {
        let n = self.document.sections.len();
        self.dirty_sections = vec![true; n];
        self.render_normalization.sections.clear();
        self.render_normalization.unprojected_revisions.clear();
        self.rebuild_derived_state();
    }

    /// 구역 k(≥1)를 앞 구역에 합친다 — 구역 나누기(k 첫 문단 머리 정의)를 빼고 문단을 앞 구역 끝에 잇는다.
    /// 뒤 구역 정의(용지·바탕쪽 등)는 사라지고 글은 앞 구역 설정을 따른다(한/글). → 합치기 전 앞 구역 문단 수.
    /// 파생 상태는 다시 만들지 않는다(rebuild_after_section_structure_change).
    pub(crate) fn merge_section_into_previous(&mut self, k: usize) -> Result<usize, HwpError> {
        if k == 0 || k >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!("앞 구역에 합칠 구역이 없습니다: {}", k)));
        }
        let mut moved = self.document.sections.remove(k);
        if let Some(first) = moved.paragraphs.first_mut() {
            first.take_section_break();
        }
        let prev = &mut self.document.sections[k - 1];
        let base = prev.paragraphs.len();
        prev.paragraphs.append(&mut moved.paragraphs);
        prev.raw_stream = None;
        prev.raw_provenance = None;
        Ok(base)
    }

    /// 구역 sec 를 문단 at(≥1, 구역 나누기 문단)에서 나눈다 — at 부터가 새 구역 sec+1 이 되고 그 문단의 구역 정의가 새 구역 정의다.
    /// 파생 상태는 다시 만들지 않는다.
    pub(crate) fn split_section_at(&mut self, sec: usize, at: usize) -> Result<(), HwpError> {
        let section = self
            .document
            .sections
            .get_mut(sec)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", sec)))?;
        if at == 0 || at >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!("구역을 나눌 문단이 아닙니다: {}/{}", sec, at)));
        }
        let def = section.paragraphs[at]
            .controls
            .iter()
            .take_while(|c| matches!(c, Control::SectionDef(_) | Control::ColumnDef(_)))
            .find_map(|c| match c {
                Control::SectionDef(d) => Some((**d).clone()),
                _ => None,
            })
            .ok_or_else(|| HwpError::RenderError(format!("구역 나누기 문단이 아닙니다: {}/{}", sec, at)))?;
        let paragraphs = section.paragraphs.split_off(at);
        section.raw_stream = None;
        section.raw_provenance = None;
        self.document.sections.insert(
            sec + 1,
            // [hwpx-cowork] The newly split section has no original HWP5 tail;
            // do not duplicate the original section's master/memo records.
            Section { section_def: def, paragraphs, trailing_lists: None, raw_stream: None, raw_provenance: None },
        );
        Ok(())
    }

    /// 구역 sec 의 문단 (from, to] 가운데 구역 나누기 문단에서 구역을 나눈다(붙여넣기로 들어온 구역 나누기 — 한/글처럼 실제 구역으로).
    /// 문단 to 의 새 자리(구역, 문단)를 돌려준다. 파생 상태는 다시 만들지 않는다.
    pub(crate) fn split_sections_at_breaks(&mut self, sec: usize, from: usize, to: usize) -> (usize, usize) {
        let mut cuts: Vec<usize> = (from + 1..=to)
            .filter(|&i| self.document.sections[sec].paragraphs.get(i).is_some_and(|p| p.has_section_break()))
            .collect();
        if cuts.is_empty() {
            return (sec, to);
        }
        let last_cut = *cuts.last().unwrap_or(&0);
        let n = cuts.len();
        cuts.reverse();
        for at in cuts {
            let _ = self.split_section_at(sec, at);
        }
        (sec + n, to - last_cut)
    }

    /// 구역을 넘는 지우기의 앞 단계 — start_section 뒤 end_section 까지를 start_section 에 합친다(사이 구역 나누기는 모두 지울
    /// 범위 안이다). → 끝 문단(end_section, end_para)의 합친 뒤 번호. 파생 상태는 다시 만들지 않는다.
    pub(crate) fn merge_sections_for_range(
        &mut self,
        start_section: usize,
        start_para: usize,
        end_section: usize,
        end_para: usize,
    ) -> Result<usize, HwpError> {
        let n = self.document.sections.len();
        if start_section >= n || end_section >= n || start_section > end_section {
            return Err(HwpError::RenderError(format!(
                "구역 범위가 올바르지 않습니다 ({}~{}, 총 {}개)",
                start_section, end_section, n
            )));
        }
        if start_para >= self.document.sections[start_section].paragraphs.len()
            || end_para >= self.document.sections[end_section].paragraphs.len()
        {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 범위 초과 (start={}, end={})",
                start_para, end_para
            )));
        }
        // 뒤에서부터 합친다 — 끝 문단 번호에 합친 앞 구역 문단 수가 차례로 더해진다
        let mut end = end_para;
        for k in (start_section + 1..=end_section).rev() {
            end += self.merge_section_into_previous(k)?;
        }
        Ok(end)
    }
}
