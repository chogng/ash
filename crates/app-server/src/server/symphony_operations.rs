use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::symphony::SymphonyConfigureParams;
use ash_app_server_protocol::protocol::symphony::SymphonyControlParams;
use ash_app_server_protocol::protocol::symphony::SymphonyEnableParams;
use ash_app_server_protocol::protocol::symphony::SymphonyMessagesParams;
use ash_app_server_protocol::protocol::symphony::SymphonySubmitParams;
use ash_protocol::SymphonyConversation;
use ash_protocol::SymphonyMessage;
use ash_protocol::SymphonyMessageRole;
use ash_protocol::SymphonyMessages;
use ash_protocol::SymphonySnapshot;
use ash_protocol::ThreadItem;
use core_api::AgentRuntime;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

impl AppServer {
    pub(crate) fn with_symphony_store(
        mut self,
        store: Arc<ash_symphony::Store>,
        http: Arc<dyn ash_http_client::HttpClient>,
    ) -> Self {
        self.symphony = Some(store);
        self.symphony_http = Some(http);
        self
    }

    pub(super) fn symphony_read(&self) -> Result<Value, RpcError> {
        let store = self.symphony_store()?;
        let conversations = store
            .jobs()
            .map_err(error)?
            .iter()
            .map(|job| self.symphony_conversation(job))
            .collect();
        result(&SymphonySnapshot {
            workflows: store.workflows().map_err(error)?,
            conversations,
        })
    }

    pub(super) fn symphony_configure(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SymphonyConfigureParams = decode(params)?;
        let workflow = ash_symphony::Workflow::load(Path::new(&params.path)).map_err(error)?;
        self.symphony_store()?
            .configure(&params.command_id, workflow)
            .map_err(error)?;
        self.updates.publish_symphony_changed();
        self.symphony_read()
    }

    pub(super) fn symphony_submit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SymphonySubmitParams = decode(params)?;
        let store = self.symphony_store()?;
        let id = store
            .submit(
                &params.command_id,
                &params.workflow_id,
                &params.title,
                &params.prompt,
            )
            .map_err(error)?;
        self.updates.publish_symphony_changed();
        result(&self.symphony_conversation(&store.job(&id).map_err(error)?))
    }

    pub(super) fn symphony_control(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SymphonyControlParams = decode(params)?;
        self.symphony_store()?
            .control(&params.command_id, &params.id, params.control)
            .map_err(error)?;
        self.updates.publish_symphony_changed();
        Ok(Value::Null)
    }

    pub(super) fn symphony_enable(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SymphonyEnableParams = decode(params)?;
        self.symphony_store()?
            .set_enabled(&params.command_id, &params.workflow_id, params.enabled)
            .map_err(error)?;
        self.updates.publish_symphony_changed();
        Ok(Value::Null)
    }

    pub(super) fn symphony_messages(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SymphonyMessagesParams = decode(params)?;
        let job = self.symphony_store()?.job(&params.id).map_err(error)?;
        let mut messages = Vec::new();
        if let Some(id) = &job.thread_id {
            let thread = self
                .agent_runtime()
                .read_thread(id)
                .map_err(super::core_error)?;
            for item in thread.items {
                let message = match item {
                    ThreadItem::UserMessage { item_id, text, .. } => Some(SymphonyMessage {
                        id: item_id.to_string(),
                        text,
                        role: SymphonyMessageRole::User,
                    }),
                    ThreadItem::AgentMessage { item_id, text, .. } => Some(SymphonyMessage {
                        id: item_id.to_string(),
                        text,
                        role: SymphonyMessageRole::Assistant,
                    }),
                    _ => None,
                };
                if let Some(message) = message {
                    messages.push(message);
                }
            }
            if messages.len() > 300 {
                messages.drain(..messages.len() - 300);
            }
        }
        result(&SymphonyMessages {
            conversation: self.symphony_conversation(&job),
            messages,
        })
    }

    fn symphony_conversation(&self, job: &ash_symphony::Job) -> SymphonyConversation {
        let mut conversation = SymphonyConversation {
            id: job.id.clone(),
            workflow_id: job.workflow_id.clone(),
            identifier: job.issue.identifier.clone(),
            title: job.issue.title.clone(),
            status: job.status,
            thread_id: job.thread_id.clone(),
            attempt: job.attempt,
            usage: Default::default(),
            duration_ms: 0,
            error: job.error.clone(),
        };
        if let Some(thread_id) = &job.thread_id {
            match self.agent_runtime().read_thread(thread_id) {
                Ok(thread) => {
                    conversation.duration_ms = thread.completed_turn_duration_ms().saturating_add(
                        thread
                            .active_turn_started_at_unix_ms()
                            .map_or(0, |start| ash_symphony::now().saturating_sub(start)),
                    );
                    conversation.usage = thread.usage;
                }
                Err(error) => conversation.error = Some(error.to_string()),
            }
        }
        conversation
    }

    fn symphony_store(&self) -> Result<&ash_symphony::Store, RpcError> {
        self.symphony
            .as_deref()
            .ok_or_else(|| RpcError::new(-32200, AppServerErrorName::SymphonyUnavailable))
    }
}

fn error(error: ash_symphony::Error) -> RpcError {
    match error {
        ash_symphony::Error::NotFound => {
            RpcError::new(-32201, AppServerErrorName::SymphonyNotFound)
        }
        ash_symphony::Error::Conflict => {
            RpcError::new(-32202, AppServerErrorName::SymphonyConflict)
        }
        ash_symphony::Error::Invalid(detail) => {
            RpcError::with_details(-32203, AppServerErrorName::SymphonyInvalid, detail)
        }
        ash_symphony::Error::Storage(_)
        | ash_symphony::Error::Record(_)
        | ash_symphony::Error::LockPoisoned => {
            RpcError::new(-32204, AppServerErrorName::SymphonyOperationFailed)
        }
    }
}
