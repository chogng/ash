use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use ash_async_utils::CancellationToken;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::ModelProviderError;
use ash_tools::ToolName;
use ash_tools::ToolRegistrySnapshot;
use ash_tools::ToolSearchQuery;
use ash_tools::ToolSearchResult;

const MAX_EMBEDDING_BATCH_ITEMS: usize = 2_048;

struct EmbeddedTool {
    name: ToolName,
    values: Vec<f32>,
}

pub(super) struct ToolSearchEmbeddingRuntime {
    registry: Arc<ToolRegistrySnapshot>,
    invoker: Arc<dyn EmbeddingInvoker>,
    documents: Mutex<BTreeMap<ToolName, EmbeddedTool>>,
}

impl ToolSearchEmbeddingRuntime {
    pub(super) fn new(
        registry: Arc<ToolRegistrySnapshot>,
        invoker: Arc<dyn EmbeddingInvoker>,
    ) -> Self {
        Self {
            registry,
            invoker,
            documents: Mutex::new(BTreeMap::new()),
        }
    }

    pub(super) fn search(
        &self,
        query: &ToolSearchQuery,
        excluded: &[ToolName],
        cancellation: &CancellationToken,
    ) -> Result<ToolSearchResult, ModelProviderError> {
        let query_request = EmbeddingRequest::new(vec![query.text().to_owned()])?;
        let query_response = self
            .invoker
            .embed_with_cancellation(&query_request, cancellation)?;
        let [query_vector] = query_response.vectors() else {
            return Err(ModelProviderError::InvalidResponse(
                "embedding model must return one query vector".into(),
            ));
        };
        check_cancellation(cancellation)?;
        let missing = {
            let documents = self
                .documents
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.registry
                .search_documents()
                .iter()
                .filter(|document| {
                    !excluded.contains(document.name()) && !documents.contains_key(document.name())
                })
                .collect::<Vec<_>>()
        };
        // Network calls must not hold the cache lock or block another Turn's cancellation.
        let embedded = self.embed_documents(&missing, query_vector.values(), cancellation)?;
        check_cancellation(cancellation)?;
        let mut documents = self
            .documents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for document in embedded {
            documents.entry(document.name.clone()).or_insert(document);
        }
        let mut ranked = documents
            .values()
            .filter(|document| !excluded.contains(&document.name))
            .map(|document| {
                cosine_similarity(query_vector.values(), &document.values)
                    .map(|score| (document.name.clone(), score))
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(documents);
        ranked.sort_by(|(left_name, left_score), (right_name, right_score)| {
            right_score
                .total_cmp(left_score)
                .then_with(|| left_name.cmp(right_name))
        });
        let semantic_ranking = ranked.into_iter().map(|(name, _)| name).collect::<Vec<_>>();
        Ok(self
            .registry
            .search_hybrid_excluding(query, &semantic_ranking, excluded))
    }

    fn embed_documents(
        &self,
        documents: &[&ash_tools::ToolSearchDocument],
        query_vector: &[f32],
        cancellation: &CancellationToken,
    ) -> Result<Vec<EmbeddedTool>, ModelProviderError> {
        let mut embedded = Vec::with_capacity(documents.len());
        for chunk in documents.chunks(MAX_EMBEDDING_BATCH_ITEMS) {
            let request = EmbeddingRequest::new(
                chunk
                    .iter()
                    .map(|document| document.text().to_owned())
                    .collect(),
            )?;
            let response = self
                .invoker
                .embed_with_cancellation(&request, cancellation)?;
            check_cancellation(cancellation)?;
            if response.vectors().len() != chunk.len() {
                return Err(ModelProviderError::InvalidResponse(format!(
                    "embedding model returned {} document vectors for {} tools",
                    response.vectors().len(),
                    chunk.len()
                )));
            }
            for (document, vector) in chunk.iter().zip(response.into_vectors()) {
                cosine_similarity(query_vector, vector.values())?;
                embedded.push(EmbeddedTool {
                    name: document.name().clone(),
                    values: vector.values().to_vec(),
                });
            }
        }
        Ok(embedded)
    }
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), ModelProviderError> {
    cancellation
        .check()
        .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Result<f32, ModelProviderError> {
    if left.len() != right.len() {
        return Err(ModelProviderError::InvalidResponse(format!(
            "embedding dimensions differ: query={}, document={}",
            left.len(),
            right.len()
        )));
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    let denominator = left_norm * right_norm;
    if !denominator.is_finite() || denominator == 0.0 {
        return Err(ModelProviderError::InvalidResponse(
            "embedding vectors must have finite, non-zero magnitude".into(),
        ));
    }
    Ok(dot / denominator)
}
