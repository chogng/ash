use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use rmcp::ClientHandler;
use rmcp::RoleClient;
use rmcp::model::{
    CancelledNotificationParam, ClientInfo, ElicitRequestParams, ElicitResult, ElicitationAction,
    ProgressNotificationParam, RequestId,
};
use rmcp::service::{NotificationContext, RequestContext};

/// Boxed future returned by host interaction callbacks.
pub type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One server-to-client elicitation together with its protocol request identity.
#[derive(Clone, Debug)]
pub struct McpElicitation {
    pub request_id: RequestId,
    pub params: ElicitRequestParams,
}

/// Asynchronous notifications emitted by an initialized MCP server.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum McpClientEvent {
    Progress(ProgressNotificationParam),
    Cancelled(CancelledNotificationParam),
    ToolListChanged,
    ResourceListChanged,
    PromptListChanged,
}

/// Host callbacks for server notifications and server-initiated interaction.
///
/// Implementations must return quickly from [`McpClientHost::on_event`]; queue work when delivery
/// may block. Elicitation may await a user response. The default implementation declines it, so a
/// product host must override [`McpClientHost::handle_elicitation`] before advertising or relying
/// on interactive behavior.
pub trait McpClientHost: Send + Sync + 'static {
    fn on_event(&self, _event: McpClientEvent) {}

    fn handle_elicitation(
        &self,
        _request: McpElicitation,
    ) -> HostFuture<Result<ElicitResult, rmcp::ErrorData>> {
        Box::pin(async { Ok(ElicitResult::new(ElicitationAction::Decline)) })
    }
}

/// Host implementation that ignores notifications and declines elicitation.
#[derive(Debug, Default)]
pub struct NoopMcpClientHost;

impl McpClientHost for NoopMcpClientHost {}

#[derive(Clone)]
pub(crate) struct ClientRuntimeHandler {
    info: ClientInfo,
    host: Arc<dyn McpClientHost>,
}

impl ClientRuntimeHandler {
    pub(crate) fn new(info: ClientInfo, host: Arc<dyn McpClientHost>) -> Self {
        Self { info, host }
    }
}

impl ClientHandler for ClientRuntimeHandler {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }

    async fn create_elicitation(
        &self,
        params: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, rmcp::ErrorData> {
        self.host
            .handle_elicitation(McpElicitation {
                request_id: context.id,
                params,
            })
            .await
    }

    async fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        self.host.on_event(McpClientEvent::Progress(params));
    }

    async fn on_cancelled(
        &self,
        params: CancelledNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        self.host.on_event(McpClientEvent::Cancelled(params));
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.host.on_event(McpClientEvent::ToolListChanged);
    }

    async fn on_resource_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.host.on_event(McpClientEvent::ResourceListChanged);
    }

    async fn on_prompt_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.host.on_event(McpClientEvent::PromptListChanged);
    }
}
