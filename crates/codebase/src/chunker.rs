use std::path::Path;

use ash_syntax::AnalysisLimits;
use ash_syntax::DocumentRevision;
use ash_syntax::SyntaxDocument;
use ash_syntax::SyntaxLanguage;
use sha2::Digest;
use sha2::Sha256;

use crate::ChunkContentHash;
use crate::ChunkKey;
use crate::ChunkSpan;
use crate::CodebaseLimits;
use crate::IndexedLanguage;

#[doc(hidden)]
pub const CHUNKER_VERSION: &str = "ash-codebase-v1";

#[derive(Clone, Debug)]
pub struct PreparedChunk {
    pub key: ChunkKey,
    pub content_hash: ChunkContentHash,
    pub span: ChunkSpan,
    pub content: String,
}

pub(crate) struct ChunkingOutcome {
    pub chunks: Vec<PreparedChunk>,
    pub limit_hit: bool,
}

pub(crate) fn language_for_path(path: &Path) -> IndexedLanguage {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("js" | "mjs" | "cjs") => IndexedLanguage::Javascript,
        Some("jsx") => IndexedLanguage::JavascriptReact,
        Some("json") => IndexedLanguage::Json,
        Some("jsonc") => IndexedLanguage::Jsonc,
        Some("rs") => IndexedLanguage::Rust,
        Some("sh" | "bash" | "zsh") => IndexedLanguage::Shell,
        Some("ts" | "mts" | "cts") => IndexedLanguage::TypeScript,
        Some("tsx") => IndexedLanguage::TypeScriptReact,
        _ => IndexedLanguage::PlainText,
    }
}

pub(crate) fn chunk_source(
    language: IndexedLanguage,
    source: &str,
    limits: &CodebaseLimits,
) -> ChunkingOutcome {
    if source.is_empty() {
        return ChunkingOutcome {
            chunks: Vec::new(),
            limit_hit: false,
        };
    }
    let structural_boundaries = syntax_language(language)
        .and_then(|syntax_language| symbol_boundaries(syntax_language, source, limits))
        .unwrap_or_default();
    let byte_ranges = build_ranges(source, structural_boundaries, limits);
    let line_starts = line_starts(source);
    let limit_hit = byte_ranges.len() > limits.max_chunks_per_file;
    let chunks = byte_ranges
        .into_iter()
        .take(limits.max_chunks_per_file)
        .map(|range| {
            let content = &source[range.clone()];
            let content_hash = ChunkContentHash::new(sha256(content.as_bytes()));
            let key = ChunkKey::new(sha256(
                [CHUNKER_VERSION.as_bytes(), b"\0", content.as_bytes()].concat(),
            ));
            PreparedChunk {
                key,
                content_hash,
                span: ChunkSpan {
                    start_byte: range.start,
                    end_byte: range.end,
                    start_line: line_at(&line_starts, range.start),
                    end_line_exclusive: end_line_exclusive(&line_starts, range.end, source.len()),
                },
                content: content.to_owned(),
            }
        })
        .collect();
    ChunkingOutcome { chunks, limit_hit }
}

pub(crate) fn source_revision(source: &str) -> crate::SourceRevision {
    crate::SourceRevision::new(sha256(source.as_bytes()))
}

fn symbol_boundaries(
    language: SyntaxLanguage,
    source: &str,
    limits: &CodebaseLimits,
) -> Option<Vec<usize>> {
    let analysis_limits = AnalysisLimits {
        max_document_bytes: limits.max_file_bytes,
        max_tokens: 0,
        max_folding_ranges: 0,
        max_selection_ranges: 0,
        max_symbols: limits.max_chunks_per_file.saturating_mul(4),
        max_diagnostics: 0,
    };
    let document = SyntaxDocument::open_with_limits(
        language,
        DocumentRevision::new(1),
        source,
        analysis_limits,
    )
    .ok()?;
    let mut boundaries = document
        .snapshot()
        .symbols()
        .iter()
        .map(|symbol| symbol.range.bytes.start)
        .filter(|offset| *offset > 0 && *offset < source.len())
        .collect::<Vec<_>>();
    boundaries.sort_unstable();
    boundaries.dedup();
    Some(boundaries)
}

fn build_ranges(
    source: &str,
    mut structural_boundaries: Vec<usize>,
    limits: &CodebaseLimits,
) -> Vec<std::ops::Range<usize>> {
    structural_boundaries.insert(0, 0);
    structural_boundaries.push(source.len());
    structural_boundaries.sort_unstable();
    structural_boundaries.dedup();

    let mut ranges = Vec::new();
    let mut pending_start = structural_boundaries[0];
    for boundary in structural_boundaries.into_iter().skip(1) {
        if boundary.saturating_sub(pending_start) <= limits.target_chunk_bytes {
            continue;
        }
        append_bounded_ranges(
            source,
            pending_start,
            boundary,
            limits.max_chunk_bytes,
            &mut ranges,
        );
        pending_start = boundary;
    }
    append_bounded_ranges(
        source,
        pending_start,
        source.len(),
        limits.max_chunk_bytes,
        &mut ranges,
    );
    ranges
}

fn append_bounded_ranges(
    source: &str,
    mut start: usize,
    end: usize,
    max_bytes: usize,
    ranges: &mut Vec<std::ops::Range<usize>>,
) {
    while end.saturating_sub(start) > max_bytes {
        let hard_end = floor_char_boundary(source, start + max_bytes);
        let split = source[start..hard_end]
            .rfind('\n')
            .map(|relative| start + relative + 1)
            .filter(|candidate| *candidate > start)
            .unwrap_or(hard_end);
        ranges.push(start..split);
        start = split;
    }
    if start < end && !source[start..end].trim().is_empty() {
        ranges.push(start..end);
    }
}

fn floor_char_boundary(source: &str, mut offset: usize) -> usize {
    offset = offset.min(source.len());
    while !source.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

pub(crate) fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(
            source
                .bytes()
                .enumerate()
                .filter_map(|(index, byte)| (byte == b'\n').then_some(index + 1)),
        )
        .collect()
}

pub(crate) fn line_at(line_starts: &[usize], byte_offset: usize) -> usize {
    line_starts
        .partition_point(|start| *start <= byte_offset)
        .saturating_sub(1)
}

pub(crate) fn end_line_exclusive(
    line_starts: &[usize],
    end_byte: usize,
    source_len: usize,
) -> usize {
    if end_byte == source_len {
        return line_starts.len();
    }
    line_at(line_starts, end_byte.saturating_sub(1)).saturating_add(1)
}

fn syntax_language(language: IndexedLanguage) -> Option<SyntaxLanguage> {
    match language {
        IndexedLanguage::Javascript => Some(SyntaxLanguage::Javascript),
        IndexedLanguage::JavascriptReact => Some(SyntaxLanguage::Javascriptreact),
        IndexedLanguage::Json => Some(SyntaxLanguage::Json),
        IndexedLanguage::Jsonc => Some(SyntaxLanguage::Jsonc),
        IndexedLanguage::Rust => Some(SyntaxLanguage::Rust),
        IndexedLanguage::Shell => Some(SyntaxLanguage::Shell),
        IndexedLanguage::TypeScript => Some(SyntaxLanguage::Typescript),
        IndexedLanguage::TypeScriptReact => Some(SyntaxLanguage::Typescriptreact),
        IndexedLanguage::PlainText => None,
    }
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes.as_ref());
    format!("sha256:{:x}", digest.finalize())
}
