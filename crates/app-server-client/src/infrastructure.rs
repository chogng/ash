use crate::AppServerClient;
use crate::ClientError;
use crate::JsonRpcTransport;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::diagnostics::FeedbackPrepareParams;
use ash_app_server_protocol::protocol::diagnostics::FeedbackUploadParams;
use ash_app_server_protocol::protocol::extension_items::ExtensionItemsParams;
use ash_app_server_protocol::protocol::extension_items::ExtensionItemsResult;
use ash_app_server_protocol::protocol::queue::QueueCancelParams;
use ash_app_server_protocol::protocol::queue::QueueEnqueueParams;
use ash_app_server_protocol::protocol::queue::QueueListParams;
use ash_app_server_protocol::protocol::queue::QueueListResult;
use ash_app_server_protocol::protocol::registry::ClientMethod;

impl<T: JsonRpcTransport> AppServerClient<T> {
    pub fn start_mcp_oauth(
        &mut self,
        params: ash_app_server_protocol::protocol::mcp::McpOAuthStartParams,
    ) -> Result<ash_app_server_protocol::protocol::mcp::McpOAuthStartResult, ClientError> {
        self.call(ClientMethod::McpOAuthStart, params)
    }
    pub fn complete_mcp_oauth(
        &mut self,
        params: McpOAuthCompleteRequest,
    ) -> Result<ash_app_server_protocol::protocol::mcp::McpOAuthMutationResult, ClientError> {
        self.call_secret(ClientMethod::McpOAuthComplete, params)
    }
    pub fn logout_mcp_oauth(
        &mut self,
        params: ash_app_server_protocol::protocol::mcp::McpOAuthMutationParams,
    ) -> Result<ash_app_server_protocol::protocol::mcp::McpOAuthMutationResult, ClientError> {
        self.call(ClientMethod::McpOAuthLogout, params)
    }
    pub fn cancel_mcp_oauth(
        &mut self,
        params: ash_app_server_protocol::protocol::mcp::McpOAuthCancelParams,
    ) -> Result<(), ClientError> {
        self.call(ClientMethod::McpOAuthCancel, params)
    }
    pub fn edit_queued_message(
        &mut self,
        params: ash_app_server_protocol::protocol::queue::QueueEditParams,
    ) -> Result<queue::QueuedMessage, ClientError> {
        self.call(ClientMethod::QueueEdit, params)
    }
    pub fn enqueue_message(
        &mut self,
        params: QueueEnqueueParams,
    ) -> Result<queue::QueuedMessage, ClientError> {
        self.call(ClientMethod::QueueEnqueue, params)
    }
    pub fn list_queued_messages(
        &mut self,
        params: QueueListParams,
    ) -> Result<QueueListResult, ClientError> {
        let scope = (params.session_id.clone(), params.thread_id.clone());
        let result: QueueListResult = self.call(ClientMethod::QueueList, params)?;
        if result.messages.iter().any(|message| {
            message.request.session_id != scope.0 || message.request.thread_id != scope.1
        }) {
            return Err(ClientError::Protocol(
                "queue snapshot belongs to another Thread".into(),
            ));
        }
        Ok(result)
    }
    pub fn cancel_queued_message(
        &mut self,
        params: QueueCancelParams,
    ) -> Result<queue::QueuedMessage, ClientError> {
        self.call(ClientMethod::QueueCancel, params)
    }
    pub fn read_diagnostics(&mut self) -> Result<diagnostics::DiagnosticSnapshot, ClientError> {
        self.call(ClientMethod::DiagnosticsRead, EmptyParams::default())
    }
    pub fn prepare_feedback(
        &mut self,
        params: FeedbackPrepareParams,
    ) -> Result<feedback_contract::PreparedFeedback, ClientError> {
        self.call(ClientMethod::FeedbackPrepare, params)
    }
    /// The caller obtains explicit user approval of the prepared bytes and destination first.
    pub fn upload_feedback(&mut self, params: FeedbackUploadParams) -> Result<(), ClientError> {
        self.call(ClientMethod::FeedbackUpload, params)
    }
    pub fn list_extension_items(
        &mut self,
        params: ExtensionItemsParams,
    ) -> Result<ExtensionItemsResult, ClientError> {
        self.call(ClientMethod::ExtensionItems, params)
    }
}

/// Secret-bearing callback request; never passed through the ordinary diagnostic serializer.
pub struct McpOAuthCompleteRequest {
    flow_id: String,
    state: String,
    authorization_code: String,
    issuer: Option<String>,
}
impl McpOAuthCompleteRequest {
    pub fn new(
        flow_id: String,
        state: String,
        authorization_code: String,
        issuer: Option<String>,
    ) -> Self {
        Self {
            flow_id,
            state,
            authorization_code,
            issuer,
        }
    }
}
impl serde::Serialize for McpOAuthCompleteRequest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("McpOAuthCompleteRequest", 4)?;
        value.serialize_field("flowId", &self.flow_id)?;
        value.serialize_field("state", &self.state)?;
        value.serialize_field("authorizationCode", &self.authorization_code)?;
        value.serialize_field("issuer", &self.issuer)?;
        value.end()
    }
}
impl Drop for McpOAuthCompleteRequest {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.state.zeroize();
        self.authorization_code.zeroize();
    }
}
