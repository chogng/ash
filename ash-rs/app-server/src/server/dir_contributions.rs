use super::agent_environment_source::AgentEnvironmentSource;
use super::agent_environment_source::RepositoryInspection;
use super::fs_watcher::DirFileChangeSink;
use super::fs_watcher::SessionDirFileChangeSink;
use super::home_context::add_home_instructions;
use super::home_context::catalog_instructions;
use crate::dir_grants::DirGrants;
use agent_roles::AgentRoleCatalog;
use agent_roles::AgentRoleCatalogSnapshot;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_file_access::Authorization;
use ash_home::AshHome;
use ash_instructions::InstructionCatalog;
use ash_instructions::InstructionCatalogSnapshot;
use ash_protocol::SessionId;
use core_api::CoreError;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::HookService;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::mpsc;

struct DirContributionCatalog {
    authorization: Authorization,
    instructions: InstructionCatalog,
    agents: AgentRoleCatalog,
}

pub(super) struct DirContributions {
    environment: AgentEnvironmentSource,
    dir_root: PathBuf,
    home: Option<Arc<AshHome>>,
    env_dir: Mutex<Option<DirContributionCatalog>>,
    dir_grants: Arc<DirGrants>,
    dirs: Mutex<BTreeMap<SessionId, BTreeMap<PathBuf, DirContributionCatalog>>>,
    session_environments: Mutex<BTreeMap<SessionId, AgentEnvironmentSource>>,
    nested_warnings: Mutex<BTreeMap<SessionId, BTreeSet<String>>>,
    hooks: Arc<RwLock<Option<Arc<ash_hooks::DeclarativeHookRuntime>>>>,
    file_hook_events: Mutex<Option<mpsc::SyncSender<HookEventRequest>>>,
}

impl DirContributions {
    pub(super) fn discover(
        dir_root: impl AsRef<Path>,
        dir_grants: Arc<DirGrants>,
        authorization: Option<Authorization>,
        home: Option<Arc<AshHome>>,
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
        let hooks: Arc<RwLock<Option<Arc<ash_hooks::DeclarativeHookRuntime>>>> =
            Arc::new(RwLock::new(None));
        Ok(Arc::new(Self {
            environment,
            dir_root,
            home,
            env_dir: Mutex::new(env_dir),
            dir_grants,
            dirs: Mutex::new(BTreeMap::new()),
            session_environments: Mutex::new(BTreeMap::new()),
            nested_warnings: Mutex::new(BTreeMap::new()),
            hooks,
            file_hook_events: Mutex::new(None),
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

    pub(super) fn refresh_root_agents(&self) -> Arc<AgentRoleCatalogSnapshot> {
        self.env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .filter(|catalog| catalog.authorization.is_active())
            .map(|catalog| catalog.agents.refresh())
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

    pub(super) fn read_instruction(&self, session: &SessionId, path: &Path) -> Option<String> {
        let home_body = if let Some(home) = &self.home
            && let Some(body) =
                home.instructions()
                    .body_at(path, home.root(), &home.root().join("instructions"))
        {
            Some(body.to_owned())
        } else {
            None
        };
        let project_body = home_body
            .is_none()
            .then(|| {
                self.env_dir
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_mut()
                    .filter(|catalog| catalog.authorization.is_active())
                    .and_then(|catalog| {
                        catalog.instructions.refresh();
                        catalog.instructions.read(path)
                    })
            })
            .flatten();
        let directory_body = (home_body.is_none() && project_body.is_none())
            .then(|| {
                self.dirs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get_mut(session)
                    .and_then(|catalogs| {
                        catalogs
                            .values_mut()
                            .filter(|catalog| catalog.authorization.is_active())
                            .find_map(|catalog| {
                                catalog.instructions.refresh();
                                catalog.instructions.read(path)
                            })
                    })
            })
            .flatten();
        let body = home_body.or(project_body).or(directory_body);
        if body.is_some() {
            if let Some(hooks) = self
                .hooks
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
            {
                let cancellation = ash_async_utils::CancellationSource::new();
                if let Err(error) = hooks.event(
                    &HookEventRequest {
                        event: ash_protocol::HookEvent::InstructionsLoaded,
                        scope: HookEventScope::Session {
                            session_id: session.clone(),
                        },
                        subject: Some(path.display().to_string()),
                        tool_name: None,
                    },
                    &cancellation.token(),
                ) {
                    log::warn!("InstructionsLoaded Hook failed: {error}");
                }
            }
        }
        body
    }

    pub(super) fn directory_instruction_sources(
        &self,
        session_id: &SessionId,
    ) -> Vec<(PathBuf, Arc<InstructionCatalogSnapshot>)> {
        let mut sources = BTreeMap::new();
        if let Some(catalog) = self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .filter(|catalog| catalog.authorization.is_active())
        {
            sources.insert(self.dir_root.clone(), catalog.instructions.refresh());
        }
        if let Some(catalogs) = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(session_id)
        {
            for (root, catalog) in catalogs
                .iter_mut()
                .filter(|(_, catalog)| catalog.authorization.is_active())
            {
                sources.insert(root.clone(), catalog.instructions.refresh());
            }
        }
        sources.into_iter().collect()
    }

    pub(super) fn instruction_snapshots(&self) -> Vec<Arc<InstructionCatalogSnapshot>> {
        let mut snapshots = Vec::new();
        if let Some(home) = &self.home {
            let user = home.instructions();
            if !user.entries().is_empty() || !user.diagnostics().is_empty() {
                snapshots.push(user);
            }
        }
        let env = self.instruction_snapshot();
        if !env.entries().is_empty() || !env.diagnostics().is_empty() {
            snapshots.push(env);
        }
        snapshots
    }

    pub(super) fn instruction_snapshots_for(
        &self,
        session_id: &SessionId,
    ) -> Vec<Arc<InstructionCatalogSnapshot>> {
        let mut snapshots = self.instruction_snapshots();
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
        self.session_environments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        self.dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        self.nested_warnings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    pub(super) fn move_session(&self, session_id: SessionId, environment: AgentEnvironmentSource) {
        self.session_environments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, environment);
    }

    pub(super) fn environment_for_directory(
        &self,
        path: &Path,
        repository_inspection: RepositoryInspection,
    ) -> Result<AgentEnvironmentSource, ash_agent_environment::AgentEnvironmentError> {
        self.environment.for_directory(path, repository_inspection)
    }

    pub(super) fn forget_ungranted_session_directory(&self, session_id: &SessionId) {
        let mut environments = self
            .session_environments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if environments.get(session_id).is_some_and(|source| {
            !self
                .dir_grants
                .list(session_id)
                .iter()
                .any(|entry| entry.dir().canonical_path() == source.cwd())
        }) {
            environments.remove(session_id);
        }
    }

    pub(super) fn dir_files_changed(
        &self,
        session_id: &SessionId,
        root: &Path,
        changed: &FsChanged,
    ) {
        self.queue_file_events(
            changed,
            HookEventScope::Session {
                session_id: session_id.clone(),
            },
        );
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
                if paths.iter().any(|path| affects_instructions(path)) {
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

    fn queue_file_events(&self, changed: &FsChanged, scope: HookEventScope) {
        if let FsChanged::PathsChanged { paths, .. } = changed {
            let runtime = self
                .hooks
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let Some(runtime) = runtime else {
                return;
            };
            if !runtime.has_enabled_event(ash_protocol::HookEvent::FileChanged) {
                return;
            }
            let mut sender = self
                .file_hook_events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let sender = sender.get_or_insert_with(|| {
                let (sender, pending) = mpsc::sync_channel(256);
                let worker_hooks = Arc::clone(&self.hooks);
                std::thread::spawn(move || {
                    while let Ok(request) = pending.recv() {
                        let runtime = worker_hooks
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        if let Some(runtime) = runtime {
                            let cancellation = ash_async_utils::CancellationSource::new();
                            if let Err(error) = runtime.event(&request, &cancellation.token()) {
                                log::warn!("FileChanged Hook failed: {error}");
                            }
                        }
                    }
                });
                sender
            });
            for path in paths {
                if let Err(error) = sender.try_send(HookEventRequest {
                    event: ash_protocol::HookEvent::FileChanged,
                    scope: scope.clone(),
                    subject: Some(path.display().to_string()),
                    tool_name: None,
                }) {
                    log::warn!("FileChanged Hook queue is unavailable: {error}");
                    break;
                }
            }
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
        let authorizations =
            match super::environment_runtime::session_hook_bindings(&self.dir_grants, session_id) {
                Ok(bindings) => bindings,
                Err(error) => {
                    log::warn!("failed to refresh directory Hooks: {error}");
                    return;
                }
            };
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
    fn validate_tool_context(
        &self,
        request: &HarnessContextRequest<'_>,
        call: &ash_protocol::ToolCall,
    ) -> Result<(), CoreError> {
        let targets = match call.name.as_str() {
            "write_file" | "edit" => vec![PathBuf::from(
                call.arguments
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        CoreError::InvalidInput("file mutation requires a path".into())
                    })?,
            )],
            "apply_patch" => ash_apply_patch::changed_paths(
                call.arguments
                    .get("patch")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        CoreError::InvalidInput("apply_patch requires patch text".into())
                    })?,
                ash_apply_patch::ApplyPatchLimits::default(),
            )
            .map_err(CoreError::InvalidInput)?,
            _ => return Ok(()),
        };
        let targets = targets
            .into_iter()
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    self.dir_root.join(path)
                }
            })
            .collect::<Vec<_>>();
        let mut required = BTreeSet::new();
        let mut user_targets = Vec::new();
        let mut user_known = Vec::new();
        let mut inspect = |root: &Path, catalog: &mut DirContributionCatalog| {
            if !catalog.authorization.is_active() {
                return;
            }
            catalog.instructions.refresh();
            let targets = matching_paths(root, &targets);
            let known = matching_paths(root, request.read_paths);
            required.extend(catalog.instructions.required_reads(
                &targets,
                &known,
                &known.iter().map(|path| root.join(path)).collect::<Vec<_>>(),
            ));
            user_targets.extend(targets);
            user_known.extend(known);
        };
        if let Some(catalog) = self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            inspect(&self.dir_root, catalog);
        }
        if let Some(catalogs) = self
            .dirs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(request.session_id)
        {
            for (root, catalog) in catalogs {
                inspect(root, catalog);
            }
        }
        if let Some(home) = &self.home {
            let catalog = InstructionCatalog::discover_user(home.root());
            let selected = matching_paths(home.root(), request.read_paths)
                .iter()
                .map(|path| home.root().join(path))
                .collect::<Vec<_>>();
            required.extend(catalog.required_reads(&user_targets, &user_known, &selected));
        }
        if required.is_empty() {
            return Ok(());
        }
        Err(CoreError::InvalidInput(format!(
            "No files were changed. Use read_instruction to read these applicable instruction files, reconsider the proposed changes, then submit a new tool call:\n{}",
            required
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        )))
    }

    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        let base_paths = matching_paths(&self.dir_root, request.read_paths);
        self.refresh_instructions();
        let primary = self.instruction_snapshot();
        let nested = self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|catalog| catalog.authorization.is_active())
            .map(|catalog| catalog.instructions.nested_instructions(&base_paths))
            .unwrap_or_default();
        let mut nested_diagnostics = nested
            .diagnostics()
            .iter()
            .cloned()
            .map(|diagnostic| (self.dir_root.clone(), diagnostic))
            .collect::<Vec<_>>();
        let mut contributions = if self
            .env_dir
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(|catalog| catalog.authorization.is_active())
        {
            directory_contributions(&primary, &nested, &base_paths, &self.dir_root)
        } else {
            Vec::new()
        };
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
        let source = self
            .session_environments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(request.session_id)
            .cloned()
            .unwrap_or_else(|| self.environment.clone());
        let environment = source
            .snapshot(roots)
            .map_err(|error| CoreError::Context(error.to_string()))?;
        let (dir_contributions, user_paths) = {
            let mut dirs = self
                .dirs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut user_paths = base_paths.clone();
            let content = dirs
                .get_mut(request.session_id)
                .into_iter()
                .flat_map(BTreeMap::iter_mut)
                .filter(|(_, catalog)| catalog.authorization.ensure_active().is_ok())
                .map(|(root, catalog)| {
                    catalog.instructions.refresh();
                    let paths = matching_paths(root, request.read_paths);
                    user_paths.extend(paths.iter().cloned());
                    let nested = catalog.instructions.nested_instructions(&paths);
                    nested_diagnostics.extend(
                        nested
                            .diagnostics()
                            .iter()
                            .cloned()
                            .map(|diagnostic| (root.clone(), diagnostic)),
                    );
                    directory_contributions(&catalog.instructions.snapshot(), &nested, &paths, root)
                })
                .collect::<Vec<_>>();
            (content, user_paths)
        };
        self.record_nested_diagnostics(request.session_id, &nested_diagnostics);
        contributions.extend(dir_contributions.into_iter().flatten());
        let instructions = contributions
            .into_iter()
            .fold(HarnessInstructions::default(), |instructions, entry| {
                instructions.with_instruction(entry)
            });
        let instructions = match &self.home {
            Some(home) => {
                add_home_instructions(instructions, home, &user_paths, request.read_paths)
            }
            None => instructions,
        };
        Ok(Arc::new(
            HarnessContext::new(instructions).with_environment(environment),
        ))
    }
}

impl DirContributions {
    fn record_nested_diagnostics(
        &self,
        session_id: &SessionId,
        diagnostics: &[(PathBuf, ash_instructions::InstructionDiagnostic)],
    ) {
        let mut history = self
            .nested_warnings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = history.get(session_id).cloned().unwrap_or_default();
        let mut current = BTreeSet::new();
        for (root, diagnostic) in diagnostics {
            let key = format!(
                "{}:{}:{:?}",
                root.display(),
                diagnostic
                    .relative_path()
                    .unwrap_or(Path::new("."))
                    .display(),
                diagnostic.code()
            );
            if !previous.contains(&key) {
                log::warn!(
                    "nested Instructions in {}: {}",
                    root.display(),
                    diagnostic.message()
                );
            }
            current.insert(key);
        }
        if current.is_empty() {
            history.remove(session_id);
        } else {
            history.insert(session_id.clone(), current);
        }
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
                if paths.iter().any(|path| affects_instructions(path)) {
                    self.refresh_instructions();
                }
                if paths.iter().any(|path| affects(path, ".ash/agents")) {
                    self.refresh_agents();
                }
            }
        }
        self.queue_file_events(changed, HookEventScope::User);
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

fn affects_instructions(path: &Path) -> bool {
    affects(path, ".ash/instructions")
        || path == Path::new("AGENTS.md")
        || path == Path::new("ASH.md")
}

fn directory_contributions(
    snapshot: &ash_instructions::InstructionCatalogSnapshot,
    nested: &ash_instructions::NestedInstructions,
    paths: &[PathBuf],
    root: &Path,
) -> Vec<ash_core::HarnessInstruction> {
    let selected = paths.iter().map(|path| root.join(path)).collect::<Vec<_>>();
    let mut entries = catalog_instructions(
        ash_core::InstructionScope::Directory,
        snapshot,
        root,
        &root.join(".ash/instructions"),
        paths,
        &selected,
    );
    entries.extend(nested.entries().map(|(path, body)| {
        ash_core::HarnessInstruction::new(
            ash_core::InstructionScope::Directory,
            root.join(path).display().to_string(),
            root.display().to_string(),
            ash_core::InstructionActivation::Nested,
            body,
        )
    }));
    entries
}

fn matching_paths(root: &Path, read_paths: &[PathBuf]) -> Vec<PathBuf> {
    let Ok(root) = dunce::canonicalize(root) else {
        return Vec::new();
    };
    read_paths
        .iter()
        .filter_map(|path| {
            let selected = if path.is_absolute() {
                path.clone()
            } else {
                root.join(path)
            };
            if selected
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return None;
            }
            // Resolve the existing ancestor, including symlinks, before accepting a new file.
            let mut ancestor = selected.as_path();
            let mut suffix = Vec::new();
            while !ancestor.exists() {
                suffix.push(ancestor.file_name()?.to_owned());
                ancestor = ancestor.parent()?;
            }
            let mut canonical = dunce::canonicalize(ancestor).ok()?;
            for part in suffix.into_iter().rev() {
                canonical.push(part);
            }
            canonical.strip_prefix(&root).ok().map(Path::to_path_buf)
        })
        .collect()
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
