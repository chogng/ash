use super::ConnectionAuthority;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::message_history::MessageHistoryAppendParams;
use ash_app_server_protocol::protocol::message_history::MessageHistoryEntry as EntryDto;
use ash_app_server_protocol::protocol::message_history::MessageHistoryKind as KindDto;
use ash_app_server_protocol::protocol::message_history::MessageHistoryPage as PageDto;
use ash_app_server_protocol::protocol::message_history::MessageHistoryReadParams;
use message_history::MessageHistoryEntry;
use message_history::MessageHistoryKind;
use message_history::MessageHistoryQuery;
use message_history::MessageHistoryStore;
use message_history::MessageHistorySubmission;
use serde_json::Value;
use std::sync::Arc;

/// Adapts profile input history without retaining connections or conversation state.
/// The injected store remains the only owner of history and pagination identities.
#[derive(Default)]
pub(super) struct MessageHistoryRequestProcessor {
    store: Option<Arc<dyn MessageHistoryStore>>,
}

impl MessageHistoryRequestProcessor {
    pub(super) fn new(store: Arc<dyn MessageHistoryStore>) -> Self {
        Self { store: Some(store) }
    }

    pub(super) fn is_available(&self, authority: ConnectionAuthority) -> bool {
        self.store(authority).is_ok()
    }

    pub(super) fn append(
        &self,
        authority: ConnectionAuthority,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let store = self.store(authority)?;
        let params: MessageHistoryAppendParams = decode(value)?;
        let submission = MessageHistorySubmission {
            text: params.text,
            kind: kind(params.kind),
            thread_id: params.thread_id,
        };
        submission.validate().map_err(|_| invalid())?;
        result(&entry(
            store.append(submission).map_err(|_| operation_failed())?,
        ))
    }

    pub(super) fn read(
        &self,
        authority: ConnectionAuthority,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let store = self.store(authority)?;
        let params: MessageHistoryReadParams = decode(value)?;
        let before = params
            .before
            .map(|value| {
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(invalid());
                }
                value.parse::<u64>().map_err(|_| invalid())
            })
            .transpose()?;
        let query = MessageHistoryQuery {
            before,
            text: params.text,
            kind: params.kind.map(kind),
            limit: params.limit,
        };
        query.validate().map_err(|_| invalid())?;
        let page = store.read(&query).map_err(|_| operation_failed())?;
        result(&PageDto {
            entries: page.entries.into_iter().map(entry).collect(),
            next_before: page.next_before.map(|id| id.to_string()),
        })
    }

    pub(super) fn clear(&self, authority: ConnectionAuthority) -> Result<Value, RpcError> {
        self.store(authority)?
            .clear()
            .map_err(|_| operation_failed())?;
        Ok(Value::Null)
    }

    fn store(&self, authority: ConnectionAuthority) -> Result<&dyn MessageHistoryStore, RpcError> {
        // Profile input includes drafts from other windows and products; extension clients cannot read it.
        if !matches!(
            authority,
            ConnectionAuthority::ProductHost | ConnectionAuthority::Browser
        ) {
            return Err(RpcError::new(-32000, AppServerErrorName::ResourceNotOwner));
        }
        self.store
            .as_deref()
            .ok_or_else(|| RpcError::new(-32540, AppServerErrorName::MessageHistoryUnavailable))
    }
}

fn invalid() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn operation_failed() -> RpcError {
    RpcError::new(-32541, AppServerErrorName::MessageHistoryOperationFailed)
}

fn kind(value: KindDto) -> MessageHistoryKind {
    match value {
        KindDto::Agent => MessageHistoryKind::Agent,
        KindDto::Shell => MessageHistoryKind::Shell,
        KindDto::Command => MessageHistoryKind::Command,
    }
}

fn entry(value: MessageHistoryEntry) -> EntryDto {
    EntryDto {
        id: value.id.to_string(),
        submitted_at_ms: value.submitted_at_ms,
        text: value.submission.text,
        kind: match value.submission.kind {
            MessageHistoryKind::Agent => KindDto::Agent,
            MessageHistoryKind::Shell => KindDto::Shell,
            MessageHistoryKind::Command => KindDto::Command,
        },
        thread_id: value.submission.thread_id,
    }
}

#[cfg(test)]
#[path = "message_history_tests.rs"]
mod tests;
