use ash_core::CoreError;

impl super::AppServer {
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
        roles.push(agent_roles::built_in_roles());
        agent::resolve_root_agent(
            selection,
            self.model_catalog.configured_default()?,
            self.turn_executor_snapshot()
                .tool_profile_snapshot()?
                .tool_names,
            &roles,
            &instructions,
            self.skills.as_deref(),
            &self.model_instructions,
        )
    }
}
