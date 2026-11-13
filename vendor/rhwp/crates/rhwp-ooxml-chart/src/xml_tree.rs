//! [hwpx-cowork] 차트 XML 의 작은 요소 나무 — 차트 구성 편집(`format`)용.
//!
//! 값 편집(`patch`)은 바이트 구간만 갈아끼우지만, 차트 종류·제목·범례처럼 요소를 넣고 빼는 편집은
//! 요소 단위로 다뤄야 한다. 이 나무는 원문을 되도록 그대로 되쓴다:
//! - 글·참조·주석·CDATA·처리 지시는 원문 바이트(`Raw`) 그대로,
//! - 요소 이름·속성 이름·속성값(이스케이프된 원문)·속성 차례 그대로,
//! - 자식이 없는 요소는 `<x/>`(한/글 저장본의 꼴).
//!
//! 그래서 손대지 않은 요소는 한/글 저장본과 바이트가 같다(시험 `round_trip_is_identity`).

use quick_xml::events::Event;
use quick_xml::Reader;

#[derive(Debug, Clone, PartialEq)]
pub struct El {
    /// 접두어 포함 이름(`c:ser`).
    pub name: String,
    /// (이름, 이스케이프된 원문 값) — 차례 보존.
    pub attrs: Vec<(String, String)>,
    pub kids: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    El(El),
    /// 원문 그대로의 글·참조·주석·CDATA·처리 지시.
    Raw(String),
}

/// 원문 문서 — 뿌리 앞(선언 등)과 뒤의 원문, 뿌리 요소.
#[derive(Debug, Clone, PartialEq)]
pub struct XmlDoc {
    pub prolog: String,
    pub root: El,
    pub epilog: String,
}

pub fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 원문 글을 사람이 읽는 글로(기본 개체·숫자 참조만).
pub fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        match tail.find(';') {
            Some(j) => {
                let ent = &tail[1..j];
                let ch = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                        u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                    }
                    _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                    _ => None,
                };
                match ch {
                    Some(c) => out.push(c),
                    None => out.push_str(&tail[..=j]),
                }
                rest = &tail[j + 1..];
            }
            None => {
                out.push_str(tail);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

impl El {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), attrs: Vec::new(), kids: Vec::new() }
    }

    /// `<name val="v"/>` 꼴.
    pub fn val(name: impl Into<String>, v: impl Into<String>) -> Self {
        let mut e = Self::new(name);
        e.attrs.push(("val".to_string(), v.into()));
        e
    }

    pub fn with(mut self, kid: El) -> Self {
        self.kids.push(Node::El(kid));
        self
    }

    pub fn with_attr(mut self, k: &str, v: &str) -> Self {
        self.attrs.push((k.to_string(), v.to_string()));
        self
    }

    pub fn with_text(mut self, raw: &str) -> Self {
        self.kids.push(Node::Raw(escape_text(raw)));
        self
    }

    pub fn local(&self) -> &str {
        local_of(&self.name)
    }

    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    pub fn set_attr(&mut self, k: &str, v: &str) {
        if let Some(a) = self.attrs.iter_mut().find(|(n, _)| n == k) {
            a.1 = v.to_string();
        } else {
            self.attrs.push((k.to_string(), v.to_string()));
        }
    }

    pub fn elems(&self) -> impl Iterator<Item = &El> {
        self.kids.iter().filter_map(|n| match n {
            Node::El(e) => Some(e),
            _ => None,
        })
    }

    pub fn elems_mut(&mut self) -> impl Iterator<Item = &mut El> {
        self.kids.iter_mut().filter_map(|n| match n {
            Node::El(e) => Some(e),
            _ => None,
        })
    }

    pub fn child(&self, local: &str) -> Option<&El> {
        self.elems().find(|e| e.local() == local)
    }

    pub fn child_mut(&mut self, local: &str) -> Option<&mut El> {
        self.elems_mut().find(|e| e.local() == local)
    }

    pub fn children<'a>(&'a self, local: &'a str) -> impl Iterator<Item = &'a El> + 'a {
        self.elems().filter(move |e| e.local() == local)
    }

    /// `val` 속성 값.
    pub fn child_val(&self, local: &str) -> Option<&str> {
        self.child(local).and_then(|e| e.attr("val"))
    }

    pub fn remove_all(&mut self, local: &str) -> usize {
        let before = self.kids.len();
        self.kids.retain(|n| !matches!(n, Node::El(e) if e.local() == local));
        before - self.kids.len()
    }

    /// 요소 안의 모든 글(원문을 풀어서) — `a:t` 이어 붙이기 등에 쓴다.
    pub fn text(&self) -> String {
        let mut s = String::new();
        for n in &self.kids {
            match n {
                Node::Raw(r) if !r.starts_with("<") => s.push_str(&unescape_text(r)),
                Node::El(e) => s.push_str(&e.text()),
                _ => {}
            }
        }
        s
    }

    /// 자손 중 이름(local)이 맞는 첫 요소(깊이 우선).
    pub fn find(&self, local: &str) -> Option<&El> {
        for e in self.elems() {
            if e.local() == local {
                return Some(e);
            }
            if let Some(f) = e.find(local) {
                return Some(f);
            }
        }
        None
    }

    /// `order`(local 이름 차례)에 맞춰 `kid` 를 넣는다 — `kid` 보다 뒤 차례의 첫 자식 앞.
    /// 같은 이름이 있으면 그 마지막 뒤. `order` 에 없는 이름은 맨 뒤.
    pub fn insert_ordered(&mut self, kid: El, order: &[&str]) {
        let rank = |l: &str| order.iter().position(|o| *o == l);
        let my = rank(kid.local());
        let mut at = self.kids.len();
        if let Some(my) = my {
            for (i, n) in self.kids.iter().enumerate() {
                if let Node::El(e) = n {
                    if let Some(r) = rank(e.local()) {
                        if r > my {
                            at = i;
                            break;
                        }
                    }
                }
            }
        }
        self.kids.insert(at, Node::El(kid));
    }

    /// 있으면 바꾸고 없으면 차례대로 넣는다.
    pub fn put_ordered(&mut self, kid: El, order: &[&str]) {
        let l = kid.local().to_string();
        if let Some(pos) = self.kids.iter().position(|n| matches!(n, Node::El(e) if e.local() == l)) {
            self.kids[pos] = Node::El(kid);
        } else {
            self.insert_ordered(kid, order);
        }
    }

    pub fn write(&self, out: &mut String) {
        out.push('<');
        out.push_str(&self.name);
        for (k, v) in &self.attrs {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            out.push_str(v);
            out.push('"');
        }
        if self.kids.is_empty() {
            out.push_str("/>");
            return;
        }
        out.push('>');
        for n in &self.kids {
            match n {
                Node::El(e) => e.write(out),
                Node::Raw(r) => out.push_str(r),
            }
        }
        out.push_str("</");
        out.push_str(&self.name);
        out.push('>');
    }
}

pub fn local_of(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

impl XmlDoc {
    pub fn parse(xml: &[u8]) -> Result<Self, String> {
        let text = std::str::from_utf8(xml).map_err(|e| format!("UTF-8 이 아닙니다: {e}"))?;
        let mut reader = Reader::from_str(text);
        reader.config_mut().trim_text(false);
        let mut stack: Vec<El> = Vec::new();
        let mut prolog: Option<String> = None;
        let mut root: Option<El> = None;
        let mut epilog = String::new();
        loop {
            let before = reader.buffer_position() as usize;
            let ev = reader.read_event().map_err(|e| format!("XML 을 읽지 못했습니다: {e}"))?;
            let after = reader.buffer_position() as usize;
            let raw = &text[before..after.min(text.len())];
            match ev {
                Event::Start(e) | Event::Empty(e) => {
                    let is_empty = raw.ends_with("/>");
                    let name = e.name().as_ref().to_string();
                    let mut attrs = Vec::new();
                    for a in e.attributes().with_checks(false) {
                        let a = a.map_err(|e| format!("속성을 읽지 못했습니다: {e}"))?;
                        attrs.push((
                            a.key.as_ref().to_string(),
                            a.value.to_string(),
                        ));
                    }
                    if prolog.is_none() {
                        prolog = Some(text[..before].to_string());
                    }
                    let el = El { name, attrs, kids: Vec::new() };
                    if is_empty {
                        match stack.last_mut() {
                            Some(p) => p.kids.push(Node::El(el)),
                            None => root = Some(el),
                        }
                    } else {
                        stack.push(el);
                    }
                }
                Event::End(_) => {
                    let el = stack.pop().ok_or("닫는 요소가 남습니다")?;
                    match stack.last_mut() {
                        Some(p) => p.kids.push(Node::El(el)),
                        None => root = Some(el),
                    }
                }
                Event::Eof => break,
                _ => match stack.last_mut() {
                    Some(p) => p.kids.push(Node::Raw(raw.to_string())),
                    None => {
                        if root.is_some() {
                            epilog.push_str(raw);
                        }
                    }
                },
            }
        }
        if !stack.is_empty() {
            return Err("닫히지 않은 요소가 있습니다".to_string());
        }
        let root = root.ok_or("뿌리 요소가 없습니다")?;
        Ok(Self { prolog: prolog.unwrap_or_default(), root, epilog })
    }

    pub fn to_string(&self) -> String {
        let mut s = self.prolog.clone();
        self.root.write(&mut s);
        s.push_str(&self.epilog);
        s
    }
}
