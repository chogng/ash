use ropey::Rope;
use ropey::RopeSlice;
use std::cell::RefCell;
use std::cmp::Reverse;
use std::ops::ControlFlow;
use std::ops::Range;
use std::sync::Arc;

use tree_sitter::ParseOptions;
use tree_sitter::ParseState;
use tree_sitter::{InputEdit, Node, Parser, Point, Query, QueryCursor, StreamingIterator, Tree};

use crate::language::LanguageConfiguration;

#[path = "editor.rs"]
mod editor;
#[path = "injections.rs"]
mod injections;
use crate::{
    AnalysisLimits, DocumentSymbol, DocumentSymbolKind, FoldingRange, SelectionRange,
    SyntaxDiagnostic, SyntaxDiagnosticKind, SyntaxError, SyntaxLanguage, SyntaxPoint, SyntaxRange,
    SyntaxSnapshot, SyntaxToken, SyntaxTokenKind,
};
pub use editor::{
    EditorBracket, EditorDiagnostic, EditorFacts, EditorFactsDelta, EditorFactsSplice, EditorFold,
    EditorRow, EditorSymbol, EditorToken,
};

/// Monotonic host-owned revision attached to source text and derived analysis.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DocumentRevision(u64);

impl DocumentRevision {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn value(self) -> u64 {
        self.0
    }
}

/// One replacement expressed in UTF-8 byte offsets against the current document revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyntaxEdit {
    range: Range<usize>,
    replacement: String,
}

impl SyntaxEdit {
    pub fn replace(range: Range<usize>, replacement: impl Into<String>) -> Self {
        Self {
            range,
            replacement: replacement.into(),
        }
    }

    pub fn insert(offset: usize, text: impl Into<String>) -> Self {
        Self::replace(offset..offset, text)
    }

    pub fn delete(range: Range<usize>) -> Self {
        Self::replace(range, String::new())
    }

    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }

    pub fn replacement(&self) -> &str {
        &self.replacement
    }
}

/// Incrementally parsed source document independent of an editor or filesystem.
pub struct SyntaxDocument {
    language: SyntaxLanguage,
    revision: DocumentRevision,
    text: Rope,
    parser: Parser,
    tree: Tree,
    configuration: Arc<LanguageConfiguration>,
    limits: AnalysisLimits,
    editor_cache: RefCell<editor::EditorCache>,
    injection_cache: RefCell<injections::InjectionCache>,
}

impl SyntaxDocument {
    pub fn open(
        language: SyntaxLanguage,
        revision: DocumentRevision,
        text: impl AsRef<str>,
    ) -> Result<Self, SyntaxError> {
        Self::open_with_limits(language, revision, text, AnalysisLimits::default())
    }

    pub fn open_with_limits(
        language: SyntaxLanguage,
        revision: DocumentRevision,
        text: impl AsRef<str>,
        limits: AnalysisLimits,
    ) -> Result<Self, SyntaxError> {
        let text = text.as_ref();
        validate_document_size(text.len(), limits)?;
        let mut parser = Parser::new();
        let configuration = LanguageConfiguration::load(language, &mut parser)?;
        let text = Rope::from_str(text);
        let tree = parse_rope(&mut parser, &text, None)?;
        Ok(Self {
            language,
            revision,
            text,
            parser,
            tree,
            configuration,
            limits,
            editor_cache: RefCell::default(),
            injection_cache: RefCell::default(),
        })
    }

    pub const fn language(&self) -> SyntaxLanguage {
        self.language
    }

    pub const fn revision(&self) -> DocumentRevision {
        self.revision
    }

    /// Borrows a read-only view of the current text without flattening its chunks.
    pub fn text(&self) -> RopeSlice<'_> {
        self.text.slice(..)
    }

    pub fn snapshot(&self) -> SyntaxSnapshot {
        SyntaxSnapshot::new(
            self.revision,
            self.tree.root_node().has_error(),
            collect_tokens(
                &self.configuration.highlights,
                &self.tree,
                &self.text,
                self.limits.max_tokens,
            ),
            collect_folding_ranges(
                &self.tree,
                &self.configuration.folds,
                &self.text,
                self.limits.max_folding_ranges,
            ),
            collect_symbols(
                &mut QueryCursor::new(),
                &self.configuration.tags,
                self.tree.root_node(),
                &self.text,
                self.limits.max_symbols,
            ),
            collect_diagnostics(&self.tree, self.limits.max_diagnostics),
        )
    }

    /// Returns the bounded, innermost-first parser scopes enclosing one exact byte range.
    ///
    /// The query is intentionally separate from [`Self::snapshot`] so consumers that only need
    /// highlighting, folding, symbols, or diagnostics do not pay to serialize the whole tree.
    pub fn selection_ranges(
        &self,
        range: Range<usize>,
    ) -> Result<Vec<SelectionRange>, SyntaxError> {
        validate_selection_range(&self.text, &range)?;
        Ok(collect_selection_ranges(
            &self.tree,
            range,
            self.limits.max_selection_ranges,
        ))
    }

    pub fn apply_edit(
        &mut self,
        next_revision: DocumentRevision,
        edit: &SyntaxEdit,
    ) -> Result<SyntaxSnapshot, SyntaxError> {
        self.apply_edits(next_revision, std::slice::from_ref(edit))
    }

    /// Applies one atomic batch of non-overlapping edits expressed against the current revision.
    ///
    /// Callers may preserve a host editor's single revision even when one edit event contains
    /// multiple replacements. Every range is interpreted against the pre-edit text; ambiguous
    /// overlapping ranges and duplicate insertion points are rejected before mutation.
    pub fn apply_edits(
        &mut self,
        next_revision: DocumentRevision,
        edits: &[SyntaxEdit],
    ) -> Result<SyntaxSnapshot, SyntaxError> {
        self.update_edits(next_revision, edits)?;
        Ok(self.snapshot())
    }

    /// Updates the shared tree without eagerly deriving facts or whole-document tokens.
    ///
    /// Returns the effective edits in descending pre-edit byte order. Hosts must use
    /// these same changes to shift retained facts: a broad or unchanged snapshot is
    /// not a replacement of every symbol and fold in the document.
    pub fn update_edits(
        &mut self,
        next_revision: DocumentRevision,
        edits: &[SyntaxEdit],
    ) -> Result<Vec<SyntaxEdit>, SyntaxError> {
        if next_revision <= self.revision {
            return Err(SyntaxError::NonIncreasingRevision {
                current: self.revision,
                requested: next_revision,
            });
        }
        let edits = validated_edits(&self.text, edits)?;
        let removed_len = edits.iter().map(|edit| edit.range.len()).sum::<usize>();
        let replacement_len = edits
            .iter()
            .map(|edit| edit.replacement.len())
            .sum::<usize>();
        let next_len = self.text.len_bytes() - removed_len + replacement_len;
        validate_document_size(next_len, self.limits)?;

        // Hosts can replace a whole snapshot for a structural-only revision, or
        // send a broad replacement containing a small text change. Preserve the
        // unchanged input so Tree-sitter and the fact caches can reuse it. Validate
        // the original batch first: shrinking edits must not conceal overlaps.
        let reduced = edits
            .into_iter()
            .filter_map(|edit| reduce_edit(&self.text, edit))
            .collect::<Vec<_>>();
        if reduced.is_empty() {
            self.revision = next_revision;
            return Ok(reduced);
        }
        let edits = reduced.iter().collect::<Vec<_>>();
        let parsed = parse_edits(&mut self.parser, &self.text, &self.tree, &edits)?;

        // Commit only after parsing succeeds. The fork shares untouched Rope nodes,
        // so validation or parse failure keeps both authoritative text and tree intact.
        self.editor_cache.get_mut().apply_edits(
            &edits,
            &self.text,
            &parsed.edited_tree,
            &parsed.tree,
        );
        self.text = parsed.text;
        self.tree = parsed.tree;
        self.injection_cache.get_mut().clear();
        self.revision = next_revision;
        Ok(reduced)
    }
}

fn reduce_edit(text: &Rope, edit: &SyntaxEdit) -> Option<SyntaxEdit> {
    let source = text.byte_slice(edit.range.clone());
    let replacement = edit.replacement();
    let mut prefix = source
        .bytes()
        .zip(replacement.bytes())
        .take_while(|(old, new)| old == new)
        .count();
    if prefix == source.len_bytes() && prefix == replacement.len() {
        return None;
    }
    // Distinct UTF-8 characters can share leading or trailing bytes. Both
    // replacement endpoints must remain character boundaries for Rope edits.
    while !replacement.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = source
        .bytes_at(source.len_bytes())
        .reversed()
        .zip(replacement.bytes().rev())
        .take((source.len_bytes() - prefix).min(replacement.len() - prefix))
        .take_while(|(old, new)| old == new)
        .count();
    while !replacement.is_char_boundary(replacement.len() - suffix) {
        suffix -= 1;
    }
    Some(SyntaxEdit::replace(
        edit.range.start + prefix..edit.range.end - suffix,
        &replacement[prefix..replacement.len() - suffix],
    ))
}

/// Tree-sitter may request a byte inside a UTF-8 character, so return the
/// containing chunk's raw suffix rather than slicing a str at that byte.
fn parse_rope(
    parser: &mut Parser,
    text: &Rope,
    old_tree: Option<&Tree>,
) -> Result<Tree, SyntaxError> {
    let mut progress = ParseProgress::new(text.len_bytes());
    let mut callback = |state: &ParseState| progress.advance(state.current_byte_offset());
    parse_rope_with_options(
        parser,
        text,
        old_tree,
        ParseOptions::new().progress_callback(&mut callback),
    )
}

// File size and snapshot limits do not bound native parsing: a grammar can keep
// reducing at one byte offset while allocating nodes. Tree-sitter checks progress
// about every 100 operations. Tree balancing and external scanners also do work
// without advancing the reported offset, so their allowance scales with input
// size. Repeated reductions on small malformed inputs retain a bounded allowance.
const MAX_STALLED_PARSE_CHECKS: usize = 1_024;

struct ParseProgress {
    furthest_byte: usize,
    stalled_checks: usize,
    max_stalled_checks: usize,
}

impl ParseProgress {
    fn new(source_bytes: usize) -> Self {
        Self {
            furthest_byte: 0,
            stalled_checks: 0,
            max_stalled_checks: MAX_STALLED_PARSE_CHECKS.saturating_add(source_bytes / 16),
        }
    }

    fn advance(&mut self, offset: usize) -> ControlFlow<()> {
        if offset > self.furthest_byte {
            self.furthest_byte = offset;
            self.stalled_checks = 0;
        } else {
            self.stalled_checks += 1;
        }
        if self.stalled_checks >= self.max_stalled_checks {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }
}

fn parse_rope_with_options(
    parser: &mut Parser,
    text: &Rope,
    old_tree: Option<&Tree>,
    options: ParseOptions<'_>,
) -> Result<Tree, SyntaxError> {
    let tree = parser.parse_with_options(
        &mut |offset, _| {
            if offset >= text.len_bytes() {
                return &[][..];
            }
            let (chunk, start, _, _) = text.chunk_at_byte(offset);
            &chunk.as_bytes()[offset - start..]
        },
        old_tree,
        Some(options),
    );
    // A cancelled parser retains its partial parse for resumption. Edits are
    // atomic here, so the next call may use different text and must start fresh.
    if tree.is_none() {
        parser.reset();
    }
    tree.ok_or(SyntaxError::ParseCancelled)
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod parse_tests;

fn point_at(text: &Rope, offset: usize) -> SyntaxPoint {
    let row = text.byte_to_line(offset);
    SyntaxPoint {
        row,
        column: offset - text.line_to_byte(row),
    }
}

// Preserve the exact edited input Tree until dependent caches record its change
// ranges. Editing another clone independently breaks shared node identity and
// makes Tree-sitter compare otherwise unchanged subtrees again.
struct ParsedEdit {
    text: Rope,
    tree: Tree,
    edited_tree: Tree,
}

fn parse_edits(
    parser: &mut Parser,
    text: &Rope,
    tree: &Tree,
    edits: &[&SyntaxEdit],
) -> Result<ParsedEdit, SyntaxError> {
    let mut next_text = text.clone();
    let mut edited_tree = tree.clone();
    // Descending old-document ranges keep all remaining byte offsets unchanged.
    for edit in edits {
        let start_point = point_at(text, edit.range.start);
        let old_end_point = point_at(text, edit.range.end);
        edited_tree.edit(&InputEdit {
            start_byte: edit.range.start,
            old_end_byte: edit.range.end,
            new_end_byte: edit.range.start + edit.replacement.len(),
            start_position: start_point.into(),
            old_end_position: old_end_point.into(),
            new_end_position: advance_point(start_point, &edit.replacement).into(),
        });
        let start = next_text.byte_to_char(edit.range.start);
        let end = next_text.byte_to_char(edit.range.end);
        next_text.remove(start..end);
        next_text.insert(start, &edit.replacement);
    }
    let tree = parse_rope(parser, &next_text, Some(&edited_tree))?;
    Ok(ParsedEdit {
        text: next_text,
        tree,
        edited_tree,
    })
}

/// Query predicates also consume chunked source, including captures spanning leaves.
struct RopeTextProvider<'a>(RopeSlice<'a>);

impl<'a> tree_sitter::TextProvider<&'a [u8]> for RopeTextProvider<'a> {
    type I = std::iter::Map<ropey::iter::Chunks<'a>, fn(&'a str) -> &'a [u8]>;

    fn text(&mut self, node: Node) -> Self::I {
        self.0
            .byte_slice(node.byte_range())
            .chunks()
            .map(str::as_bytes)
    }
}

impl From<SyntaxPoint> for Point {
    fn from(point: SyntaxPoint) -> Self {
        Self::new(point.row, point.column)
    }
}

fn validate_document_size(actual: usize, limits: AnalysisLimits) -> Result<(), SyntaxError> {
    if actual > limits.max_document_bytes {
        return Err(SyntaxError::DocumentTooLarge {
            actual,
            limit: limits.max_document_bytes,
        });
    }
    Ok(())
}

fn validate_edit(text: &Rope, edit: &SyntaxEdit) -> Result<(), SyntaxError> {
    if edit.range.start > edit.range.end || edit.range.end > text.len_bytes() {
        return Err(SyntaxError::InvalidEditRange {
            start: edit.range.start,
            end: edit.range.end,
            document_len: text.len_bytes(),
        });
    }
    for offset in [edit.range.start, edit.range.end] {
        if text.char_to_byte(text.byte_to_char(offset)) != offset {
            return Err(SyntaxError::InvalidEditBoundary { offset });
        }
    }
    Ok(())
}

fn validate_selection_range(text: &Rope, range: &Range<usize>) -> Result<(), SyntaxError> {
    if range.start > range.end || range.end > text.len_bytes() {
        return Err(SyntaxError::InvalidSelectionRange {
            start: range.start,
            end: range.end,
            document_len: text.len_bytes(),
        });
    }
    for offset in [range.start, range.end] {
        if text.char_to_byte(text.byte_to_char(offset)) != offset {
            return Err(SyntaxError::InvalidSelectionBoundary { offset });
        }
    }
    Ok(())
}

fn validated_edits<'a>(
    text: &Rope,
    edits: &'a [SyntaxEdit],
) -> Result<Vec<&'a SyntaxEdit>, SyntaxError> {
    let mut edits = edits.iter().collect::<Vec<_>>();
    for edit in &edits {
        validate_edit(text, edit)?;
    }
    edits.sort_by_key(|edit| (Reverse(edit.range.start), Reverse(edit.range.end)));
    for pair in edits.windows(2) {
        let later = pair[0];
        let earlier = pair[1];
        if earlier.range.end > later.range.start
            || (earlier.range.start == later.range.start
                && (earlier.range.is_empty() || later.range.is_empty()))
        {
            return Err(SyntaxError::OverlappingEdits);
        }
    }
    Ok(edits)
}

fn advance_point(start: SyntaxPoint, text: &str) -> SyntaxPoint {
    let newline_count = text.bytes().filter(|byte| *byte == b'\n').count();
    let column = match text.rfind('\n') {
        Some(index) => text.len() - index - 1,
        None => start.column + text.len(),
    };
    SyntaxPoint {
        row: start.row + newline_count,
        column,
    }
}

fn collect_tokens(query: &Query, tree: &Tree, text: &Rope, limit: usize) -> Vec<SyntaxToken> {
    if limit == 0 {
        return Vec::new();
    }
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(query, tree.root_node(), RopeTextProvider(text.slice(..)));
    let mut tokens = Vec::new();
    while let Some((query_match, capture_index)) = captures.next() {
        let capture = query_match.captures[*capture_index];
        let Some(kind) = token_kind(capture_names[capture.index as usize]) else {
            continue;
        };
        tokens.push(SyntaxToken {
            range: syntax_range(capture.node),
            kind,
        });
        if tokens.len() == limit {
            break;
        }
    }
    tokens.sort_by_key(|token| (token.range.bytes.start, Reverse(token.range.bytes.end)));
    tokens.dedup();
    tokens
}

fn token_kind(capture_name: &str) -> Option<SyntaxTokenKind> {
    if capture_name.starts_with("keyword.operator.") {
        return Some(SyntaxTokenKind::Operator);
    }
    let root = capture_name.split('.').next().unwrap_or(capture_name);
    match root {
        "attribute" => Some(SyntaxTokenKind::Attribute),
        "comment" => Some(SyntaxTokenKind::Comment),
        "constant" => Some(SyntaxTokenKind::Constant),
        "constructor" => Some(SyntaxTokenKind::Constructor),
        "embedded" => Some(SyntaxTokenKind::Embedded),
        "function" | "method" => Some(SyntaxTokenKind::Function),
        "keyword" => Some(SyntaxTokenKind::Keyword),
        "label" => Some(SyntaxTokenKind::Label),
        "module" | "namespace" => Some(SyntaxTokenKind::Module),
        "number" | "float" => Some(SyntaxTokenKind::Number),
        "operator" => Some(SyntaxTokenKind::Operator),
        "property" => Some(SyntaxTokenKind::Property),
        "punctuation" => Some(SyntaxTokenKind::Punctuation),
        "string" | "character" | "escape" => Some(SyntaxTokenKind::String),
        "type" => Some(SyntaxTokenKind::Type),
        "variable" => Some(SyntaxTokenKind::Variable),
        _ => None,
    }
}

fn collect_folding_ranges(
    tree: &Tree,
    query: &Query,
    text: &Rope,
    limit: usize,
) -> Vec<FoldingRange> {
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(query, tree.root_node(), RopeTextProvider(text.slice(..)));
    let mut ranges = Vec::new();
    while let Some((matched, index)) = captures.next() {
        if ranges.len() >= limit {
            break;
        }
        let node = matched.captures[*index].node;
        let end = node.end_position();
        let last_row = end.row.saturating_sub(usize::from(end.column == 0));
        if node.start_position().row < last_row {
            ranges.push(FoldingRange {
                range: syntax_range(node),
            });
        }
    }
    ranges.sort_by_key(|range| (range.range.bytes.start, range.range.bytes.end));
    ranges
}

fn collect_selection_ranges(
    tree: &Tree,
    requested: Range<usize>,
    limit: usize,
) -> Vec<SelectionRange> {
    if limit == 0 {
        return Vec::new();
    }
    let lookup_end = requested
        .end
        .saturating_sub(usize::from(!requested.is_empty()));
    let root = tree.root_node();
    let Some(mut node) = root.named_descendant_for_byte_range(requested.start, lookup_end) else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    loop {
        if node.parent().is_some()
            && node.is_named()
            && !node.is_error()
            && !node.is_missing()
            && node.start_byte() < node.end_byte()
            && node.start_byte() <= requested.start
            && requested.end <= node.end_byte()
        {
            ranges.push(SelectionRange {
                range: syntax_range(node),
            });
            if ranges.len() == limit {
                break;
            }
        }
        let Some(parent) = node.parent() else {
            break;
        };
        node = parent;
    }
    ranges.dedup_by(|left, right| left.range.bytes == right.range.bytes);
    ranges
}

fn collect_symbols(
    cursor: &mut QueryCursor,
    query: &Query,
    root: Node<'_>,
    text: &Rope,
    limit: usize,
) -> Vec<DocumentSymbol> {
    if limit == 0 {
        return Vec::new();
    }
    let capture_names = query.capture_names();
    let mut matches = cursor.matches(query, root, RopeTextProvider(text.slice(..)));
    let mut symbols = Vec::new();
    while let Some(query_match) = matches.next() {
        let mut definition = None;
        let mut name_node = None;
        for capture in query_match.captures {
            let capture_name = capture_names[capture.index as usize];
            if let Some(kind) = symbol_kind(capture_name) {
                definition = Some((kind, capture.node));
            } else if capture_name == "name" {
                name_node = Some(capture.node);
            }
        }
        let (Some((kind, definition_node)), Some(name_node)) = (definition, name_node) else {
            continue;
        };
        let Some(name) = text.get_byte_slice(name_node.byte_range()) else {
            continue;
        };
        symbols.push(DocumentSymbol {
            name: name.to_string(),
            kind,
            range: syntax_range(definition_node),
            selection_range: syntax_range(name_node),
        });
        if symbols.len() == limit {
            break;
        }
    }
    symbols.sort_by_key(|symbol| {
        (
            symbol.selection_range.bytes.start,
            symbol.selection_range.bytes.end,
            symbol.kind,
        )
    });
    symbols.dedup();
    symbols
}

fn symbol_kind(capture_name: &str) -> Option<DocumentSymbolKind> {
    let definition = capture_name.strip_prefix("definition.")?;
    match definition {
        "constant" => Some(DocumentSymbolKind::Constant),
        "enum" => Some(DocumentSymbolKind::Enum),
        "field" | "property" => Some(DocumentSymbolKind::Field),
        "function" => Some(DocumentSymbolKind::Function),
        "macro" => Some(DocumentSymbolKind::Macro),
        "method" => Some(DocumentSymbolKind::Method),
        "module" => Some(DocumentSymbolKind::Module),
        "static" => Some(DocumentSymbolKind::Static),
        "class" | "struct" => Some(DocumentSymbolKind::Struct),
        "trait" | "interface" => Some(DocumentSymbolKind::Trait),
        "type" => Some(DocumentSymbolKind::Type),
        "variable" => Some(DocumentSymbolKind::Variable),
        _ => None,
    }
}

fn collect_diagnostics(tree: &Tree, limit: usize) -> Vec<SyntaxDiagnostic> {
    let mut diagnostics = Vec::new();
    visit_nodes(tree.root_node(), &mut |node| {
        if diagnostics.len() < limit && (node.is_error() || node.is_missing()) {
            diagnostics.push(SyntaxDiagnostic {
                range: syntax_range(node),
                kind: if node.is_missing() {
                    SyntaxDiagnosticKind::Missing
                } else {
                    SyntaxDiagnosticKind::Error
                },
            });
        }
    });
    diagnostics
        .sort_by_key(|diagnostic| (diagnostic.range.bytes.start, diagnostic.range.bytes.end));
    diagnostics
}

fn visit_nodes(mut node: Node<'_>, visitor: &mut impl FnMut(Node<'_>)) {
    visitor(node);
    let mut cursor = node.walk();
    if !cursor.goto_first_child() {
        return;
    }
    loop {
        node = cursor.node();
        visit_nodes(node, visitor);
        if !cursor.goto_next_sibling() {
            break;
        }
    }
}

fn syntax_range(node: Node<'_>) -> SyntaxRange {
    let start = node.start_position();
    let end = node.end_position();
    SyntaxRange {
        bytes: node.byte_range(),
        start: SyntaxPoint {
            row: start.row,
            column: start.column,
        },
        end: SyntaxPoint {
            row: end.row,
            column: end.column,
        },
    }
}
