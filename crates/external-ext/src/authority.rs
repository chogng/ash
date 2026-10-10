use std::num::NonZeroU64;
use std::sync::Arc;

use crate::ActivateParams;

/// Exact live authority checked before activation and every runtime invocation.
///
/// Implementations should bind an immutable package digest and current activation revision. The
/// returned lease must keep disable/update drain semantics active until it is dropped.
pub trait ActivationAuthority: Send + Sync {
    fn authorizes(&self) -> bool;

    fn acquire(&self) -> Option<Box<dyn ActivationLease>>;
}

/// Held authority lease for one admitted activation or invocation.
///
/// Implementations release their authority drain guard when this value is dropped.
pub trait ActivationLease: Send {}

/// Process-local activation facts and the non-serializable authority gate that protects them.
#[derive(Clone)]
pub struct ExtensionActivationSpec {
    params: ActivateParams,
    activation_generation: NonZeroU64,
    authority: Arc<dyn ActivationAuthority>,
}

impl ExtensionActivationSpec {
    pub fn new(
        params: ActivateParams,
        activation_generation: NonZeroU64,
        authority: Arc<dyn ActivationAuthority>,
    ) -> Self {
        Self {
            params,
            activation_generation,
            authority,
        }
    }

    pub fn params(&self) -> &ActivateParams {
        &self.params
    }

    pub fn authority(&self) -> &Arc<dyn ActivationAuthority> {
        &self.authority
    }

    pub fn activation_generation(&self) -> NonZeroU64 {
        self.activation_generation
    }

    pub fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authority.acquire()
    }
}
