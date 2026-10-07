use crate::CodeSnapshot;
use crate::Error;
use crate::MAX_PACK_BYTES;
use crate::MAX_TEXT_BYTES;
use crate::OutgoingTask;
use crate::Result;
use crate::SnapshotInfo;
use crate::SourceTask;
use crate::Store;
use crate::TaskPackage;
use crate::TaskReadParams;
use crate::TaskReceipt;
use crate::TaskReport;
use crate::digest;
use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
use ash_config::ConfigStore;
use ash_core::CreateThreadRequest;
use ash_core::ThreadController;
use ash_git::GitClient;
use ash_git::GitExecutionLimits;
use ash_git::GitPackBase;
use ash_git::GitTreeId;
use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_profile_store::RemoteConnectionCatalog;
use ash_remote_profile_store::RemoteConnectionName;
use ash_remote_profile_store::RemoteConnectionProfileStore;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use protocol::AgentId;
use protocol::CommandId;
use protocol::ContentDigest;
use protocol::SessionExecutionTarget;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::ThreadItem;
use protocol::ThreadOrigin;
use protocol::UserInput;
use queue::QueueInput;
use queue::QueueStore;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Weak;
use std::time::Duration;
use worktree::ManagedDirOwner;
use worktree::ManagedDirProvisionRequest;
use worktree::ManagedDirSource;
use worktree::ManagedDirTarget;
use worktree::WorktreeManager;
use worktree::WorktreeSettings;

pub type PeerFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Host-owned, authenticated connection to an already configured SSH target. Implementations
/// must pair responses and close their transport on cancellation, including failed handshakes.
pub trait Peer: Send + Sync {
    fn snapshot_info<'a>(
        &'a self,
        target: &'a SshTarget,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, SnapshotInfo>;
    fn receive<'a>(
        &'a self,
        target: &'a SshTarget,
        package: &'a TaskPackage,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReceipt>;
    fn read<'a>(
        &'a self,
        target: &'a SshTarget,
        params: &'a TaskReadParams,
        cancellation: &'a CancellationToken,
    ) -> PeerFuture<'a, TaskReport>;
}

pub struct RuntimeServices {
    pub profile_root: PathBuf,
    pub directory: PathBuf,
    pub profile_id: ContentDigest,
    pub threads: Weak<ThreadController>,
    pub queue: Arc<QueueStore>,
    pub config: Arc<ConfigStore>,
    pub peer: Arc<dyn Peer>,
}

pub struct Runtime {
    services: RuntimeServices,
    store: Store,
    git: GitClient,
    worktrees: WorktreeManager,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SendTask {
    pub target: String,
    pub title: String,
    pub instructions: String,
    pub context: String,
    /// Reuse after an uncertain transport outcome; the saved package stays immutable.
    #[serde(default)]
    pub delivery_id: Option<ContentDigest>,
}

impl Runtime {
    pub fn open(database: &Path, services: RuntimeServices) -> Result<Self> {
        let settings = WorktreeSettings::from_desktop_config(
            &services.profile_root,
            &services
                .config
                .read_snapshot()
                .map_err(runtime)?
                .values
                .desktop,
        )
        .map_err(runtime)?;
        let git = GitClient::system().with_limits(
            GitExecutionLimits::new(
                Duration::from_secs(30),
                Duration::from_secs(90),
                MAX_PACK_BYTES,
            )
            .map_err(runtime)?,
        );
        Ok(Self {
            store: Store::open(database)?,
            services,
            git,
            worktrees: WorktreeManager::new(settings),
        })
    }

    fn threads(&self) -> Result<Arc<ThreadController>> {
        self.services
            .threads
            .upgrade()
            .ok_or_else(|| Error::Runtime("task Thread owner closed".into()))
    }

    pub fn targets(&self) -> Result<serde_json::Value> {
        let catalog = RemoteConnectionCatalog::from_profile_root(&self.services.profile_root);
        let profiles = RemoteConnectionProfileStore::from_profile_root(&self.services.profile_root);
        let entries = catalog.connections().map_err(runtime)?.into_iter().map(|entry| {
            let ready = profiles.connection(entry.target()).map_err(runtime)?.is_some();
            Ok(serde_json::json!({"name":entry.name().as_str(), "host":entry.target().host().as_str(),
                "root":entry.target().dir().as_str(), "configured":ready}))
        }).collect::<Result<Vec<_>>>()?;
        Ok(serde_json::json!({"targets":entries}))
    }

    pub async fn snapshot_info(&self) -> Result<SnapshotInfo> {
        let repo = self.repository(&self.services.directory).await?;
        Ok(SnapshotInfo {
            head: self
                .git
                .resolve_commit(&repo, "HEAD")
                .await
                .map_err(runtime)?,
        })
    }

    async fn repository(&self, directory: &Path) -> Result<ash_git::GitRepository> {
        let repo = self.git.open_repository(directory).await.map_err(runtime)?;
        let directory = ash_file_access::Dir::open_local(directory).map_err(runtime)?;
        // This contract transfers a whole repository tree. A narrower execution directory must
        // not silently send sibling projects or change its relative working directory remotely.
        if directory.canonical_path() != repo.worktree_root() {
            return Err(Error::Invalid(
                "task execution directory must be the Git repository root".into(),
            ));
        }
        Ok(repo)
    }

    /// Durable acceptance is returned only after the normal queue owns the task. Deterministic
    /// destination identities let an interrupted receive replay all steps without another Turn.
    pub async fn receive(&self, package: &TaskPackage) -> Result<TaskReceipt> {
        package.validate()?;
        if let Some(receipt) = self.store.receipt(&package.delivery_id)? {
            self.store.reserve_incoming(package)?;
            return Ok(receipt);
        }
        let config = self.services.config.read_snapshot().map_err(runtime)?;
        if !features::Feature::Queue.enabled(&config.values.features) {
            return Err(Error::Invalid(
                "destination queue feature is disabled".into(),
            ));
        }
        let pack = STANDARD
            .decode(&package.code.pack)
            .map_err(|_| Error::Invalid("task pack must use valid base64".into()))?;
        if pack.len() > MAX_PACK_BYTES || digest(&pack) != package.code.pack_digest {
            return Err(Error::Invalid(
                "task pack size or digest does not match".into(),
            ));
        }
        let repo = self.repository(&self.services.directory).await?;
        if let Some(base) = &package.code.prerequisite
            && !self
                .git
                .contains_commit(&repo, base)
                .await
                .map_err(runtime)?
        {
            return Err(Error::Invalid(
                "destination no longer has the negotiated Git prerequisite".into(),
            ));
        }
        self.store.reserve_incoming(package)?;
        self.git
            .import_task_pack(
                &repo,
                &package.code.head,
                &GitTreeId::new(package.code.tree.clone()).map_err(runtime)?,
                pack,
            )
            .await
            .map_err(runtime)?;
        let identity = format!("task-{}", package.delivery_id.as_str());
        let thread_id = ThreadId::new(identity.clone()).map_err(runtime)?;
        let session_id = SessionId::new(identity.clone()).map_err(runtime)?;
        let source = ash_file_access::Dir::open_local(&self.services.directory).map_err(runtime)?;
        let binding = self
            .worktrees
            .provision(&ManagedDirProvisionRequest {
                source: ManagedDirSource::ImmutableTree {
                    source_directory: self.services.directory.clone(),
                    tree_id: package.code.tree.clone(),
                    repository_trees: BTreeMap::new(),
                },
                target: ManagedDirTarget::Detached {
                    object_id: package.code.head.clone(),
                },
                repository_targets: BTreeMap::new(),
                source_dir_id: source.id().as_str().into(),
                owner: ManagedDirOwner::Thread {
                    thread_id: identity.clone(),
                },
            })
            .await
            .map_err(runtime)?;
        // Queue directory identity uses the filesystem's canonical representation. A binding's
        // empty relative path can leave a trailing separator, which would prevent queue delivery.
        let directory = std::fs::canonicalize(binding.dir())
            .map_err(runtime)?
            .into_os_string()
            .into_string()
            .map_err(|_| Error::Invalid("task directory must be UTF-8".into()))?;
        self.threads()?
            .create_thread(CreateThreadRequest {
                agent_id: AgentId::new(format!("agent-{identity}")).map_err(runtime)?,
                origin: ThreadOrigin::Root,
                agent: None,
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                title: package.title.clone(),
                execution_target: Some(SessionExecutionTarget::Local {
                    root: directory.clone().into(),
                }),
            })
            .map_err(runtime)?;
        let origin = serde_json::to_string(&package.source)?;
        let command_id = CommandId::new(identity).map_err(runtime)?;
        // A retry must keep the receiver's original policy choice even if its config changed.
        let existing = self.services.queue.get(&command_id).map_err(runtime)?;
        self.services
            .queue
            .enqueue(&QueueInput {
                command_id,
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                directory: directory.clone(),
                input: vec![
                    UserInput::Context {
                        name: "task-delivery-source".into(),
                        content: format!(
                            "{origin}\nGit HEAD: {}\nDisk tree: {}\n\n{}",
                            package.code.head, package.code.tree, package.context
                        ),
                    },
                    UserInput::Text {
                        text: package.instructions.clone(),
                    },
                ],
                mode: Default::default(),
                model: None,
                reasoning_effort: None,
                tool_mode: existing
                    .as_ref()
                    .map(|message| message.request.tool_mode)
                    .unwrap_or(config.values.tool_mode),
                approval_mode: protocol::ApprovalMode::Auto,
                steer_turn: None,
            })
            .map_err(runtime)?;
        let receipt = TaskReceipt {
            delivery_id: package.delivery_id.clone(),
            source: package.source.clone(),
            session_id,
            thread_id,
            directory,
            head: package.code.head.clone(),
            tree: package.code.tree.clone(),
        };
        self.store.accept(&receipt)?;
        Ok(receipt)
    }

    pub fn read(&self, params: &TaskReadParams) -> Result<TaskReport> {
        let receipt = self
            .store
            .receipt(&params.delivery_id)?
            .ok_or(Error::NotFound)?;
        let command =
            CommandId::new(format!("task-{}", params.delivery_id.as_str())).map_err(runtime)?;
        let message = self
            .services
            .queue
            .get(&command)
            .map_err(runtime)?
            .ok_or(Error::NotFound)?;
        let thread = self
            .threads()?
            .read_thread(&receipt.thread_id)
            .map_err(runtime)?;
        let turn = thread.turns.last();
        let text = thread.items.iter().rev().find_map(|item| match item {
            ThreadItem::AgentMessage { text, turn_id, .. }
                if turn.is_some_and(|turn| &turn.turn_id == turn_id) =>
            {
                Some(text.clone())
            }
            _ => None,
        });
        let truncated = text.as_ref().is_some_and(|s| s.len() > MAX_TEXT_BYTES);
        let text = text.map(|mut s| {
            if truncated {
                let mut end = MAX_TEXT_BYTES;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
            }
            s
        });
        Ok(TaskReport {
            receipt,
            queue_status: message.status,
            turn_id: turn.map(|turn| turn.turn_id.clone()),
            turn_status: turn.map(|t| t.status),
            turn_error: turn.and_then(|turn| turn.failure.clone()),
            message: text,
            message_truncated: truncated,
            error: message.error,
        })
    }

    pub async fn send(
        &self,
        owner: &ThreadId,
        operation: &str,
        directory: &Path,
        request: &SendTask,
        cancellation: &CancellationToken,
    ) -> Result<TaskReceipt> {
        let id = request.delivery_id.clone().unwrap_or_else(|| {
            digest(format!("{}\n{}\n{operation}", self.services.profile_id, owner).as_bytes())
        });
        let mut canonical = request.clone();
        canonical.delivery_id = None;
        let canonical = serde_json::to_string(&canonical)?;
        let outgoing = match self.store.outgoing(owner, &id) {
            Ok(saved) => {
                if saved.request != canonical {
                    return Err(Error::Conflict);
                }
                saved
            }
            Err(Error::NotFound) if request.delivery_id.is_none() => {
                if request.title.trim().is_empty()
                    || request.title.len() > 256
                    || request.instructions.trim().is_empty()
                    || request.instructions.len() > MAX_TEXT_BYTES
                    || request.context.len() > MAX_TEXT_BYTES
                {
                    return Err(Error::Invalid(
                        "task title, instructions or context are invalid".into(),
                    ));
                }
                let task = async {
                    let name = RemoteConnectionName::parse(&request.target).map_err(runtime)?;
                    let target =
                        RemoteConnectionCatalog::from_profile_root(&self.services.profile_root)
                            .connection(&name)
                            .map_err(runtime)?
                            .ok_or(Error::NotFound)?;
                    let info = self
                        .services
                        .peer
                        .snapshot_info(target.target(), cancellation)
                        .await?;
                    let repo = self.repository(directory).await?;
                    let tree = self
                        .git
                        .capture_worktree_tree(&repo)
                        .await
                        .map_err(runtime)?;
                    let head = self
                        .git
                        .resolve_commit(&repo, "HEAD")
                        .await
                        .map_err(runtime)?;
                    let prerequisite = self
                        .git
                        .contains_commit(&repo, &info.head)
                        .await
                        .map_err(runtime)?
                        .then_some(info.head);
                    let base = prerequisite
                        .as_deref()
                        .map(GitPackBase::ExistingCommit)
                        .unwrap_or(GitPackBase::Complete);
                    let pack = self
                        .git
                        .export_task_pack(&repo, &head, &tree, base)
                        .await
                        .map_err(runtime)?;
                    let thread = self.threads()?.read_thread(owner).map_err(runtime)?;
                    Ok::<_, Error>(OutgoingTask {
                        host: target.target().host().as_str().into(),
                        root: target.target().dir().as_str().into(),
                        request: canonical,
                        package: TaskPackage {
                            delivery_id: id.clone(),
                            source: SourceTask {
                                profile_id: self.services.profile_id.clone(),
                                session_id: thread.session_id,
                                thread_id: owner.clone(),
                            },
                            title: request.title.clone(),
                            instructions: request.instructions.clone(),
                            context: request.context.clone(),
                            code: CodeSnapshot {
                                head,
                                tree: tree.as_str().into(),
                                prerequisite,
                                pack_digest: digest(&pack),
                                pack: STANDARD.encode(pack),
                            },
                        },
                    })
                }
                .with_cancellation(cancellation.clone())
                .await
                .map_err(runtime)??;
                cancellation.check().map_err(runtime)?;
                self.store.save_outgoing(&task)?
            }
            Err(error) => return Err(error),
        };
        let target = target(&outgoing)?;
        self.services
            .peer
            .receive(&target, &outgoing.package, cancellation)
            .await
            .map_err(|error| Error::Runtime(format!("delivery_id={id}; {error}")))
    }

    pub async fn read_outgoing(
        &self,
        owner: &ThreadId,
        id: &ContentDigest,
        cancellation: &CancellationToken,
    ) -> Result<TaskReport> {
        let target = self.store.outgoing_target(owner, id)?;
        self.services
            .peer
            .read(
                &target,
                &TaskReadParams {
                    delivery_id: id.clone(),
                },
                cancellation,
            )
            .await
    }
    pub fn outgoing_links(&self, owner: &ThreadId) -> Result<serde_json::Value> {
        self.store.outgoing_links(owner)
    }
}
fn target(task: &OutgoingTask) -> Result<SshTarget> {
    Ok(SshTarget::new(
        SshHost::parse(&task.host).map_err(runtime)?,
        RemoteDirPath::parse(&task.root).map_err(runtime)?,
    ))
}
fn runtime(error: impl std::fmt::Display) -> Error {
    Error::Runtime(error.to_string())
}
