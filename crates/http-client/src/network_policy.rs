use crate::HttpClientError;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
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
    current: Mutex<CurrentPolicy>,
    changes: watch::Sender<u64>,
}

#[derive(Debug)]
struct CurrentPolicy {
    access: NetworkAccess,
    permits: Vec<Weak<PermitState>>,
}

#[derive(Debug)]
struct PermitState {
    host: String,
    revoked: watch::Sender<bool>,
}

/// Authorization for one request. Once revoked, it cannot become valid again.
#[derive(Clone, Debug)]
pub struct NetworkPermit {
    state: Arc<PermitState>,
}

impl NetworkPermit {
    pub fn check(&self) -> Result<(), HttpClientError> {
        if *self.state.revoked.borrow() {
            Err(denied())
        } else {
            Ok(())
        }
    }

    pub async fn revoked(&self) {
        let _ = self
            .state
            .revoked
            .subscribe()
            .wait_for(|revoked| *revoked)
            .await;
    }
}

impl OutboundNetworkPolicy {
    pub fn new(access: NetworkAccess) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            state: Arc::new(PolicyState {
                current: Mutex::new(CurrentPolicy {
                    access,
                    permits: Vec::new(),
                }),
                changes,
            }),
        }
    }

    pub fn update(&self, access: NetworkAccess) {
        let mut current = self
            .state
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.access != access {
            current.permits.retain(|permit| {
                let Some(permit) = permit.upgrade() else {
                    return false;
                };
                if !allows(&access, &permit.host) {
                    permit.revoked.send_replace(true);
                }
                true
            });
            current.access = access;
            self.state
                .changes
                .send_modify(|generation| *generation += 1);
        }
    }

    pub fn check_url(&self, url: &str) -> Result<(), HttpClientError> {
        let host = host(url)?;
        let current = self
            .state
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if allows(&current.access, &host) {
            Ok(())
        } else {
            Err(denied())
        }
    }

    pub fn acquire(&self, url: &str) -> Result<NetworkPermit, HttpClientError> {
        let host = host(url)?;
        let mut current = self
            .state
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !allows(&current.access, &host) {
            return Err(denied());
        }
        let state = Arc::new(PermitState {
            host,
            revoked: watch::channel(false).0,
        });
        current.permits.retain(|permit| permit.strong_count() != 0);
        current.permits.push(Arc::downgrade(&state));
        Ok(NetworkPermit { state })
    }

    /// Wakes when a live connection's target is no longer permitted.
    pub async fn wait_until_denied(&self, url: &str) {
        let mut changes = self.state.changes.subscribe();
        while self.check_url(url).is_ok() && changes.changed().await.is_ok() {}
    }
}

fn host(url: &str) -> Result<String, HttpClientError> {
    let url = Url::parse(url)
        .map_err(|_| HttpClientError::InvalidRequest("outbound target URL is invalid".into()))?;
    let host = url
        .host_str()
        .ok_or_else(|| HttpClientError::InvalidRequest("outbound target URL has no host".into()))?;
    Ok(host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned())
}

fn allows(access: &NetworkAccess, host: &str) -> bool {
    match access {
        NetworkAccess::Any => true,
        NetworkAccess::Hosts(hosts) => hosts.contains(host),
    }
}

fn denied() -> HttpClientError {
    HttpClientError::InvalidRequest(
        "outbound target is blocked by application network policy".into(),
    )
}
