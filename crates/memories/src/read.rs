use crate::Memories;
use crate::Memory;
use crate::MemoryError;
use crate::MemoryId;
use crate::MemoryScope;
use crate::MemorySource;
use crate::MemoryStoreContextRequest;
use async_utils::CancellationToken;
use base64::Engine;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use ts_rs::TS;

const MAX_SCOPES: usize = 32;
const MAX_TERMS: usize = 16;
const MAX_CANDIDATES: usize = 64;
const MAX_ITEMS: usize = 8;
const MAX_ITEM_BYTES: usize = 4096;
const MAX_TOTAL_BYTES: usize = 16 * 1024;

/// An exact UTF-8 byte range in one immutable Memory revision; it grants no read authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCitation {
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub revision: u64,
    pub start_byte: u32,
    pub end_byte: u32,
}

impl MemoryCitation {
    pub fn reference(&self) -> Result<String, MemoryError> {
        let json =
            serde_json::to_vec(self).map_err(|error| MemoryError::Storage(error.to_string()))?;
        Ok(format!(
            "memory:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        ))
    }

    pub fn parse(reference: &str) -> Result<Self, MemoryError> {
        if reference.len() > 4096 {
            return Err(MemoryError::InvalidInput(
                "Memory citation is too long".into(),
            ));
        }
        let encoded = reference
            .strip_prefix("memory:")
            .ok_or_else(|| MemoryError::InvalidInput("Invalid Memory citation".into()))?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| MemoryError::InvalidInput("Invalid Memory citation".into()))?;
        let citation: Self = serde_json::from_slice(&bytes)
            .map_err(|_| MemoryError::InvalidInput("Invalid Memory citation".into()))?;
        citation.validate()?;
        Ok(citation)
    }

    fn validate(&self) -> Result<(), MemoryError> {
        if self.revision == 0 || self.start_byte >= self.end_byte || self.end_byte > 16384 {
            return Err(MemoryError::InvalidInput(
                "Invalid Memory citation range or revision".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCitationResult {
    pub citation: MemoryCitation,
    pub title: String,
    pub source: MemorySource,
    pub body: String,
}

impl Memories {
    pub fn read_citation(
        &self,
        citation: MemoryCitation,
    ) -> Result<MemoryCitationResult, MemoryError> {
        citation.validate()?;
        let memory = self.store.read(&citation.scope, &citation.memory_id)?;
        citation_result(memory, citation)
    }

    /// Reads an exact citation only within current host authority and current scope consent.
    pub fn read_context_citation(
        &self,
        scopes: &[MemoryScope],
        citation: MemoryCitation,
        cancellation: &CancellationToken,
    ) -> Result<MemoryCitationResult, MemoryError> {
        check_cancellation(cancellation)?;
        citation.validate()?;
        if !scopes.contains(&citation.scope) {
            return Err(MemoryError::ReadDenied);
        }
        let memory = self
            .store
            .read_for_context(&citation.scope, &citation.memory_id)?;
        check_cancellation(cancellation)?;
        citation_result(memory, citation)
    }

    /// Reads the complete current Memory identified by a citation after rechecking host authority,
    /// scope consent, revision, and the cited UTF-8 range.
    pub fn read_context_memory(
        &self,
        scopes: &[MemoryScope],
        citation: MemoryCitation,
        cancellation: &CancellationToken,
    ) -> Result<MemoryCitationResult, MemoryError> {
        check_cancellation(cancellation)?;
        citation.validate()?;
        if !scopes.contains(&citation.scope) {
            return Err(MemoryError::ReadDenied);
        }
        let memory = self
            .store
            .read_for_context(&citation.scope, &citation.memory_id)?;
        check_cancellation(cancellation)?;
        validate_memory_citation(&memory, &citation)?;
        let citation = MemoryCitation {
            memory_id: memory.memory_id.clone(),
            scope: memory.scope.clone(),
            revision: memory.revision,
            start_byte: 0,
            end_byte: memory.body.len() as u32,
        };
        Ok(MemoryCitationResult {
            citation,
            title: memory.title,
            source: memory.source,
            body: memory.body,
        })
    }

    /// Retrieves only explicitly opted-in scopes selected by the host's current task authority.
    /// Returns reference data, never instructions. Automatic injection stays ephemeral; explicit
    /// model reads may return the excerpts through ordinary Tool Results.
    pub fn collect_context(
        &self,
        scopes: Vec<MemoryScope>,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<MemoryCitationResult>, MemoryError> {
        check_cancellation(cancellation)?;
        let scopes = scopes.into_iter().collect::<BTreeSet<_>>();
        if scopes.len() > MAX_SCOPES {
            return Err(MemoryError::InvalidInput(
                "Too many Memory context scopes".into(),
            ));
        }
        let terms = query_terms(query);
        if terms.is_empty() || scopes.is_empty() {
            return Ok(Vec::new());
        }
        let mut candidates = self.store.context(&MemoryStoreContextRequest {
            scopes: scopes.into_iter().collect(),
            normalized_terms: terms.clone(),
            limit: MAX_CANDIDATES,
        })?;
        check_cancellation(cancellation)?;
        candidates.sort_by_cached_key(|memory| {
            let title = memory.title.to_lowercase();
            let body = memory.body.to_lowercase();
            let score = terms
                .iter()
                .map(|term| {
                    usize::from(title.contains(term)) * 3 + usize::from(body.contains(term))
                })
                .sum::<usize>();
            (std::cmp::Reverse(score), memory.memory_id.clone())
        });
        let mut remaining = MAX_TOTAL_BYTES;
        let mut evidence = Vec::new();
        for memory in candidates.into_iter().take(MAX_ITEMS) {
            check_cancellation(cancellation)?;
            let (citation, body) = excerpt(&memory, &terms, MAX_ITEM_BYTES.min(remaining));
            if body.is_empty() {
                continue;
            }
            remaining -= body.len();
            evidence.push(MemoryCitationResult {
                citation,
                title: memory.title,
                source: memory.source,
                body,
            });
        }
        Ok(evidence)
    }
}

fn citation_result(
    memory: Memory,
    citation: MemoryCitation,
) -> Result<MemoryCitationResult, MemoryError> {
    validate_memory_citation(&memory, &citation)?;
    let body = memory.body[citation.start_byte as usize..citation.end_byte as usize].to_owned();
    Ok(MemoryCitationResult {
        citation,
        title: memory.title,
        source: memory.source,
        body,
    })
}

fn validate_memory_citation(memory: &Memory, citation: &MemoryCitation) -> Result<(), MemoryError> {
    if memory.revision != citation.revision {
        return Err(MemoryError::RevisionConflict {
            expected: citation.revision,
            actual: memory.revision,
        });
    }
    memory
        .body
        .get(citation.start_byte as usize..citation.end_byte as usize)
        .ok_or_else(|| {
            MemoryError::InvalidInput("Memory citation is outside UTF-8 content".into())
        })?;
    Ok(())
}

pub(crate) fn excerpt(
    memory: &Memory,
    terms: &[String],
    max_bytes: usize,
) -> (MemoryCitation, String) {
    // Lowercase can change UTF-8 length, so retain the source offset for each folded character.
    let folded = memory.body.to_lowercase();
    let mut offsets = Vec::new();
    for (offset, ch) in memory.body.char_indices() {
        for lower in ch.to_lowercase() {
            offsets.extend(std::iter::repeat_n(offset, lower.len_utf8()));
        }
    }
    let hit = terms
        .iter()
        .filter_map(|term| folded.find(term))
        .min()
        .and_then(|offset| offsets.get(offset).copied())
        .unwrap_or(0);
    let mut start = hit.saturating_sub(max_bytes / 4);
    while !memory.body.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + max_bytes).min(memory.body.len());
    while !memory.body.is_char_boundary(end) {
        end -= 1;
    }
    (
        MemoryCitation {
            memory_id: memory.memory_id.clone(),
            scope: memory.scope.clone(),
            revision: memory.revision,
            start_byte: start as u32,
            end_byte: end as u32,
        },
        memory.body[start..end].to_owned(),
    )
}

fn query_terms(query: &str) -> Vec<String> {
    let mut terms = BTreeSet::new();
    let mut word = String::new();
    let mut previous_cjk = None;
    for ch in query.chars().take(2048) {
        let cjk = matches!(ch as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x20000..=0x323af);
        if !ch.is_alphanumeric() || cjk {
            if word.chars().count() >= 2 {
                terms.insert(word.to_lowercase());
            }
            word.clear();
        }
        if cjk {
            // Adjacent ideographs remain searchable in prose without requiring a language model.
            if let Some(previous) = previous_cjk {
                terms.insert(format!("{previous}{ch}"));
            }
            previous_cjk = Some(ch);
        } else {
            previous_cjk = None;
            if ch.is_alphanumeric() {
                word.push(ch);
            }
        }
        if terms.len() >= MAX_TERMS {
            break;
        }
    }
    if terms.len() < MAX_TERMS && word.chars().count() >= 2 {
        terms.insert(word.to_lowercase());
    }
    terms.into_iter().collect()
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), MemoryError> {
    cancellation
        .check()
        .map_err(|signal| MemoryError::Cancelled(signal.reason().to_string()))
}
