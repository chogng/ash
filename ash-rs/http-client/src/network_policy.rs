use crate::HttpClientError;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::RwLock;
use tokio::sync::watch;
use url::Url;

/// Application-owned outbound hosts. `Any` preserves the default unrestricted behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NetworkAccess {
    Any,
    Hosts(BTreeSet<String>),
}

/// Live outbound policy shared by HTTP requests and WebSocket connections.
#[derive(Clone, Debug)]
pub struct OutboundNetworkPolicy {
    state: Arc<PolicyState>,
}

impl Default for OutboundNetworkPolicy {
    fn default() -> Self {
        Self::new(NetworkAccess::Any)
    }
}

#[derive(Debug)]
struct PolicyState {
    access: RwLock<NetworkAccess>,
    changes: watch::Sender<u64>,
}

impl OutboundNetworkPolicy {
    pub fn new(access: NetworkAccess) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            state: Arc::new(PolicyState {
                access: RwLock::new(access),
                changes,
            }),
        }
    }

    pub fn update(&self, access: NetworkAccess) {
        let mut current = self
            .state
            .access
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *current != access {
            *current = access;
            self.state
                .changes
                .send_modify(|generation| *generation += 1);
        }
    }

    pub fn check_url(&self, url: &str) -> Result<(), HttpClientError> {
        let url = Url::parse(url).map_err(|_| {
            HttpClientError::InvalidRequest("outbound target URL is invalid".into())
        })?;
        let host = url.host_str().ok_or_else(|| {
            HttpClientError::InvalidRequest("outbound target URL has no host".into())
        })?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let access = self
            .state
            .access
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(&*access, NetworkAccess::Any)
            || matches!(&*access, NetworkAccess::Hosts(hosts) if hosts.contains(host))
        {
            Ok(())
        } else {
            Err(HttpClientError::InvalidRequest(
                "outbound target is blocked by application network policy".into(),
            ))
        }
    }

    /// Wakes when a live connection's target is no longer permitted.
    pub async fn wait_until_denied(&self, url: &str) {
        let mut changes = self.state.changes.subscribe();
        while self.check_url(url).is_ok() && changes.changed().await.is_ok() {}
    }
}
