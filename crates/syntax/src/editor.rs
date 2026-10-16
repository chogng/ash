//! Viewport queries over the document's existing tree. No editor transactions live here.
use super::ParsedEdit;
use super::RopeTextProvider;
use super::SyntaxDiagnostic;
use super::SyntaxDiagnosticKind;
use super::SyntaxDocument;
use super::SyntaxEdit;
use super::SyntaxError;
use super::SyntaxPoint;
use super::SyntaxRange;
use super::collect_symbols;
use super::parse_edits;
use super::point_at;
use super::syntax_range;
use ash_language::FoldingMarker;
use ash_language::FoldingRules;
use ropey::Rope;
use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;
use tree_sitter::Node;
use tree_sitter::Point;
use tree_sitter::QueryCursor;
use tree_sitter::StreamingIterator;
use tree_sitter::Tree;

impl From<Point> for SyntaxPoint {
    fn from(point: Point) -> Self {
        Self {
            row: point.row,
            column: point.column,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorToken {
    /// Editor configuration ID for embedded text; the host language is otherwise implied.
    pub language_id: Option<&'static str>,
    pub start: usize,
    pub end: usize,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorRow {
    pub row: usize,
    pub tokens: Vec<EditorToken>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorFold {
    pub start_line_index: usize,
    pub end_line_index: usize,
    pub kind: Option<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorBracket {
    pub range: SyntaxRange,
    pub opening: SyntaxRange,
    pub closing: Option<SyntaxRange>,
    pub text: String,
    pub close_text: Option<String>,
    pub level: usize,
    pub equal_level: usize,
    pub min_indent: i64,
}

/// Editor coordinates are zero-based UTF-16 columns. Each cached subtree stores
/// them relative to its origin, so moving a subtree never re-reads its text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorSymbol {
    pub name: String,
    pub kind: super::DocumentSymbolKind,
    pub range: [usize; 4],
    pub selection_range: [usize; 4],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorDiagnostic {
    pub range: [usize; 4],
    pub kind: SyntaxDiagnosticKind,
}

#[derive(Debug)]
pub struct EditorFactsSplice<T> {
    pub start: usize,
    pub delete_count: usize,
    pub items: Vec<T>,
}

#[derive(Debug)]
pub struct EditorFactsDelta {
    pub symbols: EditorFactsSplice<EditorSymbol>,
    pub folds: EditorFactsSplice<EditorFold>,
    pub diagnostics: EditorFactsSplice<EditorDiagnostic>,
}

/// Immutable facts share unchanged subtrees across revisions. Only the changed
/// middle is expanded when producing a patch; a full request expands once.
pub struct EditorFacts {
    revision: super::DocumentRevision,
    tab_size: usize,
    tree: Tree,
    text: Rope,
    nodes: Vec<Arc<NodeFacts>>,
    folds: Arc<Vec<EditorFold>>,
    offsets: Vec<(usize, usize)>,
    change: Option<FactChange>,
    limits: super::AnalysisLimits,
}

struct FactWindow {
    old: Range<usize>,
    new: Range<usize>,
}

struct FactChange {
    base: super::DocumentRevision,
    left: usize,
    old_right: usize,
    right: usize,
}

impl EditorFacts {
    pub fn revision(&self) -> super::DocumentRevision {
        self.revision
    }

    /// Edits describe the consumer's base followed by descending replacements
    /// in each intermediate version, using zero-based UTF-16 positions.
    pub fn delta(&self, previous: Option<&Self>, edits: &[[usize; 6]]) -> EditorFactsDelta {
        let mut prefix = 0;
        let mut suffix = 0;
        if let Some(previous) = previous {
            // An insertion exactly on a cached range boundary has right affinity
            // in the editor. Include touching subtrees even when their IDs survive.
            // Positions from any intermediate revision differ from base rows by
            // at most the sum of row deltas; this envelope is conservative.
            let movement = edits.iter().map(|e| e[4].abs_diff(e[2])).sum::<usize>();
            let dirty = edits.iter().map(|e| e[0]).min().map(|start| {
                start.saturating_sub(movement)
                    ..=edits
                        .iter()
                        .map(|e| e[2].max(e[4]))
                        .max()
                        .unwrap()
                        .saturating_add(movement)
            });
            let root = previous.tree.root_node();
            let unsafe_nodes = if let Some(first) = edits.first().filter(|first| {
                edits
                    .iter()
                    .all(|edit| edit[0] == first[0] && edit[2] == first[0] && edit[4] == first[0])
            }) {
                // Keep a minified line incremental too. Intermediate columns can
                // move by at most the total inserted/deleted UTF-16 width.
                let movement = edits
                    .iter()
                    .map(|edit| edit[5].abs_diff(edit[3]))
                    .sum::<usize>();
                let start = [
                    first[0],
                    edits
                        .iter()
                        .map(|edit| edit[1])
                        .min()
                        .unwrap()
                        .saturating_sub(movement),
                ];
                let end = [
                    first[0],
                    edits
                        .iter()
                        .map(|edit| edit[3].max(edit[5]))
                        .max()
                        .unwrap()
                        .saturating_add(movement),
                ];
                child_boundary(root, |node| {
                    previous.utf16_point(node.end_position()) < start
                })..child_boundary(root, |node| {
                    previous.utf16_point(node.start_position()) <= end
                })
            } else {
                dirty
                    .map(|rows| {
                        child_boundary(root, |node| node.end_position().row < *rows.start())
                            ..child_boundary(root, |node| node.start_position().row <= *rows.end())
                    })
                    .unwrap_or(0..0)
            };
            if let Some(change) = &self.change {
                if change.base == previous.revision {
                    prefix = change.left.min(unsafe_nodes.start);
                    suffix = (previous.nodes.len() - change.old_right)
                        .min(previous.nodes.len() - unsafe_nodes.end);
                    // The cache proved these outside intervals unchanged. Only
                    // included boundary neighbors need identity comparisons.
                    debug_assert_eq!(
                        previous.nodes.len() - change.old_right,
                        self.nodes.len() - change.right
                    );
                }
            }
            while prefix < previous.nodes.len().min(self.nodes.len()) - suffix
                && !unsafe_nodes.contains(&prefix)
                && Arc::ptr_eq(&previous.nodes[prefix], &self.nodes[prefix])
            {
                prefix += 1;
            }
            while suffix < (previous.nodes.len() - prefix).min(self.nodes.len() - prefix) {
                let old = previous.nodes.len() - suffix - 1;
                let new = self.nodes.len() - suffix - 1;
                if unsafe_nodes.contains(&old)
                    || !Arc::ptr_eq(&previous.nodes[old], &self.nodes[new])
                {
                    break;
                }
                suffix += 1;
            }
        }
        let symbols = self.node_splice(
            (prefix, suffix, self.limits.max_symbols),
            (
                self.offsets.last().unwrap().0,
                previous.map_or(0, |facts| facts.offsets.last().unwrap().0),
                self.offsets[prefix].0,
                self.offsets.last().unwrap().0 - self.offsets[self.nodes.len() - suffix].0,
            ),
            |node| &node.symbols,
            |symbol, origin| {
                let mut symbol = symbol.clone();
                place_range(&mut symbol.range, origin);
                place_range(&mut symbol.selection_range, origin);
                symbol
            },
        );
        let diagnostics_full = self.tree.root_node().is_error()
            || previous.is_some_and(|facts| facts.tree.root_node().is_error());
        let mut diagnostics = self.node_splice(
            (
                if diagnostics_full { 0 } else { prefix },
                if diagnostics_full { 0 } else { suffix },
                self.limits.max_diagnostics,
            ),
            (
                self.offsets.last().unwrap().1,
                previous.map_or(0, |facts| facts.offsets.last().unwrap().1),
                self.offsets[if diagnostics_full { 0 } else { prefix }].1,
                if diagnostics_full {
                    0
                } else {
                    self.offsets.last().unwrap().1 - self.offsets[self.nodes.len() - suffix].1
                },
            ),
            |node| &node.diagnostics,
            |diagnostic, origin| {
                let mut diagnostic = diagnostic.clone();
                place_range(&mut diagnostic.range, origin);
                diagnostic
            },
        );
        if diagnostics_full {
            if let Some(previous) = previous {
                diagnostics.delete_count = (previous.offsets.last().unwrap().1
                    + usize::from(previous.tree.root_node().is_error()))
                .min(self.limits.max_diagnostics);
            }
            if self.tree.root_node().is_error() && self.limits.max_diagnostics > 0 {
                let root = self.tree.root_node();
                let end = root.end_position();
                diagnostics.items.insert(
                    0,
                    EditorDiagnostic {
                        kind: SyntaxDiagnosticKind::Error,
                        range: [
                            root.start_position().row,
                            self.text
                                .line(root.start_position().row)
                                .byte_slice(..root.start_position().column)
                                .len_utf16_cu(),
                            end.row,
                            self.text
                                .line(end.row)
                                .byte_slice(..end.column)
                                .len_utf16_cu(),
                        ],
                    },
                );
                diagnostics.items.truncate(self.limits.max_diagnostics);
            }
        }
        let old_folds = previous
            .map(|facts| facts.folds.as_slice())
            .unwrap_or_default();
        let folds = if previous.is_some_and(|facts| Arc::ptr_eq(&facts.folds, &self.folds))
            && edits.iter().all(|edit| edit[2] == edit[4])
        {
            EditorFactsSplice {
                start: old_folds.len(),
                delete_count: 0,
                items: Vec::new(),
            }
        } else {
            // Row-changing edits affect suffix coordinates. Compare them lazily;
            // do not clone and rewrite the entire acknowledged facts snapshot.
            let shifted = |fold: &EditorFold| {
                let mut fold = fold.clone();
                for edit in edits {
                    fold.start_line_index = shift_row(fold.start_line_index, *edit);
                    fold.end_line_index = shift_row(fold.end_line_index, *edit);
                }
                fold
            };
            let start = old_folds
                .iter()
                .zip(self.folds.iter())
                .take_while(|(old, new)| shifted(old) == **new)
                .count();
            let end = old_folds[start..]
                .iter()
                .rev()
                .zip(self.folds[start..].iter().rev())
                .take_while(|(old, new)| shifted(old) == **new)
                .count();
            EditorFactsSplice {
                start,
                delete_count: old_folds.len() - start - end,
                items: self.folds[start..self.folds.len() - end].to_vec(),
            }
        };
        EditorFactsDelta {
            symbols,
            folds,
            diagnostics,
        }
    }

    fn utf16_point(&self, point: Point) -> [usize; 2] {
        if point.column == 0 {
            return [point.row, 0];
        }
        [
            point.row,
            self.text
                .line(point.row)
                .byte_slice(..point.column)
                .len_utf16_cu(),
        ]
    }

    fn node_splice<T: Clone>(
        &self,
        (prefix, mut suffix, limit): (usize, usize, usize),
        (total, old_total, prefix_count, suffix_count): (usize, usize, usize, usize),
        values: impl Fn(&NodeFacts) -> &[T],
        place: impl Fn(&T, [usize; 2]) -> T,
    ) -> EditorFactsSplice<T> {
        if total == 0 {
            return EditorFactsSplice {
                start: 0,
                delete_count: old_total.min(limit),
                items: Vec::new(),
            };
        }
        let start = prefix_count.min(limit);
        let old_len = old_total.min(limit);
        // A cap can cut a shared subtree at different items after an insertion.
        // Preserve the common prefix, but include the bounded tail in that case.
        if old_total >= limit || total >= limit {
            suffix = 0;
        }
        let end = if suffix == 0 { 0 } else { suffix_count };
        let mut items = Vec::new();
        let root = self.tree.root_node();
        let mut cursor = root.walk();
        let mut children = root.children(&mut cursor);
        let full = prefix == 0 && suffix == 0;
        let mut next_child = 0;
        for index in prefix..self.nodes.len() - suffix {
            if start + items.len() == limit {
                break;
            }
            let node_values = values(&self.nodes[index]);
            if node_values.is_empty() {
                continue;
            }
            // Full requests walk siblings once; local patches use indexed access
            // and never walk the prefix to reach an edit near EOF.
            let node = if full {
                let node = children.nth(index - next_child).unwrap();
                next_child = index + 1;
                node
            } else {
                root.child(index as u32).unwrap()
            };
            let origin = self.utf16_point(node.start_position());
            items.extend(
                node_values
                    .iter()
                    .take(limit - start - items.len())
                    .map(|item| place(item, origin)),
            );
        }
        EditorFactsSplice {
            start,
            delete_count: old_len - start - end,
            items,
        }
    }
}

fn place_range(range: &mut [usize; 4], origin: [usize; 2]) {
    for index in [0, 2] {
        if range[index] == 0 {
            range[index + 1] += origin[1];
        }
        range[index] += origin[0];
    }
}

// Tree-sitter's indexed child lookup avoids walking every sibling to locate an
// edit. Include touching children because names and error recovery can cross it.
fn child_boundary(root: Node<'_>, before: impl Fn(Node<'_>) -> bool) -> usize {
    let mut low = 0;
    let mut high = root.child_count() as usize;
    while low < high {
        let middle = low + (high - low) / 2;
        if before(root.child(middle as u32).unwrap()) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn shift_row(row: usize, edit: [usize; 6]) -> usize {
    if row < edit[0] || row == edit[0] && edit[1] > 0 {
        row
    } else if row < edit[2] || row == edit[2] && edit[3] > 0 {
        edit[0]
    } else {
        row - edit[2] + edit[4]
    }
}

impl SyntaxDocument {
    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    /// Converts a parser-owned byte column on one known row to the editor's UTF-16 column.
    pub fn utf16_column(&self, point: SyntaxPoint) -> usize {
        if point.column == 0 {
            return 0;
        }
        // Most lines fit in one Rope chunk. Slice that line before counting UTF-16,
        // avoiding a second lookup from the document root for every output field.
        self.text
            .line(point.row)
            .byte_slice(..point.column)
            .len_utf16_cu()
    }

    pub(super) fn line(&self, row: usize) -> Cow<'_, str> {
        let line = self.text.line(row);
        let mut end = line.len_bytes();
        while end > 0 && matches!(line.byte(end - 1), b'\r' | b'\n') {
            end -= 1;
        }
        line.byte_slice(..end).into()
    }

    /// Row coordinates and capture columns are UTF-16; parsing stays UTF-8 internally.
    pub fn editor_highlight(
        &self,
        rows: Range<usize>,
        cancelled: &impl Fn() -> bool,
    ) -> Result<Vec<EditorRow>, SyntaxError> {
        self.highlight_with_injections(rows, cancelled, 0)
    }

    pub(super) fn highlight_with_injections(
        &self,
        rows: Range<usize>,
        cancelled: &impl Fn() -> bool,
        depth: usize,
    ) -> Result<Vec<EditorRow>, SyntaxError> {
        let query = &self.configuration.editor_highlights;
        let mut cursor = QueryCursor::new();
        cursor.set_point_range(Point::new(rows.start, 0)..Point::new(rows.end, 0));
        let mut captures = cursor.captures(
            query,
            self.tree.root_node(),
            RopeTextProvider(self.text.slice(..)),
        );
        let mut lines = vec![Vec::new(); rows.len()];
        let mut text_lines = vec![None; rows.len()];
        let included = self.parser.included_ranges();
        while let Some((matched, index)) = captures.next() {
            if cancelled() {
                return Err(SyntaxError::ParseCancelled);
            }
            let capture = matched.captures[*index];
            let name = query.capture_names()[capture.index as usize];
            if name.starts_with('_') || matches!(name, "spell" | "nospell") {
                continue;
            }
            let node = capture.node;
            for row in
                rows.start.max(node.start_position().row)..rows.end.min(node.end_position().row + 1)
            {
                let line = text_lines[row - rows.start].get_or_insert_with(|| self.line(row));
                let start = if row == node.start_position().row {
                    node.start_position().column
                } else {
                    0
                };
                let end = if row == node.end_position().row {
                    node.end_position().column.min(line.len())
                } else {
                    line.len()
                };
                // A capture can span excluded bytes between included ranges. Never
                // paint host delimiters such as Diff's +/- markers as embedded code.
                let segments = if depth == 0 {
                    vec![(start, end)]
                } else {
                    included
                        .iter()
                        .filter_map(|range| {
                            if row < range.start_point.row || row > range.end_point.row {
                                return None;
                            }
                            let from = if row == range.start_point.row {
                                range.start_point.column
                            } else {
                                0
                            };
                            let to = if row == range.end_point.row {
                                range.end_point.column
                            } else {
                                line.len()
                            };
                            Some((start.max(from), end.min(to)))
                        })
                        .collect()
                };
                for (start, end) in segments {
                    if start < end {
                        lines[row - rows.start].push((
                            line[..start].encode_utf16().count(),
                            line[..end].encode_utf16().count(),
                            matched.pattern_index,
                            query.capture_names()[capture.index as usize],
                        ));
                    }
                }
            }
        }
        let mut result: Vec<EditorRow> = lines
            .into_iter()
            .enumerate()
            .map(|(index, captures)| {
                let boundaries = captures
                    .iter()
                    .flat_map(|(start, end, _, _)| [*start, *end])
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                let mut tokens: Vec<EditorToken> = Vec::new();
                for segment in boundaries.windows(2) {
                    let winner = captures
                        .iter()
                        .enumerate()
                        .filter(|(_, (start, end, _, _))| {
                            *start <= segment[0] && *end >= segment[1]
                        })
                        .max_by_key(|(order, (_, _, priority, _))| (*priority, *order));
                    if let Some((_, (_, _, _, name))) = winner {
                        if let Some(last) = tokens
                            .last_mut()
                            .filter(|last| last.end == segment[0] && last.name == *name)
                        {
                            last.end = segment[1];
                        } else {
                            tokens.push(EditorToken {
                                language_id: (depth > 0).then(|| self.language.editor_id()),
                                start: segment[0],
                                end: segment[1],
                                name: (*name).into(),
                            });
                        }
                    }
                }
                EditorRow {
                    row: rows.start + index,
                    tokens,
                }
            })
            .collect();
        self.highlight_injections(&mut result, cancelled, depth)?;
        Ok(result)
    }

    /// Rebuilds only the edited top-level interval. Unchanged facts retain their
    /// UTF-16 coordinates relative to the subtree and share storage with the
    /// consumer's acknowledged revision.
    pub fn editor_facts(
        &self,
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<Arc<EditorFacts>, SyntaxError> {
        if cancelled() {
            return Err(SyntaxError::ParseCancelled);
        }
        let mut cache = self.editor_cache.borrow_mut();
        if cache
            .result
            .as_ref()
            .is_some_and(|facts| facts.revision == self.revision && facts.tab_size == tab_size)
        {
            return Ok(Arc::clone(cache.result.as_ref().unwrap()));
        }
        let root = self.tree.root_node();
        let previous = cache.result.clone();
        let mut windows: Vec<FactWindow> = Vec::new();
        if let (Some(old), Some(tree)) = (&previous, &cache.tree) {
            let mut ranges = cache.dirty.clone();

            ranges.sort_by_key(|range| range.start);
            let old_root = tree.root_node();
            for range in ranges {
                let window = FactWindow {
                    old: child_boundary(old_root, |node| node.end_byte() < range.start)
                        .saturating_sub(1)
                        ..(child_boundary(old_root, |node| node.start_byte() <= range.end) + 1)
                            .min(old.nodes.len()),
                    new: child_boundary(root, |node| node.end_byte() < range.start)
                        .saturating_sub(1)
                        ..(child_boundary(root, |node| node.start_byte() <= range.end) + 1)
                            .min(root.child_count() as usize),
                };
                if let Some(last) = windows.last_mut().filter(|last| {
                    window.old.start <= last.old.end || window.new.start <= last.new.end
                }) {
                    last.old.end = last.old.end.max(window.old.end);
                    last.new.end = last.new.end.max(window.new.end);
                } else {
                    windows.push(window);
                }
            }
            let mut old_end = 0;
            let mut new_end = 0;
            let aligned = windows.iter().all(|window| {
                let aligned = window.old.start - old_end == window.new.start - new_end;
                old_end = window.old.end;
                new_end = window.new.end;
                aligned
            }) && old.nodes.len() - old_end == root.child_count() as usize - new_end;
            if !aligned {
                // Error recovery can join otherwise separate scopes. Fall back to
                // the enclosing root when sibling gaps no longer correspond.
                windows = vec![FactWindow {
                    old: 0..old.nodes.len(),
                    new: 0..root.child_count() as usize,
                }];
            }
        } else {
            windows.push(FactWindow {
                old: 0..0,
                new: 0..root.child_count() as usize,
            });
        }
        let left = windows.first().map_or_else(
            || previous.as_ref().map_or(0, |old| old.nodes.len()),
            |window| window.old.start,
        );
        let old_right = windows.last().map_or(left, |window| window.old.end);
        let right = windows.last().map_or(left, |window| window.new.end);
        let mut nodes = Vec::with_capacity(root.child_count() as usize);
        // A cursor retains its query allocations across sibling subtrees.
        let mut symbol_cursor = QueryCursor::new();
        let mut old_end = 0;
        for window in &windows {
            if let Some(old) = &previous {
                nodes.extend_from_slice(&old.nodes[old_end..window.old.start]);
            }
            let mut old_ids = None;
            let mut cursor = root.walk();
            let mut children = root.children(&mut cursor);
            let full = window.new.start == 0 && window.new.end == root.child_count() as usize;
            for index in window.new.clone() {
                if (index - window.new.start) % 128 == 0 && cancelled() {
                    return Err(SyntaxError::ParseCancelled);
                }
                let node = if full {
                    children.next().unwrap()
                } else {
                    root.child(index as u32).unwrap()
                };
                let old = previous.as_ref().and_then(|old| {
                    let root = old.tree.root_node();
                    let ids = old_ids.get_or_insert_with(|| {
                        window
                            .old
                            .clone()
                            .map(|index| (root.child(index as u32).unwrap().id(), index))
                            .collect::<HashMap<_, _>>()
                    });
                    ids.get(&node.id()).map(|index| &old.nodes[*index])
                });
                let facts = if let Some(facts) = old {
                    Arc::clone(facts)
                } else if let Some(facts) = cache.pending.get(&node.id()) {
                    Arc::clone(facts)
                } else {
                    let facts =
                        Arc::new(self.collect_editor_node(node, &mut symbol_cursor, cancelled)?);
                    cache.pending.insert(node.id(), Arc::clone(&facts));
                    facts
                };
                nodes.push(facts);
            }
            old_end = window.old.end;
        }
        if let Some(old) = &previous {
            nodes.extend_from_slice(&old.nodes[old_end..]);
        }
        let line_folds = cache.lines.update(self, tab_size, cancelled)?;
        let parser_folds_unchanged = previous.as_ref().is_some_and(|old| {
            !cache.rows_moved
                && old.nodes.len() == nodes.len()
                && (left..right).all(|i| old.nodes[i].folds == nodes[i].folds)
        });
        let folds = if parser_folds_unchanged && Arc::ptr_eq(&line_folds, &cache.line_folds) {
            Arc::clone(&previous.as_ref().unwrap().folds)
        } else {
            let mut folds = Vec::new();
            let mut cursor = root.walk();
            for (tree_node, node) in root.children(&mut cursor).zip(&nodes) {
                if folds.len() == self.limits.max_folding_ranges {
                    break;
                }
                if node.folds.is_empty() {
                    continue;
                }
                let row = tree_node.start_position().row;
                folds.extend(
                    node.folds
                        .iter()
                        .take(self.limits.max_folding_ranges - folds.len())
                        .map(|fold| EditorFold {
                            start_line_index: row + fold.start_line_index,
                            end_line_index: row + fold.end_line_index,
                            kind: fold.kind,
                        }),
                );
            }
            let structural_starts = folds
                .iter()
                .map(|fold| fold.start_line_index)
                .collect::<BTreeSet<_>>();
            folds.extend(
                line_folds
                    .iter()
                    .filter(|fold| {
                        fold.kind == Some("region")
                            || !structural_starts.contains(&fold.start_line_index)
                    })
                    .cloned(),
            );
            folds.sort_by_key(|fold| (fold.start_line_index, Reverse(fold.end_line_index)));
            folds.dedup_by_key(|fold| fold.start_line_index);
            folds.truncate(self.limits.max_folding_ranges);
            Arc::new(folds)
        };
        if cancelled() {
            return Err(SyntaxError::ParseCancelled);
        }
        let mut offsets = Vec::with_capacity(nodes.len() + 1);
        if let Some(old) = &previous {
            offsets.extend_from_slice(&old.offsets[..=left]);
        } else {
            offsets.push((0, 0));
        }
        for node in &nodes[left..right] {
            let (symbols, diagnostics) = *offsets.last().unwrap();
            offsets.push((
                symbols + node.symbols.len(),
                diagnostics + node.diagnostics.len(),
            ));
        }
        if let Some(old) = &previous {
            let end = *offsets.last().unwrap();
            let old_end = old.offsets[old_right];
            if end == old_end {
                offsets.extend_from_slice(&old.offsets[old_right + 1..]);
            } else {
                offsets.extend(old.offsets[old_right + 1..].iter().map(
                    |(symbols, diagnostics)| {
                        (symbols - old_end.0 + end.0, diagnostics - old_end.1 + end.1)
                    },
                ));
            }
        }
        let change = previous.as_ref().map(|old| FactChange {
            base: old.revision,
            left,
            old_right,
            right,
        });
        let facts = Arc::new(EditorFacts {
            revision: self.revision,
            tab_size,
            tree: self.tree.clone(),
            text: self.text.clone(),
            nodes,
            folds,
            offsets,
            change,
            limits: self.limits,
        });
        cache.tree = Some(self.tree.clone());
        cache.result = Some(Arc::clone(&facts));
        cache.dirty.clear();
        cache.rows_moved = false;
        cache.pending.clear();
        cache.line_folds = line_folds;
        Ok(facts)
    }

    fn collect_editor_node(
        &self,
        root: Node<'_>,
        symbol_cursor: &mut QueryCursor,
        cancelled: &impl Fn() -> bool,
    ) -> Result<NodeFacts, SyntaxError> {
        let mut folds = Vec::new();
        let mut diagnostics = Vec::new();
        let mut interrupted = false;
        let mut cursor = root.walk();
        loop {
            let node = cursor.node();
            if cancelled() {
                interrupted = true;
                break;
            }
            let multiline = node.end_position().row > node.start_position().row;
            // A valid single-line subtree cannot contain a fold or diagnostic.
            // Error recovery still descends through single-line and missing nodes.
            let descend = multiline || node.has_error();
            if (node.is_error() || node.is_missing())
                && diagnostics.len() < self.limits.max_diagnostics
            {
                diagnostics.push(SyntaxDiagnostic {
                    range: syntax_range(node),
                    kind: if node.is_missing() {
                        SyntaxDiagnosticKind::Missing
                    } else {
                        SyntaxDiagnosticKind::Error
                    },
                });
            }
            if descend && cursor.goto_first_child() {
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    break;
                }
            }
            if cursor.node() == root {
                break;
            }
        }
        if interrupted {
            return Err(SyntaxError::ParseCancelled);
        }
        diagnostics
            .sort_by_key(|diagnostic| (diagnostic.range.bytes.start, diagnostic.range.bytes.end));
        let mut symbols = Vec::new();
        self.collect_structure(root, symbol_cursor, cancelled, 0, &mut folds, &mut symbols)?;
        symbols.sort_by_key(|symbol| {
            (
                symbol.selection_range.bytes.start,
                symbol.selection_range.bytes.end,
                symbol.kind,
            )
        });
        symbols.dedup();
        let origin = root.start_position();
        // Adjacent range/selection endpoints often share a line. Reuse its
        // Rope slice rather than seeking from the document root for each field.
        let mut line: Option<(usize, ropey::RopeSlice<'_>)> = None;
        let mut column = |point: SyntaxPoint| {
            if point.column == 0 {
                return 0;
            }
            if line.as_ref().is_none_or(|(row, _)| *row != point.row) {
                line = Some((point.row, self.text.line(point.row)));
            }
            line.as_ref()
                .unwrap()
                .1
                .byte_slice(..point.column)
                .len_utf16_cu()
        };
        let origin_column = column(origin.into());
        let mut relative = |range: &SyntaxRange| {
            let mut point = |point: SyntaxPoint| {
                [
                    point.row - origin.row,
                    column(point)
                        - if point.row == origin.row {
                            origin_column
                        } else {
                            0
                        },
                ]
            };
            let start = point(range.start);
            let end = point(range.end);
            [start[0], start[1], end[0], end[1]]
        };
        Ok(NodeFacts {
            folds: folds
                .into_iter()
                .map(|fold| EditorFold {
                    start_line_index: fold.start_line_index - origin.row,
                    end_line_index: fold.end_line_index - origin.row,
                    kind: fold.kind,
                })
                .collect(),
            diagnostics: diagnostics
                .into_iter()
                .map(|diagnostic| EditorDiagnostic {
                    range: relative(&diagnostic.range),
                    kind: diagnostic.kind,
                })
                .collect(),
            symbols: symbols
                .into_iter()
                .map(|symbol| EditorSymbol {
                    range: relative(&symbol.range),
                    selection_range: relative(&symbol.selection_range),
                    name: symbol.name,
                    kind: symbol.kind,
                })
                .collect(),
        })
    }

    // Keep global coordinates until the host subtree cache makes them relative.
    // Embedded parsers read the same Rope and never include the host delimiters.
    fn collect_structure(
        &self,
        root: Node<'_>,
        cursor: &mut QueryCursor,
        cancelled: &impl Fn() -> bool,
        depth: usize,
        folds: &mut Vec<EditorFold>,
        symbols: &mut Vec<super::DocumentSymbol>,
    ) -> Result<(), SyntaxError> {
        let query = &self.configuration.folds;
        let mut captures = cursor.captures(query, root, RopeTextProvider(self.text.slice(..)));
        while let Some((matched, index)) = captures.next() {
            if cancelled() {
                return Err(SyntaxError::ParseCancelled);
            }
            if folds.len() >= self.limits.max_folding_ranges {
                break;
            }
            let node = matched.captures[*index].node;
            let end = node.end_position();
            let end_row = end.row.saturating_sub(usize::from(end.column == 0));
            if end_row > node.start_position().row {
                folds.push(EditorFold {
                    start_line_index: node.start_position().row,
                    end_line_index: end_row,
                    kind: node
                        .kind()
                        .to_ascii_lowercase()
                        .contains("comment")
                        .then_some("comment"),
                });
            }
        }
        drop(captures);
        if cancelled() {
            return Err(SyntaxError::ParseCancelled);
        }
        symbols.extend(collect_symbols(
            cursor,
            &self.configuration.tags,
            root,
            &self.text,
            self.limits.max_symbols.saturating_sub(symbols.len()),
        ));
        self.visit_injections(
            root,
            root.start_position().row..root.end_position().row + 1,
            cancelled,
            depth,
            &mut |child, _, _| {
                child.collect_structure(
                    child.tree.root_node(),
                    cursor,
                    cancelled,
                    depth + 1,
                    folds,
                    symbols,
                )
            },
        )
    }

    /// Viewport delimiters and their ancestors provide colors and guides without a second AST.
    pub fn editor_brackets(
        &self,
        rows: &[Range<usize>],
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<Vec<EditorBracket>, SyntaxError> {
        self.brackets_with_injections(rows, tab_size, cancelled, 0)
    }

    fn brackets_with_injections(
        &self,
        rows: &[Range<usize>],
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
        depth: usize,
    ) -> Result<Vec<EditorBracket>, SyntaxError> {
        if depth < 4 && self.configuration.injections.is_some() {
            for range in rows {
                self.highlight_with_injections(range.clone(), cancelled, depth)?;
            }
        }
        let mut parents = HashMap::new();
        for rows in rows {
            let mut cursor = QueryCursor::new();
            cursor.set_point_range(Point::new(rows.start, 0)..Point::new(rows.end, 0));
            let mut captures = cursor.captures(
                &self.configuration.editor_brackets,
                self.tree.root_node(),
                RopeTextProvider(self.text.slice(..)),
            );
            while let Some((matched, index)) = captures.next() {
                if cancelled() {
                    return Err(SyntaxError::ParseCancelled);
                }
                if let Some(parent) = matched.captures[*index].node.parent() {
                    parents.insert(parent.id(), parent);
                }
            }
            let mut node = self
                .tree
                .root_node()
                .descendant_for_point_range(Point::new(rows.start, 0), Point::new(rows.start, 0));
            while let Some(parent) = node.and_then(|node| node.parent()) {
                parents.insert(parent.id(), parent);
                node = Some(parent);
            }
        }
        let mut pairs = Vec::new();
        for parent in parents.values() {
            // Program/module ancestors can contain thousands of declarations,
            // all named. They cannot own a delimiter pair; avoid walking every
            // sibling when only a small viewport was queried.
            if parent.named_child_count() == parent.child_count() {
                continue;
            }
            let mut cursor = parent.walk();
            let children = parent.children(&mut cursor).collect::<Vec<_>>();
            for open in children
                .iter()
                .filter(|node| !node.is_named() && closing(node.kind()).is_some())
            {
                let close_kind = closing(open.kind()).unwrap();
                let close = children.iter().find(|node| {
                    !node.is_named()
                        && node.kind() == close_kind
                        && node.start_byte() >= open.end_byte()
                });
                let mut level = 0;
                let mut equal_level = 0;
                let mut ancestor = parent.parent();
                while let Some(node) = ancestor {
                    if let Some(first) = node
                        .child(0)
                        .filter(|node| !node.is_named() && closing(node.kind()).is_some())
                    {
                        level += 1;
                        equal_level += usize::from(first.kind() == open.kind());
                    }
                    ancestor = node.parent();
                }
                let min_indent = close
                    .filter(|node| node.start_position().row > open.end_position().row)
                    .and_then(|close| {
                        (open.end_position().row + 1..=close.start_position().row)
                            .filter_map(|row| {
                                let line = self.line(row);
                                (!line.trim().is_empty()).then(|| indentation(&line, tab_size))
                            })
                            .min()
                    })
                    .map_or(-1, |indent| indent as i64);
                let end = close.copied().unwrap_or(*parent);
                pairs.push(EditorBracket {
                    range: SyntaxRange {
                        bytes: open.start_byte()..end.end_byte(),
                        start: open.start_position().into(),
                        end: end.end_position().into(),
                    },
                    opening: syntax_range(*open),
                    closing: close.map(|node| syntax_range(*node)),
                    text: open.kind().into(),
                    close_text: close.map(|_| close_kind.into()),
                    level,
                    equal_level,
                    min_indent,
                });
            }
        }
        if depth < 4 {
            for child in self.injection_cache.borrow().values() {
                pairs.extend(child.brackets_with_injections(
                    rows,
                    tab_size,
                    cancelled,
                    depth + 1,
                )?);
            }
        }
        pairs.sort_by_key(|pair| (pair.range.bytes.start, pair.range.bytes.end));
        pairs.dedup_by_key(|pair| (pair.opening.bytes.start, pair.opening.bytes.end));
        Ok(pairs)
    }

    /// A hypothetical edit uses a fork, leaving the persistent document and its revision intact.
    pub fn editor_preview(
        &self,
        row: usize,
        lines: &[String],
        cancelled: &impl Fn() -> bool,
    ) -> Result<Vec<EditorRow>, SyntaxError> {
        let start = self.text.line_to_byte(row);
        let end_row = (row + lines.len()).min(self.line_count());
        let end = self.text.line_to_byte(end_row);
        let mut ends_with_cr = false;
        let crlf = self.text.chunks().any(|chunk| {
            let found = chunk.contains("\r\n") || (ends_with_cr && chunk.starts_with('\n'));
            ends_with_cr = chunk.ends_with('\r');
            found
        });
        let eol = if crlf { "\r\n" } else { "\n" };
        let replacement = lines.join(eol) + if end_row < self.line_count() { eol } else { "" };
        let edit = SyntaxEdit::replace(start..end, replacement);
        let mut parser = tree_sitter::Parser::new();
        let configuration =
            crate::language::LanguageConfiguration::load(self.language, &mut parser)?;
        let ParsedEdit { text, tree, .. } =
            parse_edits(&mut parser, &self.text, &self.tree, &[&edit])?;
        let fork = Self {
            language: self.language,
            revision: self.revision,
            text,
            parser,
            tree,
            configuration,
            limits: self.limits,
            editor_cache: Default::default(),
            injection_cache: Default::default(),
        };
        fork.editor_highlight(row..(row + lines.len()).min(fork.line_count()), cancelled)
    }
}

fn closing(kind: &str) -> Option<&'static str> {
    match kind {
        "(" => Some(")"),
        "[" => Some("]"),
        "{" => Some("}"),
        _ => None,
    }
}
fn indentation(line: &str, tab_size: usize) -> usize {
    let mut indent = 0;
    for ch in line.chars() {
        match ch {
            ' ' => indent += 1,
            '\t' => indent += tab_size - indent % tab_size,
            _ => break,
        }
    }
    indent
}

fn merge_dirty_ranges(ranges: &mut Vec<Range<usize>>) {
    ranges.sort_by_key(|range| range.start);
    let mut length = 0;
    for index in 0..ranges.len() {
        let range = ranges[index].clone();
        if length > 0 && range.start <= ranges[length - 1].end {
            ranges[length - 1].end = ranges[length - 1].end.max(range.end);
        } else {
            ranges[length] = range;
            length += 1;
        }
    }
    ranges.truncate(length);
    // Bound retained invalidation history while facts have no active consumer.
    // Falling back to one enclosing interval preserves correctness.
    if ranges.len() > 1024 {
        let range = ranges[0].start..ranges.last().unwrap().end;
        ranges.clear();
        ranges.push(range);
    }
}

// Cached values are derived from the caller's text. Keeping the source Tree
// alive protects node IDs, including work completed before cancellation.
#[derive(Default)]
pub(super) struct EditorCache {
    tree: Option<Tree>,
    result: Option<Arc<EditorFacts>>,
    pending: HashMap<usize, Arc<NodeFacts>>,
    dirty: Vec<Range<usize>>,
    rows_moved: bool,
    lines: LineFoldCache,
    line_folds: Arc<Vec<EditorFold>>,
}
impl EditorCache {
    pub(super) fn apply_edits(
        &mut self,
        edits: &[&SyntaxEdit],
        text: &Rope,
        edited_tree: &Tree,
        tree: &Tree,
    ) {
        self.pending.clear();
        if self.result.is_none() {
            // Legacy snapshot consumers never request editor facts. Do not retain
            // edit history or a cancelled initial cache for those documents.
            *self = Self::default();
            return;
        }
        for edit in edits {
            let start = point_at(text, edit.range().start);
            let end = point_at(text, edit.range().end);
            let next = super::advance_point(start, edit.replacement());
            if let Some(tree) = &mut self.tree {
                tree.edit(&tree_sitter::InputEdit {
                    start_byte: edit.range().start,
                    old_end_byte: edit.range().end,
                    new_end_byte: edit.range().start + edit.replacement().len(),
                    start_position: start.into(),
                    old_end_position: end.into(),
                    new_end_position: next.into(),
                });
            }
            let shift = |offset: usize| {
                if offset < edit.range().start {
                    offset
                } else if offset < edit.range().end {
                    edit.range().start
                } else {
                    offset - edit.range().end + edit.range().start + edit.replacement().len()
                }
            };
            let new_end = edit.range().start + edit.replacement().len();
            for dirty in &mut self.dirty {
                *dirty = shift(dirty.start)..shift(dirty.end);
            }
            self.dirty.push(edit.range().start..new_end);
            self.rows_moved |= start.row != end.row || end.row != next.row;
            self.lines.apply_edit(start, end, next);
        }
        self.dirty.extend(
            edited_tree
                .changed_ranges(tree)
                .map(|range| range.start_byte..range.end_byte),
        );
        merge_dirty_ranges(&mut self.dirty);
    }
}
struct NodeFacts {
    folds: Vec<EditorFold>,
    symbols: Vec<EditorSymbol>,
    diagnostics: Vec<EditorDiagnostic>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LineFacts {
    indent: Option<usize>,
    region: FoldingMarker,
}
impl LineFacts {
    fn new(line: &str, tab_size: usize, rules: &FoldingRules) -> Self {
        Self {
            indent: (!line.trim().is_empty()).then(|| indentation(line, tab_size)),
            region: rules.marker(line),
        }
    }
}

#[derive(Clone, Default, Eq, PartialEq)]
struct FoldState {
    stack: Vec<(usize, usize)>,
    regions: Vec<usize>,
    previous: Option<(usize, usize)>,
}
impl FoldState {
    fn shift(&mut self, edit: [usize; 6]) {
        let shift = |row: &mut usize| *row = shift_row(*row, edit);
        for (row, _) in &mut self.stack {
            shift(row);
        }
        for row in &mut self.regions {
            shift(row);
        }
        if let Some((row, _)) = &mut self.previous {
            shift(row);
        }
    }
    fn step(&mut self, row: usize, line: LineFacts, off_side: bool) -> Vec<EditorFold> {
        let mut folds = Vec::new();
        match line.region {
            FoldingMarker::End => {
                if let Some(start) = self.regions.pop() {
                    if row > start {
                        folds.push(EditorFold {
                            start_line_index: start,
                            end_line_index: row,
                            kind: Some("region"),
                        });
                    }
                }
            }
            FoldingMarker::Start => self.regions.push(row),
            FoldingMarker::None => {}
        }
        if let Some(indent) = line.indent {
            while self
                .stack
                .last()
                .is_some_and(|(_, current)| indent <= *current)
            {
                let (start, _) = self.stack.pop().unwrap();
                let end = if off_side {
                    row - 1
                } else {
                    self.previous.map_or(row - 1, |(row, _)| row)
                };
                if end > start {
                    folds.push(EditorFold {
                        start_line_index: start,
                        end_line_index: end,
                        kind: None,
                    });
                }
            }
            if let Some((start, current)) = self.previous {
                if indent > current {
                    self.stack.push((start, current));
                }
            }
            self.previous = Some((row, indent));
        }
        folds
    }
}

#[derive(Default)]
struct LineFoldCache {
    tab_size: usize,
    lines: Vec<Option<LineFacts>>,
    dirty: Vec<Range<usize>>,
    checkpoints: std::collections::BTreeMap<usize, FoldState>,
    emissions: std::collections::BTreeMap<usize, Vec<EditorFold>>,
    folds: Arc<Vec<EditorFold>>,
    rows_changed: bool,
}
impl LineFoldCache {
    fn apply_edit(&mut self, start: SyntaxPoint, end: SyntaxPoint, next: SyntaxPoint) {
        if self.lines.is_empty() {
            return;
        }
        // For line origins only zero versus nonzero column matters, so these
        // parser byte columns have the same row affinity as UTF-16 positions.
        let edit = [
            start.row,
            start.column,
            end.row,
            end.column,
            next.row,
            next.column,
        ];
        let (start, end, next) = (start.row, end.row, next.row);
        let shift = |row| shift_row(row, edit);
        for dirty in &mut self.dirty {
            *dirty = shift(dirty.start)..shift(dirty.end - 1) + 1;
        }
        self.dirty.push(start..next + 1);
        merge_dirty_ranges(&mut self.dirty);
        if end != next {
            self.rows_changed = true;
            self.lines
                .splice(start..=end, std::iter::repeat_n(None, next - start + 1));
            let checkpoints = self.checkpoints.split_off(&(start + 1));
            self.checkpoints
                .extend(checkpoints.into_iter().filter_map(|(row, mut state)| {
                    if row > start && row <= end {
                        return None;
                    }
                    state.shift(edit);
                    Some((if row > start { row - end + next } else { row }, state))
                }));
            let emissions = self.emissions.split_off(&start);
            self.emissions
                .extend(emissions.into_iter().filter_map(|(row, mut folds)| {
                    if row >= start && row <= end {
                        return None;
                    }
                    for fold in &mut folds {
                        fold.start_line_index = shift(fold.start_line_index);
                        fold.end_line_index = shift(fold.end_line_index);
                    }
                    Some((if row > end { row - end + next } else { row }, folds))
                }));
        }
    }

    fn update(
        &mut self,
        document: &SyntaxDocument,
        tab_size: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<Arc<Vec<EditorFold>>, SyntaxError> {
        let rules = document.configuration.folding;
        if self.tab_size != tab_size || self.lines.len() != document.line_count() {
            *self = Self {
                tab_size,
                lines: vec![None; document.line_count()],
                dirty: vec![0..document.line_count()],
                rows_changed: true,
                ..Self::default()
            };
        }
        if self.dirty.is_empty() {
            return Ok(Arc::clone(&self.folds));
        }
        let dirty = self.dirty.clone();
        let mut changed = self.rows_changed;
        for range in &dirty {
            // Seek once per dirty interval; consecutive lines reuse the Rope iterator.
            for (row, line) in range.clone().zip(document.text.lines_at(range.start)) {
                if cancelled() {
                    return Err(SyntaxError::ParseCancelled);
                }
                let line: Cow<'_, str> = line.into();
                let line = LineFacts::new(line.trim_end_matches(['\r', '\n']), tab_size, rules);
                changed |= self.lines[row] != Some(line);
                self.rows_changed = changed;
                self.lines[row] = Some(line);
            }
        }
        // Preserve this flag until a successful scan, including across cancellation.
        self.rows_changed = changed;
        if !changed {
            self.dirty.clear();
            return Ok(Arc::clone(&self.folds));
        }
        let mut windows = Vec::new();
        let mut last_end = 0;
        let mut checkpoints = Vec::new();
        let mut emissions = Vec::new();
        for dirty in dirty {
            if last_end >= dirty.end {
                continue;
            }
            let (mut start, mut state) = self
                .checkpoints
                .range(..=dirty.start)
                .next_back()
                .map(|(row, state)| (*row, state.clone()))
                .unwrap_or_default();
            // A prior window can already have propagated through this edit. Its
            // stopping checkpoint is known to have the same old and new state.
            if start < last_end {
                start = last_end;
                state = self.checkpoints.get(&start).cloned().unwrap_or_default();
            }
            let mut end = document.line_count() + 1;
            for row in start..document.line_count() {
                if cancelled() {
                    return Err(SyntaxError::ParseCancelled);
                }
                if row >= dirty.end && self.checkpoints.get(&row) == Some(&state) {
                    end = row;
                    break;
                }
                // Deep region/indent stacks must not be copied at every checkpoint;
                // cap checkpoint depth so adversarial nesting stays memory-bounded.
                if row % 128 == 0 && state.stack.len() + state.regions.len() <= 128 {
                    checkpoints.push((row, state.clone()));
                }
                let line = *self.lines[row]
                    .get_or_insert_with(|| LineFacts::new(&document.line(row), tab_size, rules));
                let folds = state.step(row, line, rules.off_side());
                if !folds.is_empty() {
                    emissions.push((row, folds));
                }
            }
            if end > document.line_count() {
                let last_row = if rules.off_side() {
                    document.line_count() - 1
                } else {
                    state.previous.map_or(0, |(row, _)| row)
                };
                let folds = state
                    .stack
                    .into_iter()
                    .filter_map(|(start, _)| {
                        (last_row > start).then_some(EditorFold {
                            start_line_index: start,
                            end_line_index: last_row,
                            kind: None,
                        })
                    })
                    .collect::<Vec<_>>();
                if !folds.is_empty() {
                    emissions.push((document.line_count(), folds));
                }
            }
            windows.push(start..end);
            last_end = end;
        }
        if cancelled() {
            return Err(SyntaxError::ParseCancelled);
        }
        // Remove only recomputed windows; split_off leaves unrelated map entries
        // and suffix states intact, including between distant multi-cursor edits.
        for window in windows {
            let mut suffix = self.checkpoints.split_off(&window.end);
            drop(self.checkpoints.split_off(&window.start));
            self.checkpoints.append(&mut suffix);
            let mut suffix = self.emissions.split_off(&window.end);
            drop(self.emissions.split_off(&window.start));
            self.emissions.append(&mut suffix);
        }
        self.checkpoints.extend(checkpoints);
        self.emissions.extend(emissions);
        self.folds = Arc::new(self.emissions.values().flatten().cloned().collect());
        self.dirty.clear();
        self.rows_changed = false;
        Ok(Arc::clone(&self.folds))
    }
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
