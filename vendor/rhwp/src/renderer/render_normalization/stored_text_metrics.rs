//! 원문 글자 크기와 줄간격이 함께 입증하는 명목 줄 메트릭의 렌더 전용 투영.

use crate::model::{
    control::Control,
    document::Document,
    paragraph::{ColumnBreakType, LineSeg, Paragraph},
    style::{BorderLineType, HeadType, LineSpacingType},
    table::{Cell, TablePageBreak},
};
use crate::renderer::{
    composer::compute_line_spacing_hwp,
    float_placement::{is_para_topbottom_float, stored_inline_host_has_separate_float_frame},
    px_to_hwpunit,
    style_resolver::{detect_lang_category, ResolvedStyleSet},
};

fn floating_text_host(paragraph: &Paragraph) -> bool {
    let mut floating = false;
    for control in &paragraph.controls {
        match control {
            Control::Table(table) if is_para_topbottom_float(&table.common) => floating = true,
            Control::SectionDef(_) | Control::ColumnDef(_) => {}
            _ => return false,
        }
    }
    floating
}

fn nominal_height(
    paragraph: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
    include_empty: bool,
) -> Option<i32> {
    // 여러 글자모양의 경계는 완전한 문자 주소가 있을 때만 읽는다.
    // 주소가 없는 합성 입력에서 첫 글자모양을 전체 문단의 근거로 쓰지 않는다.
    if paragraph.char_shapes.is_empty()
        || paragraph
            .char_shapes
            .windows(2)
            .any(|pair| pair[0].start_pos > pair[1].start_pos)
        || (paragraph.char_shapes.len() > 1
            && (paragraph.char_offsets.len() != paragraph.text.chars().count()
                || paragraph
                    .char_offsets
                    .windows(2)
                    .any(|pair| pair[0] >= pair[1])))
    {
        return None;
    }
    let dpi = styles.resolved_dpi.unwrap_or(dpi);
    let mut height = 0;
    let mut visible = false;
    for (position, ch) in paragraph.text.chars().enumerate() {
        if ch.is_control() || ch == '\u{FFFC}' {
            return None;
        }
        visible |= !ch.is_whitespace();
        let style = styles
            .char_styles
            .get(paragraph.char_shape_id_at(position)? as usize)?;
        let language = detect_lang_category(ch);
        if style.superscript
            || style.subscript
            || style.font_position_for_lang(language) != 0
            || style.outline_type != 0
            || style.shadow_type != 0
            || style.emboss
            || style.engrave
            || style.emphasis_dot != 0
        {
            return None;
        }
        if let Some(border) = style
            .border_fill_id
            .checked_sub(1)
            .and_then(|index| styles.border_styles.get(usize::from(index)))
        {
            if border
                .borders
                .iter()
                .any(|edge| edge.line_type != BorderLineType::None)
            {
                return None;
            }
        }
        let size = style.font_size_for_lang(language);
        if !size.is_finite() || size <= 0.0 {
            return None;
        }
        height = height.max(px_to_hwpunit(size, dpi));
    }
    // 마지막 빈 run은 보이는 글자가 없어도 문단 끝 줄 상자의 글자모양이다.
    // 재조판과 같은 원본 UTF-16 종단 주소를 소비해야 정상 저장 높이를
    // 가시 글자의 크기만으로 줄이고 셀의 기준선을 이동시키지 않는다.
    let end_size = crate::renderer::composer::paragraph_end_font_size_px(paragraph, styles);
    if end_size.is_finite() && end_size > 0.0 {
        height = height.max(px_to_hwpunit(end_size, dpi));
    }
    ((visible || include_empty) && height > 0).then_some(height)
}

fn projected_line(paragraph: &Paragraph, styles: &ResolvedStyleSet, dpi: f64) -> Option<LineSeg> {
    // 다른 문단의 편집으로 유효한 저장 줄까지 버리지 않는다.
    // 실제 편집·셀 서식 변경으로 무효화된 줄만 원래 재조판 경로에 맡긴다.
    if paragraph.stored_text_partition_is_dirty() || paragraph.cell_format_vpos_dirty {
        return None;
    }
    let [line] = paragraph.line_segs.as_slice() else {
        return None;
    };
    let style = styles.para_styles.get(paragraph.para_shape_id as usize)?;
    if !matches!(style.head_type, HeadType::None)
        || !matches!(style.line_spacing_type, LineSpacingType::Percent)
        || !style.line_spacing.is_finite()
        || style.line_spacing < 100.0
        || line.text_height <= 0
        || line.baseline_distance <= 0
        || line.baseline_distance > line.text_height
    {
        return None;
    }
    let height = nominal_height(paragraph, styles, dpi, false)?;
    // 원본 글자 크기와 원본 Percent 간격이 같은 높이를 증명해야 한다.
    // 1 HWPUNIT는 정수로 저장되는 줄간격의 반올림만 허용한다.
    let expected_spacing = (f64::from(height) * (style.line_spacing / 100.0 - 1.0)).round();
    if line.text_height <= height
        || line.line_height <= height
        || (f64::from(line.line_spacing) - expected_spacing).abs() > 1.0
    {
        return None;
    }
    let mut projected = line.clone();
    projected.line_height = height;
    projected.text_height = height;
    projected.baseline_distance = (i64::from(line.baseline_distance) * i64::from(height)
        / i64::from(line.text_height)) as i32;
    Some(projected)
}

/// [hwpx-cowork] #9042. 우리 계열에서 저장한 줄 캐시가 오래된 공동 앵커 표는
/// 한/글 재저장본처럼 현재 글자 크기와 줄 피치로 연다. 편집과 저장도 이 줄을 쓴다.
pub(crate) fn restore_managed_coanchored_cells<S: crate::storage::Storage>(
    document: &mut Document,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<(), S::Error> {
    use sha2::{Digest, Sha256};

    if !document.layout_profile().native_hwp5_layout() {
        return Ok(());
    }
    let Some((_, marker)) = document.extra_streams.iter().find(|(path, _)| path == "/RhwpLineSegTags")
    else {
        return Ok(());
    };
    let Some(digests) = marker.strip_prefix(b"RHWPLT01") else {
        return Ok(());
    };
    if marker.len() > 64 * 1024 || digests.is_empty() || digests.len() % 32 != 0 {
        return Ok(());
    }
    for section in &mut document.sections {
        let Some(raw) = section.raw_stream.as_deref() else {
            continue;
        };
        let digest = Sha256::digest(raw);
        if !digests.chunks_exact(32).any(|entry| entry == &digest[..]) {
            continue;
        }
        for paragraph in &mut section.paragraphs {
            let Some(index) = paragraph.controls.iter().position(|control| {
                matches!(
                    control,
                    Control::Table(table)
                        if table.layout_page_break() == TablePageBreak::RowBreak
                            && table.common.flow_with_text
                            && stored_inline_host_has_separate_float_frame(paragraph, table)
                )
            }) else {
                continue;
            };
            let Control::Table(table) = &mut paragraph.controls[index] else {
                unreachable!("the index came from a table control");
            };
            for cell in &mut table.cells {
                refresh_managed_cell_lines(cell, styles, dpi, storage)?;
            }
        }
    }
    Ok(())
}

fn refresh_managed_cell_lines<S: crate::storage::Storage>(
    cell: &mut Cell,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<(), S::Error> {
    if cell.dirty_flag || cell.text_direction != 0 || cell.line_wrap != 0 {
        return Ok(());
    }
    let mut current = storage.vec(cell.paragraphs.len())?;
    let mut previous = None;
    let mut next_top = None;
    let mut stale = false;
    for paragraph in &cell.paragraphs {
        let Some((mut line, changed)) = managed_cell_line(paragraph, styles, dpi) else {
            return Ok(());
        };
        let saved_top = line.vertical_pos;
        if previous.is_some_and(|top| {
            saved_top < top || line.is_first_line_of_page() || line.is_first_line_of_column()
        }) {
            return Ok(());
        }
        previous = Some(saved_top);
        line.vertical_pos = next_top.unwrap_or(saved_top);
        next_top = line
            .vertical_pos
            .checked_add(line.line_height)
            .and_then(|end| end.checked_add(line.line_spacing));
        if next_top.is_none() {
            return Ok(());
        }
        current.push(line);
        stale |= changed;
    }
    if stale {
        for (paragraph, line) in cell.paragraphs.iter_mut().zip(current) {
            paragraph.line_segs[0] = line;
            paragraph.source_line_seg_vertical_pos = None;
        }
    }
    Ok(())
}

fn managed_cell_line(
    paragraph: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<(LineSeg, bool)> {
    let [line] = paragraph.line_segs.as_slice() else {
        return None;
    };
    let style = styles.para_styles.get(paragraph.para_shape_id as usize)?;
    if !paragraph.controls.is_empty()
        || paragraph.stored_text_partition_is_dirty()
        || paragraph.cell_format_vpos_dirty
        || paragraph.column_type != ColumnBreakType::None
        || style.page_break_before
        || style.spacing_before != 0.0
        || style.spacing_after != 0.0
        || !matches!(style.head_type, HeadType::None)
        || line.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
        || line.text_start != 0
        || line.vertical_pos < 0
        || line.segment_width <= 0
        || line.line_height != line.text_height
        || line.text_height <= 0
        || line.baseline_distance <= 0
        || line.baseline_distance > line.text_height
    {
        return None;
    }
    let height = nominal_height(paragraph, styles, dpi, true)?;
    match style.line_spacing_type {
        LineSpacingType::Percent if style.line_spacing >= 100.0 => {}
        LineSpacingType::Fixed if style.line_spacing > 0.0 => {}
        _ => return None,
    }
    if !style.line_spacing.is_finite() {
        return None;
    }
    let spacing = compute_line_spacing_hwp(style.line_spacing_type, style.line_spacing, height, dpi);
    // 저장 높이와 전진값이 둘 다 다를 때만 캐시가 낡았다고 판정한다.
    // 1HU는 높이와 간격을 따로 저장할 때 생기는 반올림 오차다.
    let saved_advance = i64::from(line.line_height) + i64::from(line.line_spacing);
    let advance = i64::from(height) + i64::from(spacing);
    let stale = line.text_height > height && (saved_advance - advance).abs() > 1;
    let mut current = line.clone();
    current.line_height = height;
    current.text_height = height;
    current.baseline_distance = (f64::from(line.baseline_distance) * f64::from(height)
        / f64::from(line.text_height))
        .round() as i32;
    current.line_spacing = spacing;
    Some((current, stale))
}

fn project(
    paragraph: &Paragraph,
    cell: bool,
    hwpx_cells: bool,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<Paragraph> {
    match project_with_storage(
        paragraph,
        cell,
        hwpx_cells,
        styles,
        dpi,
        &crate::storage::Unbounded,
    ) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
fn project_with_storage<S: crate::storage::Storage>(
    paragraph: &Paragraph,
    cell: bool,
    hwpx_cells: bool,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<Option<Paragraph>, S::Error> {
    let eligible =
        floating_text_host(paragraph) || (cell && hwpx_cells && paragraph.controls.is_empty());
    let mut projected = eligible
        .then(|| projected_line(paragraph, styles, dpi))
        .flatten()
        .map(|line| {
            let mut result = storage.clone_paragraph(paragraph)?;
            result.line_segs[0] = line;
            Ok::<_, S::Error>(result)
        })
        .transpose()?;
    for (control_index, control) in paragraph.controls.iter().enumerate() {
        let Control::Table(table) = control else {
            continue;
        };
        for (cell_index, cell) in table.cells.iter().enumerate() {
            if cell.text_direction != 0 || cell.line_wrap != 0 {
                continue;
            }
            for (paragraph_index, child) in cell.paragraphs.iter().enumerate() {
                if let Some(child) =
                    project_with_storage(child, true, hwpx_cells, styles, dpi, storage)?
                {
                    if projected.is_none() {
                        projected = Some(storage.clone_paragraph(paragraph)?);
                    }
                    let result = projected.as_mut().unwrap();
                    let Control::Table(table) = &mut result.controls[control_index] else {
                        unreachable!()
                    };
                    table.cells[cell_index].paragraphs[paragraph_index] = child;
                }
            }
        }
    }
    Ok(projected)
}

pub(crate) fn normalize(
    paragraphs: &[Paragraph],
    styles: &ResolvedStyleSet,
    dpi: f64,
    hwpx_cells: bool,
) -> Option<Vec<Paragraph>> {
    match normalize_with_storage(
        paragraphs,
        styles,
        dpi,
        hwpx_cells,
        &crate::storage::Unbounded,
    ) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
pub(crate) fn normalize_with_storage<S: crate::storage::Storage>(
    paragraphs: &[Paragraph],
    styles: &ResolvedStyleSet,
    dpi: f64,
    hwpx_cells: bool,
    storage: &S,
) -> Result<Option<Vec<Paragraph>>, S::Error> {
    let mut result = None;
    for (index, paragraph) in paragraphs.iter().enumerate() {
        if let Some(projected) =
            project_with_storage(paragraph, false, hwpx_cells, styles, dpi, storage)?
        {
            if result.is_none() {
                result = Some(
                    storage.try_collect(paragraphs.iter().map(|p| storage.clone_paragraph(p)))?,
                );
            }
            result.as_mut().unwrap()[index] = projected;
        }
    }
    Ok(result)
}
