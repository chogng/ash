use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::memory::MemoryAddParams;
use ash_app_server_protocol::protocol::memory::MemoryChanged;
use ash_app_server_protocol::protocol::memory::MemoryDeleteParams;
use ash_app_server_protocol::protocol::memory::MemoryListParams;
use ash_app_server_protocol::protocol::memory::MemoryReadParams;
use ash_app_server_protocol::protocol::memory::MemorySearchParams;
use ash_async_utils::CancellationToken;
use memories::MemoryError;
use memories::MemoryMutationDisposition;
use serde_json::Value;

const DEFAULT_PAGE_LIMIT: u32 = 20;

impl AppServer {
    pub(super) fn memory_citation_read(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::memory::MemoryCitationReadParams =
            decode(value)?;
        self.authorize_memory_scope(connection, &params.citation.scope)?;
        result(
            &self
                .memories(connection)?
                .read_citation(params.citation)
                .map_err(memory_error)?,
        )
    }

    pub(super) fn memory_policy_read(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::memory::MemoryPolicyReadParams =
            decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        result(
            &self
                .memories(connection)?
                .policy(&params.scope)
                .map_err(memory_error)?,
        )
    }

    pub(super) fn memory_policy_update(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::memory::MemoryPolicyUpdateParams =
            decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        let mutation = self
            .memories(connection)?
            .update_policy(memories::UpdateMemoryPolicyRequest {
                command_id: params.command_id,
                scope: params.scope,
                expected_revision: params.expected_revision,
                automatic_read: params.automatic_read,
                model_write: params.model_write,
            })
            .map_err(memory_error)?;
        if mutation.disposition == MemoryMutationDisposition::Committed {
            self.updates.publish_memory_changed(MemoryChanged {
                scope: mutation.policy.scope.clone(),
                catalog_revision: mutation.catalog_revision,
            });
        }
        result(&mutation)
    }

    pub(super) fn memory_add(
        &self,
        connection: &ConnectionState,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: MemoryAddParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        self.refresh_analytics()?;
        let mutation = self
            .memories(connection)?
            .add_user_memory(
                memories::AddMemoryRequest {
                    command_id: params.command_id,
                    memory_id: params.memory_id,
                    scope: params.scope,
                    title: params.title,
                    body: params.body,
                },
                cancellation,
            )
            .map_err(memory_error)?;
        if mutation.disposition == MemoryMutationDisposition::Committed {
            self.analytics.record(analytics::UsageEvent::MemoryAdded);
            self.updates.publish_memory_changed(MemoryChanged {
                scope: mutation.memory.scope.clone(),
                catalog_revision: mutation.catalog_revision,
            });
        }
        result(&mutation)
    }

    pub(super) fn memory_scopes(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::memory::MemoryScopesParams = decode(value)?;
        let memories = self.memories(connection)?;
        let scopes = self
            .memory_scope_labels(params.thread_id.as_ref())
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
            .into_iter()
            .map(|(scope, label)| {
                memories.policy(&scope).map(|policy| {
                    ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor {
                        label,
                        policy,
                    }
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(memory_error)?;
        result(&ash_app_server_protocol::protocol::memory::MemoryScopesResult { scopes })
    }

    pub(super) fn memory_update(
        &self,
        connection: &ConnectionState,
        value: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::memory::MemoryUpdateParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        let mutation = self
            .memories(connection)?
            .update_user_memory(
                memories::UpdateMemoryRequest {
                    command_id: params.command_id,
                    memory_id: params.memory_id,
                    scope: params.scope,
                    expected_revision: params.expected_revision,
                    title: params.title,
                    body: params.body,
                },
                cancellation,
            )
            .map_err(memory_error)?;
        if mutation.disposition == MemoryMutationDisposition::Committed {
            self.updates.publish_memory_changed(MemoryChanged {
                scope: mutation.memory.scope.clone(),
                catalog_revision: mutation.catalog_revision,
            });
        }
        result(&mutation)
    }

    pub(super) fn memory_list(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: MemoryListParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        let page = self
            .memories(connection)?
            .list(memories::ListMemoriesRequest {
                scope: params.scope,
                cursor: params.cursor,
                limit: params.limit.unwrap_or(DEFAULT_PAGE_LIMIT),
            })
            .map_err(memory_error)?;
        result(&page)
    }

    pub(super) fn memory_read(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: MemoryReadParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        let memory = self
            .memories(connection)?
            .read(memories::ReadMemoryRequest {
                memory_id: params.memory_id,
                scope: params.scope,
            })
            .map_err(memory_error)?;
        result(&memory)
    }

    pub(super) fn memory_search(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: MemorySearchParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        let page = self
            .memories(connection)?
            .search(memories::SearchMemoriesRequest {
                scope: params.scope,
                query: params.query,
                cursor: params.cursor,
                limit: params.limit.unwrap_or(DEFAULT_PAGE_LIMIT),
            })
            .map_err(memory_error)?;
        result(&page)
    }

    pub(super) fn memory_delete(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: MemoryDeleteParams = decode(value)?;
        self.authorize_memory_scope(connection, &params.scope)?;
        self.refresh_analytics()?;
        let deleted = self
            .memories(connection)?
            .delete(memories::DeleteMemoryRequest {
                command_id: params.command_id,
                memory_id: params.memory_id,
                scope: params.scope,
                expected_revision: params.expected_revision,
            })
            .map_err(memory_error)?;
        if deleted.disposition == MemoryMutationDisposition::Committed {
            self.analytics.record(analytics::UsageEvent::MemoryDeleted);
            self.updates.publish_memory_changed(MemoryChanged {
                scope: deleted.scope.clone(),
                catalog_revision: deleted.catalog_revision,
            });
        }
        result(&deleted)
    }

    fn memories(&self, connection: &ConnectionState) -> Result<&memories::Memories, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        self.memories
            .as_deref()
            .ok_or_else(|| RpcError::new(-32130, AppServerErrorName::MemoryUnavailable))
    }

    fn authorize_memory_scope(
        &self,
        connection: &ConnectionState,
        scope: &memories::MemoryScope,
    ) -> Result<(), RpcError> {
        self.memories(connection)?;
        if let memories::MemoryScope::Project { project_id } = scope {
            self.projects
                .as_deref()
                .ok_or_else(|| RpcError::new(-32130, AppServerErrorName::MemoryUnavailable))?
                .read(project_id)
                .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        }
        Ok(())
    }
}

fn memory_error(error: MemoryError) -> RpcError {
    match error {
        MemoryError::WriteDenied => RpcError::new(-32073, AppServerErrorName::PermissionRequired),
        MemoryError::ReadDenied => RpcError::new(-32135, AppServerErrorName::MemoryOperationFailed),
        MemoryError::InvalidInput(_) => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        MemoryError::NotFound => RpcError::new(-32131, AppServerErrorName::MemoryNotFound),
        MemoryError::AlreadyExists => {
            RpcError::new(-32132, AppServerErrorName::MemoryAlreadyExists)
        }
        MemoryError::CommandConflict => RpcError::new(-32012, AppServerErrorName::CommandConflict),
        MemoryError::RevisionConflict { .. } => {
            RpcError::new(-32133, AppServerErrorName::MemoryConflict)
        }
        MemoryError::StaleCursor { .. } => {
            RpcError::new(-32134, AppServerErrorName::MemoryCursorStale)
        }
        MemoryError::Cancelled(_) => RpcError::new(-32800, AppServerErrorName::RequestCancelled),
        MemoryError::Storage(_) => RpcError::new(-32135, AppServerErrorName::MemoryOperationFailed),
    }
}

#[cfg(test)]
#[path = "memories_operations_tests.rs"]
mod tests;
