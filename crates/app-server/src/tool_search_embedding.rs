use std::sync::Arc;
use std::sync::Mutex;

use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
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
    documents: Mutex<Option<Vec<EmbeddedTool>>>,
}

impl ToolSearchEmbeddingRuntime {
    pub(super) fn new(
        registry: Arc<ToolRegistrySnapshot>,
        invoker: Arc<dyn EmbeddingInvoker>,
    ) -> Self {
        Self {
            registry,
            invoker,
            documents: Mutex::new(None),
        }
    }

    pub(super) fn search(&self, query: &ToolSearchQuery) -> Result<ToolSearchResult, String> {
        let query_request = EmbeddingRequest::new(vec![query.text().to_owned()])
            .map_err(|error| error.to_string())?;
        let query_response = self
            .invoker
            .embed(&query_request)
            .map_err(|error| error.to_string())?;
        let query_vector = query_response
            .vectors()
            .first()
            .ok_or_else(|| "embedding model returned no query vector".to_owned())?;
        let mut documents = self
            .documents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if documents.is_none() {
            *documents = Some(self.embed_documents()?);
        }
        let mut ranked = documents
            .as_ref()
            .expect("embedding documents initialized")
            .iter()
            .map(|document| {
                cosine_similarity(query_vector.values(), &document.values)
                    .map(|score| (document.name.clone(), score))
            })
            .collect::<Result<Vec<_>, _>>()?;
        ranked.sort_by(|(left_name, left_score), (right_name, right_score)| {
            right_score
                .total_cmp(left_score)
                .then_with(|| left_name.cmp(right_name))
        });
        let semantic_ranking = ranked.into_iter().map(|(name, _)| name).collect::<Vec<_>>();
        Ok(self.registry.search_hybrid(query, &semantic_ranking))
    }

    fn embed_documents(&self) -> Result<Vec<EmbeddedTool>, String> {
        let documents = self.registry.search_documents();
        let mut embedded = Vec::with_capacity(documents.len());
        for chunk in documents.chunks(MAX_EMBEDDING_BATCH_ITEMS) {
            let request = EmbeddingRequest::new(
                chunk
                    .iter()
                    .map(|document| document.text().to_owned())
                    .collect(),
            )
            .map_err(|error| error.to_string())?;
            let response = self
                .invoker
                .embed(&request)
                .map_err(|error| error.to_string())?;
            if response.vectors().len() != chunk.len() {
                return Err(format!(
                    "embedding model returned {} document vectors for {} tools",
                    response.vectors().len(),
                    chunk.len()
                ));
            }
            embedded.extend(
                chunk
                    .iter()
                    .zip(response.into_vectors())
                    .map(|(document, vector)| EmbeddedTool {
                        name: document.name().clone(),
                        values: vector.values().to_vec(),
                    }),
            );
        }
        Ok(embedded)
    }
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Result<f32, String> {
    if left.len() != right.len() {
        return Err(format!(
            "embedding dimensions differ: query={}, document={}",
            left.len(),
            right.len()
        ));
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    let denominator = left_norm * right_norm;
    if denominator == 0.0 {
        return Err("embedding vectors must have non-zero magnitude".into());
    }
    Ok(dot / denominator)
}
