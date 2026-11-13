//! 그림/캡션 레이아웃 + 각주 영역 레이아웃

use super::super::composer::{compose_paragraph, ComposedLine, ComposedParagraph};
use super::super::page_layout::LayoutRect;
use super::super::pagination::{FootnoteFloatCut, FootnoteFragment, FootnoteRef, FootnoteSource};
use super::super::render_tree::*;
use super::super::style_resolver::ResolvedStyleSet;
use super::super::{hwpunit_to_px, AutoNumberCounter, PathCommand, StrokeDash, TextStyle};
use super::border_rendering::border_width_to_px;
use super::text_measurement::{estimate_text_width, resolved_to_text_style};
use super::utils::{
    extract_picture_transform, find_bin_data_bytes, picture_data_is_unusable,
    picture_display_size_hu,
};
use super::{footnote_separator_length_px, LayoutEngine, ParagraphVerticalSpacing};
use crate::model::bin_data::BinDataContent;
use crate::model::control::Control;
use crate::model::footnote::{FootnoteShape, NumberFormat};
use crate::model::paragraph::Paragraph;
use crate::model::shape::{
    Caption, CaptionDirection, CommonObjAttr, HorzAlign, TextWrap, VertAlign, VertRelTo,
};

/// 본문 그림의 표시 끝과 후속 흐름 원점은 서로 다른 소유를 가진다.
pub(crate) struct BodyPicturePlacement {
    pub flow_end: f64,
    pub content_bottom: f64,
}

use crate::model::style::{Alignment, LineSpacingType};

#[derive(Clone, Copy, PartialEq, Eq)]
enum FootnoteParagraphRoute {
    Numbered,
    Plain,
    StoredEmpty,
}

struct FootnoteBlockTableFrame<'a> {
    table: &'a crate::model::table::Table,
    measured: crate::renderer::height_measurer::MeasuredTable,
    top_offset: f64,
    advance: f64,
    /// A saved TAC line includes the table's outer box and owns its spacing.
    trailing_line_spacing: f64,
    /// TAC geometry belongs to the host line, not the object's float offsets.
    line_left_offset: Option<f64>,
}

struct FootnoteParagraphPlacement<'a> {
    route: FootnoteParagraphRoute,
    spacing: ParagraphVerticalSpacing,
    block_table: Option<FootnoteBlockTableFrame<'a>>,
}

fn fragment_line_bounds(fragment: Option<FootnoteFragment>, total_lines: usize) -> (usize, usize) {
    match fragment {
        Some(fragment) => {
            let start = fragment.start_line.min(total_lines);
            let end = fragment.end_line.clamp(start, total_lines);
            (start, end)
        }
        None => (0, total_lines),
    }
}

/// [hwpx-cowork] 이 조각에서 `para_start` 줄로 시작하는 문단의 떠 있는 개체를 미루는가.
fn floats_deferred(fragment: Option<FootnoteFragment>, para_start: usize) -> bool {
    fragment
        .and_then(|fragment| fragment.defer_floats_from)
        .is_some_and(|line| para_start >= line)
}

/// [hwpx-cowork] 2026-11-04 이 조각에서 `para_start` 줄로 시작하는 문단의 잘린 표(`tail` = 뒤 조각 쪽).
fn fragment_float_cut(
    fragment: Option<FootnoteFragment>,
    para_start: usize,
    tail: Option<bool>,
) -> Option<FootnoteFloatCut> {
    fragment
        .and_then(|fragment| fragment.float_cut)
        .filter(|cut| cut.para_line == para_start && tail.is_none_or(|tail| cut.tail == tail))
}

/// [hwpx-cowork] 2026-11-04 앞 조각이 잘린 표 문단 바로 앞에서 끝나면 끝 줄 뒤 줄 간격을 남긴다(표 문단 위 = 다음
/// 줄 자리, 한/글 재저장 줄 vpos 51480 = 앞 줄 49500 + 1980).
fn fragment_spacing_end(fragment: Option<FootnoteFragment>, end_line: usize) -> usize {
    match fragment.and_then(|fragment| fragment.float_cut) {
        Some(cut) if !cut.tail && cut.para_line == end_line => end_line + 1,
        _ => end_line,
    }
}

fn fragment_draws_separator(fragment: Option<FootnoteFragment>) -> bool {
    fragment
        .map(|fragment| fragment.draw_separator)
        .unwrap_or(true)
}

fn fragment_draws_number(fragment: Option<FootnoteFragment>) -> bool {
    fragment
        .map(|fragment| fragment.draw_number)
        .unwrap_or(true)
}

/// [#6034] 저장 LINE_SEG 가 없는 각주 문단은 45자 고정 휴리스틱(compose_lines
/// 폴백) 대신 **각주 영역 폭**으로 재조판해 compose 한다. 한글 6.x 대 저장본은
/// 각주 문단에 LINE_SEG 를 저장하지 않는데, 폴백 폭과 실제 영역 폭의 차가 각주
/// 블록을 부풀려(2912735: rhwp 15줄 vs 한글 9줄) bottom-anchor 인 영역 상단이
/// 본문 마지막 줄 위로 올라가 구분선이 글줄을 관통했다. 편집 경로
/// (footnote_ops)의 reflow 계약과 같은 상자를 쓴다. LINE_SEG 가 있으면 종전
/// 그대로 통과한다.
fn compose_footnote_paragraph(
    para: &Paragraph,
    content_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> crate::renderer::composer::ComposedParagraph {
    // 저장 줄이 없는 실제 빈 각주 문단도 원본 글자모양의 줄 상자를 소유한다.
    // 본문은 같은 재조판 경로를 쓰는데, 각주만 400HU로 줄이면 앞 각주의
    // 예약 높이와 구분선 원점까지 작아진다. 문단 자체가 없는 입력은 제외한다.
    let has_paragraph_line =
        !para.text.is_empty() || (para.char_count > 0 && para.controls.is_empty());
    if para.line_segs.is_empty() && has_paragraph_line && content_width_px > 0.0 {
        let para_style = styles.para_styles.get(para.para_shape_id as usize);
        let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
        let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
        let final_width = (content_width_px - margin_left - margin_right).max(0.0);
        if final_width > 0.0 {
            let mut owned = para.clone();
            crate::renderer::composer::reflow_line_segs(
                &mut owned,
                crate::renderer::composer::ParagraphBox::content_width_px(final_width, dpi),
                styles,
                dpi,
            );
            return crate::renderer::composer::compose_paragraph_in_context(&owned, styles);
        }
    }
    let mut composed = crate::renderer::composer::compose_paragraph_in_context(para, styles);
    // 각주 영역에 실제 등록된 원본 빈 줄도 저장 높이로 측정한다.
    if composed.lines.is_empty()
        && para.text.is_empty()
        && para.controls.is_empty()
        && !para.stored_text_partition_is_dirty()
    {
        if let [line] = para.line_segs.as_slice() {
            if line.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                && line.line_height > 0
            {
                composed.lines.push(ComposedLine {
                    runs: Vec::new(),
                    line_height: line.line_height,
                    baseline_distance: line.baseline_distance,
                    segment_width: line.segment_width as i32,
                    column_start: line.column_start,
                    line_spacing: line.line_spacing,
                    has_line_break: false,
                    char_start: 0,
                });
            }
        }
    }
    composed
}

/// 원본 각주 본문의 선두 자동 번호 슬롯을 보존한다.
/// [hwpx-cowork] 번호 글자는 구역 각주 모양으로 만든 `number_text` — 한/글은 슬롯의 `autoNumFormat` 이 아니라
/// 구역 모양으로 그린다(2026-11-03 실측: 슬롯 DIGIT `)` · 구역 CIRCLED_DIGIT 뒤 장식 없음 → `⑤`).
fn stored_footnote_number_prefix(para: &Paragraph, number_text: &str) -> Option<(String, usize)> {
    if para.stored_text_partition_is_dirty()
        || para.line_segs.is_empty()
        || para.line_segs.iter().any(|line| {
            line.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
        })
    {
        return None;
    }
    let positions = para.control_text_positions();
    let mut prefix = String::new();
    for (index, control) in para.controls.iter().enumerate() {
        let Control::AutoNumber(auto) = control else {
            return None;
        };
        if auto.number_type != crate::model::control::AutoNumberType::Footnote
            || auto.superscript
            || positions.get(index) != Some(&index)
            || para.text.chars().nth(index) != Some(' ')
        {
            return None;
        }
        prefix.push_str(number_text.trim_end());
    }
    Some((prefix, para.controls.len()))
}

/// 각주 번호를 문단 첫 줄에 실은 조합 결과를 만든다.
///
/// 각주 문단은 번호 자리에 autoNum 컨트롤을 두고, 파서는 그 자리를 공백 1자로
/// 남긴다. 머리말·꼬리말 쪽번호(#3216)와 같이 모델 글자는 그대로 두고 `display_text`
/// 만 번호로 바꿔, 글자 인덱스와 줄 나눔을 유지한 채 일반 문단 경로가 내어쓰기·정렬을
/// 적용하게 한다. 자리표시 뒤의 원문 공백이 번호와 본문 사이를 맡으므로 번호 서식의
/// 끝 공백은 뺀다(한/글: `78) CFR`).
///
/// 자리표시가 없는 문단(편집으로 만든 각주 등)은 첫 줄 앞에 번호 run 을 붙이고, 글자
/// 모양은 종전 번호 경로와 같은 문단 첫 글자 모양을 쓴다. 첫 줄을 그리지 않는 조각
/// (`selected_start > 0`)이나 조합 줄이 없는 빈 문단은 `None` 으로 종전 경로에 맡긴다.
fn footnote_composed_with_number(
    para: &Paragraph,
    composed: &ComposedParagraph,
    number_text: &str,
    selected_start: usize,
    base_cs_id: u32,
) -> Option<ComposedParagraph> {
    if selected_start != 0
        || composed
            .lines
            .first()
            .is_none_or(|line| line.runs.is_empty())
    {
        return None;
    }
    let mut numbered = composed.clone();
    let line = numbered.lines.first_mut()?;
    let number_marker = para.controls.iter().find_map(|control| match control {
        Control::AutoNumber(auto)
            if auto.number_type == crate::model::control::AutoNumberType::Footnote =>
        {
            auto.superscript.then_some(auto.assigned_number)
        }
        _ => None,
    });
    let positions = para.control_text_positions();
    let placeholder = para
        .controls
        .iter()
        .enumerate()
        .find_map(|(index, control)| match control {
            Control::AutoNumber(_) => positions.get(index).copied(),
            _ => None,
        });
    let mut run_start = line.char_start;
    let mut target = None;
    if let Some(position) = placeholder {
        for (run_index, run) in line.runs.iter().enumerate() {
            let len = run.text.chars().count();
            if (run_start..run_start + len).contains(&position)
                && run.text.chars().nth(position - run_start) == Some(' ')
            {
                target = Some((run_index, position - run_start));
                break;
            }
            run_start += len;
        }
    }
    match target {
        Some((run_index, local)) => {
            let run = line.runs.remove(run_index);
            let chars: Vec<char> = run.text.chars().collect();
            let mut pieces = Vec::with_capacity(3);
            if local > 0 {
                let mut before = run.clone();
                before.text = chars[..local].iter().collect();
                before.display_text = None;
                before.footnote_marker = None;
                pieces.push(before);
            }
            let mut number = run.clone();
            number.text = " ".to_string();
            number.display_text = Some(number_text.trim_end().to_string());
            number.footnote_marker = number_marker;
            pieces.push(number);
            if local + 1 < chars.len() {
                let mut after = run;
                after.text = chars[local + 1..].iter().collect();
                after.display_text = None;
                after.footnote_marker = None;
                pieces.push(after);
            }
            for (offset, piece) in pieces.into_iter().enumerate() {
                line.runs.insert(run_index + offset, piece);
            }
        }
        None => {
            let mut number = line.runs.first().cloned().unwrap_or_default();
            number.text = number_text.to_string();
            number.char_style_id = base_cs_id;
            number.display_text = None;
            number.footnote_marker = number_marker;
            number.char_overlap = None;
            number.inserted_control_text = true;
            line.runs.insert(0, number);
        }
    }
    Some(numbered)
}

/// 각주 내용 번호 "작게": 일반 문단 경로가 그린 번호 run을 본문 각주 표시와 같은 크기(3/4)·
/// 기준선으로 줄이고, 같은 줄 뒤의 글자 run을 줄어든 폭만큼 당긴다(한/글 12.30 Mac 인쇄).
fn shrink_footnote_number(nodes: &mut [RenderNode], number: &str) {
    for line in nodes
        .iter_mut()
        .filter(|node| matches!(node.node_type, RenderNodeType::TextLine(_)))
    {
        let Some(index) = line.children.iter().position(|child| {
            matches!(&child.node_type, RenderNodeType::TextRun(run)
                if run.display_or_text().trim_end() == number)
        }) else {
            continue;
        };
        let node = &mut line.children[index];
        let RenderNodeType::TextRun(run) = &mut node.node_type else {
            return;
        };
        let base = run.style.font_size;
        let (size, baseline) =
            crate::renderer::script_metrics::ScriptMetricsContract::NoteReference.draw_metrics(
                base,
                run.baseline,
                true,
                false,
                run.style.font_position,
            );
        run.style.font_size = size;
        run.baseline = baseline;
        // 실제 크기·기준선으로 소비했으므로 paint가 첨자를 다시 축소하지 않는다.
        run.style.superscript = false;
        run.style.subscript = false;
        run.style.font_position = None;
        run.layout_positions = None;
        let width = estimate_text_width(run.display_or_text(), &run.style);
        let dx = node.bbox.width - width;
        node.bbox.width = width;
        for next in &mut line.children[index + 1..] {
            if matches!(next.node_type, RenderNodeType::TextRun(_)) {
                next.bbox.x -= dx;
            }
        }
        return;
    }
}

fn footnote_composed_line_count(
    paragraphs: &[Paragraph],
    content_width_px: f64,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> usize {
    paragraphs
        .iter()
        .map(|paragraph| {
            compose_footnote_paragraph(paragraph, content_width_px, styles, dpi)
                .lines
                .len()
                .max(1)
        })
        .sum()
}

/// [#6866] 회전 프레임 그림의 노드 상자 — `pic`(회전 전 비트맵)과 **중심이 같은**
/// `size` 상자를 만든다. `size` 가 `pic` 과 같으면 원래 상자 그대로다.
fn rotated_frame_node_box(
    pic_x: f64,
    pic_y: f64,
    pic_width: f64,
    pic_height: f64,
    size: (f64, f64),
) -> BoundingBox {
    let (width, height) = size;
    let center_x = pic_x + pic_width / 2.0;
    let center_y = pic_y + pic_height / 2.0;
    BoundingBox::new(
        center_x - width / 2.0,
        center_y - height / 2.0,
        width,
        height,
    )
}

impl LayoutEngine {
    /// [Task #825] 머리말/꼬리말 picture 전용 — outer Header/Footer 위치 marker 전달.
    /// `header_footer_ref` 가 `Some` 일 때 ImageNode 에 마커 설정 → rhwp-studio
    /// 머리말/꼬리말 그림 클릭 hit-test + 개체 속성 dialog dispatch 활성화.
    ///
    /// [Task #1151 v4] `cell_ctx` 가 `Some` 일 때 ImageNode 의 cell_index 설정 +
    /// tac=true 인 경우 `inline_shape_positions` 등록. studio findPictureAtClick 가
    /// cellIdx 인식하여 셀 안 picture 의 클릭 hit-test 정상 동작.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_picture_full(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        picture: &crate::model::image::Picture,
        container: &LayoutRect,
        bin_data_content: &[BinDataContent],
        alignment: Alignment,
        section_index: Option<usize>,
        para_index: Option<usize>,
        control_index: Option<usize>,
        header_footer_ref: Option<crate::renderer::render_tree::HeaderFooterImageRef>,
        cell_ctx: Option<&crate::renderer::layout::CellContext>,
        // [#6284] 캡션 문단 조판에 필요하다.
        styles: &ResolvedStyleSet,
    ) {
        // 그림 크기 (HWPUNIT → 픽셀)
        // 회전 picture에서 common.width/height는 한컴이 저장한 회전 후 외접 프레임이고
        // current_width/current_height는 실제로 회전시킬 원본 표시 크기다. common 프레임을
        // 다시 회전시키면 다단/셀 경계를 침범하므로, current 이미지를 common 프레임 중앙에 둔다.
        let rotation = picture.shape_attr.rotation_angle.rem_euclid(360);
        let uses_rotated_frame = rotation != 0
            && picture.shape_attr.current_width > 0
            && picture.shape_attr.current_height > 0
            && picture.common.width > 0
            && picture.common.height > 0;
        let (pic_width_hu, pic_height_hu) = if uses_rotated_frame {
            (
                picture.shape_attr.current_width as i32,
                picture.shape_attr.current_height as i32,
            )
        } else {
            picture_display_size_hu(picture)
        };
        let mut pic_width = hwpunit_to_px(pic_width_hu, self.dpi);
        let mut pic_height = hwpunit_to_px(pic_height_hu, self.dpi);
        let mut frame_width = if uses_rotated_frame {
            hwpunit_to_px(picture.common.width as i32, self.dpi)
        } else {
            pic_width
        };
        let mut frame_height = if uses_rotated_frame {
            hwpunit_to_px(picture.common.height as i32, self.dpi)
        } else {
            pic_height
        };

        // 글자처럼 표 셀 그림은 저장 frame으로 그린 뒤 TableCell clip에 맡긴다. 한/글은
        // 셀 안쪽 폭에 맞춰 비율 축소하지 않으며, 넘치는 오른쪽·아래만 셀 경계에서 자른다.
        // 먼저 축소하면 #7333 31쪽 스크린샷과 그 안의 주석 도형이 함께 작아진다. 그 밖의
        // 그림은 기존처럼 컨테이너를 넘지 않도록 비율 유지 축소한다.
        let preserve_inline_cell_frame = picture.common.treat_as_char && cell_ctx.is_some();
        if !preserve_inline_cell_frame {
            // 회전 프레임과 실제 이미지를 같은 비율로 축소해야 중심/회전축이 유지된다.
            if container.width > 0.0 && frame_width > container.width {
                let scale = container.width / frame_width;
                frame_width = container.width;
                frame_height *= scale;
                pic_width *= scale;
                pic_height *= scale;
            }
            if container.height > 0.0 && frame_height > container.height {
                let scale = container.height / frame_height;
                frame_height = container.height;
                frame_width *= scale;
                pic_height *= scale;
                pic_width *= scale;
            }
        }

        // [#6866] **회전 프레임 그림의 노드 상자는 `frame`(= 선언 상자)이다.**
        //
        // 페인터는 `ShapeTransform::effective_image_bbox` 로 90/270° 회전 그림의
        // bbox 가로세로를 **먼저 뒤집은 뒤** 회전을 건다(이중회전 방지, shot 05).
        // 즉 페인터는 노드 상자가 **회전 후** 상자라고 전제한다. 그런데 위에서
        // `pic_*`(= `current_*`, 회전 **전** 비트맵)로 상자를 내면 그 전제가 깨져
        // 뒤집기가 한 번 더 걸린다 — 선언 29.3×53.7 이 53.7×29.3 으로 눕는다
        // (156627451 12쪽 `angle=270`, 같은 문서 `angle=0` 15장은 정상).
        //
        // 두 상자는 중심이 같으므로, 노드에 `frame` 을 실으면 페인터의 뒤집기가
        // 정확히 `pic` 을 만들어 내고 회전이 다시 `frame` 으로 돌려놓는다.
        // 두 상자는 중심이 같으므로 원점도 그 중심에서 되짚는다.
        let node_box_size = if uses_rotated_frame {
            (frame_width, frame_height)
        } else {
            (pic_width, pic_height)
        };

        // [#6284] 캡션 띠 — 그림이 차지하는 블록은 그림 + 캡션이다.
        //
        // 이 계약은 형제 함수 `layout_body_picture` 에 이미 있었는데, 본문 그림을
        // 실제로 그리는 이 경로에는 없었다. 그래서 `side="TOP"` 캡션이 통째로
        // 사라지고 그림이 캡션 띠만큼(≈15.6~20px) 위로 올라왔다
        // (156562502: 캡션 17개 전부 TOP, 그림 9개가 3pt 초과로 어긋남).
        let caption_band_height =
            crate::renderer::composer::caption_height_px(&picture.caption, self.dpi);
        let caption_spacing = picture
            .caption
            .as_ref()
            .map(|c| hwpunit_to_px(c.spacing as i32, self.dpi))
            .unwrap_or(0.0);
        let (caption_top_offset, caption_left_offset, caption_band_width) =
            match picture.caption.as_ref().map(|c| c.direction) {
                Some(CaptionDirection::Top) => (caption_band_height + caption_spacing, 0.0, 0.0),
                Some(CaptionDirection::Left) => {
                    let cw = picture
                        .caption
                        .as_ref()
                        .map(|c| hwpunit_to_px(c.width as i32, self.dpi))
                        .unwrap_or(0.0);
                    (0.0, cw + caption_spacing, cw + caption_spacing)
                }
                Some(CaptionDirection::Right) => {
                    let cw = picture
                        .caption
                        .as_ref()
                        .map(|c| hwpunit_to_px(c.width as i32, self.dpi))
                        .unwrap_or(0.0);
                    (0.0, 0.0, cw + caption_spacing)
                }
                _ => (0.0, 0.0, 0.0),
            };
        // Bottom 캡션은 그림을 밀지 않고 블록 높이만 늘린다.
        let caption_block_extra_height = match picture.caption.as_ref().map(|c| c.direction) {
            Some(CaptionDirection::Top) | Some(CaptionDirection::Bottom) => {
                caption_band_height + caption_spacing
            }
            _ => 0.0,
        };
        let block_width = frame_width + caption_band_width;
        let block_height = frame_height + caption_block_extra_height;

        // 그림 위치: non-TAC 이미지는 common 속성의 offset 적용
        // 머리말/꼬리말에서 vert=Paper는 상단여백(header area) 기준
        let (pic_x, pic_y) = if !picture.common.treat_as_char {
            let h_offset = hwpunit_to_px(picture.common.horizontal_offset as i32, self.dpi);
            let v_offset = hwpunit_to_px(picture.common.vertical_offset as i32, self.dpi);
            let frame_x = match crate::renderer::float_placement::effective_horz_align(picture.common.horz_align) {
                HorzAlign::Left | HorzAlign::Inside => container.x + h_offset,
                HorzAlign::Center => container.x + (container.width - block_width) / 2.0 + h_offset,
                HorzAlign::Right | HorzAlign::Outside => {
                    container.x + container.width - block_width - h_offset
                }
            };
            let frame_y = match crate::renderer::float_placement::effective_vert_align(picture.common.vert_rel_to, picture.common.vert_align) {
                VertAlign::Top | VertAlign::Inside => container.y + v_offset,
                VertAlign::Center => {
                    container.y + (container.height - block_height) / 2.0 + v_offset
                }
                VertAlign::Bottom | VertAlign::Outside => {
                    container.y + container.height - block_height - v_offset
                }
            };
            (
                frame_x + caption_left_offset + (frame_width - pic_width) / 2.0,
                frame_y + caption_top_offset + (frame_height - pic_height) / 2.0,
            )
        } else {
            let frame_x = match alignment {
                Alignment::Center | Alignment::Distribute => {
                    container.x + (container.width - block_width).max(0.0) / 2.0
                }
                Alignment::Right => container.x + (container.width - block_width).max(0.0),
                _ => container.x,
            };
            (
                frame_x + caption_left_offset + (frame_width - pic_width) / 2.0,
                container.y + caption_top_offset + (frame_height - pic_height) / 2.0,
            )
        };

        // BinData에서 이미지 데이터 찾기 (bin_data_id는 1-indexed 순번)
        let bin_data_id = picture.image_attr.bin_data_id;
        let image_data = find_bin_data_bytes(bin_data_content, bin_data_id);
        // [Task #2225] 그림 미지정(bin 참조 실패 + 외부 경로 없음): 한컴은 편집기
        // 에서만 점선 테두리+그림-없음 아이콘으로 표시하고 인쇄 등가 출력은
        // 미출력 — 의미 노드(MissingPicture)로 방출해 백엔드별 분기를 일원화.
        if picture_data_is_unusable(image_data.as_deref())
            && picture.image_attr.external_path.is_none()
        {
            let ph_id = tree.next_id();
            parent_node.children.push(RenderNode::new(
                ph_id,
                RenderNodeType::Placeholder(
                    // [Task #2230] 문서 좌표 + 셀 경로 배선 — 편집 뷰 클릭
                    // 선택·그림 지정의 대상 특정에 사용.
                    crate::renderer::render_tree::PlaceholderNode::missing_picture(
                        section_index,
                        para_index,
                        control_index,
                        cell_ctx.cloned(),
                    ),
                ),
                rotated_frame_node_box(pic_x, pic_y, pic_width, pic_height, node_box_size),
            ));
            return;
        }

        // 그림 자르기: crop 좌표를 그대로 저장 (렌더러에서 이미지 px 크기와 비교)
        let crop = picture.render_crop_rect();

        // crop 좌표 기준 범위(imgDim). orgSz는 개체 크기이므로 사용하지 않는다.
        let original_size_hu = picture.crop_reference_size();

        // 이미지 노드 생성
        // [Task #1151 v7 항목 1] cell_ctx 의 3 필드 매핑은 CellContext::last_image_indices()
        // 로 통합 (이전: 각 필드마다 path.last() 호출 반복).
        let (cei, cpi, otci) = cell_ctx
            .map(|c| c.last_image_indices())
            .unwrap_or((None, None, None));
        let img_id = tree.next_id();
        let mut img_node = RenderNode::new(
            img_id,
            RenderNodeType::Image(ImageNode {
                section_index,
                para_index,
                control_index,
                crop,
                original_size_hu,
                effect: picture.image_attr.effect,
                brightness: picture.image_attr.brightness,
                contrast: picture.image_attr.contrast,
                opacity: picture.image_attr.opacity(),
                text_wrap: Some(picture.common.text_wrap),
                transform: crate::renderer::image_geometry::picture_transform(picture),
                external_path: picture.image_attr.external_path.clone(),
                content_inset: crate::renderer::layout::utils::picture_content_inset(picture),
                pre_rotation_ratio: crate::renderer::image_geometry::picture_pre_rotation_ratio(
                    picture,
                ),
                source_rect: crate::renderer::image_geometry::picture_source_rect(picture),
                header_footer_ref: header_footer_ref.clone(),
                cell_index: cei,
                cell_para_index: cpi,
                outer_table_control_index: otci,
                // [Task #1161] 전체 다단계 경로 보존(스칼라는 위 innermost 투영).
                cell_context: cell_ctx.cloned(),
                ..ImageNode::new(bin_data_id, image_data)
            }),
            rotated_frame_node_box(pic_x, pic_y, pic_width, pic_height, node_box_size),
        );
        img_node.source_inline_picture = picture.common.treat_as_char;

        self.append_picture_image_node(tree, parent_node, picture, img_node);

        // [#6284] 캡션 렌더링 — 기하는 위에서 예약한 띠와 같은 산식이다
        // (`layout_body_picture` 의 캡션 방출부와 같은 규칙).
        if let Some(ref caption) = picture.caption {
            use crate::model::shape::CaptionVertAlign;
            let (cap_x, cap_w, cap_y) = match caption.direction {
                CaptionDirection::Top => (
                    pic_x,
                    pic_width,
                    (pic_y - caption_top_offset).max(container.y),
                ),
                CaptionDirection::Bottom => {
                    (pic_x, pic_width, pic_y + pic_height + caption_spacing)
                }
                CaptionDirection::Left | CaptionDirection::Right => {
                    let cw = hwpunit_to_px(caption.width as i32, self.dpi);
                    let cx = if caption.direction == CaptionDirection::Left {
                        pic_x - caption_left_offset
                    } else {
                        pic_x + pic_width + caption_spacing
                    };
                    let cy = match caption.vert_align {
                        CaptionVertAlign::Top => pic_y,
                        CaptionVertAlign::Center => {
                            pic_y + (pic_height - caption_band_height).max(0.0) / 2.0
                        }
                        CaptionVertAlign::Bottom => {
                            pic_y + (pic_height - caption_band_height).max(0.0)
                        }
                    };
                    (cx, cw, cy)
                }
            };
            let caption_cell_ctx = cell_ctx.cloned().or_else(|| {
                para_index.map(|pi| super::CellContext {
                    in_textbox: false,
                    parent_para_index: pi,
                    path: vec![super::CellPathEntry {
                        control_index: control_index.unwrap_or(0),
                        cell_index: 0,
                        cell_para_index: 0,
                        text_direction: 0,
                    }],
                })
            });
            self.layout_caption(
                tree,
                parent_node,
                caption,
                styles,
                container,
                cap_x,
                cap_w,
                cap_y,
                &mut self.auto_counter.borrow_mut(),
                bin_data_content,
                caption_cell_ctx,
                CaptionOwner::new(
                    section_index,
                    para_index,
                    control_index,
                    CaptionControlKind::Image,
                ),
            );
        }

        // [Task #1151 v4] tac=true 셀 안 picture 의 위치를 inline_shape_positions 에 등록 →
        // cursor_rect 의 hit-test 루프가 picture 클릭 인식. 셀 외부 / 본문 picture 는
        // 기존 register path (paragraph_layout) 가 처리하므로 cell_ctx Some + tac=true
        // 인 경우만.
        if picture.common.treat_as_char {
            if let (Some(sec), Some(para_for_layout), Some(ctrl)) =
                (section_index, para_index, control_index)
            {
                tree.set_inline_shape_position(sec, para_for_layout, ctrl, cell_ctx, pic_x, pic_y);
            }
        }

        // 그림과 외곽선은 위 append_picture_image_node에서 한 번 발행했다.
    }

    /// 개체(Picture/Shape)의 절대 좌표 (x, y)를 계산한다.
    /// HWP 스펙에 따른 VertRelTo/HorzRelTo/VertAlign/HorzAlign/treat_as_char 처리를 통합한 단일 함수.
    /// 상대 크기(WidthCriterion/HeightCriterion)를 적용하여 실제 px 크기를 반환한다.
    pub(crate) fn resolve_object_size(
        &self,
        common: &CommonObjAttr,
        col_area: &LayoutRect,
        body_area: &LayoutRect,
        paper_area: &LayoutRect,
    ) -> (f64, f64) {
        use crate::model::shape::SizeCriterion;

        let raw_w = common.width as f64;
        let raw_h = common.height as f64;

        let obj_width = match common.width_criterion {
            SizeCriterion::Absolute => hwpunit_to_px(common.width as i32, self.dpi),
            SizeCriterion::Paper => paper_area.width * raw_w / 10000.0,
            SizeCriterion::Page => body_area.width * raw_w / 10000.0,
            SizeCriterion::Column => col_area.width * raw_w / 10000.0,
            SizeCriterion::Para => col_area.width * raw_w / 10000.0,
        };

        // [hwpx-cowork] 2026-11-04 글상자 자동 늘림(textbox_autogrow)이 늘린 높이는 HU 다 — 상대
        // 높이 기준이어도 % 로 다시 읽지 않는다(늘린 3646 → 30698 겹셈, textbox 검정 b214·b215).
        let height_criterion = if common.auto_grow_base_height.is_some() {
            SizeCriterion::Absolute
        } else {
            common.height_criterion
        };
        let obj_height = match height_criterion {
            SizeCriterion::Absolute => hwpunit_to_px(common.height as i32, self.dpi),
            SizeCriterion::Paper => paper_area.height * raw_h / 10000.0,
            SizeCriterion::Page => body_area.height * raw_h / 10000.0,
            _ => hwpunit_to_px(common.height as i32, self.dpi),
        };

        (obj_width, obj_height)
    }

    pub(crate) fn compute_object_position(
        &self,
        common: &CommonObjAttr,
        obj_width: f64,
        obj_height: f64,
        container: &LayoutRect,
        col_area: &LayoutRect,
        body_area: &LayoutRect,
        paper_area: &LayoutRect,
        para_y: f64,
        alignment: Alignment,
    ) -> (f64, f64) {
        crate::renderer::float_placement::ObjectPlacementFrame {
            container,
            column: col_area,
            body: body_area,
            paper: paper_area,
            paragraph_y: para_y,
            alignment,
            dpi: self.dpi,
        }
        .position(common, obj_width, obj_height)
    }

    /// 본문 그림을 배치하고, 같은 확정 원점에서 표시 하단과 흐름 끝을 반환한다.
    pub(crate) fn layout_body_picture(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        picture: &crate::model::image::Picture,
        container: &LayoutRect,
        col_area: &LayoutRect,
        body_area: &LayoutRect,
        paper_area: &LayoutRect,
        bin_data_content: &[BinDataContent],
        styles: &ResolvedStyleSet,
        alignment: Alignment,
        y_offset: f64,
        section_index: usize,
        para_index: usize,
        control_index: usize,
        // [Task #1079] 파일 vpos 가 이미 그림 공간을 반영(그림 para 줄 앞 gap ≥ 그림 높이)하면
        // 그림을 그 gap 안(바닥이 그림 para 줄에 정렬)에 그리고 flow 를 그림 높이만큼 추가
        // 진행하지 않는다. 이중 계상(gap + draw-advance) 방지.
        vpos_accounts_for_height: bool,
    ) -> BodyPicturePlacement {
        // 그림 크기 (HWPUNIT → 픽셀)
        // [Issue #1230] 측면흐름 wrap 은 common(개체 틀) 프레임으로 그린다.
        let (pic_width_hu, pic_height_hu) = super::utils::picture_flow_frame_size_hu(picture);
        let pic_width = hwpunit_to_px(pic_width_hu, self.dpi);
        let pic_height = hwpunit_to_px(pic_height_hu, self.dpi);

        // 캡션 높이 및 간격 계산
        let caption_height = self.calculate_caption_height(&picture.caption, styles);
        let caption_spacing = if let Some(ref caption) = picture.caption {
            hwpunit_to_px(caption.spacing as i32, self.dpi)
        } else {
            0.0
        };

        // #6596의 여백·캡션 상자를 셀과 같은 생산 결과로 소비한다.
        let outer_box = crate::renderer::float_placement::picture_outer_box(
            picture,
            pic_width,
            pic_height,
            caption_height,
            self.dpi,
        );
        let box_width = outer_box.width;
        let box_height = outer_box.height;
        let margin_left = outer_box.margin_left;
        let margin_top = outer_box.margin_top;

        // 통합 좌표 계산 (여백을 포함한 상자 기준)
        let (box_x, base_y) = self.compute_object_position(
            &picture.common,
            box_width,
            box_height,
            container,
            col_area,
            body_area,
            paper_area,
            y_offset,
            alignment,
        );

        // [Issue #2032] restrictInPage(쪽 영역 안으로 제한, HWP5 attr bit 13 = HWPX pos@flowWithText):
        // vert=Para floating 그림의 하단이 쪽 영역을 벗어나면 쪽 영역 안으로 끌어올린다.
        // 미적용 시 앵커+offset 조합으로 좌표가 페이지 캔버스 밖이 되어 그림이 어느
        // 페이지에서도 보이지 않는다 (완전 소실). floating 표 동등 로직
        // (table_layout.rs compute_table_y 의 Para 클램프) 과 동일 시멘틱.
        // 상단(top bleed) 은 한컴도 허용하는 사례가 있어 하단 초과만 교정한다
        // (표의 allow_para_top_bleed 예외와 동일 취지).
        // vpos_accounts_for_height(파일 vpos 가 그림 공간을 이미 반영) 이면 그림은
        // base_y 위쪽 gap 안에 그려지므로 (frame 하단 = base_y) 클램프 비대상.
        let base_y = if !picture.common.treat_as_char
            && picture.common.flow_with_text
            && !vpos_accounts_for_height
            && matches!(picture.common.vert_rel_to, VertRelTo::Para)
        {
            let body_bottom = col_area.y + col_area.height - box_height;
            base_y.min(body_bottom.max(col_area.y))
        } else {
            base_y
        };

        let caption_top_offset = outer_box.caption_top;
        let caption_left_offset = outer_box.caption_left;

        // 잉크 원점 = 상자 원점 + (왼쪽 여백, 위 여백). #3821 이 Column-왼쪽 Square 의
        // 왼쪽 여백에만 좁혀 적용하던 것을 위 실측대로 사방·전 기준으로 편다. wrap
        // exclusion 은 이미 source LINE_SEG 가 상자 기준으로 보유한다.
        let adjusted_pic_x = box_x + margin_left + caption_left_offset;
        // [Task #1079] already_accounted: 상자를 gap 안에 그림(상자 바닥이 base_y=그림 para
        // 줄에 정렬되도록 box_height 만큼 위로). flow 진행은 아래 return 에서 생략.
        let vpos_shift = if vpos_accounts_for_height {
            box_height
        } else {
            0.0
        };
        let content_top = base_y + margin_top - vpos_shift;
        let pic_y = content_top + caption_top_offset;

        // BinData에서 이미지 데이터 찾기 (bin_data_id는 1-indexed 순번)
        let bin_data_id = picture.image_attr.bin_data_id;
        let image_data = find_bin_data_bytes(bin_data_content, bin_data_id);
        // [Task #2225] 그림 미지정 — layout_picture_full 과 동일 분기.
        //
        // 여기서 곧장 되돌아가면(early return) 캡션 배치와 흐름 계산을 통째로 건너뛴다 —
        // 캡션 글자가 사라지고, 반환값도 "후속 y" 가 아니라 "높이" 가 되어 뒤 문단이 그림
        // 위로 올라탄다. 그래서 **노드만 바꿔 끼우고** 나머지 경로는 그대로 태운다.
        let picture_missing = picture_data_is_unusable(image_data.as_deref())
            && picture.image_attr.external_path.is_none();

        // 그림 자르기
        let crop = picture.render_crop_rect();

        let original_size_hu = picture.crop_reference_size();

        // 이미지 노드 생성 (그림 미지정이면 같은 자리·같은 bbox 의 placeholder 노드)
        let img_id = tree.next_id();
        let node_type = if picture_missing {
            RenderNodeType::Placeholder(
                // [Task #2230] 본문 picture — 셀 경로 없음(None).
                crate::renderer::render_tree::PlaceholderNode::missing_picture(
                    Some(section_index),
                    Some(para_index),
                    Some(control_index),
                    None,
                ),
            )
        } else {
            RenderNodeType::Image(ImageNode {
                section_index: Some(section_index),
                para_index: Some(para_index),
                control_index: Some(control_index),
                crop,
                original_size_hu,
                effect: picture.image_attr.effect,
                brightness: picture.image_attr.brightness,
                contrast: picture.image_attr.contrast,
                opacity: picture.image_attr.opacity(),
                text_wrap: Some(picture.common.text_wrap),
                transform: crate::renderer::image_geometry::picture_transform(picture),
                external_path: picture.image_attr.external_path.clone(),
                content_inset: crate::renderer::layout::utils::picture_content_inset(picture),
                pre_rotation_ratio: crate::renderer::image_geometry::picture_pre_rotation_ratio(
                    picture,
                ),
                source_rect: crate::renderer::image_geometry::picture_source_rect(picture),
                ..ImageNode::new(bin_data_id, image_data)
            })
        };
        let mut img_node = RenderNode::new(
            img_id,
            node_type,
            BoundingBox::new(adjusted_pic_x, pic_y, pic_width, pic_height),
        );
        // [hwpx-cowork] 그림 효과(그림자·네온) — 그림 뒤에 먼저 넣고 효과의 왼쪽·위 넘침만큼 그림·테두리를 옮긴다
        let (fx_dx, fx_dy) = self.push_picture_effect_nodes(tree, parent_node, picture, &mut img_node);

        parent_node.children.push(img_node);
        let mut content_bottom = pic_y + pic_height;

        // 그림 테두리(선) 렌더링 — 효과로 옮긴 그림을 따라간다(흐름·캡션 자리는 그대로)
        self.render_picture_border(
            tree,
            parent_node,
            picture,
            img_id,
            adjusted_pic_x + fx_dx,
            pic_y + fx_dy,
            pic_width,
            pic_height,
        );

        // 캡션 렌더링
        if let Some(ref caption) = picture.caption {
            use crate::model::shape::CaptionVertAlign;
            let (cap_x, cap_w, cap_y) = match caption.direction {
                CaptionDirection::Top => (adjusted_pic_x, pic_width, base_y + margin_top),
                CaptionDirection::Bottom => (
                    adjusted_pic_x,
                    pic_width,
                    pic_y + pic_height + caption_spacing,
                ),
                CaptionDirection::Left | CaptionDirection::Right => {
                    let cw = hwpunit_to_px(caption.width as i32, self.dpi);
                    let cx = if caption.direction == CaptionDirection::Left {
                        box_x + margin_left
                    } else {
                        adjusted_pic_x + pic_width + caption_spacing
                    };
                    let cy = match caption.vert_align {
                        CaptionVertAlign::Top => pic_y,
                        CaptionVertAlign::Center => {
                            pic_y + (pic_height - caption_height).max(0.0) / 2.0
                        }
                        CaptionVertAlign::Bottom => pic_y + (pic_height - caption_height).max(0.0),
                    };
                    (cx, cw, cy)
                }
            };

            content_bottom = content_bottom.max(cap_y + caption_height);
            let cell_ctx = super::CellContext {
                in_textbox: false,
                parent_para_index: para_index,
                path: vec![super::CellPathEntry {
                    control_index,
                    cell_index: 0,
                    cell_para_index: 0,
                    text_direction: 0,
                }],
            };
            self.layout_caption(
                tree,
                parent_node,
                caption,
                styles,
                col_area,
                cap_x,
                cap_w,
                cap_y,
                &mut self.auto_counter.borrow_mut(),
                bin_data_content,
                Some(cell_ctx),
                CaptionOwner::new(
                    Some(section_index),
                    Some(para_index),
                    Some(control_index),
                    CaptionControlKind::Image,
                ),
            );
        }

        // y_offset 업데이트: Para 기준 그림만 높이만큼 진행
        // Page/Paper 기준 그림은 플로팅이므로 y_offset 변경 없음
        // Task #347: 글뒤로/글앞으로 그림은 본문 흐름을 점유하지 않으므로 y 미진행.
        // base_y는 vert_offset이 적용된 상자 상단 y이므로, base_y + box_height 가
        // 상자 하단(잉크 + 위·아래 여백) y가 된다. y_offset(앵커 단락 y) 대신 base_y를
        // 기준으로 반환해야 vert_offset이 있는 혼합 단락(텍스트+그림)에서 후속 단락이
        // 그림 위로 겹치지 않는다.
        let flow_end = match (picture.common.vert_rel_to, picture.common.text_wrap) {
            (VertRelTo::Para, TextWrap::BehindText | TextWrap::InFrontOfText) => y_offset,
            // [Task #1079] 파일 vpos 가 그림 공간을 이미 반영하면 그림은 gap 안에 그려졌고
            // 후속 문단은 파일 vpos(그림 para 줄)로 흐르므로 추가 진행 없이 base_y 반환.
            (VertRelTo::Para, _) if vpos_accounts_for_height => base_y,
            (VertRelTo::Para, _) => base_y + box_height,
            (VertRelTo::Page | VertRelTo::Paper, _) => y_offset,
        };
        BodyPicturePlacement {
            flow_end,
            content_bottom,
        }
    }

    /// 캡션의 총 높이를 계산한다.
    ///
    /// 산식은 `composer::caption_height_px`가 단일 정의다(#4320) — height_measurer 의
    /// `measure_caption`도 같은 함수를 호출한다.
    pub(crate) fn calculate_caption_height(
        &self,
        caption: &Option<Caption>,
        styles: &ResolvedStyleSet,
    ) -> f64 {
        super::super::composer::caption_height_px_in_context(caption, Some(styles), self.dpi)
    }

    /// 캡션을 레이아웃한다.
    pub(crate) fn layout_caption(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        caption: &Caption,
        styles: &ResolvedStyleSet,
        _col_area: &LayoutRect,
        content_x: f64,
        content_width: f64,
        y_start: f64,
        _auto_counter: &mut AutoNumberCounter,
        bin_data_content: &[BinDataContent],
        cell_ctx: Option<super::CellContext>,
        caption_owner: Option<CaptionOwner>,
    ) {
        if caption.paragraphs.is_empty() {
            return;
        }

        let caption_area = LayoutRect {
            x: content_x,
            y: y_start,
            width: content_width,
            height: 0.0, // 높이는 동적
        };

        // [hwpx-cowork] 떠 있는 개체가 든 캡션: 줄 위치·개체 위치를 흐름 계획으로 정한다.
        let float_plan = super::super::composer::caption_float_plan_in_context(caption, Some(styles), self.dpi);
        let mut para_y = y_start;
        for (pi, para) in caption.paragraphs.iter().enumerate() {
            let first_caption_node = parent_node.children.len();
            if let Some(top) = float_plan.as_ref().and_then(|p| p.para_text_top.get(pi)) {
                para_y = y_start + top;
            }
            let para_y_before_layout = para_y;
            // 먼저 문단을 조합
            let mut composed =
                crate::renderer::composer::compose_paragraph_in_context(para, styles);

            // 자동 번호는 자리표 글자의 표시 문자열로만 바꿔 글자 위치 대응을 지킨다.
            crate::renderer::composer::project_caption_auto_numbers(&mut composed, para);

            // cell_ctx에 cell_para_index 갱신
            let ctx = cell_ctx.as_ref().map(|c| {
                let mut cc = c.clone();
                if let Some(last) = cc.path.last_mut() {
                    last.cell_para_index = pi;
                }
                cc
            });

            para_y = self.layout_composed_paragraph(
                tree,
                parent_node,
                &composed,
                styles,
                &caption_area,
                para_y,
                0,
                composed.lines.len(),
                0,
                0,
                ctx.clone(),
                false,
                false,
                0.0,
                None,
                Some(para),
                Some(bin_data_content),
                None, // 캡션 컨텍스트 — wrap zone 무관
            );

            // Tag only lines emitted by this caption paragraph, not text inside
            // its nested controls or earlier siblings. Wrapped lines share pi.
            for node in &mut parent_node.children[first_caption_node..] {
                if let RenderNodeType::TextLine(line) = &mut node.node_type {
                    line.caption_owner = caption_owner.map(|owner| CaptionOwner {
                        caption_ordinal: pi,
                        ..owner
                    });
                }
            }

            // [hwpx-cowork] 글자처럼 도형은 줄 배치가 인라인 좌표만 등록하고 그리는 쪽이 없어
            // 캡션에서 사라졌다(본문은 layout_shape 가 그 좌표로 그린다).
            for (ci, ctrl) in para.controls.iter().enumerate() {
                let Control::Shape(shape) = ctrl else {
                    continue;
                };
                if !shape.common().treat_as_char {
                    continue;
                }
                if let Some((sx, sy)) = tree.get_inline_shape_position(0, 0, ci, ctx.as_ref()) {
                    let sw = hwpunit_to_px(shape.common().width as i32, self.dpi);
                    let sh = hwpunit_to_px(shape.common().height as i32, self.dpi);
                    self.layout_shape_object(
                        tree,
                        parent_node,
                        shape,
                        sx,
                        sy,
                        sw,
                        sh,
                        0,
                        pi,
                        ci,
                        styles,
                        bin_data_content,
                        &std::collections::HashMap::new(),
                        &[],
                        None,
                        false,
                    );
                }
            }
            if float_plan.is_none() {
                // [hwpx-cowork] 저장 첫 줄이 이 문단 첫머리 자리차지 그림에 밀려 내려갔으면 그림의
                // 원점은 문단 위다(`stored_head_float_pushdown_hu`).
                let stored_head_float_pushdown_px = crate::renderer::layout::stored_head_float_pushdown_hu(
                    pi.checked_sub(1).and_then(|i| caption.paragraphs.get(i)),
                    para,
                )
                .map(|hu| hwpunit_to_px(hu, self.dpi))
                .unwrap_or(0.0);
                self.layout_caption_topbottom_pictures(
                    tree,
                    parent_node,
                    para,
                    &caption_area,
                    para_y_before_layout,
                    stored_head_float_pushdown_px,
                    bin_data_content,
                    ctx.as_ref(),
                    styles,
                );
            }
        }
        if let Some(plan) = float_plan.as_ref() {
            self.layout_caption_floats(
                tree,
                parent_node,
                caption,
                plan,
                styles,
                &caption_area,
                bin_data_content,
                cell_ctx.as_ref(),
            );
        }
    }

    /// [hwpx-cowork] 2026-11-04 표 캡션을 그리고 캡션 영역을 넘는 내용을 그 영역으로 자른다
    /// (`clip_caption_content`). `owner` 는 캡션이 붙은 표 상자(나뉜 표는 이 조각), 나머지 인자는
    /// `layout_caption` 과 같다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_table_caption_clipped(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        caption: &Caption,
        styles: &ResolvedStyleSet,
        col_area: &LayoutRect,
        content_x: f64,
        content_width: f64,
        y_start: f64,
        auto_counter: &mut AutoNumberCounter,
        bin_data_content: &[BinDataContent],
        cell_ctx: Option<super::CellContext>,
        caption_owner: Option<CaptionOwner>,
        owner: BoundingBox,
    ) {
        let first = parent_node.children.len();
        self.layout_caption(
            tree,
            parent_node,
            caption,
            styles,
            col_area,
            content_x,
            content_width,
            y_start,
            auto_counter,
            bin_data_content,
            cell_ctx,
            caption_owner,
        );
        clip_caption_content(
            &mut parent_node.children[first..],
            caption.direction,
            owner,
            content_x,
            content_width,
            y_start,
        );
    }

    /// [hwpx-cowork] 캡션 안 떠 있는 개체(표·도형·그림)를 흐름 계획대로 그린다.
    /// 원점은 `RegionFloatFrame`(가로 = 캡션 틀, 세로 쪽·종이 = 캡션 위 높이 0, 세로 문단 = 앵커
    /// 문단 위). 종전에는 자리차지 그림만 저장 줄 vpos(이미 개체 아래로 밀린 줄)에 그리고 표·도형은
    /// 그리지 않았다.
    #[allow(clippy::too_many_arguments)]
    fn layout_caption_floats(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        caption: &Caption,
        plan: &super::super::composer::CaptionFloatPlan,
        styles: &ResolvedStyleSet,
        caption_area: &LayoutRect,
        bin_data_content: &[BinDataContent],
        cell_ctx: Option<&super::CellContext>,
    ) {
        let top = LayoutRect {
            height: 0.0,
            ..*caption_area
        };
        for f in &plan.floats {
            let Some(para) = caption.paragraphs.get(f.para_index) else {
                continue;
            };
            let Some(ctrl) = para.controls.get(f.control_index) else {
                continue;
            };
            let (Some(common), Some((w, h))) = (
                super::super::composer::caption_float_common(ctrl),
                super::super::composer::caption_float_object_size(ctrl, self.dpi),
            ) else {
                continue;
            };
            let (x, y) = crate::renderer::float_placement::RegionFloatFrame {
                horz: top,
                page: top,
                paper: top,
                para_y: caption_area.y + f.anchor_y,
                dpi: self.dpi,
            }
            .ink_origin(common, w, h);
            match ctrl {
                Control::Picture(pic) => {
                    let mut positioned = (**pic).clone();
                    positioned.common =
                        crate::renderer::float_placement::region_positioned_common(
                            &pic.common,
                            x,
                            y,
                            self.dpi,
                        );
                    positioned.common.horz_rel_to = crate::model::shape::HorzRelTo::Para;
                    positioned.common.vert_rel_to = crate::model::shape::VertRelTo::Para;
                    positioned.common.horizontal_offset = 0;
                    positioned.common.vertical_offset = 0;
                    let area = LayoutRect {
                        x,
                        y,
                        width: w,
                        height: h,
                    };
                    self.layout_picture(
                        tree,
                        parent_node,
                        &positioned,
                        &area,
                        bin_data_content,
                        Alignment::Left,
                        Some(0),
                        Some(f.para_index),
                        Some(f.control_index),
                        cell_ctx,
                        styles,
                    );
                }
                Control::Shape(shape) => {
                    self.layout_shape_object(
                        tree,
                        parent_node,
                        shape,
                        x,
                        y,
                        w,
                        h,
                        0,
                        f.para_index,
                        f.control_index,
                        styles,
                        bin_data_content,
                        &std::collections::HashMap::new(),
                        &[],
                        None,
                        false,
                    );
                }
                Control::Table(t) => {
                    self.layout_table(
                        tree,
                        parent_node,
                        t,
                        0,
                        styles,
                        0,
                        caption_area,
                        y,
                        bin_data_content,
                        None,
                        0,
                        Some((f.para_index, f.control_index)),
                        Alignment::Left,
                        None,
                        0.0,
                        0.0,
                        None,
                        None,
                        None,
                        None,
                        false,
                        false,
                        0.0,
                        Some((Some(x), y)),
                        Default::default(),
                    );
                }
                _ => {}
            }
        }
    }

    fn layout_caption_topbottom_pictures(
        &self,
        tree: &mut PageLayoutContext,
        parent_node: &mut RenderNode,
        para: &Paragraph,
        caption_area: &LayoutRect,
        para_y: f64,
        stored_head_float_pushdown_px: f64,
        bin_data_content: &[BinDataContent],
        cell_ctx: Option<&super::CellContext>,
        // [#6284] 캡션 문단 조판에 필요하다.
        styles: &ResolvedStyleSet,
    ) {
        let anchor_y = para
            .line_segs
            .first()
            .filter(|seg| seg.vertical_pos >= 0)
            .map(|seg| {
                caption_area.y + hwpunit_to_px(seg.vertical_pos, self.dpi)
                    - stored_head_float_pushdown_px
            })
            .unwrap_or(para_y);

        for (ctrl_idx, ctrl) in para.controls.iter().enumerate() {
            let Control::Picture(pic) = ctrl else {
                continue;
            };
            if !matches!(pic.common.text_wrap, TextWrap::TopAndBottom) {
                continue;
            }
            if tree
                .get_inline_shape_position(0, 0, ctrl_idx, cell_ctx)
                .is_some()
            {
                continue;
            }

            let (pic_width_hu, pic_height_hu) = picture_display_size_hu(pic);
            let pic_width = hwpunit_to_px(pic_width_hu, self.dpi);
            let pic_height = hwpunit_to_px(pic_height_hu, self.dpi);
            let placement_area = LayoutRect {
                x: caption_area.x,
                y: anchor_y,
                width: caption_area.width,
                height: pic_height.max(caption_area.height),
            };
            let mut placement_common = pic.common.clone();
            placement_common.treat_as_char = false;
            let (pic_x, pic_y) = self.compute_object_position(
                &placement_common,
                pic_width,
                pic_height,
                &placement_area,
                &placement_area,
                &placement_area,
                &placement_area,
                anchor_y,
                Alignment::Left,
            );
            let pic_area = LayoutRect {
                x: pic_x,
                y: pic_y,
                width: pic_width,
                height: pic_height,
            };
            let mut pic_for_layout = (**pic).clone();
            pic_for_layout.common.treat_as_char = false;
            pic_for_layout.common.horizontal_offset = 0;
            pic_for_layout.common.vertical_offset = 0;
            pic_for_layout.common.horz_align = HorzAlign::Left;
            pic_for_layout.common.vert_align = VertAlign::Top;

            self.layout_picture(
                tree,
                parent_node,
                &pic_for_layout,
                &pic_area,
                bin_data_content,
                Alignment::Left,
                Some(0),
                Some(0),
                Some(ctrl_idx),
                cell_ctx,
                styles,
            );

            if pic.common.treat_as_char {
                tree.set_inline_shape_position(0, 0, ctrl_idx, cell_ctx, pic_x, pic_y);
            }
        }
    }

    /// [#5708] 저장 LINE_SEG 가 없는 각주 문단의 합성 폴백 줄높이(400 HWPUNIT = 5.33px)를
    /// 문단 줄간격 설정으로 보정한다.
    ///
    /// 폴백값을 그대로 쓰면 줄 전진(5.3px)이 글자 크기(9pt = 12px)보다 작아 각주 줄이 서로
    /// 겹쳐 그려진다(00464 1쪽 하단 주석 8줄). 본문·표 경로는 #674 로 같은 보정을 이미
    /// 하고 있고, 각주 경로만 빠져 있었다. `corrected_line_metrics` 는 `raw_lh < max_fs`
    /// 일 때만 개입하므로 저장 LINE_SEG 를 가진 각주는 종전 그대로다(#2112 계약).
    fn footnote_line_metrics(
        &self,
        comp_line: &ComposedLine,
        para_style_id: u16,
        styles: &ResolvedStyleSet,
    ) -> (f64, f64) {
        let raw_lh = hwpunit_to_px(comp_line.line_height, self.dpi);
        let raw_ls = hwpunit_to_px(comp_line.line_spacing, self.dpi);
        let max_fs = comp_line
            .runs
            .iter()
            .map(|run| run.line_box_font_size(styles))
            .fold(0.0f64, f64::max);
        let para_style = styles.para_styles.get(para_style_id as usize);
        let ls_val = para_style.map(|s| s.line_spacing).unwrap_or(160.0);
        let ls_type = para_style
            .map(|s| s.line_spacing_type)
            .unwrap_or(LineSpacingType::Percent);
        crate::renderer::corrected_line_metrics(raw_lh, raw_ls, max_fs, ls_type, ls_val)
    }

    fn footnote_block_table<'a>(
        para: &'a Paragraph,
        selected: &std::ops::Range<usize>,
    ) -> Option<&'a crate::model::table::Table> {
        let [Control::Table(table)] = para.controls.as_slice() else {
            return None;
        };
        // [hwpx-cowork] Non-TAC notes share the measured float-band/cut path.
        // The 0.9 block route is retained for stored TAC outer-box owners.
        if !table.common.treat_as_char { return None; }
        if selected.start != 0
            || selected.end == 0
            || para
                .text
                .chars()
                .any(|ch| !ch.is_whitespace() && ch != '\u{fffc}')
            || !matches!(table.common.text_wrap, TextWrap::TopAndBottom)
            || !matches!(table.common.vert_rel_to, VertRelTo::Para)
            || !matches!(table.common.vert_align, VertAlign::Top | VertAlign::Inside)
            || table.caption.is_some()
            || table.row_count == 0
            || table.col_count == 0
        {
            return None;
        }
        if table.common.treat_as_char {
            let seg_width = para.line_segs.first().map_or(0, |line| line.segment_width);
            // Ordinary inline TACs are already painted by the paragraph path.
            // A sole table that owns a saved outer-box line is instead classified
            // as a block by that path. The note must consume the same owned line
            // rather than reserving its height while dropping its table.
            if para.stored_text_partition_is_dirty()
                // [hwpx-cowork] Generated TAC lines are reflow output, not proof
                // of a stored outer-box owner. Keep them on the inline route:
                // Hancom B/W generated wrapper notes retain the complete host
                // line (including the wrapper cell's margins), not just the
                // measured table body. Saved genuine outer-box lines retain
                // the upstream block route below.
                || para.line_segs.iter().any(|line| {
                    line.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                })
                || !Self::tac_stored_band_is_outer_box(para, table)
                || crate::renderer::height_measurer::is_tac_table_inline_in_para(
                    table, seg_width, para,
                )
            {
                return None;
            }
        }
        Some(table)
    }

    fn footnote_block_table_frame<'a>(
        &self,
        para: &'a Paragraph,
        composed: &ComposedParagraph,
        styles: &ResolvedStyleSet,
        selected: &std::ops::Range<usize>,
        area_width: f64,
    ) -> Option<FootnoteBlockTableFrame<'a>> {
        let table = Self::footnote_block_table(para, selected)?;
        let measurer = crate::renderer::height_measurer::HeightMeasurer::new(self.dpi)
            .with_hwp3_variant(self.profile.get().hwp3_layout())
            .with_stored_geometry_policy(self.profile.get().stored_geometry_policy())
            .with_native_hwp5(self.profile.get().hwp5_stored_pagination_layout())
            .with_hwpx_stored_layout(self.profile.get().hwpx_stored_layout())
            .with_session_edited(self.profile.get().session_edited())
            .with_render_normalization(self.render_normalization_overlay());
        let measured = measurer.measure_table(table, 0, 0, styles);
        // Whole-table paint consumes this same resolved row geometry. The
        // empty host is an anchor, not another text row added below the table.
        let rows = self.resolve_row_heights(
            table,
            table.col_count as usize,
            table.row_count as usize,
            Some(&measured),
            styles,
            table.common.treat_as_char,
        );
        let body_height = rows.iter().sum::<f64>()
            + measured.cell_spacing * (table.row_count as usize + 1) as f64;
        let top_offset = if table.common.treat_as_char {
            // Same stored-band producer as the body TAC path. The verified
            // saved line contains the top/table/bottom outer box.
            self.tac_table_stored_outer_band_top(para, table, body_height, 0.0)?
        } else {
            hwpunit_to_px(table.common.vertical_offset as i32, self.dpi)
                + hwpunit_to_px(table.outer_margin_top as i32, self.dpi)
        };
        let mut advance =
            top_offset + body_height + hwpunit_to_px(table.outer_margin_bottom as i32, self.dpi);
        let (trailing_line_spacing, line_left_offset) = if table.common.treat_as_char {
            let line = composed.lines.first()?;
            let (line_height, line_spacing) =
                self.footnote_line_metrics(line, composed.para_style_id, styles);
            // The line and its table occupy one box. If actual cell demand grows,
            // reserve that demand rather than clipping it into the saved line.
            advance = advance.max(line_height);
            let style = styles.para_styles.get(composed.para_style_id as usize);
            let margin_left = style.map_or(0.0, |style| style.margin_left);
            let right = style.map_or(0.0, |style| style.margin_right);
            let indent = crate::renderer::equation_tac_flow::paragraph_line_indent_for_source(
                style.map_or(0.0, |style| style.indent),
                0,
                Some(para),
                composed.lines.len(),
                true,
                area_width - margin_left - right,
                self.dpi,
            );
            let left = margin_left + indent;
            let outer_left = hwpunit_to_px(table.outer_margin_left as i32, self.dpi);
            let outer_right = hwpunit_to_px(table.outer_margin_right as i32, self.dpi);
            let width = self
                .resolve_column_widths(table, table.col_count as usize)
                .iter()
                .sum::<f64>()
                + measured.cell_spacing * (table.col_count as usize + 1) as f64;
            let slack = (area_width - left - right - width - outer_left - outer_right).max(0.0);
            let aligned = match style.map_or(Alignment::Left, |style| style.alignment) {
                Alignment::Center | Alignment::Distribute => slack / 2.0,
                Alignment::Right => slack,
                _ => 0.0,
            };
            (line_spacing, Some(left + aligned + outer_left))
        } else {
            (0.0, None)
        };
        Some(FootnoteBlockTableFrame {
            table,
            measured,
            top_offset,
            advance,
            trailing_line_spacing,
            line_left_offset,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn footnote_paragraph_placement<'a>(
        &self,
        para: &'a Paragraph,
        composed: &ComposedParagraph,
        styles: &ResolvedStyleSet,
        fragment: Option<FootnoteFragment>,
        number_drawn: bool,
        selected: std::ops::Range<usize>,
        relative_y: f64,
        area_width: f64,
    ) -> FootnoteParagraphPlacement<'a> {
        let mut block_table = (composed.lines.len() <= 1)
            .then(|| self.footnote_block_table_frame(para, composed, styles, &selected, area_width))
            .flatten();
        let route = if para.text.is_empty()
            && para.controls.is_empty()
            && !fragment_draws_number(fragment)
            && composed.lines.len() == 1
        {
            FootnoteParagraphRoute::StoredEmpty
        } else if fragment_draws_number(fragment) && !number_drawn {
            FootnoteParagraphRoute::Numbered
        } else {
            FootnoteParagraphRoute::Plain
        };
        let mut spacing = ParagraphVerticalSpacing {
            before: 0.0,
            after: 0.0,
        };
        if route == FootnoteParagraphRoute::Plain {
            let style = styles.para_styles.get(composed.para_style_id as usize);
            if selected.start == 0 && relative_y.abs() >= 1.0 {
                spacing.before = crate::renderer::hwp3_variant_flow_spacing_before(
                    style.map_or(0.0, |style| style.spacing_before),
                    self.use_hwp3_origin_flow_spacing_before.get(),
                )
                .max(0.0);
            }
            if selected.end == composed.lines.len().max(1) {
                spacing.after = style.map_or(0.0, |style| style.spacing_after).max(0.0);
            }
        }
        if route == FootnoteParagraphRoute::Numbered {
            if let Some(block) = block_table.as_mut() {
                let number_line_height = composed.lines.first().map_or_else(
                    || hwpunit_to_px(400, self.dpi),
                    |line| {
                        self.footnote_line_metrics(line, composed.para_style_id, styles)
                            .0
                    },
                );
                block.advance = block.advance.max(number_line_height);
            }
        }
        FootnoteParagraphPlacement {
            route,
            spacing,
            block_table,
        }
    }

    /// The saved-note composer retains these source lines without reflow.
    /// Source pagination owns their page cuts; an edited or fallback note uses
    /// the newly composed physical budget instead.
    pub(crate) fn footnote_area_has_stored_lines(
        &self,
        footnotes: &[FootnoteRef],
        paragraphs: &[Paragraph],
        area_width: f64,
    ) -> bool {
        // 저장 줄이 있어도 현재 각주 영역보다 넓은 캐시는 같은 조판을 증언하지 않는다.
        // 생성 각주가 제본 여백을 빼기 전 폭을 저장한 경우 실제 영역을 재조판한다.
        let width_hu = i64::from(crate::renderer::px_to_hwpunit(area_width, self.dpi));
        !footnotes.is_empty()
            && footnotes.iter().all(|note| {
                let paras = get_footnote_paragraphs(note, paragraphs);
                !paras.is_empty()
                    && paras.iter().all(|para| {
                        !para.line_segs.is_empty()
                            && !para.stored_text_partition_is_dirty()
                            && para.line_segs.iter().all(|line| {
                                line.line_height > 0
                                && line.segment_width > 0
                                && i64::from(line.column_start) + i64::from(line.segment_width)
                                    <= width_hu
                                && line.tag
                                    & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY
                                    == 0
                            })
                    })
            })
    }

    pub(crate) fn estimate_footnote_area_height(
        &self,
        footnotes: &[FootnoteRef],
        paragraphs: &[Paragraph],
        shape: &FootnoteShape,
        styles: &ResolvedStyleSet,
        area_width: f64,
    ) -> f64 {
        self.estimate_footnote_area_height_with_metrics(
            footnotes,
            paragraphs,
            styles,
            area_width,
            hwpunit_to_px(shape.separator_above_margin_hu() as i32, self.dpi)
                + border_width_to_px(shape.separator_line_width).max(0.5)
                + hwpunit_to_px(shape.separator_below_margin_hu() as i32, self.dpi),
            hwpunit_to_px(shape.between_notes_margin_hu() as i32, self.dpi),
        )
    }

    /// 페이지 분할 큐와 최종 배치는 같은 선택 줄 메트릭을 소비한다.
    pub(crate) fn estimate_footnote_area_height_with_metrics(
        &self,
        footnotes: &[FootnoteRef],
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
        area_width: f64,
        separator_height: f64,
        between_notes: f64,
    ) -> f64 {
        if footnotes.is_empty() {
            return 0.0;
        }
        let mut total = if footnotes
            .iter()
            .any(|note| fragment_draws_separator(note.fragment))
        {
            separator_height
        } else {
            0.0
        };

        // 실제 `layout_footnote_area`와 같은 줄 높이 산식을 사용한다. 저장 LineSeg의
        // line_height만 더하면 renderer가 누적하는 trailing line_spacing이 빠져 긴
        // 각주가 예약 영역(및 footer)을 넘을 수 있다. 마지막 각주 문단의 마지막 줄은
        // layout 경로에서도 trailing spacing을 붙이지 않는다.
        // [hwpx-cowork] 각주 안 떠 있는 개체 자리를 재는 상자(가로 위치는 높이와 무관).
        let float_area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: area_width,
            height: 0.0,
        };
        for (i, fn_ref) in footnotes.iter().enumerate() {
            let fn_paras = get_footnote_paragraphs(fn_ref, paragraphs);
            total += self.footnote_paragraphs_content_height(
                fn_paras,
                styles,
                area_width,
                fn_ref.fragment,
                total,
            );
            // 각주 간 간격
            if i + 1 < footnotes.len() {
                total += between_notes;
            }
        }
        total
    }

    /// [hwpx-cowork] 조각 맨 위에 먼저 놓는 각주 개체 — (문단 번호, 자리).
    /// 첫 조각이면 쪽·종이 기준 위 개체, 앞 조각에서 미룬 개체가 있으면 그것(문단 기준을 조각 맨 위로).
    fn footnote_prepass_floats(
        &self,
        fn_paras: &[Paragraph],
        fragment: Option<FootnoteFragment>,
        start_line: usize,
        area: &LayoutRect,
        note_top: f64,
        styles: &ResolvedStyleSet,
    ) -> Vec<(usize, super::footnote_objects::NoteFloat)> {
        let mut out = Vec::new();
        if start_line == 0 {
            for (p_idx, para) in fn_paras.iter().enumerate() {
                for f in self.footnote_paragraph_floats(para, area, note_top, note_top, styles, true) {
                    out.push((p_idx, f));
                }
            }
        }
        if let Some(carry) = fragment.and_then(|fragment| fragment.carry_floats_from) {
            let mut flat = 0usize;
            let mut top = note_top;
            for (p_idx, para) in fn_paras.iter().enumerate() {
                let para_start = flat;
                flat += compose_footnote_paragraph(para, area.width, styles, self.dpi)
                    .lines
                    .len()
                    .max(1);
                if para_start < carry || para_start >= start_line {
                    continue;
                }
                // [hwpx-cowork] 2026-11-04 앞 조각에서 잘린 표의 나머지도 여기서(조각 맨 위).
                for f in self.footnote_paragraph_floats_cut(
                    para,
                    area,
                    top,
                    note_top,
                    styles,
                    fragment_float_cut(fragment, para_start, Some(true)),
                ) {
                    top = top.max(f.bottom);
                    out.push((p_idx, f));
                }
            }
        }
        out
    }

    /// [hwpx-cowork] 쪽에 남은 자리(`fits`)에 각주가 다 들어가지 않으면 줄 단위로 나눈다 —
    /// (앞 조각, 앞 높이, 뒤 조각, 뒤 높이). 높이는 구분선을 뺀 내용 높이(떠 있는 개체 포함).
    /// 다 들어가거나 한 줄도 들어가지 않으면 None.
    pub(crate) fn split_footnote_for_capacity(
        &self,
        full: &FootnoteRef,
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
        area_width: f64,
        fits: &dyn Fn(f64) -> bool,
    ) -> Option<(FootnoteFragment, f64, FootnoteFragment, f64)> {
        let height_of = |fragment: Option<FootnoteFragment>| {
            let note = FootnoteRef {
                fragment,
                ..full.clone()
            };
            self.estimate_footnote_area_height_with_metrics(
                std::slice::from_ref(&note),
                paragraphs,
                styles,
                area_width,
                0.0,
                0.0,
            )
        };
        if fits(height_of(None)) {
            return None;
        }
        let fn_paras = get_footnote_paragraphs(full, paragraphs);
        let total = footnote_composed_line_count(fn_paras, area_width, styles, self.dpi);
        // 떠 있는 개체를 가진 문단의 첫 평탄 줄.
        let probe_area = LayoutRect {
            x: 0.0,
            y: 0.0,
            width: area_width,
            height: 0.0,
        };
        let mut float_starts = Vec::new();
        let mut flat = 0usize;
        for para in fn_paras {
            if !self
                .footnote_paragraph_floats(para, &probe_area, 0.0, 0.0, styles, false)
                .is_empty()
            {
                float_starts.push(flat);
            }
            flat += compose_footnote_paragraph(para, area_width, styles, self.dpi)
                .lines
                .len()
                .max(1);
        }
        let fragment = |start_line, end_line, first, defer, carry| FootnoteFragment {
            start_line,
            end_line,
            draw_separator: true,
            draw_number: first,
            defer_floats_from: defer,
            carry_floats_from: carry,
            float_cut: None,
        };
        // [hwpx-cowork] 2026-11-04 쪽 끝에 걸린 각주 안 표를 나눈다 — 한/글 2022 는 표 나눔이 '셀 단위로'·'나눔'이면
        // 각주 안에서도 표를 이 쪽 각주 바닥까지 두고 나머지를 다음 쪽 각주 맨 위로 잇는다(회귀 B·W footNote
        // straddle 69+, 시험지 `scratch/fn-table/probe1`). 앞 조각은 표 문단 앞 줄까지 + 표 윗부분, 뒤 조각은 표 문단부터
        // (표 나머지가 맨 위, 표 문단·뒤 문단 글은 그 아래). 나눌 수 없으면(나누지 않음·첫 행이 안 들어감) 종전대로.
        let split_table_at = |line: usize| -> Option<(FootnoteFragment, f64, FootnoteFragment, f64)> {
            if line == 0 {
                return None;
            }
            let mut flat = 0usize;
            let para = fn_paras.iter().find(|para| {
                let start = flat;
                flat += compose_footnote_paragraph(para, area_width, styles, self.dpi)
                    .lines
                    .len()
                    .max(1);
                start == line
            })?;
            let floats = self.footnote_paragraph_floats(para, &probe_area, 0.0, 0.0, styles, false);
            let [only] = floats.as_slice() else {
                return None;
            };
            let Some(Control::Table(table)) = para.controls.get(only.ctrl_idx) else {
                return None;
            };
            if matches!(table.common.text_wrap, TextWrap::BehindText | TextWrap::InFrontOfText) {
                return None;
            }
            let cut = |offset_hu: i32, tail: bool| FootnoteFloatCut {
                para_line: line,
                control_index: only.ctrl_idx,
                offset_hu,
                tail,
            };
            let head = |offset_hu: i32| FootnoteFragment {
                float_cut: Some(cut(offset_hu, false)),
                ..fragment(0, line, true, None, None)
            };
            // [hwpx-cowork] Query-only evidence for object-note cut decisions.
            if crate::renderer::layout_trace_log::enabled() {
                let h = height_of(Some(head(0)));
                crate::renderer::layout_trace_log::record(0, "noteCut", h, h,
                    format!("line={line} total={total} head0_fits={} object_height={} row_bounds={:?}",
                        fits(h), only.h, self.note_table_row_bounds(table, styles)),
                    std::panic::Location::caller());
            }
            if !fits(height_of(Some(head(0)))) {
                return None;
            }
            // 이 쪽에 들어가는 가장 긴 윗부분(HU)을 찾고 표 나눔 규칙으로 자를 자리를 정한다.
            let (mut lo, mut hi) = (0i32, crate::renderer::px_to_hwpunit(only.h, self.dpi).max(0));
            while lo < hi {
                let mid = lo + (hi - lo + 1) / 2;
                if fits(height_of(Some(head(mid)))) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            let selected_cut = self.note_table_cut(table, styles, hwpunit_to_px(lo, self.dpi));
            if crate::renderer::layout_trace_log::enabled() {
                crate::renderer::layout_trace_log::record(0, "noteTableCut", f64::from(lo), f64::from(lo),
                    format!("selected={selected_cut:?}"), std::panic::Location::caller());
            }
            let (head_px, tail_px) = selected_cut?;
            let head_hu = crate::renderer::px_to_hwpunit(head_px, self.dpi).min(lo);
            if head_hu <= 0 {
                return None;
            }
            let prefix = head(head_hu);
            let prefix_height = height_of(Some(prefix));
            if !fits(prefix_height) {
                return None;
            }
            let tail_hu = (tail_px * crate::renderer::HWPUNIT_PER_INCH / self.dpi).round() as i32;
            // 표 문단(한 줄)과 그 뒤 줄이 표 띠에 밀리지 않고 윗부분 옆·위에 들어가면 이 쪽에 둔다 — 한/글 2022:
            // 세로 오프셋 2000 이면 앵커 줄('앵커 위간격')은 0쪽 표 위에, 어울림 표 옆 글('회귀 뒤 문단')은 0쪽 표 옆.
            // 이때 뒤 조각은 표 나머지를 맨 위에 이어 놓는다(carry).
            let para_lines = compose_footnote_paragraph(para, area_width, styles, self.dpi)
                .lines
                .len()
                .max(1);
            let mut end = line;
            if para_lines == 1 {
                for e in line + 1..=total {
                    let wider = FootnoteFragment {
                        float_cut: Some(cut(head_hu, false)),
                        ..fragment(0, e, true, None, None)
                    };
                    if height_of(Some(wider)) <= prefix_height + 0.01 {
                        end = e;
                    } else {
                        break;
                    }
                }
            }
            if end > line {
                let prefix = FootnoteFragment {
                    float_cut: Some(cut(head_hu, false)),
                    ..fragment(0, end, true, None, None)
                };
                let suffix = FootnoteFragment {
                    float_cut: Some(cut(tail_hu, true)),
                    ..fragment(end, total, false, None, Some(line))
                };
                return Some((prefix, height_of(Some(prefix)), suffix, height_of(Some(suffix))));
            }
            let suffix = FootnoteFragment {
                float_cut: Some(cut(tail_hu, true)),
                ..fragment(line, total, false, None, None)
            };
            Some((prefix, prefix_height, suffix, height_of(Some(suffix))))
        };
        let table_split = std::cell::OnceCell::new();
        for k in (1..=total).rev() {
            // 줄 k 개를 개체와 함께 이 쪽에 둔다.
            if k < total {
                let prefix = fragment(0, k, true, None, None);
                let prefix_height = height_of(Some(prefix));
                if fits(prefix_height) {
                    let suffix = fragment(k, total, false, None, None);
                    return Some((prefix, prefix_height, suffix, height_of(Some(suffix))));
                }
            }
            // 후보 문단은 늘 첫 개체 문단(float_starts 는 오름차순) — 한 번만 잰다.
            if let Some(split) = float_starts
                .first()
                .filter(|&&line| line < k)
                .and_then(|&line| *table_split.get_or_init(|| split_table_at(line)))
            {
                return Some(split);
            }
            // 줄은 들어가는데 개체가 넘치면 한/글은 개체만 다음 쪽 각주 맨 위로 넘긴다
            // (회귀 B footNote straddle: 앵커 줄·뒤 줄은 0쪽, 개체만 1쪽 각주 바닥까지).
            if let Some(&defer) = float_starts.iter().find(|&&line| line < k) {
                let prefix = fragment(0, k, true, Some(defer), None);
                let prefix_height = height_of(Some(prefix));
                if fits(prefix_height) {
                    let suffix = fragment(k, total, false, None, Some(defer));
                    return Some((prefix, prefix_height, suffix, height_of(Some(suffix))));
                }
            }
        }
        None
    }

    /// Paragraph plans are shared by area sizing, body reservation and paint.
    pub(crate) fn footnote_paragraphs_content_height(
        &self,
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
        area_width: f64,
        fragment: Option<FootnoteFragment>,
        origin_y: f64,
    ) -> f64 {
        let (start_line, end_line) = fragment_line_bounds(
            fragment,
            footnote_composed_line_count(paragraphs, area_width, styles, self.dpi),
        );
        let mut total = origin_y;
        let float_area = LayoutRect { x: 0.0, y: 0.0, width: area_width, height: 0.0 };
        let mut flat_line = 0usize;
        let mut number_drawn = false;
        // [hwpx-cowork] 각주 안 개체 띠·바닥 — `layout_footnote_area` 와 같은 규칙.
        let note_top = total;
        let mut bands: Vec<(f64, f64)> = Vec::new();
        let mut float_bottom = f64::MIN;
        for (_, f) in self.footnote_prepass_floats(
            paragraphs,
            fragment,
            start_line,
            &float_area,
            note_top,
            styles,
        ) {
            bands.extend(f.band);
            float_bottom = float_bottom.max(f.bottom);
        }
        for para in paragraphs {
            let composed = compose_footnote_paragraph(para, area_width, styles, self.dpi);
            let line_count = composed.lines.len().max(1);
            let para_start = flat_line;
            let selected_start = start_line.saturating_sub(para_start).min(line_count);
            let selected_end = end_line.saturating_sub(para_start).min(line_count);
            flat_line += line_count;
            if selected_start >= selected_end {
                // [hwpx-cowork] 2026-11-04 앞 조각 끝에 잘린 표: 표 문단 위에 표 윗부분만 놓는다.
                // 한/글 2022: 쪽 끝에서 나뉘는 표의 문단 위 간격은 쓰지 않는다(회귀 textPrev '앵커 위간격' 문단의
                // 표도 0쪽 906px — 빈 문단과 같은 자리).
                if let Some(cut) = fragment_float_cut(fragment, para_start, Some(false)) {
                    let para_top = total;
                    for f in self.footnote_paragraph_floats_cut(
                        para, &float_area, para_top, note_top, styles, Some(cut),
                    ) {
                        float_bottom = float_bottom.max(f.bottom);
                    }
                }
                continue;
            }
            let placement = self.footnote_paragraph_placement(
                para,
                &composed,
                styles,
                fragment,
                number_drawn,
                selected_start..selected_end,
                total,
                area_width,
            );
            total += placement.spacing.before;
            // 글이 전혀 없는 문단의 줄은 자기 개체 띠에 밀리지 않는다(한/글 lineseg: 띠 안에 폭 0 줄).
            let prior_bands = bands.len();
            let para_floats = if floats_deferred(fragment, para_start) {
                Vec::new()
            } else {
                // [hwpx-cowork] 2026-11-04 잘린 표: 뒤 조각 맨 위 문단이면 나머지, 앞 조각 끝 문단이면 윗부분
                // (앞 조각은 문단 위 간격 없이).
                let cut = fragment_float_cut(fragment, para_start, None);
                let top = if cut.is_some_and(|cut| !cut.tail) {
                    total - placement.spacing.before
                } else {
                    total
                };
                self.footnote_paragraph_floats_cut(
                    para,
                    &float_area,
                    top,
                    note_top,
                    styles,
                    cut,
                )
            };
            for f in para_floats {
                bands.extend(f.band);
                float_bottom = float_bottom.max(f.bottom);
            }
            let push_bands = if para.text.is_empty() {
                &bands[..prior_bands]
            } else {
                &bands[..]
            };
            if !push_bands.is_empty() {
                let first_h = composed
                    .lines
                    .get(selected_start)
                    .map(|l| self.footnote_line_metrics(l, composed.para_style_id, styles).0)
                    .unwrap_or_else(|| hwpunit_to_px(400, self.dpi));
                total = Self::push_below_note_bands(total, first_h, push_bands);
            }
            if let Some(block) = placement.block_table {
                total += block.advance;
                if para_start + selected_end < fragment_spacing_end(fragment, end_line) { total += block.trailing_line_spacing; }
            } else if placement.route == FootnoteParagraphRoute::StoredEmpty {
                // 실제 빈 줄 경로는 저장 높이만 소비하고 후행 줄간격을 붙이지 않는다.
                total += hwpunit_to_px(composed.lines[0].line_height, self.dpi);
            } else if composed.lines.is_empty() {
                total += hwpunit_to_px(400, self.dpi);
            } else {
                for (index, line) in composed.lines[selected_start..selected_end]
                    .iter()
                    .enumerate()
                {
                    let (line_height, line_spacing_px) =
                        self.footnote_line_metrics(line, composed.para_style_id, styles);
                    total += line_height;
                    if para_start + selected_start + index + 1
                        < fragment_spacing_end(fragment, end_line)
                    {
                        total += line_spacing_px;
                    }
                }
            }
            total += placement.spacing.after;
            number_drawn |= placement.route == FootnoteParagraphRoute::Numbered;
        }
        // [hwpx-cowork] 개체 바닥이 글 줄보다 아래면 각주 영역이 개체 바닥까지 자란다.
        total = total.max(float_bottom);
        total - origin_y
    }

    pub(crate) fn footnote_with_block_table_content_height(
        &self,
        footnote: &crate::model::footnote::Footnote,
        styles: &ResolvedStyleSet,
        area_width: f64,
        fragment: Option<FootnoteFragment>,
    ) -> Option<f64> {
        footnote
            .paragraphs
            .iter()
            .any(|para| {
                Self::footnote_block_table(para, &(0..1)).is_some()
                    && compose_footnote_paragraph(para, area_width, styles, self.dpi)
                        .lines
                        .len()
                        <= 1
            })
            .then(|| {
                self.footnote_paragraphs_content_height(
                    &footnote.paragraphs,
                    styles,
                    area_width,
                    fragment,
                    0.0,
                )
            })
    }

    /// 각주 영역 레이아웃 (구분선 + 각주 문단들)
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_footnote_area(
        &self,
        tree: &mut PageLayoutContext,
        fn_node: &mut RenderNode,
        footnotes: &[FootnoteRef],
        paragraphs: &[Paragraph],
        styles: &ResolvedStyleSet,
        fn_area: &LayoutRect,
        shape: &FootnoteShape,
        source_indices: &[usize],
        bin_data_content: &[BinDataContent],
    ) {
        let mut y = fn_area.y;

        if footnotes
            .iter()
            .any(|footnote| fragment_draws_separator(footnote.fragment))
        {
            // (1) 구분선 위 여백
            y += hwpunit_to_px(shape.separator_above_margin_hu() as i32, self.dpi);

            // (2) 구분선
            let sep_length =
                footnote_separator_length_px(shape.separator_length, fn_area.width, self.dpi);
            let line_width = border_width_to_px(shape.separator_line_width).max(0.5);

            super::note_separator::append(
                tree, fn_node, shape, fn_area.x, y, sep_length, line_width,
            );
            y += line_width;

            // (3) 구분선 아래 여백
            y += hwpunit_to_px(shape.separator_below_margin_hu() as i32, self.dpi);
        }

        // (4) 각 각주 렌더링
        // 각주 TextRun에 마커를 인코딩하여 히트테스트에서 식별 가능하도록 함
        // section_index = footnote_index (footnotes 배열 인덱스)
        // para_index = usize::MAX - 2000 - fn_para_idx (각주 내 문단 인덱스)
        for (frame_index, fn_ref) in footnotes.iter().enumerate() {
            let i = source_indices[frame_index];
            let fn_paras = get_footnote_paragraphs(fn_ref, paragraphs);
            let number_text = format_footnote_number(fn_ref.number, shape);
            let (fragment_start, fragment_end) = fragment_line_bounds(
                fn_ref.fragment,
                footnote_composed_line_count(fn_paras, fn_area.width, styles, self.dpi),
            );
            let mut flat_line = 0usize;
            let mut number_drawn = false;
            // [hwpx-cowork] 각주 안 떠 있는 개체: 각주 맨 위 개체를 먼저 놓고 띠를 모은다.
            let note_top = y;
            let mut bands: Vec<(f64, f64)> = Vec::new();
            let mut float_bottom = f64::MIN;
            for (p_idx, f) in self.footnote_prepass_floats(
                fn_paras,
                fn_ref.fragment,
                fragment_start,
                fn_area,
                note_top,
                styles,
            ) {
                bands.extend(f.band);
                float_bottom = float_bottom.max(f.bottom);
                self.render_footnote_float(
                    tree,
                    fn_node,
                    &fn_paras[p_idx],
                    &f,
                    fn_area,
                    styles,
                    bin_data_content,
                    i,
                    usize::MAX - 2000 - p_idx,
                );
            }

            for (p_idx, para) in fn_paras.iter().enumerate() {
                let composed = compose_footnote_paragraph(para, fn_area.width, styles, self.dpi);
                let marker_section = i; // footnote_index
                let marker_para = usize::MAX - 2000 - p_idx; // 각주 내 문단 인덱스
                                                             // 각주 번호 스타일용 기본 char_shape_id (빈/비빈 문단 모두 동일)
                let base_cs_id = para
                    .char_shapes
                    .first()
                    .map(|cs| cs.char_shape_id as u32)
                    .unwrap_or(composed.para_style_id as u32);

                let line_count = composed.lines.len().max(1);
                let para_start = flat_line;
                let para_end = flat_line + line_count;
                let selected_start = fragment_start.saturating_sub(para_start).min(line_count);
                let selected_end = fragment_end.saturating_sub(para_start).min(line_count);
                flat_line = para_end;
                if selected_start >= selected_end {
                    // [hwpx-cowork] 2026-11-04 앞 조각 끝에 잘린 표: 표 문단 위에 표 윗부분만 그린다.
                    // 한/글 2022: 쪽 끝에서 나뉘는 표의 문단 위 간격은 쓰지 않는다(회귀 textPrev '앵커 위간격' 문단의
                    // 표도 0쪽 906px — 빈 문단과 같은 자리).
                    if let Some(cut) = fragment_float_cut(fn_ref.fragment, para_start, Some(false)) {
                        let para_top = y;
                        for f in self.footnote_paragraph_floats_cut(
                            para, fn_area, para_top, note_top, styles, Some(cut),
                        ) {
                            float_bottom = float_bottom.max(f.bottom);
                            self.render_footnote_float(
                                tree,
                                fn_node,
                                para,
                                &f,
                                fn_area,
                                styles,
                                bin_data_content,
                                marker_section,
                                marker_para,
                            );
                        }
                    }
                    continue;
                }
                // [hwpx-cowork] 2026-11-04 잘린 표 앞 줄은 줄 간격을 남긴다(`fragment_spacing_end`).
                let is_last_selected_line =
                    para_start + selected_end == fragment_spacing_end(fn_ref.fragment, fragment_end);
                let placement = self.footnote_paragraph_placement(
                    para,
                    &composed,
                    styles,
                    fn_ref.fragment,
                    number_drawn,
                    selected_start..selected_end,
                    y - fn_area.y,
                    fn_area.width,
                );
                if let Some(block) = placement.block_table {
                    y += placement.spacing.before;
                    let anchor_y = y;
                    if placement.route == FootnoteParagraphRoute::Numbered {
                        // 번호와 표는 같은 호스트 줄에 속한다. 번호 줄의 높이를
                        // 표 아래에 다시 더하지 않고 공통 advance에 포함한다.
                        let mut number_host = composed.clone();
                        if number_host.lines.is_empty() {
                            // 가상 빈 줄도 번호를 실제 출력한다. 측정과 같은
                            // 기존 400HU fallback 줄이며 표의 내용 줄이 아니다.
                            number_host.lines.push(ComposedLine {
                                runs: Vec::new(),
                                line_height: 400,
                                baseline_distance: 320,
                                segment_width: 0,
                                column_start: 0,
                                line_spacing: 0,
                                has_line_break: false,
                                char_start: 0,
                            });
                        }
                        self.layout_footnote_paragraph_with_number(
                            tree,
                            fn_node,
                            &number_host,
                            para,
                            styles,
                            fn_area,
                            anchor_y,
                            &number_text,
                            fn_ref.number,
                            marker_section,
                            marker_para,
                            base_cs_id,
                            selected_start,
                            selected_end,
                            true,
                            shape.number_code_superscript,
                        );
                        number_drawn = true;
                    }
                    let style = styles.para_styles.get(composed.para_style_id as usize);
                    self.layout_table(
                        tree,
                        fn_node,
                        block.table,
                        marker_section,
                        styles,
                        0,
                        fn_area,
                        anchor_y,
                        bin_data_content,
                        Some(&block.measured),
                        0,
                        Some((marker_para, 0)),
                        style.map_or(Alignment::Left, |style| style.alignment),
                        None,
                        style.map_or(0.0, |style| style.margin_left),
                        style.map_or(0.0, |style| style.margin_right),
                        None,
                        None,
                        Some(anchor_y),
                        None,
                        false,
                        false,
                        0.0,
                        Some((
                            block.line_left_offset.map(|offset| fn_area.x + offset),
                            anchor_y + block.top_offset,
                        )),
                        Self::standalone_table_char_border_fill(Some(para), block.table, styles),
                    );
                    y = anchor_y + block.advance + placement.spacing.after;
                    if !is_last_selected_line {
                        y += block.trailing_line_spacing;
                    }
                    continue;
                }
                // [hwpx-cowork] 이 문단의 떠 있는 개체를 놓고, 첫 줄이 자리차지 띠와 겹치면 띠 아래로 민다.
                {
                    let para_top = y + placement.spacing.before;
                    let prior_bands = bands.len();
                    let para_floats = if floats_deferred(fn_ref.fragment, para_start) {
                        Vec::new()
                    } else {
                        // [hwpx-cowork] 2026-11-04 잘린 표: 뒤 조각 맨 위 문단이면 나머지, 앞 조각 끝 문단이면 윗부분.
                        let cut = fragment_float_cut(fn_ref.fragment, para_start, None);
                        let top = if cut.is_some_and(|cut| !cut.tail) {
                            y
                        } else {
                            para_top
                        };
                        self.footnote_paragraph_floats_cut(
                            para,
                            fn_area,
                            top,
                            note_top,
                            styles,
                            cut,
                        )
                    };
                    for f in para_floats {
                        bands.extend(f.band);
                        float_bottom = float_bottom.max(f.bottom);
                        self.render_footnote_float(
                            tree,
                            fn_node,
                            para,
                            &f,
                            fn_area,
                            styles,
                            bin_data_content,
                            marker_section,
                            marker_para,
                        );
                    }
                    let push_bands = if para.text.is_empty() {
                        &bands[..prior_bands]
                    } else {
                        &bands[..]
                    };
                    if !push_bands.is_empty() {
                        let first_h = composed
                            .lines
                            .get(selected_start)
                            .map(|l| self.footnote_line_metrics(l, composed.para_style_id, styles).0)
                            .unwrap_or_else(|| hwpunit_to_px(400, self.dpi));
                        y = Self::push_below_note_bands(para_top, first_h, push_bands)
                            - placement.spacing.before;
                    }
                }
                let line_top = y + placement.spacing.before;
                if placement.route == FootnoteParagraphRoute::StoredEmpty {
                    y += hwpunit_to_px(composed.lines[0].line_height, self.dpi);
                    continue;
                }

                // 첫 fragment의 첫 선택 줄에만 각주 번호를 싣는다. 번호는 문단의 autoNum
                // 자리표시 위에 얹어 일반 문단 경로로 그린다 — 그래야 번호 문단도 다른 문단과
                // 같은 내어쓰기·정렬을 받는다. 조합 줄이 없는 빈 문단만 종전 전용 경로를 쓴다.
                let draw_number = placement.route == FootnoteParagraphRoute::Numbered;
                number_drawn |= draw_number;
                let stored_prefix = (self.profile.get().hwpx_stored_layout()
                    || self.profile.get().hwp5_stored_pagination_layout())
                .then(|| stored_footnote_number_prefix(para, &number_text))
                .flatten();
                let paragraph_number = stored_prefix
                    .as_ref()
                    .map_or(number_text.as_str(), |(text, _)| text.as_str());
                // 여러 자동 번호 슬롯은 기존 번호 경로가 원본 형식을 보존한다.
                let numbered = (draw_number
                    && stored_prefix.as_ref().is_none_or(|(_, slots)| *slots <= 1))
                .then(|| {
                    footnote_composed_with_number(
                        para,
                        &composed,
                        paragraph_number,
                        selected_start,
                        base_cs_id,
                    )
                })
                .flatten();
                if !draw_number
                    && composed.lines.len() == 1
                    && selected_start == 0
                    && selected_end == line_count
                    && para.controls.iter().any(|control| {
                        matches!(control, Control::Table(table) if table.common.treat_as_char)
                    })
                {
                    // 선택된 TAC 줄의 표는 원본 줄 상자 안의 실제 내용이다.
                    // 일반 인라인 표와 같은 원점·여백·자원을 사용해 빈 글줄만
                    // 남기지 않고 표와 내부 그림까지 해당 각주 조각에 보존한다.
                    let style = styles.para_styles.get(composed.para_style_id as usize);
                    let before = crate::renderer::hwp3_variant_flow_spacing_before(
                        style.map_or(0.0, |style| style.spacing_before),
                        self.use_hwp3_origin_flow_spacing_before.get(),
                    );
                    let after = style.map_or(0.0, |style| style.spacing_after);
                    y = self.layout_inline_table_paragraph(
                        tree,
                        fn_node,
                        para,
                        Some(&composed),
                        styles,
                        fn_area,
                        y + placement.spacing.before - before,
                        marker_section,
                        marker_para,
                        bin_data_content,
                        &[],
                    ).flow_bottom + placement.spacing.after - after;
                    if is_last_selected_line {
                        y -= hwpunit_to_px(composed.lines[0].line_spacing, self.dpi);
                    }
                } else if draw_number && numbered.is_none() {
                    y = self.layout_footnote_paragraph_with_number(
                        tree,
                        fn_node,
                        &composed,
                        para,
                        styles,
                        fn_area,
                        y,
                        &number_text,
                        fn_ref.number,
                        marker_section,
                        marker_para,
                        base_cs_id,
                        selected_start,
                        selected_end,
                        is_last_selected_line,
                            shape.number_code_superscript,
                        );
                } else {
                    let composed = numbered.as_ref().unwrap_or(&composed);
                    let first_new_child = fn_node.children.len();
                    // 각주 줄도 원본 인라인 개체와 문서의 BinData를 소비한다.
                    // 텍스트 줄만 전달하면 높이는 예약하면서 TAC 표·그림을
                    // 출력하지 못한다. 이어받기에도 같은 글줄 소유를 사용한다.
                    let returned_y = self.layout_composed_paragraph_in_frame(
                        tree,
                        fn_node,
                        composed,
                        styles,
                        fn_area,
                        y,
                        selected_start,
                        selected_end,
                        marker_section,
                        marker_para,
                        None,
                        false,
                        false,
                        0.0,
                        None,
                        // [hwpx-cowork] 문단·그림 자료를 넘겨 글자처럼 취급한 그림·표·수식을 줄 자리에 그린다.
                        Some(para),
                        Some(bin_data_content),
                        None, // 각주 컨텍스트 — wrap zone 무관
                        false,
                        false,
                        Some(placement.spacing),
                        None,
                    );
                    self.render_footnote_inline_shapes(
                        tree,
                        fn_node,
                        para,
                        fn_area,
                        styles,
                        bin_data_content,
                        marker_section,
                        marker_para,
                        line_top,
                    );
                    if shape.number_code_superscript && numbered.is_some() {
                        shrink_footnote_number(
                            &mut fn_node.children[first_new_child..],
                            paragraph_number.trim_end(),
                        );
                    }
                    if is_last_selected_line {
                        // fragment의 마지막 줄은 trailing line-spacing을 쓰지 않는다.
                        let trail_ls = composed
                            .lines
                            .get(selected_end.saturating_sub(1))
                            .map(|l| hwpunit_to_px(l.line_spacing, self.dpi))
                            .unwrap_or(0.0);
                        y = returned_y - trail_ls;
                    } else {
                        y = returned_y;
                    }
                }
            }

            // [hwpx-cowork] 개체 바닥까지 각주가 자란다(다음 각주는 그 아래).
            y = y.max(float_bottom);
            // 각주 간 간격
            if i + 1 < footnotes.len() {
                y += hwpunit_to_px(shape.between_notes_margin_hu() as i32, self.dpi);
            }
        }
    }

    /// 각주 번호를 앞에 붙여 문단을 레이아웃
    /// marker_section: footnote_index, marker_para: 각주 내 문단 마커 (usize::MAX - 2000 - fn_para_idx)
    /// base_cs_id: 번호 스타일 결정용 기본 char_shape_id (문단의 char_shapes[0])
    pub(crate) fn layout_footnote_paragraph_with_number(
        &self,
        tree: &mut PageLayoutContext,
        parent: &mut RenderNode,
        composed: &ComposedParagraph,
        paragraph: &Paragraph,
        styles: &ResolvedStyleSet,
        area: &LayoutRect,
        y_start: f64,
        number_text: &str,
        note_number: u16,
        marker_section: usize,
        marker_para: usize,
        base_cs_id: u32,
        line_start: usize,
        line_end: usize,
        // fragment의 마지막 선택 줄은 trailing line_spacing을 누적하지 않는다.
        is_last_selected_line: bool,
        // 각주 모양 "각주 내용 번호 속성: 작게"
        small_number: bool,
    ) -> f64 {
        let mut y = y_start;
        let stored_prefix = (self.profile.get().hwpx_stored_layout()
            || self.profile.get().hwp5_stored_pagination_layout())
        .then(|| stored_footnote_number_prefix(paragraph, number_text))
        .flatten();
        let number_text = stored_prefix
            .as_ref()
            .map_or(number_text, |(text, _)| text.as_str());
        // 분할 큐는 빈 각주 문단도 한 줄의 virtual fragment로 센다. 실제 composed
        // 줄은 0개이므로 그 범위를 그대로 slice하면 panic 난다. 기존 비분할 경로처럼
        // 빈 문단 fallback까지 흘려보내 번호/높이 계약을 보존한다.
        let line_start = line_start.min(composed.lines.len());
        let line_end = line_end.min(composed.lines.len()).max(line_start);

        let para_style = styles.para_styles.get(composed.para_style_id as usize);
        let margin_left = para_style.map(|style| style.margin_left).unwrap_or(0.0);
        let margin_right = para_style.map(|style| style.margin_right).unwrap_or(0.0);
        let indent = para_style.map(|style| style.indent).unwrap_or(0.0);

        for (offset, comp_line) in composed.lines[line_start..line_end].iter().enumerate() {
            // 이어받은 쪽에서도 원본 문단 안의 줄 번호로 들여쓰기를 결정한다.
            let line_indent = crate::renderer::equation_tac_flow::paragraph_line_indent_for_source(
                indent,
                line_start + offset,
                Some(paragraph),
                composed.lines.len(),
                true,
                area.width - margin_left - margin_right,
                self.dpi,
            );
            let line_x = area.x + margin_left + line_indent;
            let line_width = (area.width - margin_left - margin_right - line_indent).max(0.0);
            // LineSeg.line_height는 HWP에서 줄간격이 이미 반영된 값.
            // [#5708] 저장 LINE_SEG 가 없는 문단의 폴백(400 HWPUNIT = 5.33px)은 글자보다
            // 작아 줄이 겹치므로 문단 줄간격 설정으로 보정한다.
            let (line_height, corrected_line_spacing) =
                self.footnote_line_metrics(comp_line, composed.para_style_id, styles);
            let raw_baseline = hwpunit_to_px(comp_line.baseline_distance, self.dpi);
            // 베이스라인도 같은 비율로 따라간다 — 줄 상자만 키우면 글자가 상자 위로 뜬다.
            let baseline = if line_height > 0.0
                && raw_baseline > 0.0
                && hwpunit_to_px(comp_line.line_height, self.dpi) > 0.0
            {
                (raw_baseline * line_height / hwpunit_to_px(comp_line.line_height, self.dpi))
                    .min(line_height)
            } else {
                raw_baseline
            };

            let line_id = tree.next_id();
            let mut line_node = RenderNode::new(
                line_id,
                RenderNodeType::TextLine(TextLineNode::new(line_height, baseline)),
                BoundingBox::new(line_x, y, line_width, line_height),
            );

            let mut x = line_x;

            // 첫 줄에 각주 번호 삽입
            if offset == 0 {
                // 각주 번호 스타일: 문단의 기본 char_shape로 고정 (크기 약간 축소)
                // 빈/비빈 문단 모두 동일한 base_cs_id 사용 → 리렌더링 시 폰트·폭 변동 방지
                let base_style = {
                    let mut ts = resolved_to_text_style(styles, base_cs_id, 0);
                    if small_number {
                        ts.font_size = FootnoteMarkerNode::font_size(ts.font_size);
                    } else if stored_prefix.is_none() {
                        ts.font_size = (ts.font_size * 0.9).max(8.0);
                    }
                    ts
                };
                let number_baseline = if small_number {
                    FootnoteMarkerNode::reference_baseline(
                        resolved_to_text_style(styles, base_cs_id, 0).font_size,
                        baseline,
                    )
                } else {
                    baseline
                };

                let num_width = estimate_text_width(number_text, &base_style);
                let num_id = tree.next_id();
                let num_node = RenderNode::new(
                    num_id,
                    RenderNodeType::TextRun(TextRunNode {
                        text: number_text.to_string(),
                        style: base_style,
                        char_shape_id: None,
                        para_shape_id: None,
                        section_index: Some(marker_section),
                        para_index: Some(marker_para),
                        char_start: None, // 번호 run은 char_start 없음
                        cell_context: None,
                        is_para_end: false,
                        is_line_break_end: false,
                        rotation: 0.0,
                        is_vertical: false,
                        char_overlap: None,
                        border_fill_id: 0,
                        baseline: number_baseline,
                        field_marker: FieldMarkerType::None,
                        layout_positions: None,
                        display_text: None,
                    }),
                    BoundingBox::new(x, y, num_width, line_height),
                );
                line_node.children.push(num_node);
                x += num_width;
            }

            // 원본 TextRun들
            let mut char_offset = comp_line.char_start;
            let mut tab_index = composed
                .lines
                .iter()
                .take(line_start + offset)
                .flat_map(|line| line.runs.iter())
                .flat_map(|run| run.text.chars())
                .filter(|&ch| ch == '\t')
                .count();
            for run in &comp_line.runs {
                let mut text_style = run.text_style(styles);
                let skipped = stored_prefix.as_ref().map_or(0, |(_, count)| {
                    count
                        .saturating_sub(char_offset)
                        .min(run.text.chars().count())
                });
                let text = run.text.chars().skip(skipped).collect::<String>();
                if stored_prefix.is_some() {
                    text_style.inline_tabs = composed
                        .tab_extended
                        .iter()
                        .skip(tab_index)
                        .copied()
                        .collect();
                }
                let width = estimate_text_width(&text, &text_style);
                tab_index += run.text.chars().filter(|&ch| ch == '\t').count();

                let run_id = tree.next_id();
                let run_node = RenderNode::new(
                    run_id,
                    RenderNodeType::TextRun(TextRunNode {
                        text,
                        style: text_style,
                        char_shape_id: None,
                        para_shape_id: None,
                        section_index: Some(marker_section),
                        para_index: Some(marker_para),
                        // 번호 대신 그리지 않은 문자는 원본 문단의 주소에는 남는다.
                        char_start: Some(char_offset + skipped),
                        cell_context: None,
                        is_para_end: false,
                        is_line_break_end: false,
                        rotation: 0.0,
                        is_vertical: false,
                        char_overlap: run.char_overlap.clone(),
                        border_fill_id: 0,
                        baseline,
                        field_marker: FieldMarkerType::None,
                        layout_positions: None,
                        display_text: None,
                    }),
                    BoundingBox::new(x, y, width, line_height),
                );
                line_node.children.push(run_node);
                x += width;
                char_offset += run.text.chars().count();
            }

            parent.children.push(line_node);
            // [Issue #483] trailing line_spacing 추가 — layout_composed_paragraph:2560 과 정합.
            // 단, 각주의 마지막 paragraph 의 마지막 line 에서는 trailing line_spacing 을
            // 누적하지 않는다 — 다음 각주와의 간격은 between-notes 값이 책임하므로
            // 이중 합산을 피하기 위함.
            let is_last_line = offset + 1 >= line_end - line_start;
            if is_last_selected_line && is_last_line {
                y += line_height;
            } else {
                let line_spacing_px = corrected_line_spacing;
                y += line_height + line_spacing_px;
            }
        }

        // 빈 문단 fallback
        if composed.lines.is_empty() {
            let default_height = hwpunit_to_px(400, self.dpi);
            let line_id = tree.next_id();
            let line_node = RenderNode::new(
                line_id,
                RenderNodeType::TextLine(TextLineNode::new(default_height, default_height * 0.8)),
                BoundingBox::new(area.x, y, area.width, default_height),
            );
            parent.children.push(line_node);
            y += default_height;
        }

        y
    }

    /// 문단 내 각주/미주 컨트롤에 대해 윗첨자 참조 번호를 렌더링한다.
    ///
    /// 마지막 TextLine의 마지막 TextRun 우측에 윗첨자 번호를 추가한다.
    pub(crate) fn add_footnote_superscripts(
        &self,
        tree: &mut PageLayoutContext,
        parent: &mut RenderNode,
        para: &Paragraph,
        _styles: &ResolvedStyleSet,
    ) {
        // layout_composed_paragraph에서 이미 인라인 FootnoteMarker를 삽입한 경우 건너뜀
        let has_inline_markers = parent.children.iter().any(|line| {
            line.children
                .iter()
                .any(|n| matches!(n.node_type, RenderNodeType::FootnoteMarker(_)))
        });
        if has_inline_markers {
            return;
        }

        // 각주/미주의 (번호, 텍스트 위치) 수집 — ComposedParagraph에서 미리 계산된 위치 사용
        // 폴백: control_text_positions로 직접 계산
        let ctrl_positions = para.control_text_positions();
        let mut footnotes: Vec<(String, usize)> = Vec::new();
        for (ci, ctrl) in para.controls.iter().enumerate() {
            let marker_text = match ctrl {
                Control::Footnote(note) => Some(
                    super::paragraph_layout::note_marker_text_from_control(Some(ctrl), note.number),
                ),
                Control::Endnote(note) => Some(
                    super::paragraph_layout::note_marker_text_from_control(Some(ctrl), note.number),
                ),
                _ => None,
            };
            if let Some(text) = marker_text {
                let pos = ctrl_positions.get(ci).copied().unwrap_or(usize::MAX);
                footnotes.push((text, pos));
            }
        }

        if footnotes.is_empty() {
            return;
        }

        // 각 각주 위첨자를 렌더링: char_start 기반으로 정확한 TextRun 위치에 삽입
        for (_fn_idx, (number_text, char_pos)) in footnotes.iter().enumerate() {
            let mut target_line_idx: Option<usize> = None;
            let mut insert_x = 0.0;
            let mut line_height = 18.0;
            let mut line_y = 0.0;
            let mut base_font_size = 12.0_f64;
            let mut base_font_family = "sans-serif".to_string();

            // TextRun의 char_start로 각주 위치 찾기
            if *char_pos < usize::MAX {
                'outer: for (li, line_node) in parent.children.iter().enumerate() {
                    if !matches!(line_node.node_type, RenderNodeType::TextLine(_)) {
                        continue;
                    }
                    // 이 줄의 char_start 범위 확인: 첫 run의 char_start ~ 마지막 run의 (char_start + len)
                    let mut line_min_cs = usize::MAX;
                    let mut line_max_end = 0usize;
                    for run_node in &line_node.children {
                        if let RenderNodeType::TextRun(ref run) = run_node.node_type {
                            if let Some(cs) = run.char_start {
                                line_min_cs = line_min_cs.min(cs);
                                line_max_end = line_max_end.max(cs + run.text.chars().count());
                            }
                        }
                    }
                    // 각주 위치가 이 줄에 포함되지 않으면 다음 줄
                    if *char_pos > line_max_end || line_min_cs == usize::MAX {
                        continue;
                    }

                    for run_node in &line_node.children {
                        if let RenderNodeType::TextRun(ref run) = run_node.node_type {
                            if let Some(cs) = run.char_start {
                                let run_len = run.text.chars().count();
                                let run_end = cs + run_len;
                                if *char_pos >= cs && *char_pos <= run_end {
                                    let chars_before = char_pos - cs;
                                    let partial_text: String =
                                        run.text.chars().take(chars_before).collect();
                                    let partial_width =
                                        estimate_text_width(&partial_text, &run.style);
                                    insert_x = run_node.bbox.x + partial_width;
                                    line_height = line_node.bbox.height;
                                    line_y = line_node.bbox.y;
                                    base_font_size = run.style.font_size;
                                    base_font_family = run.style.font_family.clone();
                                    target_line_idx = Some(li);
                                    break 'outer;
                                }
                            }
                        }
                    }
                }
            }

            // 최종 폴백: 마지막 TextLine 끝
            if target_line_idx.is_none() {
                if let Some(li) = parent
                    .children
                    .iter()
                    .rposition(|n| matches!(n.node_type, RenderNodeType::TextLine(_)))
                {
                    let line = &parent.children[li];
                    insert_x = line
                        .children
                        .last()
                        .map(|c| c.bbox.x + c.bbox.width)
                        .unwrap_or(line.bbox.x);
                    line_height = line.bbox.height;
                    line_y = line.bbox.y;
                    if let Some(last_run) = line.children.last() {
                        if let RenderNodeType::TextRun(ref run) = last_run.node_type {
                            base_font_size = run.style.font_size;
                            base_font_family = run.style.font_family.clone();
                        }
                    }
                    target_line_idx = Some(li);
                }
            }

            if let Some(line_idx) = target_line_idx {
                let sup_font_size = (base_font_size * 0.6).max(7.0);
                let sup_y_offset = line_height * 0.35;
                let style = TextStyle {
                    font_size: sup_font_size,
                    font_family: base_font_family,
                    ..Default::default()
                };
                let width = estimate_text_width(&number_text, &style);

                let run_id = tree.next_id();
                let run_node = RenderNode::new(
                    run_id,
                    RenderNodeType::TextRun(TextRunNode {
                        text: number_text.clone(),
                        style,
                        char_shape_id: None,
                        para_shape_id: None,
                        section_index: None,
                        para_index: None,
                        char_start: None,
                        cell_context: None,
                        is_para_end: false,
                        is_line_break_end: false,
                        rotation: 0.0,
                        is_vertical: false,
                        char_overlap: None,
                        border_fill_id: 0,
                        baseline: line_height,
                        field_marker: FieldMarkerType::None,
                        layout_positions: None,
                        display_text: None,
                    }),
                    BoundingBox::new(insert_x, line_y - sup_y_offset, width, line_height),
                );

                let line_mut = &mut parent.children[line_idx];
                line_mut.children.push(run_node);
            }
        }
    }
}

fn get_footnote_paragraphs<'a>(
    fn_ref: &FootnoteRef,
    paragraphs: &'a [Paragraph],
) -> &'a [Paragraph] {
    match &fn_ref.source {
        FootnoteSource::Body {
            para_index,
            control_index,
        } => {
            if let Some(para) = paragraphs.get(*para_index) {
                if let Some(Control::Footnote(footnote)) = para.controls.get(*control_index) {
                    return &footnote.paragraphs;
                }
            }
            &[]
        }
        FootnoteSource::TableCell {
            para_index,
            table_control_index,
            cell_index,
            cell_para_index,
            cell_control_index,
        } => {
            if let Some(para) = paragraphs.get(*para_index) {
                if let Some(Control::Table(table)) = para.controls.get(*table_control_index) {
                    if let Some(cell) = table.cells.get(*cell_index) {
                        if let Some(cp) = cell.paragraphs.get(*cell_para_index) {
                            if let Some(Control::Footnote(footnote)) =
                                cp.controls.get(*cell_control_index)
                            {
                                return &footnote.paragraphs;
                            }
                        }
                    }
                }
            }
            &[]
        }
        FootnoteSource::NestedTableCell {
            para_index,
            table_control_index,
            cell_path,
        } => {
            let Some(Control::Table(table)) = paragraphs
                .get(*para_index)
                .and_then(|para| para.controls.get(*table_control_index))
            else {
                return &[];
            };
            let mut table = table.as_ref();
            for (index, entry) in cell_path.iter().enumerate() {
                let Some(control) = table
                    .cells
                    .get(entry.cell_index)
                    .and_then(|cell| cell.paragraphs.get(entry.cell_para_index))
                    .and_then(|para| para.controls.get(entry.control_index))
                else {
                    return &[];
                };
                if index + 1 == cell_path.len() {
                    return match control {
                        Control::Footnote(note) => &note.paragraphs,
                        _ => &[],
                    };
                }
                let Control::Table(child) = control else {
                    return &[];
                };
                table = child;
            }
            &[]
        }
        FootnoteSource::ShapeTextBox {
            para_index,
            shape_control_index,
            tb_para_index,
            tb_control_index,
        } => {
            if let Some(para) = paragraphs.get(*para_index) {
                if let Some(Control::Shape(shape_obj)) = para.controls.get(*shape_control_index) {
                    if let Some(text_box) = shape_obj.drawing().and_then(|d| d.text_box.as_ref()) {
                        if let Some(tp) = text_box.paragraphs.get(*tb_para_index) {
                            if let Some(Control::Footnote(footnote)) =
                                tp.controls.get(*tb_control_index)
                            {
                                return &footnote.paragraphs;
                            }
                        }
                    }
                }
            }
            &[]
        }
    }
}

fn format_control_note_marker(
    number: u16,
    number_shape: u32,
    before_decoration_letter: u16,
    after_decoration_letter: u16,
) -> String {
    // [hwpx-cowork] 한 곳(renderer::format_note_marker)에서 — 사용자 기호·원 문자 모양·장식 없음까지
    crate::renderer::format_note_marker(number, number_shape, before_decoration_letter, after_decoration_letter)
}

/// [hwpx-cowork] 2026-11-04 표 캡션 영역 잘림 — 한/글 2022 실측(숨은 COM, CreatePageImage 표식 색 상자,
/// `artifacts/layout-fix-20261103/scratch/fix-capclip/probe.py`·`reports/fix-capclip.md`). 한/글은 캡션 안 개체·글을
/// 캡션 영역 밖으로 그리지 않는다.
/// - 아래 캡션: 가로 = 캡션 폭(가로 오프셋으로 넘친 개체의 오른쪽이 잘림), 세로 = 표 아래 끝(간격 포함)부터.
///   쪽·종이 기준 아래·가운데 정렬 개체는 표 아래 끝~캡션 위 띠만 보인다(개체를 266px 로 키워도 같음). 아래 끝은
///   자르지 않는다 — 한/글은 캡션 높이를 떠 있는 개체 바닥(글 앞으로 개체까지)까지 늘린다.
/// - 위 캡션: 가로 = 캡션 폭, 세로 = 캡션 위부터(캡션 위로 나간 쪽 기준 아래 정렬 개체는 안 보임). 표 쪽 끝은
///   캡션이 개체를 품도록 늘어나므로 표 위 끝과 내용 바닥 중 큰 값.
/// - 왼쪽·오른쪽 캡션: 가로 = 캡션 바깥 끝부터 표 옆 끝까지(간격 포함), 세로 = 표 위·아래 끝(캡션 글이 표보다
///   길어도 표 아래로는 안 보임). 한/글 그림은 표 아래 끝보다 약 2px(≈0.5mm) 더 보이는데 간격·표 높이와 무관한
///   상수라 따르지 않았다.
/// 한/글은 캡션 폭보다 넓은 글자처럼 표도 캡션 오른끝에서 자르지만, 엔진은 글 줄을 세로로만 자른다(아래 주석).
/// 영역 안에 다 드는 노드는 그대로 둔다(잘림 묶음을 만들지 않음). 넘는 노드에만 `clip` 을 붙인다 — `bbox` 는 그대로라
/// 커서·클릭 판정·편집은 바뀌지 않는다.
pub(crate) fn clip_caption_content(
    nodes: &mut [RenderNode],
    direction: CaptionDirection,
    owner: BoundingBox,
    cap_x: f64,
    cap_w: f64,
    cap_y: f64,
) {
    const EPS: f64 = 0.5;
    fn extent(node: &RenderNode, acc: &mut (f64, f64, f64, f64)) {
        if !node.visible {
            return;
        }
        let b = &node.bbox;
        if b.width > 0.0 || b.height > 0.0 {
            acc.0 = acc.0.min(b.x);
            acc.1 = acc.1.min(b.y);
            acc.2 = acc.2.max(b.x + b.width);
            acc.3 = acc.3.max(b.y + b.height);
        }
        for child in &node.children {
            extent(child, acc);
        }
    }
    if nodes.is_empty() {
        return;
    }
    let extents: Vec<(f64, f64, f64, f64)> = nodes
        .iter()
        .map(|n| {
            let mut acc = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            extent(n, &mut acc);
            acc
        })
        .collect();
    let content_bottom = extents
        .iter()
        .filter(|e| e.3.is_finite())
        .map(|e| e.3)
        .fold(f64::NEG_INFINITY, f64::max);
    let owner_bottom = owner.y + owner.height;
    let (x0, y0, x1, y1) = match direction {
        CaptionDirection::Bottom => (cap_x, owner_bottom, cap_x + cap_w, content_bottom.max(owner_bottom)),
        CaptionDirection::Top => (cap_x, cap_y, cap_x + cap_w, content_bottom.max(owner.y)),
        CaptionDirection::Left => (cap_x, owner.y, owner.x, owner_bottom),
        CaptionDirection::Right => (owner.x + owner.width, owner.y, cap_x + cap_w, owner_bottom),
    };
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
        return;
    }
    for (node, e) in nodes.iter_mut().zip(extents) {
        if !e.0.is_finite() {
            continue;
        }
        // 글 줄은 세로로만 자른다. 한/글은 캡션 폭 안에서 줄을 나누므로 글이 옆으로 넘치지 않는데, 엔진 글자 폭
        // 오차로 마지막 글자가 캡션 폭을 조금 넘는 줄(자동 번호 폭 등)을 반쯤 자르지 않으려고.
        let (nx0, nx1) = if matches!(node.node_type, RenderNodeType::TextLine(_)) {
            (x0.min(e.0), x1.max(e.2))
        } else {
            (x0, x1)
        };
        let inside = e.0 >= nx0 - EPS && e.1 >= y0 - EPS && e.2 <= nx1 + EPS && e.3 <= y1 + EPS;
        if !inside {
            let clip = BoundingBox::new(nx0, y0, (nx1 - nx0).max(0.0), (y1 - y0).max(0.0));
            // 캡션 안 표의 캡션처럼 이미 잘림이 있으면 겹친 영역만 남긴다.
            node.clip = Some(match node.clip {
                Some(c) => {
                    let (ix0, iy0) = (c.x.max(clip.x), c.y.max(clip.y));
                    let ix1 = (c.x + c.width).min(clip.x + clip.width);
                    let iy1 = (c.y + c.height).min(clip.y + clip.height);
                    BoundingBox::new(ix0, iy0, (ix1 - ix0).max(0.0), (iy1 - iy0).max(0.0))
                }
                None => clip,
            });
        }
    }
}

/// 각주 번호 포맷 (NumberFormat에 따른 변환)
/// [hwpx-cowork] 한/글처럼 구역 각주 모양의 번호 모양·사용자 기호·앞뒤 장식 그대로(뒤 장식이 없으면 붙이지 않는다 —
/// 종전에는 `)` 를 붙이고 원 문자·영문 외 모양은 숫자로 그렸다).
fn format_footnote_number(number: u16, shape: &crate::model::footnote::FootnoteShape) -> String {
    let code = crate::model::footnote::FootnoteShape::number_format_attr_code(shape.number_format);
    let text = crate::renderer::format_note_number(number, code, shape.user_char, shape.prefix_char, shape.suffix_char);
    format!("{} ", text)
}
// [hwpx-cowork] 2026-11-04 표 캡션 영역 잘림(`clip_caption_content`) — 한/글 2022 실측 시험지에서 만든 문서.
// bottom_page_bottom_tall: 아래 캡션 안 쪽 기준 아래 정렬 표를 20000HU 로 키움(한/글은 표 아래 끝~캡션 위 띠만 보임).
// right_long_behind: 오른쪽 캡션 안 글 뒤로 30000HU 표(한/글은 표 높이만큼만 보임).
// bottom_horz_over: 아래 캡션 안 가로 오프셋 36000HU 표(한/글은 캡션 오른끝에서 잘림).
// bottom_page_top: 쪽 기준 위 정렬 — 캡션 영역 안이라 잘림 없음(회귀 시험 A-5832d559cfd2).
#[cfg(test)]
mod caption_clip_tests {
    use super::*;
    use crate::document_core::DocumentCore;

    fn tree(bytes: &[u8]) -> PageRenderTree {
        let mut doc = DocumentCore::from_bytes(bytes).expect("열기");
        doc.convert_to_editable_native().expect("편집 가능 변환");
        doc.build_page_tree(0).expect("쪽 렌더 트리")
    }

    fn collect<'a>(node: &'a RenderNode, out: &mut Vec<&'a RenderNode>) {
        out.push(node);
        for child in &node.children {
            collect(child, out);
        }
    }

    /// 캡션 안 시험 표(2×2, 폭 160px) 노드.
    fn caption_table(tree: &PageRenderTree) -> RenderNode {
        let mut nodes = Vec::new();
        collect(&tree.root, &mut nodes);
        nodes
            .into_iter()
            .find(|n| {
                matches!(&n.node_type, RenderNodeType::Table(t) if t.row_count == 2 && t.col_count == 2)
            })
            .expect("캡션 안 표")
            .clone()
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.2
    }

    #[test]
    fn bottom_caption_object_is_clipped_from_parent_table_bottom() {
        let t = tree(include_bytes!("../../../tests/fixtures/caption_clip/bottom_page_bottom_tall.hwpx"));
        let table = caption_table(&t);
        // 놓는 자리·상자는 그대로(바닥 = 캡션 위 276.4, 높이 266.7) — 커서·클릭 판정은 bbox 를 쓴다.
        assert!(near(table.bbox.y + table.bbox.height, 276.4), "{:?}", table.bbox);
        assert!(near(table.bbox.height, 266.7), "{:?}", table.bbox);
        let clip = table.clip.expect("캡션 영역 잘림");
        // 가로 = 캡션 폭(113.4~673.4), 세로 = 부모 표 아래 끝(265.1)부터.
        assert!(near(clip.x, 113.4) && near(clip.x + clip.width, 673.4), "{clip:?}");
        assert!(near(clip.y, 265.1), "{clip:?}");
        assert!(clip.y + clip.height >= 276.4 - 0.2, "아래 끝은 캡션 내용 끝까지: {clip:?}");
        // 캡션 글 줄은 영역 안이라 잘림 묶음을 만들지 않는다.
        let mut nodes = Vec::new();
        collect(&t.root, &mut nodes);
        assert!(nodes
            .iter()
            .filter(|n| matches!(&n.node_type, RenderNodeType::TextLine(l) if l.caption_owner.is_some()))
            .all(|n| n.clip.is_none()));
    }

    #[test]
    fn bottom_caption_clip_reaches_svg_and_json() {
        let bytes = include_bytes!("../../../tests/fixtures/caption_clip/bottom_page_bottom_tall.hwpx");
        let mut doc = DocumentCore::from_bytes(bytes).expect("열기");
        doc.convert_to_editable_native().expect("편집 가능 변환");
        let svg = doc.render_page_svg_native(0).expect("SVG");
        assert!(svg.contains("generic-clip-"), "layer SVG 에 잘림 경로");
        let legacy = doc.render_page_svg_legacy_native(0).expect("옛 SVG");
        assert!(legacy.contains("node-clip-"), "옛 SVG 경로도 잘림");
        let json = doc.build_page_tree(0).expect("트리").root.to_json();
        assert!(json.contains("\"clip\":{\"x\":113.4,\"y\":265.1"), "렌더 트리 JSON 에 clip");
    }

    #[test]
    fn right_caption_object_is_clipped_to_table_height() {
        let t = tree(include_bytes!("../../../tests/fixtures/caption_clip/right_long_behind.hwpx"));
        let table = caption_table(&t);
        let clip = table.clip.expect("캡션 영역 잘림");
        // 가로 = 부모 표 오른끝(460.1, 간격 포함)~캡션 오른끝(658.1), 세로 = 부모 표 185.1~265.1.
        assert!(near(clip.x, 460.1) && near(clip.x + clip.width, 658.1), "{clip:?}");
        assert!(near(clip.y, 185.1) && near(clip.y + clip.height, 265.1), "{clip:?}");
    }

    #[test]
    fn bottom_caption_object_is_clipped_at_caption_right_edge() {
        let t = tree(include_bytes!("../../../tests/fixtures/caption_clip/bottom_horz_over.hwpx"));
        let table = caption_table(&t);
        assert!(near(table.bbox.x + table.bbox.width, 753.4), "{:?}", table.bbox);
        let clip = table.clip.expect("캡션 오른끝 잘림");
        assert!(near(clip.x + clip.width, 673.4), "{clip:?}");
    }

    #[test]
    fn caption_content_inside_its_area_has_no_clip() {
        let t = tree(include_bytes!("../../../tests/fixtures/caption_clip/bottom_page_top.hwpx"));
        let mut nodes = Vec::new();
        collect(&t.root, &mut nodes);
        assert!(nodes.iter().all(|n| n.clip.is_none()));
    }

    #[test]
    fn caption_text_line_is_clipped_only_vertically() {
        let line = |id, y| {
            let mut n = RenderNode::new(id, RenderNodeType::TextLine(TextLineNode::new(14.0, 11.0)), BoundingBox::new(10.0, y, 100.0, 14.0));
            // 엔진 글자 폭 오차로 캡션 폭(110)을 넘은 마지막 글자
            n.children.push(RenderNode::new(id + 10, RenderNodeType::TextBox, BoundingBox::new(100.0, y, 18.0, 14.0)));
            n
        };
        let mut nodes = vec![line(1, 100.0), line(2, 190.0)];
        // 오른쪽 캡션: 표 0~95 높이 100~200, 캡션 10~110
        clip_caption_content(
            &mut nodes,
            CaptionDirection::Right,
            BoundingBox::new(-5.0, 100.0, 10.0, 100.0),
            10.0,
            100.0,
            100.0,
        );
        assert!(nodes[0].clip.is_none(), "가로로만 넘친 글 줄은 자르지 않는다");
        let c = nodes[1].clip.expect("표 아래로 나간 글 줄은 자른다");
        assert_eq!((c.y, c.y + c.height), (100.0, 200.0));
        assert!(c.x + c.width >= 118.0, "글 줄의 가로는 넓혀 둔다: {c:?}");
    }

    #[test]
    fn nested_clip_is_intersected() {
        let mut nodes = vec![RenderNode::new(1, RenderNodeType::TextBox, BoundingBox::new(0.0, 0.0, 100.0, 100.0))];
        nodes[0].clip = Some(BoundingBox::new(0.0, 50.0, 30.0, 100.0));
        clip_caption_content(
            &mut nodes,
            CaptionDirection::Bottom,
            BoundingBox::new(0.0, -50.0, 60.0, 80.0),
            0.0,
            60.0,
            40.0,
        );
        let c = nodes[0].clip.unwrap();
        assert_eq!((c.x, c.y, c.width, c.height), (0.0, 50.0, 30.0, 50.0));
    }
}
