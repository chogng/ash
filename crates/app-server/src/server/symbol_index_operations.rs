use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;

use ash_app_server_protocol::protocol::codebase_symbols::CodebaseSymbolsSearchHitDto;
use ash_app_server_protocol::protocol::codebase_symbols::CodebaseSymbolsSearchParams;
use ash_app_server_protocol::protocol::codebase_symbols::CodebaseSymbolsSearchResult;
use ash_app_server_protocol::protocol::codebase_symbols::CodebaseSymbolsStateDto;
use ash_app_server_protocol::protocol::codebase_symbols::CodebaseSymbolsStatusResult;
use ash_app_server_protocol::protocol::codebase_symbols::DocumentOverlayCloseParams;
use ash_app_server_protocol::protocol::codebase_symbols::DocumentOverlayStatusResult;
use ash_app_server_protocol::protocol::codebase_symbols::DocumentOverlaySynchronizeParams;
use ash_app_server_protocol::protocol::codebase_symbols::SymbolKindDto;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::language::LanguageRangeDto;
use ash_codebase::CodebaseOverlayDocument;
use ash_codebase::IndexedLanguage;
use ash_codebase::IndexedSourceReference;
use ash_codebase::SymbolIndexError;
use ash_codebase::SymbolIndexQuery;
use ash_codebase::SymbolIndexSnapshot;
use ash_codebase::SymbolKind;
use ash_codebase::SymbolRange;
use ash_codebase::SymbolSearchHit;
use serde_json::Value;

use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use super::symbol_index_runtime::SymbolIndexRuntime;
use super::symbol_index_runtime::SymbolIndexRuntimeError;
use super::symbol_index_runtime::SymbolIndexRuntimeState;

const MAX_PROTOCOL_RESULTS: usize = 100;

impl AppServer {
    pub(super) fn symbol_index_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let runtime = self.symbol_index_service()?;
        result(&project_status(&runtime))
    }

    pub(super) fn symbol_index_search(&self, params: &Value) -> Result<Value, RpcError> {
        let params: CodebaseSymbolsSearchParams = decode(params)?;
        let result_limit = NonZeroUsize::new(params.max_results)
            .filter(|value| value.get() <= MAX_PROTOCOL_RESULTS)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let query = SymbolIndexQuery::new(params.query).with_result_limit(result_limit);
        let runtime = self.symbol_index_service()?;
        let codebase = self.codebase_service()?;
        let hits = runtime.search(&query).map_err(symbol_index_runtime_error)?;
        let (hits, discarded_stale_hit_count) = project_verified_hits(codebase.index(), hits);
        result(&CodebaseSymbolsSearchResult {
            status: project_status(&runtime),
            hits,
            discarded_stale_hit_count,
        })
    }

    pub(super) fn document_overlay_synchronize(&self, params: &Value) -> Result<Value, RpcError> {
        let params: DocumentOverlaySynchronizeParams = decode(params)?;
        let codebase = self.codebase_service()?;
        let symbol_index = self.symbol_index_service()?;
        let snapshot = codebase
            .index()
            .synchronize_overlay(CodebaseOverlayDocument {
                relative_path: params.document.path,
                editor_revision: params.document.revision,
                language: indexed_language(&params.document.language_id),
                content: params.document.text,
            })
            .map_err(codebase_overlay_error)?;
        symbol_index
            .reconcile_overlay()
            .map_err(symbol_index_error)?;
        result(&DocumentOverlayStatusResult {
            generation: snapshot.generation,
            dirty_document_count: snapshot.documents.len(),
        })
    }

    pub(super) fn document_overlay_close(&self, params: &Value) -> Result<Value, RpcError> {
        let params: DocumentOverlayCloseParams = decode(params)?;
        let codebase = self.codebase_service()?;
        let symbol_index = self.symbol_index_service()?;
        let snapshot = codebase
            .index()
            .close_overlay(&params.path)
            .map_err(codebase_overlay_error)?;
        symbol_index
            .reconcile_overlay()
            .map_err(symbol_index_error)?;
        result(&DocumentOverlayStatusResult {
            generation: snapshot.generation,
            dirty_document_count: snapshot.documents.len(),
        })
    }
}

pub(super) fn project_status(runtime: &SymbolIndexRuntime) -> CodebaseSymbolsStatusResult {
    let (state, snapshot) = match runtime.state() {
        SymbolIndexRuntimeState::Empty => (CodebaseSymbolsStateDto::Empty, None),
        SymbolIndexRuntimeState::Indexing { last_ready } => {
            (CodebaseSymbolsStateDto::Indexing, last_ready)
        }
        SymbolIndexRuntimeState::Ready(snapshot) => {
            (CodebaseSymbolsStateDto::Ready, Some(snapshot))
        }
        SymbolIndexRuntimeState::Stale(snapshot) => {
            (CodebaseSymbolsStateDto::Stale, Some(snapshot))
        }
        SymbolIndexRuntimeState::Failed => (CodebaseSymbolsStateDto::Failed, None),
    };
    project_snapshot(runtime, state, snapshot.as_ref())
}

fn project_snapshot(
    runtime: &SymbolIndexRuntime,
    state: CodebaseSymbolsStateDto,
    snapshot: Option<&SymbolIndexSnapshot>,
) -> CodebaseSymbolsStatusResult {
    CodebaseSymbolsStatusResult {
        state,
        root_id: runtime.root_id().as_str().to_owned(),
        generation: snapshot.map_or(0, |snapshot| snapshot.generation),
        source_generation: snapshot.map_or(0, |snapshot| snapshot.source_generation),
        indexed_source_count: snapshot.map_or(0, |snapshot| snapshot.indexed_source_count),
        indexed_symbol_count: snapshot.map_or(0, |snapshot| snapshot.indexed_symbol_count),
        symbol_limit_hit: snapshot.is_some_and(|snapshot| snapshot.symbol_limit_hit),
    }
}

fn project_verified_hits(
    codebase: std::sync::Arc<ash_codebase::Codebase>,
    hits: Vec<SymbolSearchHit>,
) -> (Vec<CodebaseSymbolsSearchHitDto>, usize) {
    let mut sources = BTreeMap::<(PathBuf, String), Option<String>>::new();
    let mut projected = Vec::with_capacity(hits.len());
    let mut discarded = 0;
    for hit in hits {
        let reference = &hit.symbol.reference;
        let key = (
            reference.relative_path.clone(),
            reference.source_revision.as_str().to_owned(),
        );
        let content = sources.entry(key).or_insert_with(|| {
            codebase
                .materialize_sources(&[IndexedSourceReference {
                    root_id: reference.root_id.clone(),
                    relative_path: reference.relative_path.clone(),
                    source_revision: reference.source_revision.clone(),
                    language: reference.language,
                    source_bytes: reference.source_bytes,
                }])
                .ok()
                .and_then(|mut sources| sources.pop())
                .map(|source| source.content)
        });
        let Some(content) = content else {
            discarded += 1;
            continue;
        };
        let Some(declaration_range) = project_range(content, &reference.declaration_range) else {
            discarded += 1;
            continue;
        };
        let Some(selection_range) = project_range(content, &reference.selection_range) else {
            discarded += 1;
            continue;
        };
        projected.push(CodebaseSymbolsSearchHitDto {
            name: hit.symbol.name.clone(),
            kind: project_kind(hit.symbol.kind),
            container_name: hit.symbol.container_name,
            path: reference.relative_path.clone(),
            language: reference.language.id().to_owned(),
            source_revision: reference.source_revision.as_str().to_owned(),
            declaration_range,
            selection_range,
            score: hit.score,
            matched_indices: project_matched_indices(&hit.symbol.name, &hit.matched_indices),
        });
    }
    (projected, discarded)
}

fn project_range(text: &str, range: &SymbolRange) -> Option<LanguageRangeDto> {
    Some(LanguageRangeDto {
        start: project_position(text, range.start_byte, range.start_line)?,
        end: project_position(text, range.end_byte, range.end_line)?,
    })
}

fn project_position(
    text: &str,
    byte_offset: usize,
    expected_line: usize,
) -> Option<LanguagePositionDto> {
    let prefix = text.get(..byte_offset)?;
    let line_index = prefix.bytes().filter(|byte| *byte == b'\n').count();
    if line_index != expected_line {
        return None;
    }
    let line = prefix.rsplit_once('\n').map_or(prefix, |(_, line)| line);
    Some(LanguagePositionDto {
        line_index: u32::try_from(line_index).ok()?,
        column_index: u32::try_from(line.encode_utf16().count()).ok()?,
    })
}

fn project_matched_indices(name: &str, indices: &[u32]) -> Vec<u32> {
    let requested = indices
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut utf16_offset = 0u32;
    name.chars()
        .enumerate()
        .filter_map(|(scalar_offset, character)| {
            let projected = requested
                .contains(&u32::try_from(scalar_offset).ok()?)
                .then_some(utf16_offset);
            utf16_offset = utf16_offset.saturating_add(character.len_utf16() as u32);
            projected
        })
        .collect()
}

fn project_kind(kind: SymbolKind) -> SymbolKindDto {
    match kind {
        SymbolKind::Constant => SymbolKindDto::Constant,
        SymbolKind::Enum => SymbolKindDto::Enum,
        SymbolKind::Field => SymbolKindDto::Field,
        SymbolKind::Function => SymbolKindDto::Function,
        SymbolKind::Macro => SymbolKindDto::Macro,
        SymbolKind::Method => SymbolKindDto::Method,
        SymbolKind::Module => SymbolKindDto::Module,
        SymbolKind::Static => SymbolKindDto::Static,
        SymbolKind::Struct => SymbolKindDto::Struct,
        SymbolKind::Trait => SymbolKindDto::Trait,
        SymbolKind::Type => SymbolKindDto::Type,
        SymbolKind::Variable => SymbolKindDto::Variable,
    }
}

fn indexed_language(language_id: &str) -> IndexedLanguage {
    match language_id {
        "javascript" => IndexedLanguage::Javascript,
        "javascriptreact" => IndexedLanguage::JavascriptReact,
        "json" => IndexedLanguage::Json,
        "jsonc" => IndexedLanguage::Jsonc,
        "rust" => IndexedLanguage::Rust,
        "shell" => IndexedLanguage::Shell,
        "typescript" => IndexedLanguage::TypeScript,
        "typescriptreact" => IndexedLanguage::TypeScriptReact,
        _ => IndexedLanguage::PlainText,
    }
}

fn codebase_overlay_error(error: ash_codebase::CodebaseError) -> RpcError {
    match error {
        ash_codebase::CodebaseError::InvalidOverlayPath
        | ash_codebase::CodebaseError::OverlayRevisionConflict
        | ash_codebase::CodebaseError::SourceVerificationLimitExceeded => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        _ => RpcError::new(-32094, AppServerErrorName::CodebaseSymbolsOperationFailed),
    }
}

fn symbol_index_runtime_error(error: SymbolIndexRuntimeError) -> RpcError {
    match error {
        SymbolIndexRuntimeError::NotReady => {
            RpcError::new(-32093, AppServerErrorName::CodebaseSymbolsNotReady)
        }
        SymbolIndexRuntimeError::SourceIndex(error) => {
            log::warn!("symbol-index source generation check failed: {error}");
            RpcError::new(-32094, AppServerErrorName::CodebaseSymbolsOperationFailed)
        }
        SymbolIndexRuntimeError::Index(error) => symbol_index_error(error),
    }
}

fn symbol_index_error(error: SymbolIndexError) -> RpcError {
    match error {
        SymbolIndexError::QueryTooLarge => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        _ => RpcError::new(-32094, AppServerErrorName::CodebaseSymbolsOperationFailed),
    }
}

#[cfg(test)]
#[path = "symbol_index_operations_tests.rs"]
mod tests;
