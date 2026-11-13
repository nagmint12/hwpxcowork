// [hwpx-cowork] 나뉜 칸의 미룬 자리차지 개체 띠 표는 문서별이다.
//
// 한 인스턴스에 문서가 여럿 살아 있을 때 다른 문서를 조판해도 앞 문서의 띠 기록이 지워지면 안 된다 —
// 지워지면 앞 문서는 조판(조각 높이)은 이월로, 그리기는 이월 없이 되어 어긋난다.
// 자료: 회귀 시험 A-236cc58dc825(쪽을 넘는 1×1 칸, 쪽 끝 앵커의 자리차지 그림 → 다음 조각 맨 위로)와
// A-6ec874a35bed(같은 칸, 글 앞 사각형).

use super::DocumentCore;

const BAND_DOC: &[u8] = include_bytes!("../../tests/fixtures/split_cell/deferred_band_pic.hwpx");
const OTHER_DOC: &[u8] = include_bytes!("../../tests/fixtures/split_cell/overlay_rect.hwpx");

fn open(bytes: &[u8]) -> DocumentCore {
    let mut doc = DocumentCore::from_bytes(bytes).expect("열기");
    doc.convert_to_editable_native().expect("편집 가능 변환");
    doc
}

fn pages(doc: &DocumentCore) -> Vec<String> {
    (0..doc.page_count())
        .map(|page| doc.render_page_svg_native(page).expect("쪽 그리기"))
        .collect()
}

#[test]
fn split_cell_deferred_band_survives_other_document_pagination() {
    let alone = pages(&open(BAND_DOC));
    assert_eq!(alone.len(), 2, "나뉜 칸은 두 쪽");

    let band_doc = open(BAND_DOC);
    // 다른 문서를 열어 조판한다(같은 스레드 지역 표를 쓴다).
    let other = open(OTHER_DOC);
    assert!(other.page_count() >= 1);
    let after_other = pages(&band_doc);
    assert_eq!(after_other, alone, "다른 문서 조판 뒤에도 같은 쪽 그림");

    // 앞 문서를 버린 뒤 새로 연 문서도 같은 결과(칸 주소가 겹쳐도 문서 id 가 다르다).
    drop(band_doc);
    let reopened = open(BAND_DOC);
    assert_eq!(pages(&reopened), alone);
}
