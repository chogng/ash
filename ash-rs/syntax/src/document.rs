use std::cmp::Reverse;
use std::ops::Range;

use tree_sitter::{InputEdit, Node, Parser, Point, Query, QueryCursor, StreamingIterator, Tree};

use crate::language::LanguageConfiguration;
use crate::{
    AnalysisLimits, DocumentSymbol, DocumentSymbolKind, FoldingRange, SelectionRange,
    SyntaxDiagnostic, SyntaxDiagnosticKind, SyntaxError, SyntaxLanguage, SyntaxPoint, SyntaxRange,
    SyntaxSnapshot, SyntaxToken, SyntaxTokenKind,
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
    text: String,
    line_index: LineIndex,
    parser: Parser,
    tree: Tree,
    configuration: LanguageConfiguration,
    limits: AnalysisLimits,
}

impl SyntaxDocument {
    pub fn open(
        language: SyntaxLanguage,
        revision: DocumentRevision,
        text: impl Into<String>,
    ) -> Result<Self, SyntaxError> {
        Self::open_with_limits(language, revision, text, AnalysisLimits::default())
    }

    pub fn open_with_limits(
        language: SyntaxLanguage,
        revision: DocumentRevision,
        text: impl Into<String>,
        limits: AnalysisLimits,
    ) -> Result<Self, SyntaxError> {
        let text = text.into();
        validate_document_size(text.len(), limits)?;
        let mut parser = Parser::new();
        let configuration = LanguageConfiguration::load(language, &mut parser)?;
        let tree = parser
            .parse(&text, None)
            .ok_or(SyntaxError::ParseCancelled)?;
        let line_index = LineIndex::new(&text);
        Ok(Self {
            language,
            revision,
            text,
            line_index,
            parser,
            tree,
            configuration,
            limits,
        })
    }

    pub const fn language(&self) -> SyntaxLanguage {
        self.language
    }

    pub const fn revision(&self) -> DocumentRevision {
        self.revision
    }

    pub fn text(&self) -> &str {
        &self.text
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
            collect_folding_ranges(&self.tree, self.limits.max_folding_ranges),
            collect_symbols(
                &self.configuration.tags,
                &self.tree,
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
        let next_len = self.text.len() - removed_len + replacement_len;
        validate_document_size(next_len, self.limits)?;

        let mut edited_tree = self.tree.clone();
        let mut next_text = self.text.clone();
        let mut next_line_index = self.line_index.clone();
        for edit in edits {
            let start_point = self.line_index.point(edit.range.start);
            let old_end_point = self.line_index.point(edit.range.end);
            let new_end_point = advance_point(start_point, &edit.replacement);
            edited_tree.edit(&InputEdit {
                start_byte: edit.range.start,
                old_end_byte: edit.range.end,
                new_end_byte: edit.range.start + edit.replacement.len(),
                start_position: start_point.into(),
                old_end_position: old_end_point.into(),
                new_end_position: new_end_point.into(),
            });
            next_text.replace_range(edit.range.clone(), &edit.replacement);
            next_line_index.apply_edit(edit.range.clone(), &edit.replacement);
        }
        let tree = self
            .parser
            .parse(&next_text, Some(&edited_tree))
            .ok_or(SyntaxError::ParseCancelled)?;

        self.text = next_text;
        self.line_index = next_line_index;
        self.tree = tree;
        self.revision = next_revision;
        Ok(self.snapshot())
    }
}

#[derive(Clone, Debug)]
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(
            text.bytes()
                .enumerate()
                .filter_map(|(index, byte)| (byte == b'\n').then_some(index + 1)),
        );
        Self { starts }
    }

    fn point(&self, offset: usize) -> SyntaxPoint {
        let row = self
            .starts
            .partition_point(|line_start| *line_start <= offset)
            .saturating_sub(1);
        SyntaxPoint {
            row,
            column: offset - self.starts[row],
        }
    }

    fn apply_edit(&mut self, range: Range<usize>, replacement: &str) {
        let removed_len = range.len();
        let replacement_len = replacement.len();
        self.starts
            .retain(|line_start| *line_start <= range.start || *line_start > range.end);
        for line_start in &mut self.starts {
            if *line_start > range.end {
                *line_start = if replacement_len >= removed_len {
                    *line_start + (replacement_len - removed_len)
                } else {
                    *line_start - (removed_len - replacement_len)
                };
            }
        }
        let replacement_starts = replacement
            .bytes()
            .enumerate()
            .filter_map(|(index, byte)| (byte == b'\n').then_some(range.start + index + 1));
        self.starts.extend(replacement_starts);
        self.starts.sort_unstable();
        self.starts.dedup();
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

fn validate_edit(text: &str, edit: &SyntaxEdit) -> Result<(), SyntaxError> {
    if edit.range.start > edit.range.end || edit.range.end > text.len() {
        return Err(SyntaxError::InvalidEditRange {
            start: edit.range.start,
            end: edit.range.end,
            document_len: text.len(),
        });
    }
    for offset in [edit.range.start, edit.range.end] {
        if !text.is_char_boundary(offset) {
            return Err(SyntaxError::InvalidEditBoundary { offset });
        }
    }
    Ok(())
}

fn validate_selection_range(text: &str, range: &Range<usize>) -> Result<(), SyntaxError> {
    if range.start > range.end || range.end > text.len() {
        return Err(SyntaxError::InvalidSelectionRange {
            start: range.start,
            end: range.end,
            document_len: text.len(),
        });
    }
    for offset in [range.start, range.end] {
        if !text.is_char_boundary(offset) {
            return Err(SyntaxError::InvalidSelectionBoundary { offset });
        }
    }
    Ok(())
}

fn validated_edits<'a>(
    text: &str,
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

fn collect_tokens(query: &Query, tree: &Tree, text: &str, limit: usize) -> Vec<SyntaxToken> {
    if limit == 0 {
        return Vec::new();
    }
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(query, tree.root_node(), text.as_bytes());
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

fn collect_folding_ranges(tree: &Tree, limit: usize) -> Vec<FoldingRange> {
    let mut ranges = Vec::new();
    visit_nodes(tree.root_node(), &mut |node| {
        if ranges.len() < limit
            && node.start_position().row < node.end_position().row
            && is_foldable(node.kind())
        {
            ranges.push(FoldingRange {
                range: syntax_range(node),
            });
        }
    });
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

fn is_foldable(kind: &str) -> bool {
    matches!(
        kind,
        "block"
            | "array"
            | "class_body"
            | "declaration_list"
            | "enum_variant_list"
            | "enum_body"
            | "field_declaration_list"
            | "interface_body"
            | "jsx_element"
            | "match_block"
            | "object"
            | "object_type"
            | "statement_block"
            | "switch_body"
            | "token_tree"
            | "use_list"
    )
}

fn collect_symbols(query: &Query, tree: &Tree, text: &str, limit: usize) -> Vec<DocumentSymbol> {
    if limit == 0 {
        return Vec::new();
    }
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, tree.root_node(), text.as_bytes());
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
        let Ok(name) = name_node.utf8_text(text.as_bytes()) else {
            continue;
        };
        symbols.push(DocumentSymbol {
            name: name.to_owned(),
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
        "field" => Some(DocumentSymbolKind::Field),
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
