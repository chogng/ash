use std::num::NonZeroU64;
use std::num::NonZeroUsize;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use ash_codebase::ChunkReference;
use ash_codebase::MaterializedChunk;
use serde::Deserialize;
use serde::Serialize;

use crate::CloudCodebaseError;

macro_rules! text_identity {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, CloudCodebaseError> {
                let value = value.into();
                validate_text(&value, $label)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

text_identity!(CloudCodebaseGrantId, "grant identity");
text_identity!(CloudCodebaseId, "cloud codebase identity");
text_identity!(CloudCodebaseProviderId, "provider identity");

/// User-visible deployment choice for codebase retrieval.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CodebaseDeploymentMode {
    LocalOnly,
    Cloud,
}

/// Deletion guarantee required before any cloud grant can become active.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloudCodebaseDeletionSupport {
    IdempotentGrantDeletion,
    Unsupported,
}

/// Static provider capabilities checked before a grant is persisted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CloudCodebaseCapabilities {
    pub deletion: CloudCodebaseDeletionSupport,
}

/// Provider, tenant, and provider-owned collection selected by the user.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CloudCodebaseDestination {
    pub provider: CloudCodebaseProviderId,
    pub tenant: String,
    pub collection: String,
}

impl CloudCodebaseDestination {
    pub fn new(
        provider: CloudCodebaseProviderId,
        tenant: impl Into<String>,
        collection: impl Into<String>,
    ) -> Result<Self, CloudCodebaseError> {
        let tenant = tenant.into();
        let collection = collection.into();
        validate_text(&tenant, "tenant")?;
        validate_text(&collection, "collection")?;
        Ok(Self {
            provider,
            tenant,
            collection,
        })
    }
}

/// Directory-relative source selection covered by one durable egress grant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CloudCodebaseSelection {
    EntireIndex,
    PathPrefixes(Vec<PathBuf>),
}

impl CloudCodebaseSelection {
    pub fn path_prefixes(prefixes: Vec<PathBuf>) -> Result<Self, CloudCodebaseError> {
        if prefixes.is_empty() {
            return Err(CloudCodebaseError::InvalidInput(
                "path-prefix selection must not be empty",
            ));
        }
        for prefix in &prefixes {
            validate_relative_prefix(prefix)?;
        }
        Ok(Self::PathPrefixes(prefixes))
    }

    pub(crate) fn includes(&self, path: &Path) -> bool {
        match self {
            Self::EntireIndex => true,
            Self::PathPrefixes(prefixes) => prefixes.iter().any(|prefix| path.starts_with(prefix)),
        }
    }
}

/// Durable, root-bound user consent with a source-content byte ceiling.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CloudCodebaseGrant {
    pub id: CloudCodebaseGrantId,
    pub codebase_id: CloudCodebaseId,
    pub root_id: String,
    pub destination: CloudCodebaseDestination,
    pub selection: CloudCodebaseSelection,
    pub max_egress_bytes: NonZeroU64,
}

/// Whether the current local generation fits within the proposed egress byte ceiling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloudCodebaseLimitDisposition {
    WithinLimit,
    ExceedsLimit,
}

/// Exact local preview of source-content units and bytes for the current generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudCodebasePreview {
    pub local_generation: u64,
    pub file_count: usize,
    pub chunk_count: usize,
    pub upload_unit_count: usize,
    pub egress_bytes: u64,
    pub limit: CloudCodebaseLimitDisposition,
}

/// Durable cloud publication/deletion phase.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CloudCodebaseState {
    LocalOnly,
    Granted,
    Syncing,
    Ready,
    Stale,
    Revoking,
    Failed,
}

/// Current deployment choice and local/remote generation relationship.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudCodebaseStatus {
    pub deployment_mode: CodebaseDeploymentMode,
    pub state: CloudCodebaseState,
    pub grant: Option<CloudCodebaseGrant>,
    pub local_generation: u64,
    pub synced_local_generation: Option<u64>,
    pub remote_generation: Option<String>,
}

/// Persistence location for egress consent and deletion recovery state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CloudCodebaseStorage {
    Memory,
    Persistent(PathBuf),
}

/// Provider publication acknowledgement. The generation must be opaque and non-secret.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudCodebasePublication {
    pub remote_generation: String,
}

/// Bounded semantic query issued against the exact remote generation recorded by the grant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudCodebaseQuery {
    text: String,
    result_limit: NonZeroUsize,
}

impl CloudCodebaseQuery {
    pub fn new(
        text: impl Into<String>,
        result_limit: NonZeroUsize,
    ) -> Result<Self, CloudCodebaseError> {
        let text = text.into();
        if text.trim().is_empty() || text.len() > 8 * 1024 {
            return Err(CloudCodebaseError::InvalidInput(
                "cloud query must contain at most 8192 bytes of text",
            ));
        }
        if result_limit.get() > 100 {
            return Err(CloudCodebaseError::InvalidInput(
                "cloud query result limit must not exceed 100",
            ));
        }
        Ok(Self { text, result_limit })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn result_limit(&self) -> NonZeroUsize {
        self.result_limit
    }
}

/// Provider query input bound to the durable grant and one exact remote generation.
#[derive(Clone, Debug)]
pub struct CloudCodebaseQueryRequest {
    pub grant: CloudCodebaseGrant,
    pub remote_generation: String,
    pub query: CloudCodebaseQuery,
}

/// One cloud retrieval candidate at its provider-ranked position in the query result.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudCodebaseCandidate {
    pub reference: ChunkReference,
}

/// Provider-ranked query result, including the generation that actually served the candidates.
///
/// Candidate order is canonical. The cloud Codebase service must finish semantic recall,
/// reranking, filtering, and truncation before returning this result.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudCodebaseQueryResult {
    pub remote_generation: String,
    pub candidates: Vec<CloudCodebaseCandidate>,
}

/// Locally chunked, revision-verified source fragments sent for cloud embedding/vector storage.
#[derive(Clone, Debug)]
pub struct CloudCodebasePublicationRequest {
    pub grant: CloudCodebaseGrant,
    pub local_generation: u64,
    pub chunks: Vec<MaterializedChunk>,
}

fn validate_text(value: &str, _label: &'static str) -> Result<(), CloudCodebaseError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(CloudCodebaseError::InvalidInput(
            "cloud identity text must be 1..=256 bytes without control characters",
        ));
    }
    Ok(())
}

fn validate_relative_prefix(prefix: &Path) -> Result<(), CloudCodebaseError> {
    if prefix.as_os_str().is_empty()
        || prefix.is_absolute()
        || prefix
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CloudCodebaseError::InvalidInput(
            "egress path prefixes must be non-empty normalized relative paths",
        ));
    }
    Ok(())
}
