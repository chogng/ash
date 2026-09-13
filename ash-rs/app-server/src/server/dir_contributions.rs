use super::agent_environment_source::AgentEnvironmentSource;
use super::fs_watcher::DirFileChangeSink;
use super::fs_watcher::SessionDirFileChangeSink;
use crate::dir_grants::DirGrants;
use agent_roles::AgentRoleCatalog;
use agent_roles::AgentRoleCatalogSnapshot;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_core::CoreError;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_file_access::Authorization;
use ash_instructions::InstructionCatalog;
use ash_instructions::InstructionCatalogSnapshot;
use ash_protocol::SessionId;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

struct DirContributionCatalog {
    authorization: Authorization,
    instructions: InstructionCatalog,
    agents: AgentRoleCatalog,
}

pub(super) struct DirContributions {
    environment: AgentEnvironmentSource,
    env_dir: Mutex<Option<DirContributionCatalog>>,
    dir_grants: Arc<DirGrants>,
    dirs: Mutex<BTreeMap<SessionId, BTreeMap<PathBuf, DirContributionCatalog>>>,
    hooks: RwLock<Option<Arc<ash_hooks::DeclarativeHookRuntime>>>,
}

impl DirContributions {
    pub(super) fn discover(
        dir_root: impl AsRef<Path>,
        dir_grants: Arc<DirGrants>,
        authorization: Option<Authorization>,
    ) -> Result<Arc<Self>, ash_agent_environment::AgentEnvironmentError> {
        let dir_root = dir_root.as_ref().to_path_buf();
        let env_dir = authorization
            .filter(|authorization| {
                authorization.permission() == ash_file_access::Permission::LoadInstructions
                    && authorization.is_active()
                    && authorization
                        .dir()
                        .directory()
                        .driver()
                        .open_directory(&dir_root)
                        .map(ash_file_access::Dir::from_directory)
                        .is_ok_and(|dir| &dir == authorization.dir())
            })
            .map(|authorization| {
                let source_id = authorization.dir().id().to_string();
                DirContributionCatalog {
                    instructions: InstructionCatalog::discover(&dir_root),
                    agents: AgentRoleCatalog::discover(source_id, &dir_root),
                    authorization,
                }
            });
        let environment = AgentEnvironmentSource::capture(&dir_root)?;
        Ok(Arc::new(Self {
            environment,
            env_dir: Mutex::new(env_dir),
            dir_grants,
            dirs: Mutex::new(BTreeMap::new()),
            hooks: RwLock::new(None),
        }))
    }

    pub(super) fn bind_hooks(&self, hooks: Arc<ash_hooks::DeclarativeHookRuntime>) {
        *self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hooks);
    }

    pub(super) fn instruction_snapshot(&self) -> Arc<InstructionCatalogSnapshot> {
        self.env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|catalog| catalog.authorization.is_active())
            .map(|catalog| catalog.instructions.snapshot())
            .unwrap_or_default()
    }

    pub(super) fn agent_snapshot(&self) -> Arc<AgentRoleCatalogSnapshot> {
        self.env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|catalog| catalog.authorization.is_active())
            .map(|catalog| catalog.agents.snapshot())
            .unwrap_or_default()
    }

    pub(super) fn agent_snapshots_for(
        &self,
        session_id: &SessionId,
    ) -> Vec<Arc<AgentRoleCatalogSnapshot>> {
        let mut snapshots = Vec::new();
        let env = self.agent_snapshot();
        if !env.entries().is_empty() || !env.diagnostics().is_empty() {
            snapshots.push(env);
        }
        let dirs = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(catalogs) = dirs.get(session_id) {
            snapshots.extend(
                catalogs
                    .values()
                    .filter(|catalog| catalog.authorization.ensure_active().is_ok())
                    .map(|catalog| catalog.agents.snapshot()),
            );
        }
        snapshots
    }

    pub(super) fn instruction_snapshots_for(
        &self,
        session_id: &SessionId,
    ) -> Vec<Arc<InstructionCatalogSnapshot>> {
        let mut snapshots = Vec::new();
        let env = self.instruction_snapshot();
        if !env.entries().is_empty() || !env.diagnostics().is_empty() {
            snapshots.push(env);
        }
        let dirs = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(catalogs) = dirs.get(session_id) {
            snapshots.extend(
                catalogs
                    .values()
                    .filter(|catalog| catalog.authorization.ensure_active().is_ok())
                    .map(|catalog| catalog.instructions.snapshot()),
            );
        }
        snapshots
    }

    pub(super) fn reconcile_session(
        &self,
        session_id: &SessionId,
        authorizations: Vec<Authorization>,
    ) {
        let mut dirs = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut previous = dirs.remove(session_id).unwrap_or_default();
        let catalogs = authorizations
            .into_iter()
            .filter(|authorization| {
                authorization.permission() == ash_file_access::Permission::LoadInstructions
                    && authorization.subject()
                        == &ash_file_access::GrantSubject::SessionTree(session_id.clone())
                    && authorization.is_active()
            })
            .map(|authorization| {
                let root = authorization.dir().canonical_path().to_path_buf();
                let catalog = if let Some(mut catalog) = previous
                    .remove(&root)
                    .filter(|catalog| catalog.authorization.dir() == authorization.dir())
                {
                    catalog.authorization = authorization;
                    catalog
                } else {
                    let source_id = authorization.dir().id().to_string();
                    DirContributionCatalog {
                        instructions: InstructionCatalog::discover(&root),
                        agents: AgentRoleCatalog::discover(source_id, &root),
                        authorization,
                    }
                };
                (root, catalog)
            })
            .collect::<BTreeMap<_, _>>();
        if !catalogs.is_empty() {
            dirs.insert(session_id.clone(), catalogs);
        }
    }

    pub(super) fn remove_session(&self, session_id: &SessionId) {
        self.dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    pub(super) fn dir_files_changed(
        &self,
        session_id: &SessionId,
        root: &Path,
        changed: &FsChanged,
    ) {
        let refresh_hooks = matches!(changed, FsChanged::RescanRequired { .. })
            || matches!(changed, FsChanged::PathsChanged { paths, .. } if paths.iter().any(|path| affects(path, ".ash/config.toml")));
        let mut dirs = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(catalog) = dirs
            .get_mut(session_id)
            .and_then(|catalogs| catalogs.get_mut(root))
        else {
            drop(dirs);
            if refresh_hooks {
                self.refresh_session_hooks(session_id);
            }
            return;
        };
        if catalog.authorization.ensure_active().is_err() {
            return;
        }
        match changed {
            FsChanged::RescanRequired { .. } => {
                catalog.instructions.refresh();
                catalog.agents.refresh();
            }
            FsChanged::PathsChanged { paths, .. } => {
                if paths.iter().any(|path| affects(path, ".ash/instructions")) {
                    catalog.instructions.refresh();
                }
                if paths.iter().any(|path| affects(path, ".ash/agents")) {
                    catalog.agents.refresh();
                }
            }
        }
        drop(dirs);
        if refresh_hooks {
            self.refresh_session_hooks(session_id);
        }
    }

    fn refresh_session_hooks(&self, session_id: &SessionId) {
        let Some(hooks) = self
            .hooks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        else {
            return;
        };
        let authorizations = self
            .dir_grants
            .snapshot_for(session_id, ash_file_access::Permission::DiscoverHooks)
            .ok()
            .flatten()
            .into_iter()
            .flat_map(|snapshot| snapshot.authorizations().to_vec())
            .filter_map(|discovery| {
                self.dir_grants
                    .authorize(
                        session_id,
                        discovery.dir().canonical_path(),
                        ash_file_access::Permission::ExecuteCommands,
                    )
                    .ok()
                    .flatten()
                    .map(|execution| (discovery, execution))
            })
            .filter_map(|(discovery, execution)| {
                super::environment_runtime::read_dir_config(discovery.dir())
                    .ok()
                    .map(|document| (document.hooks, discovery, execution))
            })
            .collect();
        if let Err(error) = hooks.replace_session_dirs(session_id.clone(), authorizations) {
            log::warn!("failed to refresh directory Hooks: {error}");
        }
    }

    fn refresh_instructions(&self) {
        if let Some(catalog) = self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .filter(|catalog| catalog.authorization.is_active())
        {
            catalog.instructions.refresh();
        }
    }

    fn refresh_agents(&self) {
        if let Some(catalog) = self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .filter(|catalog| catalog.authorization.is_active())
        {
            catalog.agents.refresh();
        }
    }
}

impl HarnessContextProvider for DirContributions {
    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        let base_instructions = Arc::new(render_harness_instructions(
            self.instruction_snapshot().as_ref(),
        ));
        let roots = self
            .dir_grants
            .snapshot_for(
                request.session_id,
                ash_file_access::Permission::InspectRepository,
            )
            .map_err(|error| CoreError::Context(error.to_string()))?
            .into_iter()
            .flat_map(|snapshot| {
                snapshot
                    .authorizations()
                    .iter()
                    .filter(|root| root.is_active())
                    .map(|root| root.dir().canonical_path().to_path_buf())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let environment = self
            .environment
            .snapshot(roots)
            .map_err(|error| CoreError::Context(error.to_string()))?;
        let dir_content = {
            let dirs = self
                .dirs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            dirs.get(request.session_id)
                .into_iter()
                .flat_map(BTreeMap::iter)
                .filter(|(_, catalog)| catalog.authorization.ensure_active().is_ok())
                .filter_map(|(root, catalog)| {
                    catalog
                        .instructions
                        .snapshot()
                        .global_content()
                        .map(|content| (root.clone(), content))
                })
                .collect::<Vec<_>>()
        };
        let instructions = if dir_content.is_empty() {
            base_instructions
        } else {
            let primary = self.instruction_snapshot();
            Arc::new(render_harness_instructions_with_dirs(
                primary.as_ref(),
                &dir_content,
            ))
        };
        Ok(Arc::new(
            HarnessContext::new(instructions.as_ref().clone()).with_environment(environment),
        ))
    }
}

impl DirFileChangeSink for DirContributions {
    fn files_changed(&self, changed: &FsChanged) {
        match changed {
            FsChanged::RescanRequired { .. } => {
                self.refresh_instructions();
                self.refresh_agents();
            }
            FsChanged::PathsChanged { paths, .. } => {
                if paths.iter().any(|path| affects(path, ".ash/instructions")) {
                    self.refresh_instructions();
                }
                if paths.iter().any(|path| affects(path, ".ash/agents")) {
                    self.refresh_agents();
                }
            }
        }
    }
}

impl SessionDirFileChangeSink for DirContributions {
    fn session_files_changed(&self, session_id: &SessionId, root: &Path, changed: &FsChanged) {
        self.dir_files_changed(session_id, root, changed);
    }
}

fn affects(path: &Path, customization_root: &str) -> bool {
    path == Path::new(".ash")
        || path.starts_with(customization_root)
        || Path::new(customization_root).starts_with(path)
}

fn render_harness_instructions(instructions: &InstructionCatalogSnapshot) -> HarnessInstructions {
    let directory_content = instructions.global_content();
    let directory_revision = content_revision(
        "directory-instructions",
        directory_content.as_deref().unwrap_or_default(),
    );
    HarnessInstructions::directory(directory_content).with_directory_revision(directory_revision)
}

fn render_harness_instructions_with_dirs(
    instructions: &InstructionCatalogSnapshot,
    dirs: &[(PathBuf, String)],
) -> HarnessInstructions {
    let mut sections = Vec::new();
    if let Some(primary) = instructions.global_content() {
        sections.push(primary);
    }
    sections.extend(dirs.iter().map(|(root, content)| {
        format!(
            "<directory root=\"{}\">\n{}\n</directory>",
            escape_xml(&root.display().to_string()),
            content
        )
    }));
    let content = sections.join("\n\n");
    let directory_revision = content_revision("directory-instructions", &content);
    HarnessInstructions::directory((!content.is_empty()).then_some(content))
        .with_directory_revision(directory_revision)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn content_revision(kind: &str, content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    format!(
        "{kind}:sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[cfg(test)]
#[path = "dir_contributions_tests.rs"]
mod tests;

impl agent::AgentCatalogProvider for DirContributions {
    fn agent_snapshots_for(&self, session: &SessionId) -> Vec<Arc<AgentRoleCatalogSnapshot>> {
        self.agent_snapshots_for(session)
    }
    fn instruction_snapshots_for(
        &self,
        session: &SessionId,
    ) -> Vec<Arc<InstructionCatalogSnapshot>> {
        self.instruction_snapshots_for(session)
    }
}
