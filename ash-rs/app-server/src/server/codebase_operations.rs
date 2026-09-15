use super::AppServer;
use super::RpcError;
use super::codebase_runtime::CodebaseRuntime;
use super::codebase_runtime::CodebaseRuntimeError;
use super::codebase_runtime::CodebaseRuntimeState;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::codebase::CodebaseChunkSpanDto;
use ash_app_server_protocol::protocol::codebase::CodebaseSearchHitDto;
use ash_app_server_protocol::protocol::codebase::CodebaseSearchParams;
use ash_app_server_protocol::protocol::codebase::CodebaseSearchResult;
use ash_app_server_protocol::protocol::codebase::CodebaseStateDto;
use ash_app_server_protocol::protocol::codebase::CodebaseStatusResult;
use ash_app_server_protocol::protocol::codebase::FastRegexIndexStatusResult;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_codebase::CodebaseError;
use ash_codebase::CodebaseQuery;
use ash_codebase::CodebaseSnapshot;
use ash_codebase::SearchHit;
use serde_json::Value;
use std::num::NonZeroUsize;

const MAX_PROTOCOL_RESULTS: usize = 100;

impl AppServer {
    pub(super) fn codebase_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let runtime = self.codebase_service()?;
        result(&self.project_codebase_status(&runtime))
    }

    pub(super) fn codebase_search(&self, params: &Value) -> Result<Value, RpcError> {
        let params: CodebaseSearchParams = decode(params)?;
        let result_limit = NonZeroUsize::new(params.max_results)
            .filter(|value| value.get() <= MAX_PROTOCOL_RESULTS)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let query = CodebaseQuery::new(params.query).with_result_limit(result_limit);
        let runtime = self.codebase_service()?;
        let hits = runtime
            .search(&query)
            .map_err(codebase_runtime_error)?
            .into_iter()
            .map(project_hit)
            .collect();
        result(&CodebaseSearchResult {
            status: self.project_codebase_status(&runtime),
            hits,
        })
    }

    pub(super) fn codebase_rebuild(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let runtime = self.codebase_service()?;
        runtime.rebuild().map_err(codebase_error)?;
        if let Err(error) = runtime.index().handoff_matching_overlays() {
            log::warn!("codebase overlay handoff failed after explicit rebuild: {error}");
        }
        if let Ok(symbol_index) = self.symbol_index_service()
            && let Err(error) = symbol_index.reconcile()
        {
            log::warn!("symbol-index reconcile failed after explicit codebase rebuild: {error}");
        }
        if let Ok(symbol_index) = self.symbol_index_service()
            && let Err(error) = symbol_index.reconcile_overlay()
        {
            log::warn!(
                "symbol-index overlay reconcile failed after explicit codebase rebuild: {error}"
            );
        }
        if let Some(job) = self.codebase_semantic_job() {
            job.schedule();
        }
        result(&self.project_codebase_status(&runtime))
    }

    pub(super) fn fast_regex_index_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let (service, root) = self.agent_grep_index_context()?;
        let snapshot = service
            .fast_regex_snapshot(&root)
            .map_err(|_| RpcError::new(-32092, AppServerErrorName::CodebaseOperationFailed))?;
        result(&project_fast_regex_status(
            service.watches_fast_regex(),
            snapshot,
        ))
    }

    pub(super) fn fast_regex_index_rebuild(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let (service, root) = self.agent_grep_index_context()?;
        let snapshot = service
            .rebuild_fast_regex(&root)
            .map_err(|_| RpcError::new(-32092, AppServerErrorName::CodebaseOperationFailed))?;
        result(&project_fast_regex_status(true, Some(snapshot)))
    }

    pub(super) fn project_codebase_status(
        &self,
        runtime: &CodebaseRuntime,
    ) -> CodebaseStatusResult {
        let mut status = project_status(runtime);
        if let Some(job) = self.codebase_semantic_job() {
            use super::semantic_index_job::SemanticIndexJobState;
            status.state = match (status.state, job.snapshot().state) {
                (
                    CodebaseStateDto::Ready | CodebaseStateDto::Stale,
                    SemanticIndexJobState::Syncing,
                ) => CodebaseStateDto::Indexing,
                (
                    CodebaseStateDto::Ready,
                    SemanticIndexJobState::Stale
                    | SemanticIndexJobState::Cancelled
                    | SemanticIndexJobState::Failed,
                ) => CodebaseStateDto::Stale,
                (state, _) => state,
            };
        }
        status
    }
}

fn project_fast_regex_status(
    enabled: bool,
    snapshot: Option<ash_fast_regex_search::FastRegexSearchSnapshot>,
) -> FastRegexIndexStatusResult {
    FastRegexIndexStatusResult {
        enabled,
        active: snapshot.is_some(),
        generation: snapshot.as_ref().map(|snapshot| snapshot.generation),
        indexed_file_count: snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.indexed_file_count),
        indexed_source_bytes: snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.indexed_source_bytes),
    }
}

pub(super) fn project_status(runtime: &CodebaseRuntime) -> CodebaseStatusResult {
    let (state, snapshot) = match runtime.state() {
        CodebaseRuntimeState::Empty => (CodebaseStateDto::Empty, None),
        CodebaseRuntimeState::Indexing { last_ready } => (CodebaseStateDto::Indexing, last_ready),
        CodebaseRuntimeState::Ready(snapshot) => (CodebaseStateDto::Ready, Some(snapshot)),
        CodebaseRuntimeState::Stale(snapshot) => (CodebaseStateDto::Stale, Some(snapshot)),
        CodebaseRuntimeState::Failed => (CodebaseStateDto::Failed, None),
    };
    project_snapshot(runtime, state, snapshot.as_ref())
}

fn project_snapshot(
    runtime: &CodebaseRuntime,
    state: CodebaseStateDto,
    snapshot: Option<&CodebaseSnapshot>,
) -> CodebaseStatusResult {
    CodebaseStatusResult {
        state,
        root_id: runtime.root().id().as_str().to_owned(),
        generation: snapshot.map_or(0, |snapshot| snapshot.generation),
        indexed_file_count: snapshot.map_or(0, |snapshot| snapshot.indexed_file_count),
        indexed_chunk_count: snapshot.map_or(0, |snapshot| snapshot.indexed_chunk_count),
        indexed_source_bytes: snapshot.map_or(0, |snapshot| snapshot.indexed_source_bytes),
        skipped_file_count: snapshot.map_or(0, |snapshot| snapshot.skipped_file_count),
        truncated_file_count: snapshot.map_or(0, |snapshot| snapshot.truncated_file_count),
        file_limit_hit: snapshot.is_some_and(|snapshot| snapshot.file_limit_hit),
        source_bytes_limit_hit: snapshot.is_some_and(|snapshot| snapshot.source_bytes_limit_hit),
    }
}

fn project_hit(hit: SearchHit) -> CodebaseSearchHitDto {
    CodebaseSearchHitDto {
        path: hit.reference.relative_path,
        language: hit.language.id().to_owned(),
        source_revision: hit.reference.source_revision.as_str().to_owned(),
        chunk_key: hit.reference.key.as_str().to_owned(),
        content_hash: hit.reference.content_hash.as_str().to_owned(),
        span: CodebaseChunkSpanDto {
            start_byte: hit.reference.span.start_byte,
            end_byte: hit.reference.span.end_byte,
            start_line: hit.reference.span.start_line,
            end_line_exclusive: hit.reference.span.end_line_exclusive,
        },
        content: hit.content,
        score: hit.score,
    }
}

fn codebase_runtime_error(error: CodebaseRuntimeError) -> RpcError {
    match error {
        CodebaseRuntimeError::NotReady => {
            RpcError::new(-32091, AppServerErrorName::CodebaseNotReady)
        }
        CodebaseRuntimeError::Index(error) => codebase_error(error),
    }
}

fn codebase_error(error: CodebaseError) -> RpcError {
    match error {
        CodebaseError::InvalidQuery(_) => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        _ => RpcError::new(-32092, AppServerErrorName::CodebaseOperationFailed),
    }
}

#[cfg(test)]
#[path = "codebase_operations_tests.rs"]
mod tests;
