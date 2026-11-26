use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::result;
use agent_roles::UserRoleMutationError;
use ash_app_server_protocol::protocol::agent::AgentRoleUserDeleteParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use core_api::AgentRuntime;
use core_api::CoreError;
use serde_json::Value;

impl super::AppServer {
    pub(super) fn agent_role_user_delete(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        if !connection.allows_product_host_capabilities() || !connection.allows_team_capabilities()
        {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let params: AgentRoleUserDeleteParams = decode(params)?;
        if params.coordinator_responsibility.trim().is_empty() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let home = self
            .home
            .as_deref()
            .ok_or_else(|| RpcError::new(-32010, AppServerErrorName::CoreOperationFailed))?;
        let catalog = home.agents();
        let role = catalog
            .get(&params.name)
            .ok_or_else(|| RpcError::new(-32000, AppServerErrorName::ResourceNotFound))?;
        let expected = params.expected_content_digest.as_str();
        if role.content_digest() != expected {
            return Err(user_role_mutation_error(
                UserRoleMutationError::RevisionConflict,
            ));
        }
        // Detach first so no live Project reference survives a successful file deletion.
        // If a write fails, the definition remains available and the cleanup can be retried.
        self.project_processor()
            .remove_user_bot_from_projects(&params.name, &params.coordinator_responsibility)?;
        home.delete_agent(&params.name, expected)
            .map_err(user_role_mutation_error)?;
        result(&())
    }

    pub(super) fn resolve_root_agent(
        &self,
        selection: &ash_protocol::AgentRoleSelection,
    ) -> Result<Option<ash_protocol::AgentConfiguration>, CoreError> {
        if matches!(selection, ash_protocol::AgentRoleSelection::Default) {
            return Ok(None);
        }
        let (mut roles, instructions) = {
            let environment = self
                .env_runtime
                .read()
                .map_err(|_| CoreError::Execution("Environment runtime lock poisoned".into()))?;
            match &environment._dir_contributions {
                Some(contributions) => (
                    vec![contributions.agent_snapshot()],
                    contributions.instruction_snapshots(),
                ),
                None => (Vec::new(), Vec::new()),
            }
        };
        if matches!(
            selection,
            ash_protocol::AgentRoleSelection::Exact {
                source: ash_protocol::AgentRoleSource::User,
                ..
            }
        ) && let Some(home) = &self.home
        {
            roles.push(home.agents());
        }
        roles.push(agent_roles::built_in_roles());
        agent::resolve_root_agent(
            selection,
            self.model_catalog.configured_default()?,
            self.agent_runtime().agent_tool_catalog(),
            &roles,
            &instructions,
            self.skills.as_deref(),
            &self.model_instructions,
        )
    }
}

pub(super) fn user_role_mutation_error(error: UserRoleMutationError) -> RpcError {
    match error {
        UserRoleMutationError::RevisionConflict => {
            RpcError::new(-32074, AppServerErrorName::RevisionConflict)
        }
        UserRoleMutationError::Io(error) => match error.kind() {
            std::io::ErrorKind::InvalidInput => {
                RpcError::new(-32602, AppServerErrorName::InvalidParams)
            }
            std::io::ErrorKind::NotFound => {
                RpcError::new(-32000, AppServerErrorName::ResourceNotFound)
            }
            _ => core_error(CoreError::Execution(error.to_string())),
        },
    }
}
