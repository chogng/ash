//! Profile-wide live window discovery. Editor objects remain in the selected client.
#[cfg(test)]
#[path = "ide_registry_tests.rs"]
mod tests;
use crate::client_host::ClientHost;
use crate::client_host::ClientHostError;
use ash_app_server_protocol::protocol::ide::IdeHostRequest;
use ash_app_server_protocol::protocol::ide::IdeHostResult;
use ash_app_server_protocol::protocol::ide::IdeWindow;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_async_utils::CancellationToken;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Clone)]
pub(crate) struct IdeTarget {
    pub(crate) window: IdeWindow,
    host: Weak<ClientHost>,
    connection_id: u64,
    active: Arc<AtomicBool>,
}

impl IdeTarget {
    pub(crate) fn is_connected(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && self
                .host
                .upgrade()
                .is_some_and(|host| host.is_connected(self.connection_id))
    }

    pub(crate) fn request(
        &self,
        params: &IdeHostRequest,
        cancellation: &CancellationToken,
    ) -> Result<IdeHostResult, ClientHostError> {
        if !self.is_connected() {
            return Err(ClientHostError::CapabilityUnavailable);
        }
        let host = self
            .host
            .upgrade()
            .ok_or(ClientHostError::CapabilityUnavailable)?;
        host.request_with_timeout(
            self.connection_id,
            HostMethod::IdeHostRequest,
            params,
            cancellation,
            Duration::from_secs(5),
        )
    }
}

#[derive(Default)]
pub(crate) struct IdeRegistry {
    windows: Mutex<BTreeMap<String, IdeTarget>>,
}

impl IdeRegistry {
    pub(crate) fn register(
        &self,
        host: &Arc<ClientHost>,
        connection_id: u64,
        title: String,
        roots: Vec<String>,
    ) -> Result<IdeWindow, ClientHostError> {
        let mut windows = self
            .windows
            .lock()
            .map_err(|_| ClientHostError::Failed("IDE registry lock poisoned".into()))?;
        let existing = windows.values().find(|target| {
            target.connection_id == connection_id && target.host.ptr_eq(&Arc::downgrade(host))
        });
        if let Some(target) = existing {
            if target.window.roots == roots {
                let id = target.window.id.clone();
                let target = windows
                    .get_mut(&id)
                    .expect("existing IDE window is still locked");
                target.window.title = title;
                return Ok(target.window.clone());
            }
            target.active.store(false, Ordering::Release);
            let id = target.window.id.clone();
            windows.remove(&id);
        }
        windows.retain(|_, target| target.is_connected());
        if windows.len() >= 128 {
            return Err(ClientHostError::Failed("IDE window limit reached".into()));
        }
        let mut bytes = [0; 16];
        getrandom::getrandom(&mut bytes)
            .map_err(|error| ClientHostError::Failed(error.to_string()))?;
        let id = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let window = IdeWindow {
            id: id.clone(),
            title,
            roots,
        };
        windows.insert(
            id,
            IdeTarget {
                window: window.clone(),
                host: Arc::downgrade(host),
                connection_id,
                active: Arc::new(AtomicBool::new(true)),
            },
        );
        Ok(window)
    }

    pub(crate) fn list(&self) -> Vec<IdeWindow> {
        self.windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|target| target.is_connected())
            .map(|target| target.window.clone())
            .collect()
    }

    pub(crate) fn get(&self, id: &str) -> Result<IdeTarget, ClientHostError> {
        self.windows
            .lock()
            .map_err(|_| ClientHostError::Failed("IDE registry lock poisoned".into()))?
            .get(id)
            .filter(|target| target.is_connected())
            .cloned()
            .ok_or(ClientHostError::CapabilityUnavailable)
    }

    pub(crate) fn unregister(&self, host: &Arc<ClientHost>, connection_id: u64) {
        self.windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, target| {
                let keep = target.connection_id != connection_id
                    || !target.host.ptr_eq(&Arc::downgrade(host));
                if !keep {
                    target.active.store(false, Ordering::Release);
                }
                keep
            });
    }
}
