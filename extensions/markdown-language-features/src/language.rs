//! Markdown-specific semantics. Syntax folds, outline and selection reuse the editor's
//! shared Tree-sitter providers. Requests borrow versioned snapshots; dirty documents
//! precede authorized filesystem reads and edits are returned to the client's transaction.
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::ops::Deref;
use std::ops::DerefMut;
use std::ops::Range;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::RwLock;

use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::Client;
use external_ext_sdk::client::DocumentSnapshot;
use external_ext_sdk::languages::Operation;
use external_ext_sdk::languages::Position;
use globset::Glob;
use pulldown_cmark::Event;
use pulldown_cmark::LinkType;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use pulldown_cmark::TagEnd;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use url::Url;

use crate::invalid;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default)]
    resource: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    version: u32,
    position: Option<Position>,
    kind: Option<String>,
    new_name: Option<String>,
    #[serde(default)]
    include_declaration: bool,
    #[serde(default)]
    query: String,
    #[serde(default)]
    only: Vec<String>,
    range: Option<external_ext_sdk::languages::Range>,
}

struct Heading {
    title: String,
    slug: String,
    range: Range<usize>,
    content: Range<usize>,
}

struct Link {
    destination: String,
    range: Range<usize>,
    destination_range: Range<usize>,
    reference: Option<String>,
}

struct Definition {
    id: String,
    label: Range<usize>,
    range: Range<usize>,
    destination: String,
}

struct Document {
    snapshot: DocumentSnapshot,
    headings: Vec<Heading>,
    links: Vec<Link>,
    definitions: Vec<Definition>,
    index: SourceIndex,
    heading_ids: BTreeMap<String, usize>,
}

/// Shared with preview and rename so collisions use the same document-order IDs.
#[derive(Default)]
pub(crate) struct HeadingIds {
    next: BTreeMap<String, usize>,
}

impl HeadingIds {
    pub(crate) fn insert(&mut self, title: &str) -> String {
        let base = slug(title);
        let mut number = self.next.get(&base).copied().unwrap_or(0);
        let mut candidate = if number == 0 {
            base.clone()
        } else {
            format!("{base}-{number}")
        };
        while self.next.contains_key(&candidate) {
            number += 1;
            candidate = format!("{base}-{number}");
        }
        self.next.insert(base, number + 1);
        self.next.insert(candidate.clone(), 1);
        candidate
    }
}

/// Only derived analysis is retained. Every lookup requires a caller-supplied
/// snapshot, including its text, so equal URI/version values from different
/// clients or reopened models cannot reuse another snapshot's analysis.
#[derive(Default)]
struct AnalysisCache {
    entries: VecDeque<(Arc<Document>, usize)>,
    bytes: usize,
}

impl AnalysisCache {
    const MAX_ENTRIES: usize = 16;
    const MAX_BYTES: usize = 32 * 1024 * 1024;

    fn get(&mut self, snapshot: &DocumentSnapshot) -> Option<Arc<Document>> {
        let index = self.entries.iter().position(|(document, _)| {
            document.snapshot.uri == snapshot.uri
                && document.snapshot.version == snapshot.version
                && document.snapshot.text == snapshot.text
        })?;
        let entry = self.entries.remove(index)?;
        let document = Arc::clone(&entry.0);
        self.entries.push_back(entry);
        Some(document)
    }

    fn remove(&mut self, uri: &str) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|(document, _)| document.snapshot.uri == uri)
        {
            self.bytes -= self.entries.remove(index).unwrap().1;
        }
    }

    fn insert(&mut self, document: Arc<Document>) {
        if self.entries.iter().any(|(previous, _)| {
            previous.snapshot.uri == document.snapshot.uri
                && previous.snapshot.version > document.snapshot.version
        }) {
            return;
        }
        self.remove(&document.snapshot.uri);
        let bytes = document.retained_bytes();
        if bytes > Self::MAX_BYTES {
            return;
        }
        while self.entries.len() >= Self::MAX_ENTRIES || self.bytes + bytes > Self::MAX_BYTES {
            self.bytes -= self.entries.pop_front().unwrap().1;
        }
        self.bytes += bytes;
        self.entries.push_back((document, bytes));
    }
}

/// Observed open documents retain only derived link targets, never editor state.
/// Oversized dependency sets fall back to checking that source on any change.
#[derive(Default)]
struct DependencyIndex {
    sources: BTreeMap<String, Option<BTreeSet<String>>>,
    bytes: usize,
    edges: usize,
}

impl DependencyIndex {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    const MAX_EDGES: usize = 65536;

    fn remove(&mut self, uri: &str) {
        if let Some(Some(targets)) = self.sources.remove(uri) {
            self.edges -= targets.len();
            self.bytes -= targets.iter().map(|target| target.len()).sum::<usize>();
        }
    }

    fn update(&mut self, uri: String, targets: Option<BTreeSet<String>>) {
        self.remove(&uri);
        let targets = targets.filter(|targets| {
            self.edges + targets.len() <= Self::MAX_EDGES
                && self.bytes + targets.iter().map(|target| target.len()).sum::<usize>()
                    <= Self::MAX_BYTES
        });
        if let Some(targets) = &targets {
            self.edges += targets.len();
            self.bytes += targets.iter().map(|target| target.len()).sum::<usize>();
        }
        self.sources.insert(uri, targets);
    }

    fn affected(&self, uri: &str) -> BTreeSet<String> {
        self.sources
            .iter()
            .filter(|(source, targets)| {
                source.as_str() == uri
                    || targets.as_ref().is_none_or(|targets| targets.contains(uri))
            })
            .map(|(source, _)| source.clone())
            .collect()
    }
}

/// Sparse UTF-16 checkpoints bound coordinate conversion work even on long lines.
struct SourceIndex {
    lines: Vec<(usize, u32)>,
    points: Vec<(usize, u32)>,
}

impl SourceIndex {
    fn new(text: &str) -> Self {
        let mut index = Self {
            lines: vec![(0, 0)],
            points: vec![(0, 0)],
        };
        let mut units = 0;
        for (byte, character) in text.char_indices() {
            if byte - index.points.last().unwrap().0 >= 256 {
                index.points.push((byte, units));
            }
            units += character.len_utf16() as u32;
            if character == '\n' {
                index.lines.push((byte + 1, units));
            }
        }
        index.points.push((text.len(), units));
        index
    }

    fn position(&self, text: &str, offset: usize) -> Value {
        let line = self.lines.partition_point(|point| point.0 <= offset) - 1;
        let point = self.points[self.points.partition_point(|point| point.0 <= offset) - 1];
        let column =
            point.1 + text[point.0..offset].encode_utf16().count() as u32 - self.lines[line].1;
        json!({"lineIndex":line,"columnIndex":column})
    }

    fn offset(&self, text: &str, position: Position) -> Result<usize, ExtensionError> {
        let &(start, units) = self
            .lines
            .get(position.line as usize)
            .ok_or_else(|| invalid("Markdown position is outside the snapshot"))?;
        let target = units
            .checked_add(position.character)
            .ok_or_else(|| invalid("Markdown position is outside the snapshot"))?;
        let limit = self
            .lines
            .get(position.line as usize + 1)
            .map_or_else(|| self.points.last().unwrap().1, |line| line.1 - 1);
        if target > limit {
            return Err(invalid("Markdown position is outside the snapshot"));
        }
        let point = self.points[self
            .points
            .partition_point(|point| point.1 <= target)
            .saturating_sub(1)];
        let mut units = point.1;
        for (offset, character) in text[point.0..].char_indices() {
            if units == target && point.0 + offset >= start {
                return Ok(point.0 + offset);
            }
            if units > target || character == '\n' && point.0 + offset >= start {
                break;
            }
            units += character.len_utf16() as u32;
        }
        if units == target && self.lines.last().is_some_and(|line| line.0 == start) {
            return Ok(text.len());
        }
        Err(invalid("Markdown position is outside the snapshot"))
    }
}

/// Request-local snapshots and references to cached analysis. The client remains
/// the document owner; cached entries cannot authorize a target document read.
#[derive(Default)]
struct Documents {
    snapshots: BTreeMap<String, DocumentSnapshot>,
    parsed: BTreeMap<String, Arc<Document>>,
    open: BTreeSet<String>,
}

impl Deref for Documents {
    type Target = BTreeMap<String, DocumentSnapshot>;
    fn deref(&self) -> &Self::Target {
        &self.snapshots
    }
}

impl DerefMut for Documents {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.snapshots
    }
}

impl Document {
    fn parse(
        snapshot: DocumentSnapshot,
        token: &CancellationToken,
    ) -> Result<Self, ExtensionError> {
        token.check_cancelled()?;
        if snapshot.text.len() > 16 * 1024 * 1024 {
            return Err(invalid("Markdown source exceeds its limit"));
        }
        let mut headings = Vec::new();
        let mut links = Vec::new();
        let mut definitions = Vec::new();
        let mut heading: Option<(Range<usize>, String)> = None;
        let mut occupied = Vec::new();
        let mut slugs = HeadingIds::default();
        // Keep unresolved reference links in the semantic tree so diagnostics and
        // completion work before their definition has been written.
        let mut broken = |link: pulldown_cmark::BrokenLink<'_>| {
            Some(("".into(), link.reference.to_string().into()))
        };
        let parser = Parser::new_with_broken_link_callback(
            &snapshot.text,
            Options::ENABLE_TABLES
                | Options::ENABLE_STRIKETHROUGH
                | Options::ENABLE_TASKLISTS
                | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
                | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS
                | Options::ENABLE_MATH,
            Some(&mut broken),
        );
        for (id, definition) in parser.reference_definitions().iter() {
            let span = definition.span.clone();
            definitions.push(Definition::new(
                id,
                span,
                definition.dest.to_string(),
                &snapshot.text,
            )?);
        }
        for (event, span) in parser.into_offset_iter() {
            token.check_cancelled()?;
            occupied.push(span.clone());
            match event {
                Event::Start(Tag::Heading { .. }) => heading = Some((span, String::new())),
                Event::Text(text) | Event::Code(text) | Event::InlineMath(text) => {
                    if let Some((_, title)) = &mut heading {
                        title.push_str(&text);
                    }
                }
                Event::End(TagEnd::Heading(_)) => {
                    if let Some((span, title)) = heading.take() {
                        let unique = slugs.insert(&title);
                        let raw = snapshot.text[span.clone()].trim_end_matches(['\r', '\n']);
                        let trimmed = raw.trim_start_matches('\u{feff}');
                        let start = span.start + raw.len() - trimmed.len();
                        let first = trimmed.lines().next().unwrap_or("");
                        let content_start =
                            first.len() - first.trim_start_matches('#').trim_start().len();
                        let content_end = if first.starts_with('#') {
                            let without_hashes = first.trim_end().trim_end_matches('#');
                            if without_hashes.ends_with(char::is_whitespace) {
                                without_hashes.trim_end().len()
                            } else {
                                first.trim_end().len()
                            }
                        } else {
                            first.trim_end().len()
                        };
                        headings.push(Heading {
                            title,
                            slug: unique,
                            content: start + content_start..start + content_end.max(content_start),
                            range: span.start..span.start + raw.len(),
                        });
                    }
                }
                Event::Start(Tag::Link {
                    dest_url,
                    link_type,
                    id,
                    ..
                })
                | Event::Start(Tag::Image {
                    dest_url,
                    link_type,
                    id,
                    ..
                }) => {
                    let span =
                        if matches!(link_type, LinkType::Collapsed | LinkType::CollapsedUnknown)
                            && snapshot.text[span.end..].starts_with("[]")
                        {
                            span.start..span.end + 2
                        } else {
                            span
                        };
                    let reference = matches!(
                        link_type,
                        LinkType::Reference
                            | LinkType::Collapsed
                            | LinkType::Shortcut
                            | LinkType::ReferenceUnknown
                            | LinkType::CollapsedUnknown
                            | LinkType::ShortcutUnknown
                    )
                    .then(|| id.to_lowercase());
                    let raw = &snapshot.text[span.clone()];
                    let source_range = link_range(raw, link_type);
                    links.push(Link {
                        destination: dest_url.into_string(),
                        range: span.clone(),
                        destination_range: span.start + source_range.start
                            ..span.start + source_range.end,
                        reference,
                    });
                }
                _ => {}
            }
        }
        // The parser resolves the first definition for a label. Recover subsequent
        // definitions from otherwise unoccupied source, never from code or HTML.
        occupied.sort_by_key(|range| range.start);
        let mut covered: Vec<Range<usize>> = Vec::new();
        for span in occupied {
            if let Some(last) = covered.last_mut().filter(|last| last.end >= span.start) {
                last.end = last.end.max(span.end);
            } else {
                covered.push(span);
            }
        }
        let mut offset = 0;
        for line in snapshot.text.split_inclusive('\n') {
            let trimmed = line.trim_start_matches(' ');
            let start = offset + line.len() - trimmed.len();
            if line.len() - trimmed.len() <= 3
                && trimmed.starts_with('[')
                && !covered
                    .get(
                        covered
                            .partition_point(|span| span.start <= start)
                            .wrapping_sub(1),
                    )
                    .is_some_and(|span| start < span.end)
                && !definitions
                    .iter()
                    .any(|definition| definition.range.start == start)
            {
                for (id, definition) in Parser::new(trimmed).reference_definitions().iter() {
                    let span = definition.span.clone();
                    definitions.push(Definition::new(
                        id,
                        start + span.start..start + span.end,
                        definition.dest.to_string(),
                        &snapshot.text,
                    )?);
                }
            }
            offset += line.len();
        }
        definitions.sort_by_key(|definition| definition.range.start);
        // A definition's destination is a file/heading link; its label is a
        // separate rename target. Reference uses must never edit that destination.
        for definition in &definitions {
            let raw = &snapshot.text[definition.label.end + 2..definition.range.end];
            let span = destination_range(raw);
            let start = definition.label.end + 2;
            links.push(Link {
                destination: definition.destination.clone(),
                range: start + span.start..start + span.end,
                destination_range: start + span.start..start + span.end,
                reference: None,
            });
        }
        let index = SourceIndex::new(&snapshot.text);
        let heading_ids = headings
            .iter()
            .enumerate()
            .map(|(index, heading)| (heading.slug.clone(), index))
            .collect();
        Ok(Self {
            snapshot,
            headings,
            links,
            definitions,
            index,
            heading_ids,
        })
    }

    fn range(&self, range: Range<usize>) -> Value {
        json!({"start":self.index.position(&self.snapshot.text,range.start),"end":self.index.position(&self.snapshot.text,range.end)})
    }

    fn retained_bytes(&self) -> usize {
        self.snapshot.text.capacity()
            + self.snapshot.uri.capacity()
            + self.headings.capacity() * std::mem::size_of::<Heading>()
            + self
                .headings
                .iter()
                .map(|heading| heading.title.capacity() + heading.slug.capacity())
                .sum::<usize>()
            + self.links.capacity() * std::mem::size_of::<Link>()
            + self
                .links
                .iter()
                .map(|link| {
                    link.destination.capacity()
                        + link.reference.as_ref().map_or(0, String::capacity)
                })
                .sum::<usize>()
            + self.definitions.capacity() * std::mem::size_of::<Definition>()
            + self
                .definitions
                .iter()
                .map(|definition| definition.id.capacity() + definition.destination.capacity())
                .sum::<usize>()
            + (self.index.lines.capacity() + self.index.points.capacity())
                * std::mem::size_of::<(usize, u32)>()
            + self
                .heading_ids
                .keys()
                .map(|key| key.capacity() + 64)
                .sum::<usize>()
    }

    /// Reparse the edited heading content to account for Markdown formatting and
    /// every later heading whose collision suffix changes with the rename.
    fn renamed_heading_ids(
        &self,
        heading: &Heading,
        name: &str,
        token: &CancellationToken,
    ) -> Result<BTreeMap<String, String>, ExtensionError> {
        let mut snapshot = self.snapshot.clone();
        snapshot.text.replace_range(heading.content.clone(), name);
        let renamed = Self::parse(snapshot, token)?;
        if renamed.headings.len() != self.headings.len() {
            return Err(invalid(
                "Markdown rename must preserve the heading structure",
            ));
        }
        Ok(self
            .headings
            .iter()
            .zip(&renamed.headings)
            .filter(|(before, after)| before.slug != after.slug)
            .map(|(before, after)| (before.slug.clone(), after.slug.clone()))
            .collect())
    }

    fn offset(&self, position: Position) -> Result<usize, ExtensionError> {
        self.index.offset(&self.snapshot.text, position)
    }

    fn heading(&self, fragment: &str) -> Option<&Heading> {
        self.heading_ids
            .get(&fragment.to_lowercase())
            .map(|index| &self.headings[*index])
    }
}

impl Definition {
    fn new(
        id: &str,
        range: Range<usize>,
        destination: String,
        source: &str,
    ) -> Result<Self, ExtensionError> {
        let raw = &source[range.clone()];
        let mut escaped = false;
        let end = raw
            .char_indices()
            .skip(1)
            .find_map(|(offset, character)| {
                if escaped {
                    escaped = false;
                    return None;
                }
                if character == '\\' {
                    escaped = true;
                    return None;
                }
                (character == ']').then_some(offset)
            })
            .ok_or_else(|| invalid("Invalid Markdown reference definition"))?;
        Ok(Self {
            id: id.to_lowercase(),
            label: range.start + 1..range.start + end,
            range,
            destination,
        })
    }
}

#[cfg(test)]
#[path = "language_tests.rs"]
mod tests;

pub(crate) fn slug(text: &str) -> String {
    static PUNCTUATION: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}\p{M}_\-\s]").unwrap());
    PUNCTUATION
        .replace_all(&text.trim().to_lowercase(), "")
        .chars()
        .map(|character| {
            if character.is_whitespace() {
                '-'
            } else {
                character
            }
        })
        .collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                result.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        result.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

/// pulldown-cmark returns decoded destinations. Edits must address the original
/// spelling, including angle brackets, escaped parentheses and reference labels.
fn link_range(raw: &str, kind: LinkType) -> Range<usize> {
    match kind {
        LinkType::Reference
        | LinkType::ReferenceUnknown
        | LinkType::Collapsed
        | LinkType::CollapsedUnknown
        | LinkType::Shortcut
        | LinkType::ShortcutUnknown => {
            let mut depth = 0usize;
            let mut escaped = false;
            let mut start = 0;
            let mut label = 0..0;
            for (offset, character) in raw.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if character == '\\' {
                    escaped = true;
                    continue;
                }
                if character == '[' {
                    if depth == 0 {
                        start = offset + 1;
                    }
                    depth += 1;
                } else if character == ']' && depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        label = start..offset;
                    }
                }
            }
            label
        }
        LinkType::Autolink | LinkType::Email => 1..raw.len().saturating_sub(1),
        LinkType::Inline => {
            let start = inline_delimiter(raw).map_or(0, |offset| offset + 2);
            let range = destination_range(&raw[start..]);
            start + range.start..start + range.end
        }
        LinkType::WikiLink { .. } => 0..raw.len(),
    }
}

fn inline_delimiter(raw: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut escaped = false;
    for (offset, character) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '[' {
            depth += 1;
        }
        if character == ']' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return raw[offset..].starts_with("](").then_some(offset);
            }
        }
    }
    None
}

fn destination_range(raw: &str) -> Range<usize> {
    let start = raw.len() - raw.trim_start().len();
    let angle = raw[start..].starts_with('<');
    let start = start + usize::from(angle);
    let mut depth = 0;
    let mut escaped = false;
    for (offset, character) in raw[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if angle {
            if character == '>' {
                return start..start + offset;
            }
        } else {
            if character == '(' {
                depth += 1;
            }
            if character == ')' {
                if depth == 0 {
                    return start..start + offset;
                }
                depth -= 1;
            }
            if character.is_whitespace() && depth == 0 {
                return start..start + offset;
            }
        }
    }
    start..raw.len()
}

fn matches_glob(pattern: &str, value: &str) -> bool {
    Glob::new(pattern).is_ok_and(|glob| glob.compile_matcher().is_match(value))
}

fn severity<'a>(configuration: &'a Value, path: &str, default: &'a str) -> &'a str {
    configuration
        .pointer(path)
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "ignore" | "hint" | "warning" | "error"))
        .unwrap_or(default)
}

fn target(
    resource: &str,
    destination: &str,
    folders: &[String],
) -> Option<(String, Option<String>)> {
    let base = Url::parse(resource).ok()?;
    let mut uri = if destination.starts_with('/') && !destination.starts_with("//") {
        // Markdown's leading slash refers to the containing workspace, including
        // nested multi-root folders. Without one, use the document's directory.
        let root = folders
            .iter()
            .filter_map(|folder| Url::parse(&(folder.trim_end_matches('/').to_owned() + "/")).ok())
            .filter(|folder| base.as_str().starts_with(folder.as_str()))
            .max_by_key(|folder| folder.as_str().len())
            .or_else(|| base.join("./").ok())?;
        root.join(destination.trim_start_matches('/')).ok()?
    } else {
        base.join(destination).ok()?
    };
    if matches!(
        uri.scheme(),
        "http" | "https" | "mailto" | "javascript" | "data" | "command"
    ) {
        return None;
    }
    let fragment = uri.fragment().map(decode);
    uri.set_fragment(None);
    Some((uri.into(), fragment))
}

fn markdown_alias(uri: &str) -> Option<String> {
    let mut candidate = Url::parse(uri).ok()?;
    let path = candidate.path();
    let stem = if let Some(stem) = path.strip_suffix(".html") {
        stem
    } else if path
        .rsplit('/')
        .next()
        .is_some_and(|name| !name.contains('.'))
    {
        path
    } else {
        return None;
    };
    candidate.set_path(&format!("{stem}.md"));
    Some(candidate.into())
}

struct Runtime {
    client: Client,
    folders: RwLock<Vec<String>>,
    messages: Value,
    analysis: Mutex<AnalysisCache>,
    observations: Mutex<Option<DependencyIndex>>,
}

impl Runtime {
    fn target(
        &self,
        resource: &str,
        destination: &str,
    ) -> Result<Option<(String, Option<String>)>, ExtensionError> {
        let folders = self
            .folders
            .read()
            .map_err(|_| invalid("Markdown workspace unavailable"))?;
        Ok(target(resource, destination, &folders))
    }

    fn dependencies(
        &self,
        document: &Document,
        token: &CancellationToken,
    ) -> Result<Option<BTreeSet<String>>, ExtensionError> {
        let mut targets = BTreeSet::new();
        let mut bytes = 0;
        for link in &document.links {
            token.check_cancelled()?;
            if let Some((uri, _)) = self.target(&document.snapshot.uri, &link.destination)? {
                // Track both spellings without filesystem calls. Creating or
                // closing an extensionless/.html target can change its resolution.
                for uri in std::iter::once(uri.clone()).chain(markdown_alias(&uri)) {
                    if targets.insert(uri.clone()) {
                        bytes += uri.len();
                    }
                    if targets.len() > DependencyIndex::MAX_EDGES
                        || bytes > DependencyIndex::MAX_BYTES
                    {
                        return Ok(None);
                    }
                }
            }
        }
        Ok(Some(targets))
    }

    fn parse(
        &self,
        snapshot: DocumentSnapshot,
        token: &CancellationToken,
    ) -> Result<Arc<Document>, ExtensionError> {
        token.check_cancelled()?;
        if let Some(document) = self
            .analysis
            .lock()
            .map_err(|_| invalid("Markdown analysis unavailable"))?
            .get(&snapshot)
        {
            return Ok(document);
        }
        let document = Arc::new(Document::parse(snapshot, token)?);
        token.check_cancelled()?;
        self.analysis
            .lock()
            .map_err(|_| invalid("Markdown analysis unavailable"))?
            .insert(Arc::clone(&document));
        Ok(document)
    }
    fn message(&self, key: &str, value: &str) -> String {
        self.messages[key]
            .as_str()
            .unwrap_or(key)
            .replace("{0}", value)
    }

    fn publish_diagnostics(
        &self,
        event: Option<external_ext_sdk::languages::DocumentEvent>,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        if let Some(event) = &event {
            let (external_ext_sdk::languages::DocumentEvent::Open { document }
            | external_ext_sdk::languages::DocumentEvent::Change { document }
            | external_ext_sdk::languages::DocumentEvent::Close { document }) = event;
            if document.language_id != "markdown" {
                return Ok(());
            }
        }
        // Serialize observations, but never hold the analysis cache lock during
        // parsing or client calls. The input loop continues to deliver cancellation.
        let mut observations = self
            .observations
            .lock()
            .map_err(|_| invalid("Markdown observations unavailable"))?;
        let refresh = observations.is_none() || event.is_none();
        // Invalidate before any cancellable client request. A failed refresh or
        // skipped document event must not leave an older graph eligible for reuse.
        let mut index = observations.take().unwrap_or_default();
        token.check_cancelled()?;
        let mut documents = if refresh {
            self.documents(token)?
        } else {
            Documents::default()
        };
        let (changed, closed) = match event {
            Some(
                external_ext_sdk::languages::DocumentEvent::Open { document }
                | external_ext_sdk::languages::DocumentEvent::Change { document },
            ) => {
                let uri = document.uri.clone();
                documents.insert(uri.clone(), document);
                (Some(uri), false)
            }
            Some(external_ext_sdk::languages::DocumentEvent::Close { document }) => {
                documents.remove(&document.uri);
                self.analysis
                    .lock()
                    .map_err(|_| invalid("Markdown analysis unavailable"))?
                    .remove(&document.uri);
                (Some(document.uri), true)
            }
            None => (None, false),
        };
        let mut affected = if refresh {
            index = DependencyIndex::default();
            documents.keys().cloned().collect::<BTreeSet<_>>()
        } else {
            index.affected(changed.as_deref().unwrap_or(""))
        };
        if let Some(changed) = &changed {
            if closed {
                affected.remove(changed);
                index.remove(changed);
            } else {
                affected.insert(changed.clone());
            }
        }
        documents.open = index
            .sources
            .keys()
            .cloned()
            .chain(documents.keys().cloned())
            .collect();
        if closed {
            documents.open.remove(changed.as_deref().unwrap_or(""));
        }
        let mut entries = Vec::new();
        let result = (|| {
            for uri in affected {
                token.check_cancelled()?;
                let document = self.analyze(&uri, &mut documents, token)?;
                index.update(uri, self.dependencies(&document, token)?);
                if index.sources.len() > 8192 {
                    return Err(invalid("Markdown observations exceed their document limit"));
                }
                let configuration = self.client.get_configuration(
                    "markdown",
                    Some(document.snapshot.uri.clone()),
                    token,
                )?;
                let diagnostics =
                    self.diagnostics(&document, &configuration, &mut documents, token)?;
                let diagnostics = diagnostics.into_iter().map(|diagnostic| {
                let start = &diagnostic["range"]["start"];
                let end = &diagnostic["range"]["end"];
                json!({"start":{"line":start["lineIndex"],"character":start["columnIndex"]},"end":{"line":end["lineIndex"],"character":end["columnIndex"]},"message":diagnostic["message"],"severity":diagnostic["severity"],"code":diagnostic["code"],"source":"markdown"})
            }).collect::<Vec<_>>();
                entries.push(serde_json::from_value(json!({"uri":document.snapshot.uri,"version":document.snapshot.version,"diagnostics":diagnostics})).map_err(|_| invalid("Invalid Markdown diagnostic"))?);
            }
            if closed {
                entries.push(
                    serde_json::from_value(json!({"uri":changed,"version":null,"diagnostics":[]}))
                        .map_err(|_| invalid("Invalid closed Markdown document"))?,
                );
            }
            if changed.is_some() && !refresh {
                self.client
                    .update_diagnostics("markdown".into(), entries, token)
            } else {
                self.client
                    .set_diagnostics("markdown".into(), entries, token)
            }
        })();
        // An interrupted refresh must be rebuilt from the client's current open
        // snapshots; a partial dependency graph cannot safely skip future work.
        if result.is_ok() {
            *observations = Some(index);
        }
        result
    }

    fn documents(&self, token: &CancellationToken) -> Result<Documents, ExtensionError> {
        Ok(Documents {
            snapshots: self
                .client
                .text_documents(token)?
                .into_iter()
                .filter(|document| document.language_id == "markdown")
                .map(|document| (document.uri.clone(), document))
                .collect(),
            parsed: BTreeMap::new(),
            open: BTreeSet::new(),
        })
    }

    fn read(
        &self,
        uri: &str,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<DocumentSnapshot, ExtensionError> {
        if let Some(document) = documents.get(uri) {
            return Ok(document.clone());
        }
        let document = self.client.open_text_document(uri, token)?;
        documents.insert(uri.into(), document.clone());
        Ok(document)
    }

    fn analyze(
        &self,
        uri: &str,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<Arc<Document>, ExtensionError> {
        if let Some(document) = documents.parsed.get(uri) {
            return Ok(Arc::clone(document));
        }
        let document = self.parse(self.read(uri, documents, token)?, token)?;
        documents.parsed.insert(uri.into(), Arc::clone(&document));
        Ok(document)
    }

    fn exists(
        &self,
        uri: &str,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        if documents.contains_key(uri) {
            return Ok(true);
        }
        if documents.open.contains(uri) {
            return match self.read(uri, documents, token) {
                Ok(_) => Ok(true),
                Err(error) if error.code == external_ext_sdk::HostErrorCode::InvalidRequest => {
                    Ok(false)
                }
                Err(error) => Err(error),
            };
        }
        match self.client.stat_resource(uri, token) {
            Ok(_) => Ok(true),
            Err(error) if error.code == external_ext_sdk::HostErrorCode::InvalidRequest => {
                // A dirty Markdown buffer can exist before its file does. Ask
                // the document owner then; ordinary file links need no full read.
                if is_markdown(uri) {
                    return match self.read(uri, documents, token) {
                        Ok(_) => Ok(true),
                        Err(error)
                            if error.code == external_ext_sdk::HostErrorCode::InvalidRequest =>
                        {
                            Ok(false)
                        }
                        Err(error) => Err(error),
                    };
                }
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Markdown links may omit `.md` or use the published `.html` spelling.
    /// Resolve through the client's provider; aliases never become document copies.
    fn resolve_link(
        &self,
        resource: &str,
        destination: &str,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<Option<(String, Option<String>)>, ExtensionError> {
        let Some((uri, fragment)) = self.target(resource, destination)? else {
            return Ok(None);
        };
        if self.exists(&uri, documents, token)? {
            return Ok(Some((uri, fragment)));
        }
        let Some(candidate) = markdown_alias(&uri) else {
            return Ok(None);
        };
        if self.exists(&candidate, documents, token)? {
            Ok(Some((candidate, fragment)))
        } else {
            Ok(None)
        }
    }

    fn workspace(
        &self,
        documents: &mut Documents,
        configuration: &Value,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        for snapshot in self.client.text_documents(token)? {
            if snapshot.language_id == "markdown" {
                documents.entry(snapshot.uri.clone()).or_insert(snapshot);
            }
        }
        let mut pending = self
            .folders
            .read()
            .map_err(|_| invalid("Markdown workspace unavailable"))?
            .clone()
            .into_iter()
            .map(|uri| (uri, 0, String::new(), Value::Null))
            .collect::<Vec<_>>();
        let mut visited = BTreeSet::new();
        while let Some((directory, depth, prefix, mut exclusions)) = pending.pop() {
            token.check_cancelled()?;
            if !visited.insert(directory.clone()) {
                continue;
            }
            if depth > 64 || visited.len() > 8192 || documents.len() > 8192 {
                return Err(invalid("Markdown workspace exceeds its scan limit"));
            }
            if depth == 0 {
                let mut patterns = configuration
                    .get("exclude")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for section in ["files.exclude", "search.exclude"] {
                    if let Some(values) = self
                        .client
                        .get_configuration(section, Some(directory.clone()), token)?
                        .as_object()
                    {
                        patterns.extend(values.clone());
                    }
                }
                exclusions = json!({"exclude":patterns});
            }
            for (name, kind) in self.client.read_resource_directory(&directory, token)? {
                token.check_cancelled()?;
                if name.is_empty()
                    || name.contains(['/', '\\', '\0'])
                    || name == "."
                    || name == ".."
                {
                    return Err(invalid("Invalid workspace child name"));
                }
                let relative = format!("{prefix}{name}");
                if name == ".git" || name == "node_modules" || excluded(&exclusions, &relative) {
                    continue;
                }
                let base = Url::parse(&(directory.trim_end_matches('/').to_owned() + "/"))
                    .map_err(|_| invalid("Invalid workspace URI"))?;
                let mut uri = base.clone();
                uri.path_segments_mut()
                    .map_err(|_| invalid("Invalid workspace URI"))?
                    .pop_if_empty()
                    .push(&name);
                if kind & 2 != 0 {
                    pending.push((
                        uri.into(),
                        depth + 1,
                        format!("{relative}/"),
                        exclusions.clone(),
                    ));
                } else if kind & 1 != 0
                    && is_markdown(&name)
                    && !documents.contains_key(uri.as_str())
                {
                    self.read(uri.as_str(), documents, token)?;
                }
            }
        }
        Ok(())
    }

    fn invoke(
        &self,
        operation: Operation,
        request: Request,
        token: CancellationToken,
    ) -> Result<Value, ExtensionError> {
        token.check_cancelled()?;
        let configuration = self.client.get_configuration(
            "markdown",
            (!request.resource.is_empty()).then(|| request.resource.clone()),
            &token,
        )?;
        let mut documents = Documents::default();
        if let Some(index) = self
            .observations
            .lock()
            .map_err(|_| invalid("Markdown observations unavailable"))?
            .as_ref()
        {
            documents.open = index.sources.keys().cloned().collect();
        }
        if operation == Operation::WorkspaceSymbols {
            self.workspace(&mut documents, &configuration, &token)?;
            let mut result = Vec::new();
            for document in documents.snapshots.into_values() {
                let document = self.parse(document, &token)?;
                for heading in &document.headings {
                    if heading
                        .title
                        .to_lowercase()
                        .contains(&request.query.to_lowercase())
                    {
                        result.push(json!({"name":heading.title,"kind":14,"resource":document.snapshot.uri,"range":document.range(heading.range.clone())}));
                    }
                }
            }
            return Ok(json!(result));
        }
        if request.version == 0 || request.resource.is_empty() {
            return Err(invalid("Missing Markdown document identity"));
        }
        let document = self.parse(
            DocumentSnapshot {
                uri: request.resource.clone(),
                version: request.version,
                language_id: "markdown".into(),
                text: request.text.clone(),
            },
            &token,
        )?;
        documents.insert(request.resource.clone(), document.snapshot.clone());
        documents
            .parsed
            .insert(request.resource.clone(), Arc::clone(&document));
        if operation == Operation::Completion {
            return self.completion(&document, &request, &configuration, &mut documents, &token);
        }
        if operation == Operation::Diagnostics || operation == Operation::CodeAction {
            let diagnostics =
                self.diagnostics(&document, &configuration, &mut documents, &token)?;
            if operation == Operation::Diagnostics {
                return Ok(json!({"diagnostics":diagnostics}));
            }
            let mut actions = diagnostics.into_iter().filter(|diagnostic| diagnostic["code"] == "link.unused-definition" && (request.only.is_empty() || request.only.iter().any(|kind| "quickfix".starts_with(kind)))).filter(|diagnostic| request.range.is_none_or(|range| {
                let start = serde_json::from_value::<Position>(diagnostic["range"]["start"].clone()).ok();
                let end = serde_json::from_value::<Position>(diagnostic["range"]["end"].clone()).ok();
                start.zip(end).is_some_and(|(start,end)| start <= range.end && end >= range.start)
            })).map(|diagnostic| {
                json!({"title":self.message("markdown.action.removeUnusedDefinition",""),"kind":"quickfix","edit":{"entries":[{"kind":"textDocument","resource":document.snapshot.uri,"expectedText":document.snapshot.text,"edits":[{"range":diagnostic["range"],"text":""}]}]}})
            }).collect::<Vec<_>>();
            if request.only.is_empty()
                || request
                    .only
                    .iter()
                    .any(|kind| "refactor.extract.link".starts_with(kind))
            {
                if let Some(range) = request.range {
                    let start = document.offset(range.start)?;
                    let end = document.offset(range.end)?;
                    if let Some(link) = document.links.iter().find(|link| {
                        link.reference.is_none()
                            && link.range.start <= end
                            && link.range.end >= start
                    }) {
                        let raw = &request.text[link.range.clone()];
                        if let Some(delimiter) =
                            inline_delimiter(raw).filter(|_| raw.ends_with(')'))
                        {
                            let mut number = 1;
                            while document
                                .definitions
                                .iter()
                                .any(|definition| definition.id == number.to_string())
                            {
                                number += 1;
                            }
                            let newline = if request.text.contains("\r\n") {
                                "\r\n"
                            } else {
                                "\n"
                            };
                            let link_text = format!("{}[{number}]", &raw[..delimiter + 1]);
                            let definition = format!(
                                "{newline}{newline}[{number}]: {}{newline}",
                                &raw[delimiter + 2..raw.len() - 1]
                            );
                            actions.push(json!({"title":self.message("markdown.action.extractDefinition",""),"kind":"refactor.extract.link","edit":workspace_edit(&document,vec![(link.range.clone(),link_text),(request.text.len()..request.text.len(),definition)])}));
                        }
                    }
                }
            }
            if request.only.is_empty()
                || request
                    .only
                    .iter()
                    .any(|kind| "source.organizeLinkDefinitions".starts_with(kind))
            {
                let mut definitions = document.definitions.iter().collect::<Vec<_>>();
                definitions.sort_by(|a, b| a.id.cmp(&b.id));
                if !definitions.is_empty() {
                    let newline = if request.text.contains("\r\n") {
                        "\r\n"
                    } else {
                        "\n"
                    };
                    let mut text = request.text.clone();
                    for definition in document.definitions.iter().rev() {
                        text.replace_range(definition.range.clone(), "");
                    }
                    let sorted = definitions
                        .iter()
                        .map(|definition| {
                            request.text[definition.range.clone()].trim_end_matches(['\r', '\n'])
                        })
                        .collect::<Vec<_>>()
                        .join(newline);
                    text = format!(
                        "{}{newline}{newline}{sorted}{newline}",
                        text.trim_end_matches(['\r', '\n'])
                    );
                    if text != request.text {
                        actions.push(json!({"title":self.message("markdown.action.organizeDefinitions",""),"kind":"source.organizeLinkDefinitions","edit":workspace_edit(&document,vec![(0..request.text.len(),text)])}));
                    }
                }
            }
            return Ok(json!(actions));
        }
        if operation == Operation::DocumentLinks {
            let mut result = Vec::new();
            for link in &document.links {
                if link.destination.is_empty() {
                    continue;
                }
                let destination = if let Some((uri, fragment)) =
                    self.resolve_link(&request.resource, &link.destination, &mut documents, &token)?
                {
                    if let Some(fragment) = fragment {
                        if !self.exists(&uri, &mut documents, &token)? {
                            continue;
                        }
                        let other = self.analyze(&uri, &mut documents, &token)?;
                        if let Some(heading) = other.heading(&fragment) {
                            let point = other
                                .index
                                .position(&other.snapshot.text, heading.range.start);
                            let mut uri =
                                Url::parse(&uri).map_err(|_| invalid("Invalid link URI"))?;
                            uri.set_fragment(Some(&format!(
                                "{},{}",
                                point["lineIndex"].as_u64().unwrap_or(0) + 1,
                                point["columnIndex"].as_u64().unwrap_or(0) + 1
                            )));
                            uri.to_string()
                        } else {
                            format!("{uri}#{fragment}")
                        }
                    } else {
                        uri
                    }
                } else {
                    link.destination.clone()
                };
                if Url::parse(&destination)
                    .is_ok_and(|uri| !matches!(uri.scheme(), "command" | "javascript" | "data"))
                {
                    result.push(json!({"range":document.range(link.destination_range.clone()),"target":destination}));
                }
            }
            return Ok(json!(result));
        }
        let offset = document.offset(
            request
                .position
                .ok_or_else(|| invalid("Missing Markdown position"))?,
        )?;
        let heading = document
            .headings
            .iter()
            .find(|heading| contains(&heading.range, offset));
        let definition = document
            .definitions
            .iter()
            .find(|definition| contains(&definition.label, offset));
        let link = document
            .links
            .iter()
            .find(|link| contains(&link.range, offset));
        let reference_id = definition
            .map(|definition| definition.id.as_str())
            .or_else(|| link.and_then(|link| link.reference.as_deref()));
        if let Some(id) = reference_id {
            let definition = document
                .definitions
                .iter()
                .find(|definition| definition.id == id);
            let ranges = document
                .links
                .iter()
                .filter(|link| link.reference.as_deref() == Some(id))
                .map(|link| link.destination_range.clone())
                .chain(definition.map(|definition| definition.range.clone()))
                .collect::<Vec<_>>();
            return match operation {
                Operation::Definition => Ok(json!(definition.map(|definition| vec![json!({"resource":request.resource,"range":document.range(definition.range.clone())})]).unwrap_or_default())),
                Operation::DocumentHighlights => Ok(json!(if configuration.pointer("/occurrencesHighlight/enabled") == Some(&json!(false)) { Vec::new() } else { ranges.iter().map(|range| json!({"range":document.range(range.clone()),"kind":1})).collect() })),
                Operation::References => Ok(json!(ranges.iter().filter(|range| request.include_declaration || definition.is_none_or(|definition| definition.range != **range)).map(|range| json!({"resource":request.resource,"range":document.range(range.clone())})).collect::<Vec<_>>())),
                Operation::Rename => {
                    let range = link.map(|link| link.destination_range.clone()).or_else(|| definition.map(|definition| definition.label.clone())).ok_or_else(|| invalid("Missing reference range"))?;
                    if request.kind.as_deref() == Some("prepare") { Ok(json!({"range":document.range(range),"placeholder":id})) }
                    else {
                        let name = request.new_name.as_deref().ok_or_else(|| invalid("Missing reference name"))?;
                        if name.is_empty() || name.contains(['[',']','\n','\r']) { return Err(invalid("Invalid reference name")); }
                        let edits = document.links.iter().filter(|link| link.reference.as_deref() == Some(id)).map(|link| {
                            let raw = &request.text[link.range.clone()];
                            if link.destination_range.start == link.range.start + 1 + usize::from(raw.starts_with('!')) { (link.range.end..link.range.end,format!("[{name}]")) }
                            else { (link.destination_range.clone(),name.to_owned()) }
                        }).chain(document.definitions.iter().filter(|definition| definition.id == id).map(|definition| (definition.label.clone(),name.to_owned()))).collect();
                        Ok(workspace_edit(&document,edits))
                    }
                }
                Operation::Hover => Ok(definition.map_or(Value::Null,|definition| json!({"contents":[definition.destination],"range":document.range(link.map_or_else(|| definition.range.clone(),|link| link.destination_range.clone()))}))),
                _ => Err(invalid("Unsupported Markdown reference operation")),
            };
        }
        let resolved = if let Some(heading) = heading {
            Some((request.resource.clone(), Some(heading.slug.clone())))
        } else if let Some(link) = link {
            self.resolve_link(&request.resource, &link.destination, &mut documents, &token)?
        } else {
            None
        };
        let Some((uri, fragment)) = resolved else {
            return Ok(match operation {
                Operation::Hover | Operation::Rename => Value::Null,
                _ => json!([]),
            });
        };
        if !self.exists(&uri, &mut documents, &token)? {
            return Ok(
                if matches!(operation, Operation::Hover | Operation::Rename) {
                    Value::Null
                } else {
                    json!([])
                },
            );
        }
        let other = if is_markdown(&uri) || uri == request.resource {
            Some(self.analyze(&uri, &mut documents, &token)?)
        } else {
            None
        };
        let target_heading = fragment
            .as_ref()
            .and_then(|fragment| other.as_ref()?.heading(fragment));
        let target_range = target_heading.map_or(0..0, |heading| heading.range.clone());
        if operation == Operation::Definition {
            if fragment.is_some() && target_heading.is_none() {
                return Ok(json!([]));
            }
            return Ok(
                json!([{"resource":uri,"range":other.as_ref().map_or_else(|| json!({"start":{"lineIndex":0,"columnIndex":0},"end":{"lineIndex":0,"columnIndex":0}}),|other| other.range(target_range))}]),
            );
        }
        if operation == Operation::Hover {
            return Ok(
                json!({"contents":[target_heading.map_or(uri.as_str(),|heading| heading.title.as_str())],"range":document.range(link.map_or(offset..offset,|link| link.destination_range.clone()))}),
            );
        }
        if operation == Operation::DocumentHighlights
            && configuration.pointer("/occurrencesHighlight/enabled") == Some(&json!(false))
        {
            return Ok(json!([]));
        }
        if operation == Operation::Rename && request.kind.as_deref() == Some("prepare") {
            let range = heading
                .map(|heading| heading.content.clone())
                .or_else(|| link.map(|link| link.destination_range.clone()))
                .ok_or_else(|| invalid("Cannot rename this Markdown position"))?;
            return Ok(
                json!({"range":document.range(range.clone()),"placeholder":&request.text[range]}),
            );
        }
        if operation != Operation::DocumentHighlights {
            self.workspace(&mut documents, &configuration, &token)?;
        }
        let mut locations = Vec::new();
        let mut entries = Vec::new();
        let name = request.new_name.as_deref().unwrap_or("");
        if operation == Operation::Rename && (name.is_empty() || name.contains(['\n', '\r', '\0']))
        {
            return Err(invalid("Invalid Markdown rename"));
        }
        let renaming_heading = fragment.is_some()
            && (heading.is_some()
                || link.is_some_and(|link| {
                    request.text[link.destination_range.start
                        ..offset.clamp(link.destination_range.start, link.destination_range.end)]
                        .contains('#')
                }));
        let renamed_headings = if operation == Operation::Rename && renaming_heading {
            other
                .as_ref()
                .ok_or_else(|| invalid("Missing Markdown heading document"))?
                .renamed_heading_ids(
                    target_heading.ok_or_else(|| invalid("Missing Markdown heading"))?,
                    name,
                    &token,
                )?
        } else {
            BTreeMap::new()
        };
        let renamed_file = if operation == Operation::Rename && !renaming_heading {
            self.target(&request.resource, name)?.map(|target| target.0)
        } else {
            None
        };
        for snapshot in documents.values().cloned().collect::<Vec<_>>() {
            token.check_cancelled()?;
            let current = self.analyze(&snapshot.uri, &mut documents, &token)?;
            let mut edits = Vec::new();
            for found in &current.links {
                if operation == Operation::Rename && found.reference.is_some() {
                    continue;
                }
                if operation == Operation::Rename
                    && !renaming_heading
                    && current.snapshot.uri == uri
                    && found.destination.starts_with('#')
                {
                    continue;
                }
                let found_target = self.resolve_link(
                    &current.snapshot.uri,
                    &found.destination,
                    &mut documents,
                    &token,
                )?;
                if let Some(moved) = renamed_file
                    .as_deref()
                    .filter(|_| current.snapshot.uri == uri)
                {
                    if !found.destination.starts_with(['#', '/'])
                        && Url::parse(&found.destination).is_err()
                    {
                        if let Some((resource, fragment)) = self.target(&uri, &found.destination)? {
                            if resource != uri {
                                let destination = format!(
                                    "{resource}{}",
                                    fragment
                                        .map_or(String::new(), |fragment| format!("#{fragment}"))
                                );
                                edits.push((
                                    found.destination_range.clone(),
                                    relative_destination(moved, &destination, &found.destination)?,
                                ));
                                continue;
                            }
                        }
                    }
                }
                if !found_target
                    .as_ref()
                    .is_some_and(|(resource, found_fragment)| {
                        resource == &uri
                            && (operation == Operation::Rename && !renaming_heading
                                || operation == Operation::Rename
                                    && renaming_heading
                                    && found_fragment.as_ref().is_some_and(|fragment| {
                                        renamed_headings.contains_key(&fragment.to_lowercase())
                                    })
                                || operation != Operation::Rename
                                    && found_fragment
                                        .as_ref()
                                        .map(|fragment| fragment.to_lowercase())
                                        == fragment
                                            .as_ref()
                                            .map(|fragment| fragment.to_lowercase()))
                    })
                {
                    continue;
                }
                locations.push(json!({"resource":current.snapshot.uri,"range":current.range(found.destination_range.clone())}));
                if operation == Operation::Rename {
                    let replacement = if renaming_heading {
                        format!(
                            "{}#{}",
                            found.destination.split('#').next().unwrap_or(""),
                            renamed_headings[&found_target
                                .as_ref()
                                .and_then(|(_, fragment)| fragment.as_ref())
                                .unwrap()
                                .to_lowercase()]
                        )
                    } else {
                        let moved = renamed_file
                            .as_deref()
                            .ok_or_else(|| invalid("Invalid Markdown rename target"))?;
                        let base = if current.snapshot.uri == uri {
                            moved
                        } else {
                            &current.snapshot.uri
                        };
                        let relative = relative_destination(base, moved, &found.destination)?;
                        format!(
                            "{relative}{}",
                            found_target
                                .as_ref()
                                .and_then(|(_, fragment)| fragment.as_ref())
                                .as_ref()
                                .map_or(String::new(), |fragment| format!("#{fragment}"))
                        )
                    };
                    edits.push((found.destination_range.clone(), replacement));
                }
            }
            if current.snapshot.uri == uri {
                if let Some(heading) = target_heading {
                    if request.include_declaration || operation == Operation::DocumentHighlights {
                        locations.push(
                            json!({"resource":uri,"range":current.range(heading.range.clone())}),
                        );
                    }
                    if operation == Operation::Rename && renaming_heading {
                        edits.push((heading.content.clone(), name.into()));
                    }
                }
            }
            if !edits.is_empty() {
                entries.extend(
                    workspace_edit(&current, edits)["entries"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                );
            }
        }
        match operation {
            Operation::References => Ok(json!(locations)),
            Operation::DocumentHighlights => Ok(json!(
                locations
                    .into_iter()
                    .filter(|location| location["resource"] == request.resource)
                    .map(|location| json!({"range":location["range"],"kind":1}))
                    .collect::<Vec<_>>()
            )),
            Operation::Rename => {
                if let Some(target) = renamed_file {
                    entries.push(
                        json!({"kind":"rename","source":uri,"target":target,"existing":"error"}),
                    );
                }
                Ok(json!({"entries":entries}))
            }
            _ => Err(invalid("Unsupported Markdown operation")),
        }
    }

    fn completion(
        &self,
        document: &Document,
        request: &Request,
        configuration: &Value,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let mut items = Vec::new();
        if configuration.pointer("/suggest/paths/enabled") == Some(&json!(false)) {
            return Ok(json!({"items":items,"isIncomplete":false}));
        }
        let offset = document.offset(
            request
                .position
                .ok_or_else(|| invalid("Missing completion position"))?,
        )?;
        let before = &document.snapshot.text[..offset];
        let inline = before.rfind("](").map(|offset| offset + 2);
        let reference = before.rfind('[').map(|offset| offset + 1);
        let start = inline.into_iter().chain(reference).max();
        if let Some(start) = start {
            let prefix = &document.snapshot.text[start..offset];
            if !prefix.contains(['\n', '\r', ')', ']']) {
                if let Some((path, fragment)) = prefix.split_once('#') {
                    let workspace_headers = configuration
                        .pointer("/suggest/paths/includeWorkspaceHeaderCompletions")
                        .and_then(Value::as_str)
                        .unwrap_or("onDoubleHash");
                    let all = path.is_empty()
                        && (fragment.starts_with('#') && workspace_headers != "never"
                            || workspace_headers == "onSingleOrDoubleHash");
                    if all {
                        self.workspace(documents, configuration, token)?;
                    }
                    let uri = self
                        .resolve_link(&request.resource, &format!("{path}#"), documents, token)?
                        .map(|(uri, _)| uri)
                        .unwrap_or_default();
                    if !uri.is_empty() {
                        self.read(&uri, documents, token)?;
                    }
                    for snapshot in documents
                        .values()
                        .filter(|snapshot| all || snapshot.uri == uri)
                        .cloned()
                        .collect::<Vec<_>>()
                    {
                        let other = self.analyze(&snapshot.uri, documents, token)?;
                        let path = if snapshot.uri == uri {
                            path.to_owned()
                        } else {
                            let base = Url::parse(&request.resource)
                                .map_err(|_| invalid("Invalid completion URI"))?
                                .join("./")
                                .map_err(|_| invalid("Invalid completion URI"))?;
                            let target = Url::parse(&snapshot.uri)
                                .map_err(|_| invalid("Invalid completion URI"))?;
                            base.make_relative(&target).unwrap_or(snapshot.uri.clone())
                        };
                        for heading in &other.headings {
                            items.push(json!({"id":format!("{}.{}",snapshot.uri,heading.slug),"label":format!("{path}#{}",heading.slug),"kind":"reference","insertText":format!("{path}#{}",heading.slug),"insertTextFormat":"plainText","range":document.range(start..offset)}));
                        }
                    }
                } else if inline == Some(start) {
                    let (directory, partial) = prefix.rsplit_once('/').unwrap_or(("", prefix));
                    let parent = if directory.is_empty() && prefix.starts_with('/') {
                        "/".to_owned()
                    } else if directory.is_empty() {
                        "./".to_owned()
                    } else {
                        format!("{directory}/")
                    };
                    let (uri, _) = self
                        .target(&request.resource, &parent)?
                        .ok_or_else(|| invalid("Invalid completion URI"))?;
                    for (name, kind) in self.client.read_resource_directory(&uri, token)? {
                        token.check_cancelled()?;
                        if name.is_empty()
                            || name == "."
                            || name == ".."
                            || name.contains(['/', '\\', '\0'])
                        {
                            return Err(invalid("Invalid completion child name"));
                        }
                        if name.starts_with(partial) {
                            let insert = if kind & 2 == 0
                                && is_markdown(&name)
                                && configuration["preferredMdPathExtensionStyle"]
                                    == "removeExtension"
                            {
                                name.rsplit_once('.')
                                    .map_or(name.as_str(), |(stem, _)| stem)
                            } else {
                                &name
                            };
                            let path = if directory.is_empty() && prefix.starts_with('/') {
                                format!("/{insert}")
                            } else if directory.is_empty() {
                                insert.to_owned()
                            } else {
                                format!("{directory}/{insert}")
                            };
                            items.push(json!({"id":name,"label":name,"kind":if kind&2 != 0 {"folder"} else {"file"},"insertText":format!("{path}{}",if kind&2 != 0 {"/"} else {""}),"insertTextFormat":"plainText","range":document.range(start..offset)}));
                        }
                    }
                } else {
                    for definition in &document.definitions {
                        items.push(json!({"id":definition.id,"label":definition.id,"kind":"reference","insertText":definition.id,"insertTextFormat":"plainText","range":document.range(start..offset)}));
                    }
                }
            }
        }
        Ok(json!({"items":items,"isIncomplete":false}))
    }

    fn diagnostics(
        &self,
        document: &Document,
        configuration: &Value,
        documents: &mut Documents,
        token: &CancellationToken,
    ) -> Result<Vec<Value>, ExtensionError> {
        let mut result = Vec::new();
        if configuration.pointer("/validate/enabled") == Some(&json!(false)) {
            return Ok(result);
        }
        for link in &document.links {
            token.check_cancelled()?;
            if configuration
                .pointer("/validate/ignoredLinks")
                .and_then(Value::as_array)
                .is_some_and(|patterns| {
                    patterns
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|pattern| matches_glob(pattern, &link.destination))
                })
            {
                continue;
            }
            if let Some(id) = &link.reference {
                if !document
                    .definitions
                    .iter()
                    .any(|definition| &definition.id == id)
                {
                    let level =
                        severity(configuration, "/validate/referenceLinks/enabled", "warning");
                    if level != "ignore" {
                        result.push(json!({"range":document.range(link.destination_range.clone()),"severity":level,"message":self.message("markdown.diagnostic.missingReference",id),"code":"link.no-such-reference"}));
                    }
                    continue;
                }
            }
            let Some((original_uri, _)) = self.target(&document.snapshot.uri, &link.destination)?
            else {
                continue;
            };
            let resolved =
                self.resolve_link(&document.snapshot.uri, &link.destination, documents, token)?;
            let (uri, fragment) = resolved.clone().unwrap_or((original_uri, None));
            let own = uri == document.snapshot.uri;
            let file_level = severity(configuration, "/validate/fileLinks/enabled", "warning");
            let level = if own {
                severity(configuration, "/validate/fragmentLinks/enabled", "warning")
            } else {
                severity(
                    configuration,
                    "/validate/fileLinks/markdownFragmentLinks",
                    file_level,
                )
            };
            if file_level == "ignore" && level == "ignore" {
                continue;
            }
            if resolved.is_none() {
                if file_level != "ignore" {
                    result.push(json!({"range":document.range(link.destination_range.clone()),"severity":file_level,"message":self.message("markdown.diagnostic.missingFile",&link.destination),"code":"link.no-such-file"}));
                }
                continue;
            }
            if let Some(fragment) = fragment.filter(|fragment| !fragment.is_empty()) {
                if level != "ignore" && (own || is_markdown(&uri)) {
                    let other = self.analyze(&uri, documents, token)?;
                    if other.heading(&fragment).is_none() {
                        result.push(json!({"range":document.range(link.destination_range.clone()),"severity":level,"message":self.message("markdown.diagnostic.missingHeading",&fragment),"code":if own {"link.no-such-header-in-own-file"} else {"link.no-such-header-in-file"}}));
                    }
                }
            }
        }
        let unused_level = severity(
            configuration,
            "/validate/unusedLinkDefinitions/enabled",
            "hint",
        );
        let duplicate_level = severity(
            configuration,
            "/validate/duplicateLinkDefinitions/enabled",
            "warning",
        );
        let mut labels = BTreeSet::new();
        {
            for definition in &document.definitions {
                if !labels.insert(&definition.id) && duplicate_level != "ignore" {
                    result.push(json!({"range":document.range(definition.label.clone()),"severity":duplicate_level,"message":self.message("markdown.diagnostic.duplicateDefinition",&definition.id),"code":"link.duplicate-definition"}));
                }
                if unused_level != "ignore"
                    && !document
                        .links
                        .iter()
                        .any(|link| link.reference.as_deref() == Some(&definition.id))
                {
                    result.push(json!({"range":document.range(definition.range.clone()),"severity":unused_level,"message":self.message("markdown.diagnostic.unusedDefinition",&definition.id),"code":"link.unused-definition"}));
                }
            }
        }
        Ok(result)
    }
}

fn contains(range: &Range<usize>, offset: usize) -> bool {
    range.start <= offset && offset <= range.end
}

fn relative_destination(
    base: &str,
    destination: &str,
    original: &str,
) -> Result<String, ExtensionError> {
    let base = Url::parse(base)
        .and_then(|base| base.join("./"))
        .map_err(|_| invalid("Invalid document URI"))?;
    let target = Url::parse(destination).map_err(|_| invalid("Invalid rename URI"))?;
    let relative = base
        .make_relative(&target)
        .unwrap_or_else(|| target.to_string());
    Ok(
        if original.starts_with("./") && !relative.starts_with('.') {
            format!("./{relative}")
        } else {
            relative
        },
    )
}

fn workspace_edit(document: &Document, edits: Vec<(Range<usize>, String)>) -> Value {
    json!({"entries":[{"kind":"textDocument","resource":document.snapshot.uri,"expectedText":document.snapshot.text,"edits":edits.into_iter().map(|(range,text)| json!({"range":document.range(range),"text":text})).collect::<Vec<_>>()}]})
}

fn is_markdown(name: &str) -> bool {
    name.rsplit('.').next().is_some_and(|suffix| {
        matches!(
            suffix.to_ascii_lowercase().as_str(),
            "md" | "markdown"
                | "mdown"
                | "mkd"
                | "mkdn"
                | "mdwn"
                | "markdn"
                | "mdtxt"
                | "mdtext"
                | "mdc"
        )
    })
}

fn excluded(configuration: &Value, name: &str) -> bool {
    configuration
        .get("exclude")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .any(|(pattern, value)| {
            value == &json!(true)
                && (matches_glob(pattern, name) || matches_glob(pattern, &format!("{name}/")))
        })
}

pub(crate) fn register(
    context: &mut ExtensionContext,
    chinese: bool,
) -> Result<(), ExtensionError> {
    let folders = context
        .initialization()
        .map(|facts| {
            facts
                .workspace_folders
                .iter()
                .map(|folder| folder.uri.clone())
                .collect()
        })
        .unwrap_or_default();
    let messages = serde_json::from_str(if chinese {
        include_str!("../package.nls.zh-CN.json")
    } else {
        include_str!("../package.nls.json")
    })
    .map_err(|_| invalid("Invalid Markdown messages"))?;
    let runtime = Arc::new(Runtime {
        client: context.client.clone(),
        folders: RwLock::new(folders),
        messages,
        analysis: Mutex::new(AnalysisCache::default()),
        observations: Mutex::new(None),
    });
    for operation in [
        Operation::Completion,
        Operation::Definition,
        Operation::References,
        Operation::Rename,
        Operation::DocumentLinks,
        Operation::Hover,
        Operation::DocumentHighlights,
        Operation::Diagnostics,
        Operation::CodeAction,
        Operation::WorkspaceSymbols,
    ] {
        let runtime = Arc::clone(&runtime);
        context.languages.register_provider(
            format!("markdown.{operation:?}"),
            vec!["markdown".into()],
            operation,
            if operation == Operation::Completion {
                vec!["/".into(), "#".into(), "[".into(), ".".into()]
            } else {
                Vec::new()
            },
            move |request: Request, token| runtime.invoke(operation, request, token),
        )?;
    }
    let documents = Arc::clone(&runtime);
    context
        .languages
        .observe_documents("ash.documents".into(), move |event, token| {
            documents.publish_diagnostics(Some(event), &token)
        })?;
    context
        .workspace
        .observe("ash.workspace.events".into(), move |event, token| {
            if let external_ext_sdk::workspace::WorkspaceEvent::Workspace { workspace_folders } =
                event
            {
                *runtime
                    .folders
                    .write()
                    .map_err(|_| invalid("Markdown workspace unavailable"))? = workspace_folders
                    .into_iter()
                    .map(|folder| folder.uri)
                    .collect();
            }
            runtime.publish_diagnostics(None, &token)
        })
}
