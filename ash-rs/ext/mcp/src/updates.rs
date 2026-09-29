use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::mpsc;
use std::time::Duration;

use ash_rmcp_client::McpClientEvent;
use ash_rmcp_client::McpClientHost;
use ash_rmcp_client::McpElicitation;

use ash_async_utils::CancellationSource;
use ash_core::ToolInteractionService;
use ash_protocol::HookEvent;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::HookService;

tokio::task_local! {
    static ACTIVE_TOOL_INTERACTIONS: Arc<dyn ToolInteractionService>;
    static ACTIVE_HOOK_SCOPE: HookEventScope;
}

pub(crate) async fn with_active_tool_interactions<F>(
    interactions: Arc<dyn ToolInteractionService>,
    scope: Option<HookEventScope>,
    future: F,
) -> F::Output
where
    F: std::future::Future,
{
    ACTIVE_TOOL_INTERACTIONS
        .scope(interactions, async move {
            match scope {
                Some(scope) => ACTIVE_HOOK_SCOPE.scope(scope, future).await,
                None => future.await,
            }
        })
        .await
}

/// Process-local publication hub for MCP tool-catalog invalidations.
///
/// A host shares one hub across replacement runtimes and subscribes before starting the initial
/// generation. Tool-list notifications only request a full reconcile; they never mutate a live
/// catalog in place.
#[derive(Clone, Default)]
pub struct McpCatalogUpdates {
    subscribers: Arc<Mutex<Vec<mpsc::Sender<()>>>>,
    extensions: Arc<Mutex<Option<Arc<extension_api::ExtensionRegistry>>>>,
    hooks: Arc<RwLock<Option<Arc<dyn HookService>>>>,
}

impl McpCatalogUpdates {
    pub fn bind_hooks(&self, hooks: Arc<dyn HookService>) {
        *self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hooks);
    }

    /// Binds catalog notifications to the current immutable extension registry.
    pub fn bind_extensions(&self, extensions: Arc<extension_api::ExtensionRegistry>) {
        let previous = self
            .extensions
            .lock()
            .expect("MCP extension binding lock")
            .replace(extensions);
        drop(previous);
    }
    pub(crate) fn lifecycle(&self, event: extension_api::McpLifecycle) {
        let registry = self
            .extensions
            .lock()
            .expect("MCP extension binding lock")
            .clone();
        if let Some(registry) = registry {
            registry.mcp_changed(&event);
        }
    }

    /// Subscribes to future tool-catalog invalidations.
    pub fn subscribe(&self) -> McpCatalogUpdateSubscription {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        McpCatalogUpdateSubscription { receiver }
    }

    pub(crate) fn client_host(&self) -> Arc<dyn McpClientHost> {
        Arc::new(McpCatalogUpdateHost {
            updates: self.clone(),
        })
    }

    fn publish(&self) {
        self.lifecycle(extension_api::McpLifecycle::ToolsChanged);
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|subscriber| subscriber.send(()).is_ok());
    }
}

/// Blocking receiver for MCP tool-catalog invalidations.
pub struct McpCatalogUpdateSubscription {
    receiver: mpsc::Receiver<()>,
}

impl McpCatalogUpdateSubscription {
    /// Receives one pending invalidation without blocking.
    pub fn try_recv(&self) -> Result<(), mpsc::TryRecvError> {
        self.receiver.try_recv()
    }

    /// Waits up to `timeout` for one invalidation.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<(), mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

struct McpCatalogUpdateHost {
    updates: McpCatalogUpdates,
}

impl McpClientHost for McpCatalogUpdateHost {
    fn on_event(&self, event: McpClientEvent) {
        if matches!(event, McpClientEvent::ToolListChanged) {
            self.updates.publish();
        }
    }

    fn handle_elicitation(
        &self,
        request: McpElicitation,
    ) -> ash_rmcp_client::HostFuture<
        Result<ash_rmcp_client::ElicitResult, ash_rmcp_client::RmcpErrorData>,
    > {
        let interactions = ACTIVE_TOOL_INTERACTIONS.try_with(Arc::clone).ok();
        let scope = ACTIVE_HOOK_SCOPE.try_with(Clone::clone).ok();
        let hooks = self
            .updates
            .hooks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Box::pin(async move {
            if let (Some(hooks), Some(scope)) = (&hooks, &scope) {
                let decision = emit_hook(
                    Arc::clone(hooks),
                    HookEventRequest {
                        event: HookEvent::Elicitation,
                        scope: scope.clone(),
                        subject: None,
                        tool_name: None,
                    },
                )
                .await
                .map_err(|error| ash_rmcp_client::RmcpErrorData::internal_error(error, None))?;
                if let HookEventDecision::Deny { .. } = decision {
                    return Ok(ash_rmcp_client::ElicitResult::new(
                        ash_rmcp_client::ElicitationAction::Decline,
                    ));
                }
            }
            let result = crate::elicitation::handle_elicitation(interactions, request).await;
            if let (Some(hooks), Some(scope)) = (&hooks, &scope) {
                if let Err(error) = emit_hook(
                    Arc::clone(hooks),
                    HookEventRequest {
                        event: HookEvent::ElicitationResult,
                        scope: scope.clone(),
                        subject: Some(
                            if result.is_ok() {
                                "responded"
                            } else {
                                "failed"
                            }
                            .into(),
                        ),
                        tool_name: None,
                    },
                )
                .await
                {
                    log::warn!("ElicitationResult Hook failed: {error}");
                }
            }
            result
        })
    }
}

async fn emit_hook(
    hooks: Arc<dyn HookService>,
    request: HookEventRequest,
) -> Result<HookEventDecision, String> {
    tokio::task::spawn_blocking(move || {
        let cancellation = CancellationSource::new();
        hooks
            .event(&request, &cancellation.token())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
