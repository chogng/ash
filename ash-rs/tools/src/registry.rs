use crate::ToolBinding;
use crate::ToolBindingId;
use crate::ToolDefinition;
use crate::ToolExposure;
use crate::ToolLoading;
use crate::ToolName;
use crate::ToolRegistryError;
use crate::ToolRegistryGeneration;
use crate::ToolRuntimeKey;
use ash_protocol::ToolSourceProvenance;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

mod search;

use search::SearchIndex;
pub use search::TOOL_SEARCH_DEFAULT_LIMIT;
use search::TOOL_SEARCH_MAX_LIMIT;
pub use search::ToolSearchDocument;
pub use search::ToolSearchLimit;
pub use search::ToolSearchQuery;
pub use search::ToolSearchQuerySyntax;
use search::reciprocal_rank_score;

pub const TOOL_SEARCH_TOOL_NAME: &str = "tool_search";
const TOOL_SEARCH_MAX_METADATA_BYTES: usize = 16 * 1_024;

/// Extra bounded text used only to retrieve an already-authorized deferred tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSearchMetadata {
    text: String,
}

impl ToolSearchMetadata {
    pub fn new(text: impl Into<String>) -> Result<Self, ToolRegistryError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(ToolRegistryError::EmptySearchMetadata);
        }
        if text.len() > TOOL_SEARCH_MAX_METADATA_BYTES {
            return Err(ToolRegistryError::SearchMetadataTooLarge {
                actual: text.len(),
                maximum: TOOL_SEARCH_MAX_METADATA_BYTES,
            });
        }
        Ok(Self { text })
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// One source-owned definition and runtime route submitted to the registry builder.
#[derive(Clone, Debug)]
pub struct ToolRegistryRegistration {
    definition: ToolDefinition,
    runtime_key: ToolRuntimeKey,
    exposure: ToolExposure,
    search: ToolSearchMetadata,
    source_chain: Vec<ToolSourceProvenance>,
}

impl ToolRegistryRegistration {
    pub fn new(
        definition: ToolDefinition,
        runtime_key: ToolRuntimeKey,
        exposure: ToolExposure,
        search: ToolSearchMetadata,
    ) -> Result<Self, ToolRegistryError> {
        let matches_loading = match exposure {
            ToolExposure::Direct | ToolExposure::DirectModelOnly => {
                definition.loading() == ToolLoading::Eager
            }
            ToolExposure::Deferred => definition.loading() == ToolLoading::Deferred,
            ToolExposure::Hidden => true,
        };
        if !matches_loading {
            return Err(ToolRegistryError::LoadingExposureMismatch {
                name: definition.name().to_string(),
            });
        }
        Ok(Self {
            definition,
            runtime_key,
            exposure,
            search,
            source_chain: Vec::new(),
        })
    }

    pub fn with_source_chain(mut self, source_chain: Vec<ToolSourceProvenance>) -> Self {
        self.source_chain = source_chain;
        self
    }
}

/// Frozen definition, binding, exposure, and search metadata for one callable runtime.
#[derive(Clone, Debug)]
pub struct RegisteredTool {
    definition: ToolDefinition,
    binding: ToolBinding,
    exposure: ToolExposure,
    search: ToolSearchMetadata,
}

impl RegisteredTool {
    pub fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    pub fn binding(&self) -> &ToolBinding {
        &self.binding
    }

    pub const fn exposure(&self) -> ToolExposure {
        self.exposure
    }

    pub fn search_metadata(&self) -> &ToolSearchMetadata {
        &self.search
    }
}

/// Deterministic builder for one immutable tool registry generation.
pub struct ToolRegistryBuilder {
    generation: ToolRegistryGeneration,
    registrations: Vec<ToolRegistryRegistration>,
}

impl ToolRegistryBuilder {
    pub fn new(generation: ToolRegistryGeneration) -> Self {
        Self {
            generation,
            registrations: Vec::new(),
        }
    }

    pub fn register(
        &mut self,
        registration: ToolRegistryRegistration,
    ) -> Result<(), ToolRegistryError> {
        if registration.definition.name().as_str() == TOOL_SEARCH_TOOL_NAME {
            return Err(ToolRegistryError::ReservedName(
                TOOL_SEARCH_TOOL_NAME.to_owned(),
            ));
        }
        if self
            .registrations
            .iter()
            .any(|existing| existing.definition.name() == registration.definition.name())
        {
            return Err(ToolRegistryError::DuplicateName(
                registration.definition.name().to_string(),
            ));
        }
        self.registrations.push(registration);
        Ok(())
    }

    pub fn build(mut self) -> Result<ToolRegistrySnapshot, ToolRegistryError> {
        self.registrations
            .sort_by(|left, right| left.definition.name().cmp(right.definition.name()));
        let entries = self
            .registrations
            .into_iter()
            .map(|registration| {
                let name = registration.definition.name().clone();
                let binding_id = ToolBindingId::new(format!(
                    "{}:{}:{}",
                    self.generation, registration.runtime_key, name
                ))
                .expect("registry-generated binding ID is non-empty");
                let binding = ToolBinding::new(
                    self.generation,
                    binding_id,
                    name,
                    registration.definition.digest(),
                    registration.runtime_key,
                )
                .with_source_chain(registration.source_chain);
                RegisteredTool {
                    definition: registration.definition,
                    binding,
                    exposure: registration.exposure,
                    search: registration.search,
                }
            })
            .collect::<Vec<_>>();
        Ok(ToolRegistrySnapshot::new(self.generation, entries))
    }
}

/// Immutable, generation-bound catalog used for model exposure, lookup, and deterministic search.
#[derive(Clone, Debug)]
pub struct ToolRegistrySnapshot {
    generation: ToolRegistryGeneration,
    entries: Vec<RegisteredTool>,
    by_name: BTreeMap<ToolName, usize>,
    search: SearchIndex,
}

impl ToolRegistrySnapshot {
    fn new(generation: ToolRegistryGeneration, entries: Vec<RegisteredTool>) -> Self {
        let by_name = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.definition.name().clone(), index))
            .collect();
        let search = SearchIndex::new(&entries);
        Self {
            generation,
            entries,
            by_name,
            search,
        }
    }

    pub const fn generation(&self) -> ToolRegistryGeneration {
        self.generation
    }

    pub fn entries(&self) -> &[RegisteredTool] {
        &self.entries
    }

    pub fn resolve(&self, name: &ToolName) -> Option<&RegisteredTool> {
        self.by_name.get(name).map(|index| &self.entries[*index])
    }

    pub fn has_deferred_tools(&self) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.exposure == ToolExposure::Deferred)
    }

    pub fn model_definitions<'a>(
        &'a self,
        loaded: &'a BTreeSet<ToolName>,
    ) -> impl Iterator<Item = &'a ToolDefinition> + 'a {
        self.entries
            .iter()
            .filter_map(move |entry| match entry.exposure {
                ToolExposure::Direct | ToolExposure::DirectModelOnly => Some(&entry.definition),
                ToolExposure::Deferred if loaded.contains(entry.definition.name()) => {
                    Some(&entry.definition)
                }
                ToolExposure::Deferred | ToolExposure::Hidden => None,
            })
    }

    pub fn search(&self, query: &ToolSearchQuery) -> ToolSearchResult {
        self.result_from_ranking(self.search.search(&self.entries, query))
    }

    /// Merges lexical and caller-provided semantic ranks without comparing incompatible scores.
    ///
    /// The semantic ranking must be computed from [`ToolSearchDocument`] values belonging to this
    /// snapshot. Unknown or non-deferred names are ignored, and regex queries remain lexical-only.
    pub fn search_hybrid(
        &self,
        query: &ToolSearchQuery,
        semantic_ranking: &[ToolName],
    ) -> ToolSearchResult {
        if query.syntax() == ToolSearchQuerySyntax::Regex {
            return self.search(query);
        }
        let candidate_limit = TOOL_SEARCH_MAX_LIMIT;
        let lexical = self
            .search
            .search_with_limit(&self.entries, query, candidate_limit);
        let mut scores = BTreeMap::<usize, u64>::new();
        for (rank, (entry_index, _)) in lexical.into_iter().enumerate() {
            *scores.entry(entry_index).or_default() += reciprocal_rank_score(rank);
        }
        for (rank, name) in semantic_ranking.iter().take(candidate_limit).enumerate() {
            let Some(entry_index) = self.by_name.get(name).copied() else {
                continue;
            };
            if self.entries[entry_index].exposure != ToolExposure::Deferred {
                continue;
            }
            *scores.entry(entry_index).or_default() += reciprocal_rank_score(rank);
        }
        let normalized_query = query.text().to_lowercase();
        for (entry_index, score) in &mut scores {
            let name = self.entries[*entry_index]
                .definition
                .name()
                .as_str()
                .to_lowercase();
            if name == normalized_query {
                *score += 1_000_000;
            } else if name.contains(&normalized_query) {
                *score += 100_000;
            }
        }
        let mut ranked = scores.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|(left_index, left_score), (right_index, right_score)| {
            right_score.cmp(left_score).then_with(|| {
                self.entries[*left_index]
                    .definition
                    .name()
                    .cmp(self.entries[*right_index].definition.name())
            })
        });
        ranked.truncate(query.limit().get());
        self.result_from_ranking(ranked)
    }

    pub fn search_documents(&self) -> &[ToolSearchDocument] {
        &self.search.documents
    }

    fn result_from_ranking(&self, ranking: Vec<(usize, u64)>) -> ToolSearchResult {
        let matches = ranking
            .into_iter()
            .map(|(index, score)| {
                let entry = &self.entries[index];
                ToolSearchMatch {
                    score: ToolSearchScore(score),
                    loadable: LoadableToolSpec {
                        definition: entry.definition.clone(),
                        binding: entry.binding.clone(),
                    },
                }
            })
            .collect();
        ToolSearchResult {
            registry_generation: self.generation,
            matches,
        }
    }
}

/// Exact deferred definition and frozen binding returned by tool search.
#[derive(Clone, Debug)]
pub struct LoadableToolSpec {
    definition: ToolDefinition,
    binding: ToolBinding,
}

impl LoadableToolSpec {
    pub fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    pub fn binding(&self) -> &ToolBinding {
        &self.binding
    }
}

/// Stable integer relevance used only to order matches within one snapshot.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ToolSearchScore(u64);

impl ToolSearchScore {
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// One ranked deferred tool match.
#[derive(Clone, Debug)]
pub struct ToolSearchMatch {
    score: ToolSearchScore,
    loadable: LoadableToolSpec,
}

impl ToolSearchMatch {
    pub const fn score(&self) -> ToolSearchScore {
        self.score
    }

    pub fn loadable(&self) -> &LoadableToolSpec {
        &self.loadable
    }
}

/// Generation-bound result that cannot be confused with a later registry snapshot.
#[derive(Clone, Debug)]
pub struct ToolSearchResult {
    registry_generation: ToolRegistryGeneration,
    matches: Vec<ToolSearchMatch>,
}

impl ToolSearchResult {
    pub const fn registry_generation(&self) -> ToolRegistryGeneration {
        self.registry_generation
    }

    pub fn matches(&self) -> &[ToolSearchMatch] {
        &self.matches
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "registry_search_eval_tests.rs"]
mod search_eval_tests;
