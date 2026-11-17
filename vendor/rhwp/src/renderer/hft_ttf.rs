//! [hwpx-cowork] HFT placement metadata, painted with ordinary mapped TTFs.
//! No HFT outline/font/decoder is shipped or read. Generated differences only;
//! source normalised baseline and TTF ink bounds share an em coordinate frame.
use std::sync::OnceLock;
use serde::Deserialize;
use super::{font_metrics_local::LocalFontFace, hancom_fontdb::GlyphSelection};

#[derive(Deserialize)]
struct Data { programs: Vec<Program>, bindings: Vec<Binding> }
#[derive(Deserialize)]
struct Program {
    key: String, file: String, ttf: String, lang: usize,
    #[serde(default)]
    italic: bool,
    coverage: Vec<(u32,u32)>,
    // [hwpx-cowork] 2026-11-07: per glyph only cp, HFT advance (1e6 em) and
    // semantic display code. Size/baseline are font-level (`metrics`): one
    // uniform TTF scale and one baseline shift per program, never per glyph.
    differences: Vec<(u32,Option<i64>,Option<u32>)>,
    #[serde(default)]
    metrics: Option<(i64,i64)>,
}
#[derive(Deserialize)]
struct Binding { lang: usize, names: Vec<String>, ttf: String, programs: Vec<String>, fallbacks: Vec<String> }
fn data() -> &'static Data {
    static DATA: OnceLock<Data> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("hft_ttf_data.json"))
        .expect("generated HFT/TTF placement data"))
}
fn program(key:&str) -> Option<&'static Program> {
    if !key.starts_with("HFTMETRIC:") { return None; }
    data().programs.iter().find(|p|p.key==key)
}
fn covers(p:&Program,c:char)->bool {
    let cp=c as u32;
    p.coverage.binary_search_by(|&(a,b)|if cp<a {std::cmp::Ordering::Greater}
        else if cp>b {std::cmp::Ordering::Less} else {std::cmp::Ordering::Equal}).is_ok()
}
pub(crate) fn is_native(key:&str)->bool { key.starts_with("HFTMETRIC:") && program(key).is_some() }
/// [hwpx-cowork] 2026-11-16 원본 HFT 프로그램이 이 글자를 가지는가. 한/글 영문 HFT(예: ENSMJ.HFT,
/// 범위 33~126)에는 공백 글리프가 없다 — 그 자리를 표시용 TTF 의 공백으로 재면 안 된다.
pub(crate) fn program_covers(key:&str, c:char)->bool { program(key).is_some_and(|p|covers(p,c)) }
pub(crate) fn uses_extracted_policy(key:&str)->bool { is_native(key) }
pub(crate) fn find_face(key:&str)->Option<&'static LocalFontFace> {
    super::local_font_width::find_local_face(&program(key)?.ttf)
}
pub(crate) fn family_for_slot(name:&str,lang:usize)->Option<&'static str> {
    Some(&data().bindings.iter().find(|b|b.lang==lang&&b.names.iter().any(|n|n==name))?.ttf)
}
pub(crate) fn metric_key_for_slot(name:&str,lang:usize)->Option<&'static str> {
    data().bindings.iter().find(|b|b.lang==lang&&b.names.iter().any(|n|n==name))?
        .programs.first().filter(|key|!key.is_empty()).map(String::as_str)
}
fn chosen(key:&str,c:char,bold:bool,italic:bool)->Option<(&'static Program,bool)> {
    let base=program(key)?;
    let binding=data().bindings.iter().find(|b|b.programs.first().is_some_and(|p|p==key));
    let variant=usize::from(bold)+2*usize::from(italic);
    let explicit=binding.and_then(|b|b.programs.get(variant)).and_then(|k|program(k)).filter(|p|covers(p,c));
    let selected=explicit.or_else(||if italic {binding.and_then(|b|b.programs.get(2))
        .and_then(|k|program(k)).filter(|p|covers(p,c))} else {None}).unwrap_or(base);
    if covers(selected,c) {return Some((selected,bold&&explicit.is_none()));}
    // [hwpx-cowork] Preserve the source HFT fallback's spacing/placement, but
    // draw its natural TTF substitute. No fallback outline is distributed.
    for target in binding.into_iter().flat_map(|b|&b.fallbacks) {
        if let Some(p)=program(target).filter(|p|covers(p,c)) {return Some((p,bold));}
    }
    None
}

pub(crate) struct Placement {
    pub family: &'static str, pub character: char, pub advance: f64,
    /// Centre the TTF advance box inside the HFT advance (one rule for all glyphs).
    pub dx: f64,
    /// Font-level baseline shift (em, positive = down) and uniform TTF scale.
    pub dy: f64, pub scale: f64,
}
/// A single decision is consumed by width calculation and the render-tree
/// projection upstream of SVG, Canvas, CanvasKit JSON, HTML/PDF and Skia.
pub(crate) fn placement(key:&str,c:char,bold:bool,italic:bool)->Option<Placement> {
    let (p,synthetic_bold)=chosen(key,c,bold,italic)?;
    let delta=p.differences.binary_search_by_key(&(c as u32),|r|r.0).ok().map(|i|&p.differences[i]);
    let character=delta.and_then(|d|d.2).and_then(char::from_u32).unwrap_or(c);
    let ttf=super::hancom_fontdb::select_glyph(&p.ttf,character,bold,italic,p.lang);
    let family=ttf.as_ref().map_or(p.ttf.as_str(),|s|if s.requested_family {p.ttf.as_str()} else {s.paint_family});
    // Unchanged advances are omitted from data, and must be read from the
    // same TTF metric design used by the generator, not a requested style
    // synthesized because the source HFT program was absent.
    let ttf_advance=super::hancom_fontdb::select_glyph(&p.ttf,character,false,p.italic,p.lang).map(|s|s.advance_em);
    let source_advance=delta.and_then(|d|d.1).map(|v|v as f64/1_000_000.0).or(ttf_advance)?;
    // [hwpx-cowork] 2022 PDF synthetic bold: advance +.05em; the outline is
    // emboldened by the backend's ordinary bold, not by per-glyph geometry.
    let advance=source_advance+if synthetic_bold {0.05}else{0.0};
    let (scale,dy)=p.metrics.map_or((1.0,0.0),|(s,d)|(s as f64/1_000_000.0,d as f64/1_000_000.0));
    // [hwpx-cowork] 2026-11-07: no per-glyph ink fitting. The TTF glyph keeps
    // its own side bearings; its scaled advance box is centred in the HFT
    // advance, so U+2024 -> U+00B7 sits in the middle of HFT's 1em cell.
    let dx=ttf_advance.map_or(0.0,|t|(source_advance-scale*t)/2.0);
    Some(Placement {family,character,advance,dx,dy,scale})
}
pub(crate) fn select_glyph(key:&str,c:char,bold:bool,italic:bool)->Option<GlyphSelection> {
    let p=placement(key,c,bold,italic)?;
    let metric_face=super::local_font_width::find_local_face(p.family).or_else(||find_face(key))?;
    Some(GlyphSelection {paint_family:p.family,metric_face,advance_em:p.advance,requested_family:false})
}

/// [hwpx-cowork] Project after source layout positions are final. Keep source
/// text and char offsets, use display_text for semantic glyph substitutions,
/// and map TTF ink height/baseline without changing model size or line layout.
pub(crate) fn project_tree(tree:&mut super::render_tree::PageRenderTree) {
    use super::render_tree::{RenderNode,RenderNodeType};
    fn visit(node:&mut RenderNode,frame:&mut super::render_tree::PageLayoutContext) {
        let mut children=Vec::new();
        for mut child in std::mem::take(&mut node.children) {
            visit(&mut child,frame);
            let RenderNodeType::TextRun(run)=&child.node_type else {children.push(child);continue;};
            let Some(key)=run.style.metric_font_family.as_deref().filter(|s|is_native(s)) else {children.push(child);continue;};
            let display=run.display_or_text();
            // Expanded old-Hangul/overlap shaping is one logical cluster. Its
            // existing positions remain intact and it uses its mapped TTF.
            if run.char_overlap.is_some() || run.text.chars().count()!=display.chars().count() {
                let positions=run.replay_positions_for(display).into_owned();
                let mut owned=child.clone();
                if let RenderNodeType::TextRun(r)=&mut owned.node_type {
                    r.layout_positions=Some(positions);r.style.metric_font_family=None;r.style.font_metric_trusted=true;r.style.kerning=false;
                }
                children.push(owned);continue;
            }
            let source:Vec<char>=run.text.chars().collect();
            let positions=run.replay_positions_for(display).into_owned();
            let clusters=super::layout::split_into_clusters(display);
            // [hwpx-cowork] 2026-11-10 G1: 글자 없는 run(빈 줄·빈 칸 문단의 캐럿·문단 끝 표시 앵커)은
            // 투영할 글리프가 없다. 아래 조각 루프는 조각마다 run 을 새로 만들므로 조각이 0개면
            // run 자체가 트리에서 사라져, HFT 글꼴 빈 문단에서 커서(`cursor_rect_in_cell_via_page_tree`)·
            // 문단 끝 표시가 그 줄을 못 찾았다(거대 칸 표본 cell2 cp0 — 프로브 경로는 투영 전 트리라 찾음).
            // 원본 조판이 놓은 그대로 둔다.
            if clusters.is_empty() {children.push(child);continue;}
            // [hwpx-cowork] 2026-11-10 실문서A 목차 점선 겹침: 이 투영은 run 을 글자 조각으로 나누는데
            // 조각마다 run 의 탭 리더를 그대로 복제해, 각 조각 원점에서 같은 리더가 어긋나게 여러 번
            // 그려졌다(한양견고딕 목차 줄 점 288·180개가 한 줄에 겹침, 오른쪽 여백 밖까지). 리더는 그것을
            // 소유한 탭 글자의 조각에만 둔다 — TAC 조각 분할의 «탭을 소유한 조각에서 다시 계산» 과 같은 규칙.
            // 소유 조각 = 리더 시작 이하에서 시작하는 마지막 탭 조각(리더 시작 = 탭 시작 + 앞 여백).
            let leader_owner:Vec<Option<usize>>=run.style.tab_leaders.iter().map(|l|clusters.iter()
                .filter(|(i,c)|source.get(*i..i+c.chars().count()).is_some_and(|s|s.contains(&'\t'))
                    &&positions[*i]<=l.start_x+1e-6)
                .map(|(i,_)|*i).last()).collect();
            for (i,cluster) in &clusters {
                let count=cluster.chars().count();let end=i+count;
                let choice=if count==1 {placement(key,cluster.chars().next().unwrap(),run.style.bold,run.style.italic)}else{None};
                let mut projected=child.clone();
                projected.bbox.x+=positions[*i];projected.bbox.width=positions[end]-positions[*i];
                // [hwpx-cowork] 2022 PDF: 10pt -> Tf83 * .12pt = 9.96pt;
                // 12pt -> Tf100, Tz97 leaves vertical size unchanged. Quantize
                // source size to the observed 1/600-inch device frame once.
                let nominal=if run.style.font_size>0.0 {run.style.font_size}else{12.0};
                let source_size=(nominal/0.16).round()*0.16;
                let draw_size=run.style.script_draw_metrics(source_size,0.0).0;
                if let Some(ref p)=choice {projected.bbox.x+=p.dx*draw_size*run.style.ratio;}
                // Node IDs remain deterministic and unique within the page.
                projected.id=frame.next_id();
                if *i>0 {projected.children.clear();}
                if let RenderNodeType::TextRun(r)=&mut projected.node_type {
                    r.text=source[*i..end].iter().collect();r.display_text=Some(choice.as_ref().map_or_else(||cluster.clone(),|p|p.character.to_string()));
                    r.char_start=run.char_start.map(|s|s+i);r.is_para_end=run.is_para_end&&end==source.len();
                    r.is_line_break_end=run.is_line_break_end&&end==source.len();
                    r.layout_positions=Some(positions[*i..=end].iter().map(|x|x-positions[*i]).collect());
                    r.style.metric_font_family=None;r.style.font_metric_trusted=true;r.style.kerning=false;
                    // 리더는 소유 조각에만, 조각 원점 기준 좌표로(조각 x 이동량만큼 빼서 절대 위치 보존).
                    let shift=projected.bbox.x-child.bbox.x;
                    r.style.tab_leaders=run.style.tab_leaders.iter().zip(&leader_owner)
                        .filter(|(_,owner)|**owner==Some(*i))
                        .map(|(l,_)|{let mut l=l.clone();l.start_x-=shift;l.end_x-=shift;l}).collect();
                    r.style.tab_leader_glyph=if r.style.tab_leaders.iter().any(|l|l.fill_type==3)
                        {leader_glyph(run,key,draw_size,source_size)}else{None};
                    r.style.ascii_punct_latin=None;r.style.hft_fullwidth_dot=false;r.style.hft_hangul_face=false;
                    if let Some(p)=choice {
                        r.style.font_family=p.family.to_string();r.baseline+=p.dy*draw_size;
                        // One uniform font-level scale; width follows the same
                        // scale (no per-glyph x/y compensation or ink retarget).
                        r.style.paint_font_geometry=Some((source_size*p.scale,run.style.ratio));
                        r.style.paint_ink_bounds=None;
                    }
                }
                children.push(projected);
            }
        }
        node.children=children;
    }
    visit(&mut tree.root,&mut tree.frame);
}

/// [hwpx-cowork] 2026-11-10 점선 리더의 점 = 같은 run 의 `·`(U+00B7) 글자 대체 결정.
/// `·` 는 영문 슬롯 글자다(`style_resolver`·`stored_lines_runs` — 한/글 PDF 대조). 영문 슬롯 HFT 의
/// 대체 사슬(예: 한양견고딕 ENGGT 에 없음 → 한양중고딕 ENJGT)과 대응 TTF·전진·칸 가운데 맞춤·글꼴 단위
/// 배율/기준선을 본문 글자와 똑같이 쓴다. 근거: 실문서A 목차 한/글 2022 PDF 의 점 Type3 글리프 =
/// ENJGT U+00B7(전진 381, 잉크 149~233 × 310~392 /1000). 영문 슬롯 HFT 를 모르면 None(종전 원 근사).
fn leader_glyph(run:&super::render_tree::TextRunNode,key:&str,draw_size:f64,source_size:f64)->Option<super::LeaderGlyph> {
    let (latin,ratio)=match run.style.ascii_punct_latin.as_deref() {
        Some(l)=>(l.metric_font_family.as_deref().filter(|k|is_native(k))?,if l.ratio>0.0 {l.ratio}else{run.style.ratio}),
        None=>(Some(key).filter(|k|program(k).is_some_and(|p|p.lang==1))?,run.style.ratio),
    };
    let p=placement(latin,'\u{00B7}',run.style.bold,run.style.italic)?;
    Some(super::LeaderGlyph {family:p.family,character:p.character,cell:p.advance*draw_size*ratio,
        dx:p.dx*draw_size*ratio,dy:p.dy*draw_size,paint_size:source_size*p.scale})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapped_ttf_preserves_hft_advance_and_uses_middle_dot() {
        let key=metric_key_for_slot("한양중고딕",5).unwrap();
        let p=placement(key,'\u{2024}',false,false).unwrap();
        assert_eq!(p.character,'\u{00b7}');assert_eq!(p.advance,1.0);
        assert!(!p.family.contains("Cowork HFT"));
        let bold=placement(key,'\u{2024}',true,false).unwrap();assert!((bold.advance-1.05).abs()<1e-9);
        assert!(!uses_extracted_policy("HY중고딕"));
    }
    #[test]
    fn missing_symbol_keeps_source_fallback_spacing_without_an_outline_font() {
        for name in ["한양중고딕","한양신명조"] {
            let key=metric_key_for_slot(name,5).unwrap();
            for c in ['\u{2022}','\u{25cb}','\u{25a1}','\u{203b}','\u{2192}'] {
                let selected=placement(key,c,false,false).unwrap();
                assert_eq!(selected.advance,1.0,"{name} {c}");
                assert!(!selected.family.contains("HFT"));
            }
        }
    }
    #[test]
    fn source_upward_arrow_does_not_become_a_downward_ttf_arrow() {
        let key=metric_key_for_slot("한양중고딕",5).unwrap();
        let p=placement(key,'\u{21df}',false,false).unwrap();
        assert_eq!(p.character,'\u{21de}');assert_eq!(p.advance,1.0);
    }
    #[test]
    fn one_font_uses_one_scale_and_baseline_for_every_glyph() {
        // [hwpx-cowork] 2026-11-07 user report: per-glyph ink fitting gave each
        // character of one font a different size/position (HGGGT y-scale .857-.977).
        let key=metric_key_for_slot("한양견고딕",0).unwrap();
        let first=placement(key,'가',false,false).unwrap();
        for c in ['제','한','글','뵐','힝'] {
            let p=placement(key,c,false,false).unwrap();
            assert_eq!((p.scale,p.dy),(first.scale,first.dy),"{c}");
        }
        // Body size still follows HFT: HGGGT '제' Type3 height .880em vs
        // H2GTRE 960/1024em, so the font-level scale is about .94.
        assert!(first.scale>0.9&&first.scale<0.97,"{}",first.scale);
        // Composite Korean was absent from the old decoder, not the font.
        let smj=metric_key_for_slot("한양신명조",0).unwrap();
        assert!(placement(smj,'제',false,false).is_some());
    }
    #[test]
    fn hft_paint_geometry_preserves_model_size_and_generic_ttf_policy() {
        let mut style=super::super::TextStyle{font_size:40.0/3.0,ratio:0.97,..Default::default()};
        let ordinary=style.glyph_draw_params(style.font_size);
        // [hwpx-cowork] Independent TTF 100/97% PDF keeps Tf/vertical CTM.
        assert_eq!(ordinary,(style.font_size,0.97));
        let original_size=style.font_size;
        style.paint_font_geometry=Some((12.0,1.05));
        assert_eq!(style.glyph_draw_params(style.font_size),(12.0,1.05));
        assert_eq!(style.font_size,original_size);
        assert!((style.glyph_draw_params(style.font_size*0.7).0-8.4).abs()<1e-9);
    }
    #[test]
    fn charshape_italic_shares_normal_body_size_and_middle_dot_is_centred() {
        // [hwpx-cowork] Four-family 2022 Type3 control keeps the normal glyph
        // with Tm shear .333, so the synthesized italic shares its body size.
        let key=metric_key_for_slot("한양중고딕",1).unwrap();
        let (n,i)=(placement(key,'A',false,false).unwrap(),placement(key,'A',false,true).unwrap());
        assert_eq!((n.scale,n.dy),(i.scale,i.dy));
        let dot=placement(metric_key_for_slot("한양중고딕",5).unwrap(),'\u{2024}',false,false).unwrap();
        let ttf=data().programs.iter().find(|p|p.key==metric_key_for_slot("한양중고딕",5).unwrap()).unwrap().ttf.as_str();
        let t=super::super::hancom_fontdb::select_glyph(ttf,'\u{00b7}',false,false,5).unwrap().advance_em;
        assert!((dot.dx-(1.0-dot.scale*t)/2.0).abs()<1e-9);
        assert!(dot.dx>=-1e-9,"middle dot stays inside the 1em HFT cell");
    }
}
