//! Preinstalled Git extension. Repository policy is independent of the editor implementation.
mod api;
mod blame;
mod changes;
mod commands;
mod history;
mod interaction;
pub use interaction::run_helper;
mod model;
mod scm;

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
use model::RepositoryDescriptor;
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
        let broker = interaction::Broker::start(Arc::downgrade(&runtime))
            .map_err(|_| invalid("Git interaction broker could not start"))?;
        *runtime
            .api
            .interaction
            .lock()
            .map_err(|_| invalid("Git broker failed"))? = Some(broker.connection.clone());
        *runtime
            .broker
            .lock()
            .map_err(|_| invalid("Git broker failed"))? = Some(broker);
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
                    .collect(),
            )
        };
        self.publication.enqueue(revision, snapshots)
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
            configuration.boolean("ignoreMissingGitWarning", false),
            configuration.boolean("ignoreLegacyWarning", false),
            configuration.boolean("ignoreWindowsGit27Warning", false)
        ]);
        {
            let state = self.lock();
            if state.installation_signature.as_ref() == Some(&signature) {
                return Ok(state.installation_available);
            }
        }
        let version = self
            .api
            .request("version", json!({}), configuration, token)?;
        let installation = &version["installation"];
        let available = installation["kind"] == "available";
        if !available && !configuration.boolean("ignoreMissingGitWarning", false) {
            self.api.warning("git.missingInstallation", &[], token)?;
        }
        if available {
            let display = installation["version"].as_str().unwrap_or_default();
            if installation["major"]
                .as_u64()
                .is_some_and(|major| major < 2)
                && !configuration.boolean("ignoreLegacyWarning", false)
            {
                self.api
                    .warning("git.legacyInstallation", &[display], token)?;
            }
            if version["windows"] == true
                && installation["major"] == 2
                && matches!(installation["minor"].as_u64(), Some(25 | 26))
                && !configuration.boolean("ignoreWindowsGit27Warning", false)
            {
                self.api
                    .warning("git.windowsInstallation", &[display], token)?;
            }
        }
        let mut state = self.lock();
        state.installation_signature = Some(signature);
        state.installation_available = available;
        Ok(available)
    }

    fn refresh(&self, token: Option<&CancellationToken>) -> Result<(), ExtensionError> {
        let _gate = self
            .discovery
            .lock()
            .map_err(|_| invalid("Git discovery failed"))?;
        let after = self.lock().sequence;
        let facts = match token {
            Some(token) => self
                .api
                .client
                .backend_state("git.repository", after, token)?,
            None => self.api.background.backend_state("git.repository", after)?,
        };
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
        let folders: Vec<Value> = decode(facts["folders"].clone())?;
        let mut discovery = Vec::new();
        let editor_resources = self
            .api
            .editor(json!({"method":"openEditorResources"}), token)?
            .as_array()
            .cloned()
            .unwrap_or_default();
        for folder in &folders {
            let uri = folder["uri"]
                .as_str()
                .ok_or_else(|| invalid("Invalid workspace folder URI"))?;
            let config = self.api.configuration(Some(uri.to_owned()), token)?;
            let mode = config.value("autoRepositoryDetection");
            let depth = if mode == &json!(false) || mode == "openEditors" {
                0
            } else {
                config.value("repositoryScanMaxDepth").as_i64().unwrap_or(1)
            };
            let mut manual = config.strings("scanRepositories");
            if mode == "openEditors" || mode == &json!(true) {
                if let Ok(root) = url::Url::parse(uri) {
                    for editor in &editor_resources {
                        if let Some(editor) = editor
                            .as_str()
                            .and_then(|value| url::Url::parse(value).ok())
                            .filter(|editor| {
                                editor.scheme() == root.scheme()
                                    && editor.host_str() == root.host_str()
                                    && editor.path().starts_with(&format!(
                                        "{}/",
                                        root.path().trim_end_matches('/')
                                    ))
                            })
                        {
                            if let Some((parent, _)) = editor.path()
                                [root.path().trim_end_matches('/').len() + 1..]
                                .rsplit_once('/')
                            {
                                manual.push(parent.to_owned());
                            }
                        }
                    }
                }
            }
            discovery.push(json!({"dirId":folder["id"],"maxDepth":depth,"ignoredFolders":config.strings("repositoryScanIgnoredFolders"),"scanRepositories":manual,"detectSubmodules":config.boolean("detectSubmodules",true),"submoduleLimit":config.number("detectSubmodulesLimit",10),"detectWorktrees":config.boolean("detectWorktrees",false),"worktreeLimit":config.number("detectWorktreesLimit",50)}));
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
        let descriptors = if let Some(cached) = cached {
            cached
        } else {
            let result = self.api.request(
                "repositories",
                json!({"folders":discovery}),
                &configuration,
                token,
            )?;
            let descriptors: Vec<RepositoryDescriptor> = decode(result["repositories"].clone())?;
            let mut state = self.lock();
            state.discovery_signature = Some(signature);
            state.discovery_result = descriptors.clone();
            descriptors
        };
        let mut repositories = Vec::new();
        for descriptor in descriptors {
            let folder = folders
                .iter()
                .find(|folder| descriptor.dir_id.as_deref() == folder["id"].as_str())
                .or_else(|| (folders.len() == 1).then(|| &folders[0]))
                .ok_or_else(|| invalid("Git workspace folder was retired"))?;
            let root_uri = file_uri(folder["uri"].as_str().unwrap_or_default(), &descriptor.path)?;
            let config = self.api.configuration(Some(root_uri.clone()), token)?;
            if config.strings("ignoredRepositories").iter().any(|path| {
                path.trim_end_matches('/') == root_uri.trim_end_matches('/')
                    || url::Url::parse(&root_uri).ok().is_some_and(|uri| {
                        uri.path().trim_end_matches('/') == path.trim_end_matches('/')
                    })
            }) {
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
                    draft: String::new(),
                    input_revision: 0,
                    operation: None,
                    error: String::new(),
                    commit_editor_head: None,
                    blame: None,
                    retired_streams: Default::default(),
                    pending_paths: None,
                });
            let config_changed = repository.configuration.0 != config.0;
            repository.descriptor = descriptor;
            repository.root_uri = root_uri;
            repository.configuration = config;
            let changed = config_changed
                || repository.status.is_none()
                || facts["reset"] == true
                || facts["events"].as_array().is_some_and(|events| {
                    events.iter().any(|event| {
                        event["method"] == "git/statusChanged"
                            && event["params"]["status"]["repositoryId"] == repository.descriptor.id
                    })
                });
            if changed
                && (!repository.is_busy() || repository.status.is_none())
                && (repository.configuration.boolean("autorefresh", true)
                    || config_changed
                    || repository.status.is_none())
            {
                repository.status = Some(self.api.status(&repository, token)?);
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
                    )
                })
                .collect();
            // Preserve drafts and busy flags written while discovery was awaiting the backend.
            for mut repository in repositories {
                if let Some(current) = state.repositories.get(&repository.descriptor.id) {
                    repository.draft = current.draft.clone();
                    repository.input_revision = current.input_revision;
                    repository.operation = current.operation;
                    repository.error = current.error.clone();
                    repository.commit_editor_head = current.commit_editor_head.clone();
                    repository.blame = current.blame.clone();
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
                            std::thread::sleep(Duration::from_millis(500));
                            if !runtime.stopped.load(Ordering::Acquire) {
                                let _ = runtime.refresh(None);
                                let _ = runtime.update_blame();
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
            .configuration(Some(repository.root_uri.clone()), Some(token))?;
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
            "refresh" => {
                self.accept_status(self.api.status(&repository, Some(token))?);
                self.publish()?;
                Ok(Value::Null)
            }
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
                if kind == "openFile" {
                    let path = path.ok_or_else(|| invalid("Missing Git file path"))?;
                    return self.api.editor(json!({"method":"open","input":{"resource":file_uri(&repository.root_uri,path)?},"options":{"pinned":false}}),Some(token));
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
                } else {
                    "git.sync"
                },
                &[json!(repository.descriptor.id)],
                token,
            ),
            "history" => self.history(&repository, &payload, token),
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
    repository.status = Some(status);
    repository.pending_paths = None;
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
