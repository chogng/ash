//! Embedded parsers share the document Rope and retain global byte/row coordinates.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use tree_sitter::Parser;
use tree_sitter::Point;
use tree_sitter::QueryCursor;
use tree_sitter::StreamingIterator;

use super::EditorRow;
use super::RopeTextProvider;
use super::SyntaxDocument;
use super::SyntaxError;
use super::SyntaxLanguage;
use super::parse_rope;
use crate::language::LanguageConfiguration;

type InjectionKey = (SyntaxLanguage, Vec<(usize, usize)>);
pub(super) type InjectionCache = HashMap<InjectionKey, Box<SyntaxDocument>>;

impl SyntaxDocument {
    pub(super) fn highlight_injections(
        &self,
        rows: &mut [EditorRow],
        cancelled: &impl Fn() -> bool,
        depth: usize,
    ) -> Result<(), SyntaxError> {
        if rows.is_empty() {
            return Ok(());
        }
        self.visit_injections(
            self.tree.root_node(),
            rows[0].row..rows.last().unwrap().row + 1,
            cancelled,
            depth,
            &mut |child, ranges, language| {
                let injected = child.highlight_with_injections(
                    rows[0].row..rows.last().unwrap().row + 1,
                    cancelled,
                    depth + 1,
                )?;
                for (row, overlay) in rows.iter_mut().zip(injected) {
                    let line = self.line(row.row);
                    let coverage = ranges
                        .iter()
                        .filter_map(|range| {
                            if row.row < range.start_point.row || row.row > range.end_point.row {
                                return None;
                            }
                            let start = if row.row == range.start_point.row {
                                range.start_point.column
                            } else {
                                0
                            };
                            let end = if row.row == range.end_point.row {
                                range.end_point.column.min(line.len())
                            } else {
                                line.len()
                            };
                            (start < end).then(|| {
                                (
                                    line[..start].encode_utf16().count(),
                                    line[..end].encode_utf16().count(),
                                )
                            })
                        })
                        .collect::<Vec<_>>();
                    let boundaries = row
                        .tokens
                        .iter()
                        .chain(&overlay.tokens)
                        .flat_map(|token| [token.start, token.end])
                        .chain(coverage.iter().flat_map(|&(start, end)| [start, end]))
                        .collect::<std::collections::BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>();
                    let mut merged = Vec::new();
                    for segment in boundaries.windows(2) {
                        let covered = coverage
                            .iter()
                            .any(|&(start, end)| start <= segment[0] && end >= segment[1]);
                        let parent = row
                            .tokens
                            .iter()
                            .find(|token| token.start <= segment[0] && token.end >= segment[1]);
                        let token = overlay
                            .tokens
                            .iter()
                            .find(|token| token.start <= segment[0] && token.end >= segment[1])
                            .or(parent);
                        if token.is_none() && !covered {
                            continue;
                        }
                        merged.push(super::EditorToken {
                            start: segment[0],
                            end: segment[1],
                            name: token
                                .filter(|token| token.name != "none")
                                .or(parent)
                                .map_or_else(|| "none".into(), |token| token.name.clone()),
                            language_id: if covered {
                                token
                                    .and_then(|token| token.language_id)
                                    .or(Some(language.editor_id()))
                            } else {
                                token.and_then(|token| token.language_id)
                            },
                        });
                    }
                    row.tokens = merged;
                }
                Ok(())
            },
        )
    }

    /// Reuse included-range parsers for every feature without parsing or highlighting twice.
    pub(super) fn visit_injections(
        &self,
        root: tree_sitter::Node<'_>,
        rows: std::ops::Range<usize>,
        cancelled: &impl Fn() -> bool,
        depth: usize,
        visitor: &mut impl FnMut(
            &SyntaxDocument,
            &[tree_sitter::Range],
            SyntaxLanguage,
        ) -> Result<(), SyntaxError>,
    ) -> Result<(), SyntaxError> {
        let Some(query) = &self.configuration.injections else {
            return Ok(());
        };
        if depth >= 4 || rows.is_empty() {
            return Ok(());
        }
        let mut cursor = QueryCursor::new();
        cursor.set_point_range(Point::new(rows.start, 0)..Point::new(rows.end, 0));
        let mut matches = cursor.matches(query, root, RopeTextProvider(self.text.slice(..)));
        let mut processed = 0;
        while let Some(matched) = matches.next() {
            if cancelled() {
                return Err(SyntaxError::ParseCancelled);
            }
            if processed >= 256 {
                break;
            }
            let names = query.capture_names();
            let capture = |name: &str| {
                matched
                    .captures
                    .iter()
                    .find(|c| names[c.index as usize] == name)
            };
            let explicit = query
                .property_settings(matched.pattern_index)
                .iter()
                .find(|property| property.key.as_ref() == "injection.language")
                .and_then(|property| property.value.as_deref());
            let language_name = capture("injection.language")
                .map(|c| self.text.byte_slice(c.node.byte_range()).to_string());
            let filename = capture("injection.filename")
                .map(|c| self.text.byte_slice(c.node.byte_range()).to_string());
            let name = language_name
                .as_deref()
                .or(explicit)
                .or_else(|| filename.as_deref()?.rsplit('.').next());
            let Some(mut language) = name.and_then(SyntaxLanguage::for_injection) else {
                continue;
            };
            let mut ranges = Vec::new();
            for content in matched
                .captures
                .iter()
                .filter(|c| names[c.index as usize] == "injection.content")
            {
                let node = content.node;
                let mut start_byte = node.start_byte();
                let mut end_byte = node.end_byte();
                let mut start_point = node.start_position();
                let mut end_point = node.end_position();
                // Diff captures contain the change marker. Keep newlines in the included
                // ranges so multiline embedded grammars retain their lexical boundaries.
                if self.language == SyntaxLanguage::Diff && start_byte < end_byte {
                    start_byte += 1;
                    start_point.column += 1;
                    if end_byte < self.text.len_bytes() && self.text.byte(end_byte) == b'\n' {
                        end_byte += 1;
                        end_point = Point::new(end_point.row + 1, 0);
                    }
                }
                if start_byte >= end_byte {
                    continue;
                }
                if self.language == SyntaxLanguage::Html {
                    if let Some(parent) = node.parent() {
                        if let Some(tag) = parent.child(0) {
                            let tag = self
                                .text
                                .byte_slice(tag.byte_range())
                                .to_string()
                                .to_ascii_lowercase();
                            if tag.contains("application/json")
                                || tag.contains("application/ld+json")
                            {
                                language = SyntaxLanguage::Json;
                            }
                            if tag.contains("typescript") || tag.contains("lang=\"ts\"") {
                                language = SyntaxLanguage::Typescript;
                            }
                            if tag.contains("lang=\"scss\"") {
                                language = SyntaxLanguage::Scss;
                            }
                            if tag.contains("lang=\"less\"") {
                                language = SyntaxLanguage::Less;
                            }
                        }
                    }
                }
                ranges.push(tree_sitter::Range {
                    start_byte,
                    end_byte,
                    start_point,
                    end_point,
                });
            }
            ranges.sort_by_key(|range| range.start_byte);
            // Repeated captures may omit line terminators (for example message_line
            // nodes in a verbose commit patch). Preserve whitespace between captures
            // so the embedded lexer sees the original lexical boundaries.
            for index in 0..ranges.len().saturating_sub(1) {
                let next = ranges[index + 1];
                let end = ranges[index].end_byte;
                if end <= next.start_byte
                    && self
                        .text
                        .byte_slice(end..next.start_byte)
                        .bytes()
                        .all(|byte| byte.is_ascii_whitespace())
                {
                    ranges[index].end_byte = next.start_byte;
                    ranges[index].end_point = next.start_point;
                }
            }

            if ranges.is_empty() {
                continue;
            }
            let key = (
                language,
                ranges
                    .iter()
                    .map(|range| (range.start_byte, range.end_byte))
                    .collect(),
            );
            let mut cache = self.injection_cache.borrow_mut();
            // This cache holds only derived parser state, and is discarded on text edits.
            if cache.len() >= 256 && !cache.contains_key(&key) {
                cache.clear();
            }
            if !cache.contains_key(&key) {
                let mut parser = Parser::new();
                let configuration = LanguageConfiguration::load(language, &mut parser)?;
                // Captures are ordered, disjoint ranges from one validated syntax tree.
                parser
                    .set_included_ranges(&ranges)
                    .expect("ordered injection ranges");
                let tree = parse_rope(&mut parser, &self.text, None)?;
                cache.insert(
                    key.clone(),
                    Box::new(Self {
                        language,
                        revision: self.revision,
                        text: self.text.clone(),
                        parser,
                        tree,
                        configuration: Arc::clone(&configuration),
                        limits: self.limits,
                        editor_cache: RefCell::default(),
                        injection_cache: RefCell::default(),
                    }),
                );
            }
            let child = &cache[&key];
            visitor(child, &ranges, language)?;
            processed += 1;
        }
        Ok(())
    }
}
