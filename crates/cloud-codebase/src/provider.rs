use std::collections::BTreeMap;
use std::sync::Arc;

use crate::CloudCodebaseCapabilities;
use crate::CloudCodebaseError;
use crate::CloudCodebaseGrant;
use crate::CloudCodebaseProviderError;
use crate::CloudCodebaseProviderId;
use crate::CloudCodebasePublication;
use crate::CloudCodebasePublicationRequest;
use crate::CloudCodebaseQueryRequest;
use crate::CloudCodebaseQueryResult;

/// Provider boundary for cloud codebase publication and deletion.
///
/// Implementations are expected to bind credentials, network policy, tenant isolation, request
/// size limits, and logging redaction before sending any request. Publication must be retry-safe
/// for the same grant and local generation. `delete_grant` must be idempotent and cover every
/// remote object created under the supplied grant.
pub trait CloudCodebaseProvider: Send + Sync {
    fn id(&self) -> &CloudCodebaseProviderId;

    fn capabilities(&self) -> CloudCodebaseCapabilities;

    /// Publishes chunks produced and revision-verified inside the directory grant.
    ///
    /// Implementations are thin transport adapters to a remote Codebase service. They must not
    /// read directory files, change chunk boundaries, or substitute complete source files.
    fn publish(
        &self,
        request: CloudCodebasePublicationRequest,
    ) -> Result<CloudCodebasePublication, CloudCodebaseProviderError>;

    /// Queries one exact, ready remote generation without changing its lifecycle state.
    ///
    /// Implementations forward this typed request to the remote Codebase service. The remote
    /// service owns query preparation, embedding/vector recall, optional reranking, and result
    /// filtering/truncation. It returns candidates in final relevance order; local callers
    /// preserve that order during cross-source fusion and do not receive model scores.
    ///
    /// Implementations must return revision-bound references only from the supplied grant,
    /// destination, selection, and generation. The controller validates those boundaries before
    /// candidates can reach the retrieval layer.
    fn query(
        &self,
        request: CloudCodebaseQueryRequest,
    ) -> Result<CloudCodebaseQueryResult, CloudCodebaseProviderError>;

    fn delete_grant(&self, grant: &CloudCodebaseGrant) -> Result<(), CloudCodebaseProviderError>;
}

/// Immutable set of cloud providers available to one host composition.
#[derive(Clone, Default)]
pub struct CloudCodebaseProviderRegistry {
    providers: Arc<BTreeMap<CloudCodebaseProviderId, Arc<dyn CloudCodebaseProvider>>>,
}

impl CloudCodebaseProviderRegistry {
    pub fn new(
        providers: impl IntoIterator<Item = Arc<dyn CloudCodebaseProvider>>,
    ) -> Result<Self, CloudCodebaseError> {
        let mut indexed = BTreeMap::new();
        for provider in providers {
            if indexed.insert(provider.id().clone(), provider).is_some() {
                return Err(CloudCodebaseError::InvalidInput(
                    "cloud provider identities must be unique",
                ));
            }
        }
        Ok(Self {
            providers: Arc::new(indexed),
        })
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub(crate) fn get(
        &self,
        id: &CloudCodebaseProviderId,
    ) -> Option<Arc<dyn CloudCodebaseProvider>> {
        self.providers.get(id).cloned()
    }
}
