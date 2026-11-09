use super::AppServer;
use super::session_execution_router::SessionExecutionRouter;
use crate::dir_grants::DirGrants;
use ash_file_access::Permission;
use ash_projects::ProjectCoordinator;
use ash_projects::ProjectScope;
use ash_protocol::SessionId;
use ash_protocol::SessionKind;
use ash_protocol::ThreadId;
use ash_teams::TeamCoordinator;
use memories::MemoryError;
use memories::MemoryScope;
use memories_extension::MemoryScopeProvider;
use std::sync::Arc;

/// Adapts task identity and current directory authority to the Memory domain.
struct MemoryScopes {
    context_router: SessionExecutionRouter,
    config: Option<Arc<ash_config::ConfigStore>>,
    projects: Option<Arc<ProjectCoordinator>>,
    teams: Option<Arc<TeamCoordinator>>,
    dirs: Arc<DirGrants>,
}

impl AppServer {
    pub(super) fn validate_memory_origin(
        &self,
        origin: &memories::MemoryTurnSource,
        scope: &MemoryScope,
    ) -> Result<(), super::RpcError> {
        use ash_app_server_protocol::protocol::error::AppServerErrorName;
        use ash_protocol::ThreadItem;

        let invalid = || super::RpcError::new(-32602, AppServerErrorName::InvalidParams);
        let (project_id, kind) = match scope {
            MemoryScope::Project { project_id } => (project_id, SessionKind::Code),
            MemoryScope::ChatProject { project_id } => (project_id, SessionKind::Chat),
            _ => return Err(invalid()),
        };
        let project = self
            .projects
            .as_ref()
            .ok_or_else(invalid)?
            .read(project_id)
            .map_err(|_| invalid())?;
        if (kind == SessionKind::Code && project.scope() != ProjectScope::Code)
            || !project.is_active()
            || !project.session_ids.contains(&origin.session_id)
            || self
                .threads
                .read_session_catalog(&origin.session_id)
                .map_err(|_| invalid())?
                .is_none_or(|session| session.kind != kind)
        {
            return Err(invalid());
        }
        let thread = self
            .threads
            .read_thread(&origin.thread_id)
            .map_err(|_| invalid())?;
        if thread.session_id != origin.session_id
            || !thread.items.iter().any(|item| {
                matches!(item, ThreadItem::UserMessage { item_id, turn_id, .. }
                if *item_id == origin.item_id && *turn_id == origin.turn_id)
            })
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn memory_scope_labels(
        &self,
        thread_id: Option<&ThreadId>,
    ) -> Result<Vec<(MemoryScope, String)>, String> {
        let Some(thread_id) = thread_id else {
            return Ok(vec![(MemoryScope::Profile, "Personal memories".into())]);
        };
        let thread = self
            .threads
            .read_thread(thread_id)
            .map_err(|error| error.to_string())?;
        let kind = self
            .threads
            .read_session_catalog(&thread.session_id)
            .map_err(|error| error.to_string())?
            .ok_or("Session unavailable")?
            .kind;
        let dirs = self
            .env_runtime
            .read()
            .map_err(|_| "Environment lock poisoned")?
            .dir_grants
            .clone();
        let scopes = MemoryScopes {
            context_router: SessionExecutionRouter::new(&self.threads),
            config: self.config.clone(),
            projects: self.projects.clone(),
            teams: self.teams.clone(),
            dirs: dirs.clone(),
        }
        .available_scopes(kind, &thread.session_id, thread_id)
        .map_err(|error| error.to_string())?;
        let mut directory_labels = std::collections::BTreeMap::new();
        if let Some(scope) = dirs
            .thread_scope(thread_id, Permission::ReadFiles)
            .map_err(|error| error.to_string())?
        {
            let dir = scope.primary().dir();
            directory_labels.insert(dir.id(), dir.requested_path().display().to_string());
        }
        for entry in dirs.list(&thread.session_id) {
            directory_labels.insert(
                entry.dir().id(),
                entry.dir().requested_path().display().to_string(),
            );
        }
        scopes
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|scope| {
                let label = match &scope {
                    MemoryScope::Profile => "Personal memories".into(),
                    MemoryScope::Project { project_id }
                    | MemoryScope::ChatProject { project_id } => format!(
                        "Project: {}",
                        self.projects
                            .as_ref()
                            .ok_or("Projects unavailable")?
                            .read(project_id)
                            .map_err(|error| error.to_string())?
                            .name
                    ),
                    MemoryScope::Team { team_id } => format!(
                        "Team: {}",
                        self.teams
                            .as_ref()
                            .ok_or("Teams unavailable")?
                            .read(team_id)
                            .map_err(|error| error.to_string())?
                            .name
                    ),
                    MemoryScope::Dir { dir_id } => format!(
                        "Directory: {}",
                        directory_labels
                            .get(dir_id)
                            .ok_or("Directory authorization changed; refresh memory scopes")?
                    ),
                };
                Ok((scope, label))
            })
            .collect()
    }

    pub(super) fn with_memory_extension(mut self) -> Result<Self, String> {
        let Some(memories) = self.memories.clone() else {
            return Ok(self);
        };
        let scopes = Arc::new(MemoryScopes {
            context_router: SessionExecutionRouter::new(&self.threads),
            config: self.config.clone(),
            projects: self.projects.clone(),
            teams: self.teams.clone(),
            dirs: Arc::clone(&self.env_runtime_mut().dir_grants),
        });
        let mut builder =
            ash_extension_api::ExtensionRegistryBuilder::from_registry(&self.agent_extensions);
        memories_extension::install(&mut builder, memories, scopes, self.updates.clone());
        let registry = Arc::new(builder.build());
        let tools = crate::extension_tools::compose_extension_tools(&registry)
            .map_err(|error| error.to_string())?;
        self.threads
            .install_extensions(Arc::clone(&registry))
            .map_err(|error| error.to_string())?;
        let executor = self
            .env_runtime_mut()
            .turn_executor
            .clone()
            .with_extensions(Arc::clone(&registry));
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime_mut().turn_executor = executor;
        self.agent_extensions = registry;
        self.update_extension_config_watcher();
        self.with_extension_tool_port(tools)
            .map_err(|error| error.to_string())
    }
}

impl MemoryScopeProvider for MemoryScopes {
    fn scopes(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Vec<MemoryScope>, MemoryError> {
        let kind = self.route(session_id)?.kind();
        if !self.memory_enabled(kind)? {
            return Ok(Vec::new());
        }
        self.available_scopes(kind, session_id, thread_id)
    }

    fn automatic_scopes(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Vec<MemoryScope>, MemoryError> {
        let route = self.route(session_id)?;
        if !self.memory_enabled(route.kind())? {
            return Ok(Vec::new());
        }
        if route.kind() == SessionKind::Chat || route.allows_workspace() {
            self.available_scopes(route.kind(), session_id, thread_id)
        } else {
            Ok(vec![MemoryScope::Profile])
        }
    }
}

impl MemoryScopes {
    fn route(
        &self,
        session_id: &SessionId,
    ) -> Result<super::session_execution_router::SessionExecutionRoute, MemoryError> {
        self.context_router
            .resolve(session_id)
            .map_err(|error| MemoryError::Storage(error.to_string()))
    }

    fn memory_enabled(&self, kind: SessionKind) -> Result<bool, MemoryError> {
        let feature = match kind {
            SessionKind::Chat => features::Feature::ChatMemories,
            SessionKind::Code => features::Feature::Memories,
        };
        self.config
            .as_ref()
            .map(|config| {
                config
                    .read_snapshot()
                    .map(|snapshot| feature.enabled(&snapshot.values.features))
            })
            .transpose()
            .map(|enabled| enabled.unwrap_or_else(|| feature.default_enabled()))
            .map_err(|error| MemoryError::Storage(error.to_string()))
    }

    fn available_scopes(
        &self,
        kind: SessionKind,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Vec<MemoryScope>, MemoryError> {
        let mut scopes = Vec::new();
        if kind == SessionKind::Code {
            scopes.push(MemoryScope::Profile);
        }
        if let Some(projects) = &self.projects {
            for project in projects
                .list()
                .map_err(|error| MemoryError::Storage(error.to_string()))?
            {
                if !project.is_active() || !project.session_ids.contains(session_id) {
                    continue;
                }
                match kind {
                    SessionKind::Chat => scopes.push(MemoryScope::ChatProject {
                        project_id: project.project_id,
                    }),
                    SessionKind::Code if project.scope() == ProjectScope::Code => {
                        scopes.push(MemoryScope::Project {
                            project_id: project.project_id,
                        });
                    }
                    SessionKind::Code => {}
                }
            }
        }
        if kind == SessionKind::Chat {
            return Ok(scopes);
        }
        if let Some(teams) = &self.teams {
            if let Some(team_id) = teams
                .team_for_thread(session_id, thread_id)
                .map_err(|error| MemoryError::Storage(error.to_string()))?
            {
                scopes.push(MemoryScope::Team { team_id });
            }
        }
        if let Some(dir_id) = self.dirs.thread_dir_id(thread_id) {
            scopes.push(MemoryScope::Dir { dir_id });
        }
        for entry in self.dirs.list(session_id) {
            if entry.permissions().allows(Permission::ReadFiles) {
                scopes.push(MemoryScope::Dir {
                    dir_id: entry.dir().id(),
                });
            }
        }
        Ok(scopes)
    }
}

impl memories_extension::MemoryEventSink for super::update_broker::UpdateBroker {
    fn changed(&self, scope: &MemoryScope, catalog_revision: u64) {
        self.publish_memory_changed(ash_app_server_protocol::protocol::memory::MemoryChanged {
            scope: scope.clone(),
            catalog_revision,
        });
    }
}

#[cfg(test)]
#[path = "memories_context_tests.rs"]
mod tests;
