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
