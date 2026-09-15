use std::num::NonZeroUsize;
use std::sync::Arc;

use ash_async_utils::CancellationToken;
use ash_cloud_codebase::CloudCodebaseController;
use ash_codebase::Codebase;
use ash_codebase::CodebaseRetrievalBudget;
use ash_codebase::CodebaseRetrievalOrigin;
use ash_codebase::CodebaseRetrievalQuery;
use ash_codebase::CodebaseRetrievalService;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::SymbolIndex;
use ash_config::CodebaseAutomaticContext;
use ash_config::ConfigStore;
use ash_core::ContextEvidence;
use ash_core::ContextSource;
use ash_core::ContextSourceRequest;
use core_api::CoreError;

const MAX_EVIDENCE_ITEMS: usize = 8;
const MAX_EVIDENCE_ITEM_BYTES: usize = 12 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES: usize = 48 * 1024;

/// Adapts current-source-verified code retrieval into Core's generic evidence contract.
pub(crate) struct CodebaseRetrievalContextSource {
    index: Arc<Codebase>,
    symbol_index: Option<Arc<SymbolIndex>>,
    semantic: Option<Arc<CodebaseSemanticService>>,
    cloud: Option<Arc<CloudCodebaseController>>,
    config: Option<Arc<ConfigStore>>,
}

impl CodebaseRetrievalContextSource {
    pub(crate) fn new(
        index: Arc<Codebase>,
        symbol_index: Option<Arc<SymbolIndex>>,
        semantic: Option<Arc<CodebaseSemanticService>>,
        cloud: Option<Arc<CloudCodebaseController>>,
        config: Option<Arc<ConfigStore>>,
    ) -> Self {
        Self {
            index,
            symbol_index,
            semantic,
            cloud,
            config,
        }
    }

    fn enabled(&self) -> bool {
        self.config
            .as_ref()
            .and_then(|config| config.read_snapshot().ok())
            .is_some_and(|snapshot| {
                snapshot.values.codebase.automatic_context
                    == CodebaseAutomaticContext::FirstInvocation
            })
    }

    fn service(&self) -> Result<CodebaseRetrievalService, CoreError> {
        let service = match (&self.semantic, &self.cloud) {
            (_, Some(cloud)) => CodebaseRetrievalService::enhanced(
                Arc::clone(&self.index),
                Arc::clone(cloud) as Arc<dyn ash_codebase::CodebaseEnhancement>,
            ),
            (Some(semantic), None) => CodebaseRetrievalService::local_semantic(
                Arc::clone(&self.index),
                Arc::clone(semantic),
            ),
            (None, None) => Ok(CodebaseRetrievalService::local(Arc::clone(&self.index))),
        }
        .map_err(|error| CoreError::Context(error.to_string()))?;
        let service = match &self.symbol_index {
            Some(symbol_index) => service
                .with_symbol_index(Arc::clone(symbol_index))
                .map_err(|error| CoreError::Context(error.to_string()))?,
            None => service,
        };
        Ok(service.with_budget(
            CodebaseRetrievalBudget::default()
                .with_max_item_bytes(NonZeroUsize::new(MAX_EVIDENCE_ITEM_BYTES).unwrap())
                .with_max_total_bytes(NonZeroUsize::new(MAX_EVIDENCE_TOTAL_BYTES).unwrap()),
        ))
    }
}

impl ContextSource for CodebaseRetrievalContextSource {
    fn collect(
        &self,
        request: &ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, CoreError> {
        if !self.enabled() {
            return Ok(Vec::new());
        }
        let query = CodebaseRetrievalQuery::new(
            request.query,
            NonZeroUsize::new(MAX_EVIDENCE_ITEMS).unwrap(),
        )
        .map_err(|error| CoreError::Context(error.to_string()))?;
        let retrieval = self
            .service()?
            .retrieve_with_cancellation(&query, cancellation)
            .map_err(|error| match error {
                ash_codebase::CodebaseRetrievalError::Cancelled(message) => {
                    CoreError::Cancelled(message)
                }
                error => CoreError::Context(error.to_string()),
            })?;
        Ok(retrieval
            .hits
            .into_iter()
            .map(|hit| {
                let source = if hit.origins.contains(&CodebaseRetrievalOrigin::LocalSymbol) {
                    "codebase/local-symbol"
                } else {
                    "codebase"
                };
                ContextEvidence {
                    source: source.into(),
                    reference: format!(
                        "{}:{}-{}",
                        hit.reference.relative_path.display(),
                        hit.reference.span.start_line.saturating_add(1),
                        hit.reference.span.end_line_exclusive
                    ),
                    revision: hit.reference.source_revision.as_str().to_owned(),
                    body: hit.content,
                }
            })
            .collect())
    }
}

#[cfg(test)]
#[path = "codebase_retrieval_context_tests.rs"]
mod tests;
