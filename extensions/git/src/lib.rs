//! Preinstalled Git extension. Repository policy is independent of the editor implementation.
mod api;
mod blame;
mod changes;
mod commands;
mod history;
mod interaction;
pub use interaction::run_helper;
mod model;
mod paths;
mod scm;
mod timeline;

use api::Api;
use api::decode;
use api::file_uri;
use api::invalid;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::Command;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::BackgroundClient;
use model::Repository;
use model::State;
use model::Status;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

const SCM_ID: &str = "ash.scm";
#[derive(Default)]
pub struct GitExtension {
    runtime: Option<Arc<GitRuntime>>,
}
impl Extension for GitExtension {
    fn id(&self) -> &str {
        "ash.git"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let output = context.window.create_output_channel("git", "Git")?;
        let api = Api::new(
            context.client.clone(),
            BackgroundClient::new(context.services.clone()),
            context.services.clone(),
            context
                .initialization()
                .and_then(|facts| facts.language.as_deref()),
            output,
        );
        let publication = scm::Publisher::start(api.background.clone())?;
        let runtime = Arc::new(GitRuntime {
            api,
            state: Mutex::new(State::default()),
            publication,
            discovery: Mutex::new(()),
            migration: Mutex::new(false),
            operations: Mutex::new(BTreeMap::new()),
            monitor: Mutex::new(None),
            broker: Mutex::new(None),
            terminal_edits: Mutex::new(BTreeMap::new()),
            stopped: AtomicBool::new(false),
        });
        runtime
            .api
            .interaction
            .set(Arc::downgrade(&runtime))
            .map_err(|_| invalid("Git interaction owner already exists"))?;
        let terminal = Arc::clone(&runtime);
        context
            .terminal
            .register_environment("git.environment", move |token| {
                terminal.terminal_environment(&token)
            })?;
        let provider = Arc::clone(&runtime);
        context
            .scm
            .register(SCM_ID, Vec::new(), move |payload, token| {
                provider.scm(payload, &token)
            })?;
        let manifest: Value = serde_json::from_str(include_str!("../package.json"))
            .map_err(|_| invalid("Invalid product manifest"))?;
        for declaration in manifest["contributes"]["commands"]
            .as_array()
            .ok_or_else(|| invalid("Missing product commands"))?
        {
            let id = declaration["command"]
                .as_str()
                .ok_or_else(|| invalid("Invalid product command"))?
                .to_owned();
            let title_key = declaration["title"]
                .as_str()
                .unwrap_or(&id)
                .trim_matches('%');
            let title = runtime.api.text(title_key, &[]);
            let owner = Arc::clone(&runtime);
            let command = id.clone();
            let mut contribution = Command::new(id.clone(), title);
            contribution.category = declaration["category"].as_str().map(str::to_owned);
            contribution.enablement = declaration["enablement"].as_str().map(str::to_owned);
            contribution.icon = declaration["icon"].as_str().map(|icon| {
                icon.strip_prefix("$(")
                    .and_then(|icon| icon.strip_suffix(')'))
                    .unwrap_or(icon)
                    .to_owned()
            });
            if let Some(menus) = manifest["contributes"]["menus"].as_object() {
                for (menu, entries) in menus {
                    for entry in entries
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|entry| entry["command"] == id)
                    {
                        contribution.menus.push(external_ext_sdk::CommandMenu {
                            menu: menu.clone(),
                            when: entry["when"].as_str().map(str::to_owned),
                            group: entry["group"].as_str().map(str::to_owned),
                            alt: entry["alt"].as_str().map(str::to_owned),
                        });
                    }
                }
            }
            context
                .commands
                .register_command(contribution, move |invocation, token| {
                    owner.command(&command, &invocation.arguments, &token)
                })?;
        }
        // The client binding is established by activation, but subscriptions start only after
        // the initial SCM registration is acknowledged by the window's initialize callback.
        self.runtime = Some(runtime);
        Ok(())
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        if let Some(runtime) = self.runtime.take() {
            runtime.stopped.store(true, Ordering::Release);
            runtime.api.background.close();
            runtime.publication.stop();
            runtime
                .terminal_edits
                .lock()
                .map_err(|_| invalid("Git message editor failed"))?
                .clear();
            if let Some(mut broker) = runtime
                .broker
                .lock()
                .map_err(|_| invalid("Git broker failed"))?
                .take()
            {
                broker.stop();
            }

            if let Some(monitor) = runtime
                .monitor
                .lock()
                .map_err(|_| invalid("Git monitor failed"))?
                .take()
            {
                let _ = monitor.join();
            }
        }
        Ok(())
    }
}

fn editor_resources_need_discovery(state: &State, resources: &[Value]) -> bool {
    resources
        .iter()
        .filter_map(|resource| {
            resource
                .as_str()
                .and_then(|resource| paths::ResourceUri::parse(resource).ok())
        })
        .any(|resource| {
            state
                .folders
                .iter()
                .any(|folder| paths::RepoPath::from_resource(&folder.uri, &resource).is_some())
                && !state.repositories.values().any(|repository| {
                    paths::RepoPath::from_resource(&repository.root_uri, &resource).is_some()
                })
        })
}

pub(crate) struct GitRuntime {
    api: Api,
    state: Mutex<State>,
    publication: scm::Publisher,
    discovery: Mutex<()>,
    migration: Mutex<bool>,
    operations: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    monitor: Mutex<Option<JoinHandle<()>>>,
    broker: Mutex<Option<interaction::Broker>>,
    terminal_edits: Mutex<BTreeMap<String, std::sync::mpsc::SyncSender<Option<String>>>>,
    stopped: AtomicBool,
}
impl GitRuntime {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("Git view state is not poisoned")
    }
    fn publish(&self) -> Result<(), ExtensionError> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        self.refresh_incoming_changes();
        let (revision, snapshots) = {
            let mut state = self.lock();
            state.revision += 1;
            (
                state.revision + 1,
                state
                    .repositories
                    .values()
                    .filter(|repository| {
                        repository.configuration.boolean("enabled", true)
                            && !(repository.descriptor.parent_path.is_some()
                                && repository
                                    .configuration
                                    .text("openRepositoryInParentFolders", "prompt")
                                    == "never")
                    })
                    .map(|repository| {
                        scm::snapshot(
                            &self.api,
                            repository,
                            state.active.as_deref() == Some(&repository.descriptor.id),
                            state.selection_revision,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        };
        self.publication.enqueue(revision, snapshots)
    }

    fn refresh_incoming_changes(&self) {
        let repositories: Vec<_> = self.lock().repositories.values().cloned().collect();
        for repository in repositories {
            if !repository.configuration.boolean("enabled", true)
                || !repository
                    .configuration
                    .boolean("decorations.enabled", true)
            {
                continue;
            }
            let Some(status) = &repository.status else {
                continue;
            };
            if repository
                .incoming_changes
                .as_ref()
                .is_some_and(|incoming| incoming.matches(status))
            {
                continue;
            }
            let Some(local) = status.head.object_id() else {
                continue;
            };
            let Some(upstream) = status
                .head
                .upstream()
                .filter(|upstream| upstream.behind > 0)
            else {
                continue;
            };
            let remote = match &upstream.object_id {
                Some(remote) => remote.clone(),
                None => {
                    let Ok(refs) = self.api.history_refs(&repository, None) else {
                        continue;
                    };
                    if refs.status.head != status.head
                        || refs.status.history_revision != status.history_revision
                        || refs.status.stream_instance_id != status.stream_instance_id
                    {
                        continue;
                    }
                    let Some(reference) = refs.references.into_iter().find(|reference| {
                        matches!(reference.kind, model::ReferenceKind::RemoteBranch)
                            && reference.name == upstream.name
                    }) else {
                        continue;
                    };
                    reference.object_id
                }
            };
            // Query outside the state lock. Missing history must not prevent local
            // changes from publishing; a later publication can retry the comparison.
            let Ok(comparison) = self.api.compare_changes(
                &repository,
                &remote,
                local,
                model::CompareMode::MergeBase,
                None,
            ) else {
                continue;
            };
            let incoming = model::IncomingChanges {
                head: status.head.clone(),
                stream_instance_id: status.stream_instance_id.clone(),
                history_revision: status.history_revision,
                changes: comparison
                    .changes
                    .into_iter()
                    .map(|change| {
                        // A remote rename affects the old path in the local checkout.
                        let path = if change.status == "renamed" {
                            change.original_path.unwrap_or(change.path)
                        } else {
                            change.path
                        };
                        (path, change.status)
                    })
                    .collect(),
            };
            if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id)
                && current
                    .status
                    .as_ref()
                    .is_some_and(|status| incoming.matches(status))
            {
                current.incoming_changes = Some(Arc::new(incoming));
            }
        }
    }
    fn repository(&self, id: Option<&str>) -> Result<Repository, ExtensionError> {
        let state = self.lock();
        let id = id
            .or(state.active.as_deref())
            .ok_or_else(|| invalid("No active Git repository"))?;
        state
            .repositories
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("Git repository is no longer available"))
    }
    fn accept_status(&self, status: Status) {
        let mut state = self.lock();
        if let Some(repository) = state.repositories.get_mut(&status.repository_id) {
            accept_repository_status(repository, status);
        }
    }
    fn check_installation(
        &self,
        configuration: &model::Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<bool, ExtensionError> {
        let signature = json!([
            configuration.value("path"),
            configuration.boolean("ignoreMissingGitWarning", false)
        ]);
        {
            let state = self.lock();
            if state.installation_signature.as_ref() == Some(&signature) {
                return Ok(state.installation_available);
            }
        }
        let available = match self.api.installation(configuration, token)? {
            model::Installation::Available { version } => !version.is_empty(),
            model::Installation::Missing => {
                if !configuration.boolean("ignoreMissingGitWarning", false) {
                    self.api.warning("git.missingInstallation", &[], token)?;
                }
                false
            }
            model::Installation::Unsupported {
                version,
                minimum_version,
            } => {
                self.api.warning(
                    "git.unsupportedInstallation",
                    &[&minimum_version, &version],
                    token,
                )?;
                false
            }
        };
        let mut state = self.lock();
        state.installation_signature = Some(signature);
        state.installation_available = available;
        Ok(available)
    }

    fn refresh(&self, token: Option<&CancellationToken>) -> Result<(), ExtensionError> {
        let after = self.lock().sequence;
        let facts = match token {
            Some(token) => self
                .api
                .client
                .backend_state("git.repository", after, token)?,
            None => self.api.background.backend_state("git.repository", after)?,
        };
        if token.is_some() {
            let state = self.lock();
            // A command has already crossed the client's configuration/workspace cursor.
            // When that cursor is current, avoid waiting behind the idle editor/discovery
            // scan and rereading the same configuration through several IPC round trips.
            // The background monitor still polls editor-owned discovery and blame facts.
            if facts["reset"] != true
                && matches!(facts["connection"].as_str(), Some("ready" | "connected"))
                && facts["sequence"].as_u64() == Some(state.sequence)
                && state.discovery_signature.as_ref().is_some_and(|signature| {
                    signature[0] == facts["generation"] && signature[1] == facts["folders"]
                })
            {
                return Ok(());
            }
        }
        self.refresh_with_state(facts, token)
    }

    fn refresh_with_state(
        &self,
        facts: Value,
        token: Option<&CancellationToken>,
    ) -> Result<(), ExtensionError> {
        let _gate = self
            .discovery
            .lock()
            .map_err(|_| invalid("Git discovery failed"))?;
        let after = self.lock().sequence;
        if facts["sequence"]
            .as_u64()
            .is_some_and(|sequence| sequence < after)
        {
            return Ok(());
        }
        // Folder changes are only discovery inputs. Like visible editors in VS Code,
        // files within a known repository need no scan, status or catalog refresh.
        let discover_editors = if facts["editorFoldersChanged"] == true
            && facts["reset"] != true
            && matches!(facts["connection"].as_str(), Some("ready" | "connected"))
        {
            let resources = self
                .api
                .editor(json!({"method":"openEditorResources"}), token)?;
            editor_resources_need_discovery(
                &self.lock(),
                resources.as_array().map(Vec::as_slice).unwrap_or_default(),
            )
        } else {
            false
        };
        // Editor-only changes and long-poll renewals do not invalidate discovery or settings.
        // The monitor still updates blame after this returns, using lightweight editor metadata.
        {
            let mut state = self.lock();
            if !discover_editors
                && facts["reset"] != true
                && matches!(facts["connection"].as_str(), Some("ready" | "connected"))
                && facts["events"].as_array().is_some_and(Vec::is_empty)
                && state.discovery_signature.as_ref().is_some_and(|signature| {
                    signature[0] == facts["generation"] && signature[1] == facts["folders"]
                })
            {
                state.sequence = facts["sequence"].as_u64().unwrap_or(after);
                return Ok(());
            }
        }
        // A status notification already contains the backend owner's complete snapshot.
        // Keep configuration/discovery changes on the full path; ordinary file changes
        // can update the existing repository without another scan or Git subprocess.
        let updates = {
            let state = self.lock();
            let same_workspace = (facts["connection"] == "ready"
                || facts["connection"] == "connected")
                && state.discovery_signature.as_ref().is_some_and(|signature| {
                    signature[0] == facts["generation"] && signature[1] == facts["folders"]
                });
            facts["events"]
                .as_array()
                .filter(|events| {
                    same_workspace
                        && !discover_editors
                        && facts["reset"] != true
                        && !events.is_empty()
                        && events
                            .iter()
                            .all(|event| event["method"] == "git/statusChanged")
                })
                .and_then(|events| {
                    events
                        .iter()
                        .map(|event| {
                            let status: Status = decode(event["params"]["status"].clone()).ok()?;
                            let repository = state.repositories.get(&status.repository_id)?;
                            // Notifications use the shared client's defaults. A package selecting a
                            // custom executable or rename threshold must still request its own view.
                            (repository.status.is_some()
                                && !repository.is_busy()
                                && repository.configuration.boolean("autorefresh", true)
                                && repository.configuration.value("path").is_null()
                                && repository.configuration.number("similarityThreshold", 50) == 50)
                                .then_some(status)
                        })
                        .collect::<Option<Vec<_>>>()
                })
        };
        if let Some(updates) = updates {
            let mut state = self.lock();
            let mut changed = false;
            for status in updates {
                let Some(repository) = state.repositories.get_mut(&status.repository_id) else {
                    continue;
                };
                let previous = repository
                    .status
                    .as_ref()
                    .map(|status| (status.stream_instance_id.clone(), status.revision));
                accept_repository_status(repository, status);
                changed |= previous
                    != repository
                        .status
                        .as_ref()
                        .map(|status| (status.stream_instance_id.clone(), status.revision));
            }
            state.sequence = facts["sequence"].as_u64().unwrap_or(after);
            drop(state);
            if changed {
                self.publish()?;
            }
            return Ok(());
        }
        if facts["connection"] != "ready" && facts["connection"] != "connected" {
            let changed = {
                let mut state = self.lock();
                let changed = !state.repositories.is_empty();
                state.repositories.clear();
                state.discovery_signature = None;
                state.discovery_result.clear();
                state.active = None;
                changed
            };
            if changed {
                self.publish()?;
            }
            return Ok(());
        }
        let configuration = self.api.configuration(None, token)?;
        self.migrate_shared_settings(&configuration, token)?;
        if !self.check_installation(&configuration, token)? {
            let changed = {
                let mut state = self.lock();
                let changed = !state.repositories.is_empty();
                state.repositories.clear();
                state.active = None;
                changed
            };
            if changed {
                self.publish()?;
            }
            return Ok(());
        }
        let folders: Vec<model::WorkspaceFolder> = decode(facts["folders"].clone())?;
        let mut discovery = Vec::new();
        let editor_resources = self
            .api
            .editor(json!({"method":"openEditorResources"}), token)?
            .as_array()
            .cloned()
            .unwrap_or_default();
        for folder in &folders {
            let config = self
                .api
                .configuration(Some(folder.uri.to_string()), token)?;
            let mode = config.value("autoRepositoryDetection");
            let depth = if mode == &json!(false) || mode == "openEditors" {
                0
            } else {
                config.value("repositoryScanMaxDepth").as_i64().unwrap_or(1)
            };
            let mut manual = config.strings("scanRepositories");
            if mode == "openEditors" || mode == &json!(true) {
                for editor in &editor_resources {
                    let Some(path) = editor
                        .as_str()
                        .and_then(|value| crate::paths::ResourceUri::parse(value).ok())
                        .and_then(|uri| paths::RepoPath::from_resource(&folder.uri, &uri))
                    else {
                        continue;
                    };
                    if let Some((parent, _)) = path.rsplit_once('/') {
                        manual.push(parent.to_owned());
                    }
                }
            }
            discovery.push(model::DiscoveryFolder {
                dir_id: folder.id.clone(),
                max_depth: depth,
                ignored_folders: config.strings("repositoryScanIgnoredFolders"),
                scan_repositories: manual,
                detect_submodules: config.boolean("detectSubmodules", true),
                submodule_limit: config.number("detectSubmodulesLimit", 10),
                detect_worktrees: config.boolean("detectWorktrees", false),
                worktree_limit: config.number("detectWorktreesLimit", 50),
            });
        }
        let signature = json!([facts["generation"], folders, discovery, configuration.0]);
        let reset = facts["reset"] == true
            || facts["events"].as_array().is_some_and(|events| {
                events
                    .iter()
                    .any(|event| event["method"] == "git/repositoriesChanged")
            });
        let cached = {
            let state = self.lock();
            (!reset && state.discovery_signature.as_ref() == Some(&signature))
                .then(|| state.discovery_result.clone())
        };
        let mut published_statuses = std::collections::HashMap::<String, Status>::new();
        let descriptors = if let Some(cached) = cached {
            cached
        } else {
            let result = self.api.discover(&discovery, &configuration, token)?;
            let descriptors = result.repositories;
            for status in result.statuses.into_iter().flatten() {
                published_statuses.insert(status.repository_id.clone(), status);
            }
            let mut state = self.lock();
            state.discovery_signature = Some(signature);
            state.discovery_result = descriptors.clone();
            descriptors
        };
        let mut repositories = Vec::new();
        for descriptor in descriptors {
            let folder = folders
                .iter()
                .find(|folder| descriptor.dir_id.as_deref() == Some(folder.id.as_str()))
                .or_else(|| (folders.len() == 1).then(|| &folders[0]))
                .ok_or_else(|| invalid("Git workspace folder was retired"))?;
            let root_uri = paths::repository_root(&folder.uri, &descriptor.path)?;
            let config = self.api.configuration(Some(root_uri.to_string()), token)?;
            if config
                .strings("ignoredRepositories")
                .iter()
                .any(|path| paths::matches_configured_root(&root_uri, path))
            {
                continue;
            }
            let mut repository = self
                .lock()
                .repositories
                .get(&descriptor.id)
                .cloned()
                .unwrap_or(Repository {
                    descriptor: descriptor.clone(),
                    root_uri: root_uri.clone(),
                    configuration: config.clone(),
                    status: None,
                    incoming_changes: None,
                    catalog: None,
                    draft: String::new(),
                    input_revision: 0,
                    operation: None,
                    history_operation_revision: 0,
                    error: String::new(),
                    notice: String::new(),
                    commit_editor_head: None,
                    blame: None,
                    retired_streams: Default::default(),
                    pending_paths: None,
                });
            let config_changed = repository.configuration.0 != config.0;
            repository.descriptor = descriptor;
            repository.root_uri = root_uri;
            repository.configuration = config;
            // Discovery may carry the backend's already-published, watched state.
            // It is used only for a new view under the canonical client policy;
            // explicit refresh and configuration changes keep their full queries.
            let published = published_statuses.remove(&repository.descriptor.id);
            let initial_snapshot = accept_initial_repository_status(&mut repository, published);
            let changed = config_changed
                || !initial_snapshot
                    && (repository.status.is_none()
                        || facts["reset"] == true
                        || facts["events"].as_array().is_some_and(|events| {
                            events.iter().any(|event| {
                                event["method"] == "git/statusChanged"
                                    && event["params"]["status"]["repositoryId"]
                                        == repository.descriptor.id
                            })
                        }));
            if changed
                && (!repository.is_busy() || repository.status.is_none())
                && (repository.configuration.boolean("autorefresh", true)
                    || config_changed
                    || repository.status.is_none())
            {
                repository.status = Some(self.api.status(&repository, token)?);
                repository.catalog = Some(self.api.catalog(&repository, token)?);
            }
            if repository.catalog.is_none() {
                repository.catalog = Some(self.api.catalog(&repository, token)?);
            }
            if let Some(parent) = repository.descriptor.parent_path.as_deref() {
                let policy = repository
                    .configuration
                    .text("openRepositoryInParentFolders", "prompt");
                if policy != "never"
                    && repository.configuration.boolean("enabled", true)
                    && self
                        .lock()
                        .parent_prompts
                        .insert(format!("{}:{policy}", repository.descriptor.id))
                {
                    let open=policy=="always" || self.api.editor(json!({"method":"confirm","message":self.api.text("git.parentRepositoryPrompt",&[parent]),"primaryButton":self.api.text("git.openParentRepository",&[])}),token)?["confirmed"]==true;
                    if open {
                        self.api
                            .editor(json!({"method":"openWorkspace","path":parent}), token)?;
                    }
                }
            }
            repositories.push(repository);
        }
        let changed = {
            let mut state = self.lock();
            let previous: Vec<_> = state
                .repositories
                .values()
                .map(|repository| {
                    (
                        repository.descriptor.id.clone(),
                        repository
                            .status
                            .as_ref()
                            .map(|status| (status.stream_instance_id.clone(), status.revision)),
                        repository.configuration.0.clone(),
                        repository.catalog.clone(),
                    )
                })
                .collect();
            let next: Vec<_> = repositories
                .iter()
                .map(|repository| {
                    (
                        repository.descriptor.id.clone(),
                        repository
                            .status
                            .as_ref()
                            .map(|status| (status.stream_instance_id.clone(), status.revision)),
                        repository.configuration.0.clone(),
                        repository.catalog.clone(),
                    )
                })
                .collect();
            // Preserve drafts and busy flags written while discovery was awaiting the backend.
            for mut repository in repositories {
                if let Some(current) = state.repositories.get(&repository.descriptor.id) {
                    repository.draft = current.draft.clone();
                    repository.input_revision = current.input_revision;
                    repository.operation = current.operation;
                    repository.history_operation_revision = current.history_operation_revision;
                    repository.error = current.error.clone();
                    repository.notice = current.notice.clone();
                    repository.commit_editor_head = current.commit_editor_head.clone();
                    repository.blame = current.blame.clone();
                    repository.incoming_changes = current.incoming_changes.clone();
                    repository.retired_streams = current.retired_streams.clone();
                    repository.pending_paths = current.pending_paths.clone();
                    if let Some(status) = repository.status.take() {
                        repository.status = current.status.clone();
                        accept_repository_status(&mut repository, status);
                    }
                }
                state
                    .repositories
                    .insert(repository.descriptor.id.clone(), repository);
            }
            let current: std::collections::BTreeSet<_> =
                next.iter().map(|value| value.0.as_str()).collect();
            state
                .repositories
                .retain(|id, _| current.contains(id.as_str()));
            if state
                .active
                .as_ref()
                .is_none_or(|id| !state.repositories.contains_key(id))
            {
                state.active = state.repositories.keys().next().cloned();
                state.selection_revision += 1;
            }
            state.folders = folders;
            state.sequence = facts["sequence"].as_u64().unwrap_or(after);
            state.configuration = configuration;
            previous != next
        };
        if changed {
            self.publish()?;
        }
        Ok(())
    }
    fn scm(
        self: &Arc<Self>,
        payload: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let method = payload["method"]
            .as_str()
            .ok_or_else(|| invalid("Missing SCM method"))?;
        if method == "initialize" {
            self.refresh(Some(token))?;
            self.publish()?;
            let runtime = Arc::clone(self);
            // One poller per activation; initialize may be replayed after a client reconnect.
            let start = {
                let mut operations = self
                    .operations
                    .lock()
                    .map_err(|_| invalid("Git operation state failed"))?;
                operations
                    .insert("$monitor".into(), Arc::new(Mutex::new(())))
                    .is_none()
            };
            if start {
                let monitor = std::thread::Builder::new()
                    .name("git-client-subscriptions".into())
                    .spawn(move || {
                        while !runtime.stopped.load(Ordering::Acquire) {
                            let after = runtime.lock().sequence;
                            let facts = runtime
                                .api
                                .background
                                .wait_for_backend_state("git.repository", after);
                            if runtime.stopped.load(Ordering::Acquire) {
                                break;
                            }
                            match facts {
                                Ok(facts) => {
                                    let _ = runtime.refresh_with_state(facts, None);
                                    let _ = runtime.update_blame();
                                }
                                // Transport failures still back off; normal updates are
                                // driven by the window's admitted notification stream.
                                Err(_) => std::thread::sleep(Duration::from_millis(500)),
                            }
                        }
                    })
                    .map_err(|_| invalid("Git subscriptions could not start"))?;
                *self
                    .monitor
                    .lock()
                    .map_err(|_| invalid("Git monitor failed"))? = Some(monitor);
            }
            return Ok(Value::Null);
        }
        let id = payload["providerId"].as_str();
        if method == "setInput" || method == "acceptInput" {
            if let Some(value) = payload["value"].as_str() {
                if value.len() > 32768 {
                    return Err(invalid("Git commit message exceeds the input limit"));
                }
                let mut state = self.lock();
                let id = id
                    .or(state.active.as_deref())
                    .unwrap_or_default()
                    .to_owned();
                if let Some(repository) = state.repositories.get_mut(&id) {
                    let revision = payload["inputRevision"]
                        .as_u64()
                        .unwrap_or(repository.input_revision);
                    if revision >= repository.input_revision {
                        repository.draft = value.to_owned();
                        repository.input_revision = revision;
                    }
                }
            }
        }
        if method == "setInput" {
            self.publish()?;
            return Ok(Value::Null);
        }
        let mut repository = self.repository(id)?;
        repository.configuration = self
            .api
            .configuration(Some(repository.root_uri.to_string()), Some(token))?;
        match method {
            "activate" => {
                {
                    let mut state = self.lock();
                    state.active = Some(repository.descriptor.id.clone());
                    state.selection_revision += 1;
                }
                self.publish()?;
                Ok(Value::Null)
            }
            "refresh" => self.command("git.refresh", &[json!(repository.descriptor.id)], token),
            "acceptInput" => {
                let operation = scm::primary_action(&repository);
                self.command(
                    match operation {
                        "sync" => "git.sync",
                        "publish" => "git.publish",
                        _ => "git.commit",
                    },
                    &[json!(repository.descriptor.id)],
                    token,
                )?;
                Ok(
                    json!({"result":null,"value":self.repository(Some(&repository.descriptor.id))?.draft}),
                )
            }
            "action" => {
                let action = payload["actionId"].as_str().unwrap_or_default();
                let mut segments = action.splitn(3, ':');
                let kind = segments.next().unwrap_or_default();
                let _group = segments.next();
                let path = segments.next();
                let scope = match kind {
                    "viewStagedChanges" => Some("staged"),
                    "viewChanges" => Some("changes"),
                    "viewUntrackedChanges" => Some("untracked"),
                    _ => None,
                };
                if let Some(scope) = scope {
                    return self.show_multi_diff(&repository, scope, token);
                }
                if kind == "openFile" {
                    let path = path.ok_or_else(|| invalid("Missing Git file path"))?;
                    return self.api.editor(json!({"method":"open","input":{"resource":file_uri(&repository.root_uri,&paths::RepoPath::parse(path)?)?},"options":{"pinned":false}}),Some(token));
                }
                let command = match kind {
                    "stage" => "git.stageFile",
                    "unstage" => "git.unstageFile",
                    "discard" => "git.discardFile",
                    "delete" => "git.deleteFile",
                    "stageAll" => "git.stageAll",
                    "unstageAll" => "git.unstageAll",
                    "discardAll" => "git.cleanAll",
                    _ => return Err(invalid("Unknown Git action")),
                };
                let mut arguments = vec![json!(repository.descriptor.id)];
                if let Some(path) = path {
                    arguments.push(json!(path));
                }
                self.command(command, &arguments, token)
            }
            "statusBar" => self.command(
                if payload["commandId"] == "ash.status.git.branch" {
                    "git.switchBranch"
                } else if payload["commandId"] == "git.blame" {
                    "git.showBlame"
                } else if repository
                    .status
                    .as_ref()
                    .is_some_and(|status| status.head.upstream().is_none())
                {
                    "git.publish"
                } else {
                    "git.sync"
                },
                &[json!(repository.descriptor.id)],
                token,
            ),
            "history" => self.history(&repository, &payload, token),
            "timeline" => self.file_timeline(&repository, &payload, token),
            "merge" => self.merge(&repository, &payload, token),
            "open" => self.open_change(&repository, &payload, token),
            "quickDiff" => self.quick_diff(&repository, &payload, token),
            "decoration" => self.file_decoration(&repository, &payload, token),
            "multiDiff" => self.multi_diff(
                &repository,
                payload["resource"].as_str().unwrap_or_default(),
                token,
            ),
            _ => Err(invalid("Unsupported Git SCM operation")),
        }
    }
}

fn accept_initial_repository_status(repository: &mut Repository, status: Option<Status>) -> bool {
    let path = repository.configuration.value("path");
    if repository.status.is_some()
        || !(path.is_null() || path.as_array().is_some_and(Vec::is_empty))
        || repository.configuration.number("similarityThreshold", 50) != 50
    {
        return false;
    }
    let Some(status) = status.filter(|status| status.repository_id == repository.descriptor.id)
    else {
        return false;
    };
    accept_repository_status(repository, status);
    repository.status.is_some()
}

// A reconnected stream can replace a previous stream once. Delayed work from a retired
// stream must never replace the current snapshot, even when its revision is numerically larger.
fn accept_repository_status(repository: &mut Repository, status: Status) {
    if repository
        .retired_streams
        .contains(&status.stream_instance_id)
    {
        return;
    }
    if let Some(current) = &repository.status {
        if current.stream_instance_id == status.stream_instance_id {
            if current.revision > status.revision {
                return;
            }
        } else {
            repository
                .retired_streams
                .insert(current.stream_instance_id.clone());
        }
    }
    if repository
        .incoming_changes
        .as_ref()
        .is_some_and(|incoming| !incoming.matches(&status))
    {
        repository.incoming_changes = None;
    }
    repository.status = Some(status);
    repository.pending_paths = None;
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
