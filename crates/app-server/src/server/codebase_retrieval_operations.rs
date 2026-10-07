use std::num::NonZeroUsize;

use ash_app_server_protocol::protocol::codebase::CodebaseChunkSpanDto;
use ash_app_server_protocol::protocol::codebase::CodebaseRetrievalDegradationDto;
use ash_app_server_protocol::protocol::codebase::CodebaseRetrievalHitDto;
use ash_app_server_protocol::protocol::codebase::CodebaseRetrievalParams;
use ash_app_server_protocol::protocol::codebase::CodebaseRetrievalResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_cloud_codebase::CodebaseDeploymentMode;
use ash_codebase::CodebaseRetrievalDegradation;
use ash_codebase::CodebaseRetrievalError;
use ash_codebase::CodebaseRetrievalHit;
use ash_codebase::CodebaseRetrievalQuery;
use serde_json::Value;

use super::AppServer;
use super::RpcError;
use super::codebase_runtime::CodebaseRuntimeError;
use super::decode;
use super::result;

const MAX_PROTOCOL_RESULTS: usize = 100;

impl AppServer {
    pub(super) fn code_retrieve(&self, params: &Value) -> Result<Value, RpcError> {
        let params: CodebaseRetrievalParams = decode(params)?;
        let result_limit = NonZeroUsize::new(params.max_results)
            .filter(|value| value.get() <= MAX_PROTOCOL_RESULTS)
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let query = CodebaseRetrievalQuery::new(params.query, result_limit)
            .map_err(codebase_retrieval_error)?;
        let runtime = self.codebase_service()?;
        runtime
            .ensure_searchable()
            .map_err(codebase_runtime_error)?;
        let retrieval = runtime.retrieval();
        let semantic = self.codebase_semantic_service();
        let cloud = self
            .cloud_codebase_service()
            .ok()
            .and_then(|cloud| match cloud.status() {
                Ok(status) if status.deployment_mode == CodebaseDeploymentMode::LocalOnly => None,
                Ok(_) | Err(_) => Some(cloud),
            });
        let service = match (semantic, cloud) {
            (_, Some(cloud)) => retrieval
                .with_enhancement(cloud)
                .map_err(codebase_retrieval_error)?,
            (Some(semantic), None) => retrieval
                .with_semantic(semantic)
                .map_err(codebase_retrieval_error)?,
            (None, None) => retrieval,
        };
        let service = match self.symbol_index_service() {
            Ok(symbol_index) => service
                .with_symbol_index(symbol_index.index())
                .map_err(codebase_retrieval_error)?,
            Err(_) => service,
        };
        let retrieval = service.retrieve(&query).map_err(codebase_retrieval_error)?;
        result(&CodebaseRetrievalResult {
            status: self.project_codebase_status(&runtime),
            hits: retrieval.hits.into_iter().map(project_hit).collect(),
            degradations: retrieval
                .degradations
                .into_iter()
                .map(project_degradation)
                .collect(),
        })
    }
}

fn project_hit(hit: CodebaseRetrievalHit) -> CodebaseRetrievalHitDto {
    CodebaseRetrievalHitDto {
        path: hit.reference.relative_path,
        language: hit.language.id().to_owned(),
        source_revision: hit.reference.source_revision.as_str().to_owned(),
        content_hash: hit.reference.content_hash.as_str().to_owned(),
        span: CodebaseChunkSpanDto {
            start_byte: hit.reference.span.start_byte,
            end_byte: hit.reference.span.end_byte,
            start_line: hit.reference.span.start_line,
            end_line_exclusive: hit.reference.span.end_line_exclusive,
        },
        content: hit.content,
        rrf_score: hit.rrf_score,
    }
}

fn project_degradation(
    degradation: CodebaseRetrievalDegradation,
) -> CodebaseRetrievalDegradationDto {
    match degradation {
        CodebaseRetrievalDegradation::LocalSymbolQueryFailed => {
            CodebaseRetrievalDegradationDto::CodebaseIncomplete
        }
        CodebaseRetrievalDegradation::LocalSemanticQueryFailed => {
            CodebaseRetrievalDegradationDto::CodebaseIncomplete
        }
        CodebaseRetrievalDegradation::CloudQueryFailed => {
            CodebaseRetrievalDegradationDto::CloudCodebaseUnavailable
        }
        CodebaseRetrievalDegradation::CandidateVerificationFailed { discarded } => {
            CodebaseRetrievalDegradationDto::CandidateVerificationFailed { discarded }
        }
        CodebaseRetrievalDegradation::ContentBudgetExceeded { discarded } => {
            CodebaseRetrievalDegradationDto::ContentBudgetExceeded { discarded }
        }
    }
}

fn codebase_runtime_error(error: CodebaseRuntimeError) -> RpcError {
    match error {
        CodebaseRuntimeError::NotReady => {
            RpcError::new(-32091, AppServerErrorName::CodebaseNotReady)
        }
        CodebaseRuntimeError::Index(_) | CodebaseRuntimeError::Retrieval(_) => {
            RpcError::new(-32096, AppServerErrorName::CodebaseRetrievalOperationFailed)
        }
    }
}

fn codebase_retrieval_error(error: CodebaseRetrievalError) -> RpcError {
    match error {
        CodebaseRetrievalError::InvalidQuery(_) => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        CodebaseRetrievalError::RootMismatch
        | CodebaseRetrievalError::LocalIndex(_)
        | CodebaseRetrievalError::Grep(_)
        | CodebaseRetrievalError::Cancelled(_) => {
            RpcError::new(-32096, AppServerErrorName::CodebaseRetrievalOperationFailed)
        }
    }
}
