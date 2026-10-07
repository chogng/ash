use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::mpsc;

use ash_config::McpServerId;
use ash_mcp_extension::McpServerRuntimeIntent;

/// Process-local override for one configured MCP server's desired connection state.
#[derive(Clone, Default)]
pub(crate) struct McpRuntimeIntents {
    states: Arc<RwLock<BTreeMap<McpServerId, McpServerRuntimeIntent>>>,
    subscribers: Arc<MutexSubscribers>,
}

type MutexSubscribers = std::sync::Mutex<Vec<mpsc::Sender<()>>>;

impl McpRuntimeIntents {
    pub(crate) fn snapshot(&self) -> BTreeMap<McpServerId, McpServerRuntimeIntent> {
        self.states
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn intent(&self, server_id: &McpServerId) -> Option<McpServerRuntimeIntent> {
        self.states
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(server_id)
            .copied()
    }

    pub(crate) fn set(&self, server_id: McpServerId, intent: McpServerRuntimeIntent) {
        let changed = self
            .states
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(server_id, intent)
            != Some(intent);
        if changed {
            self.subscribers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|subscriber| subscriber.send(()).is_ok());
        }
    }

    /// Requests reconciliation even when the desired intent itself did not change.
    pub(crate) fn reconcile(&self) {
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|subscriber| subscriber.send(()).is_ok());
    }

    pub(crate) fn subscribe(&self) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        receiver
    }
}

#[cfg(test)]
#[path = "mcp_runtime_tests.rs"]
mod tests;
