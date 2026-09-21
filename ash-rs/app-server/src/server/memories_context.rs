use super::AppServer;
use crate::dir_grants::DirGrants;
use ash_file_access::Permission;
use ash_projects::ProjectCoordinator;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use memories::MemoryError;
use memories::MemoryScope;
use memories_extension::MemoryScopeProvider;
use std::sync::Arc;

/// Adapts task identity and current directory authority to the Memory domain.
struct MemoryScopes {
    config: Option<Arc<ash_config::ConfigStore>>,
    projects: Option<Arc<ProjectCoordinator>>,
    dirs: Arc<DirGrants>,
}

impl AppServer {
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
        let dirs = self
            .env_runtime
            .read()
            .map_err(|_| "Environment lock poisoned")?
            .dir_grants
            .clone();
        let scopes = MemoryScopes {
            config: self.config.clone(),
            projects: self.projects.clone(),
            dirs: dirs.clone(),
        }
        .available_scopes(&thread.session_id, thread_id)
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
                    MemoryScope::Project { project_id } => format!(
                        "Project: {}",
                        self.projects
                            .as_ref()
                            .ok_or("Projects unavailable")?
                            .read(project_id)
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
            config: self.config.clone(),
            projects: self.projects.clone(),
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
        self.restart_extension_config_watcher();
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
        let enabled = self
            .config
            .as_ref()
            .map(|config| {
                config
                    .read_snapshot()
                    .map(|snapshot| features::Feature::Memories.enabled(&snapshot.values.features))
            })
            .transpose()
            .map_err(|error| MemoryError::Storage(error.to_string()))?
            .unwrap_or(false);
        if !enabled {
            return Ok(Vec::new());
        }
        self.available_scopes(session_id, thread_id)
    }
}

impl MemoryScopes {
    fn available_scopes(
        &self,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<Vec<MemoryScope>, MemoryError> {
        let mut scopes = vec![MemoryScope::Profile];
        if let Some(projects) = &self.projects {
            for project in projects
                .list()
                .map_err(|error| MemoryError::Storage(error.to_string()))?
            {
                if project.is_active() && project.session_ids.contains(session_id) {
                    scopes.push(MemoryScope::Project {
                        project_id: project.project_id,
                    });
                }
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
