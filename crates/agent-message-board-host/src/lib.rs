//! Connects board storage, tools, and notifications to the Thread and Turn owners.

use agent_message_board::BoardInput;
use agent_message_board::BoardTurnHost;
use agent_message_board::Error;
use agent_message_board::MessageBoardHost;
use agent_message_board::RemoteBoardLocation;
use agent_message_board::Result;
use agent_message_board::Scope;
use agent_message_board::Store;
use agent_message_board_client::RemoteMessageBoard;
use ash_config::MessageBoardCleanupConfig;
use ash_config::MessageBoardConfig;
use ash_core::ThreadController;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_http_client::HttpClient;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use cleanup::RemoteCleanup;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

mod cleanup;

/// Shares the local board store across App Servers in one profile runtime.
pub struct MessageBoardStorage {
    database_path: Option<PathBuf>,
    local: Mutex<Option<Arc<Store>>>,
    cleanup: Arc<RemoteCleanup>,
}

impl MessageBoardStorage {
    /// Uses in-memory local storage for ephemeral runtimes that have no database path.
    pub fn new(database_path: Option<PathBuf>) -> Self {
        Self {
            database_path,
            local: Mutex::default(),
            cleanup: Arc::default(),
        }
    }

    /// Opens the backend selected by the profile configuration.
    pub fn open(
        &self,
        config: &MessageBoardConfig,
        http: &Arc<dyn HttpClient>,
    ) -> Result<MessageBoard> {
        let store = self.store()?;
        let backend = match config {
            MessageBoardConfig::Local => Backend::Local,
            MessageBoardConfig::Remote {
                endpoint,
                credential_env,
            } => {
                let location = RemoteBoardLocation {
                    endpoint: endpoint.clone(),
                    credential_env: credential_env.clone(),
                };
                let tracked_store = store.clone();
                let tracked_location = location.clone();
                let client =
                    cleanup::connect(&location, http)?.with_registration_guard(move |session| {
                        tracked_store.remember_remote(session, &tracked_location)
                    });
                Backend::Remote {
                    client: Arc::new(client),
                    location,
                }
            }
        };
        self.cleanup.resume(&store, http);
        Ok(MessageBoard {
            backend,
            store,
            cleanup: self.cleanup.clone(),
            http: http.clone(),
        })
    }

    fn store(&self) -> Result<Arc<Store>> {
        let mut local = self.local.lock().map_err(runtime_error)?;
        if let Some(store) = local.as_ref() {
            return Ok(store.clone());
        }
        let store = Arc::new(match &self.database_path {
            Some(path) => Store::open(path)?,
            None => Store::in_memory()?,
        });
        *local = Some(store.clone());
        Ok(store)
    }
}

/// One App Server's board binding, shared by its tools and Session cleanup.
pub struct MessageBoard {
    backend: Backend,
    store: Arc<Store>,
    cleanup: Arc<RemoteCleanup>,
    http: Arc<dyn HttpClient>,
}

enum Backend {
    Local,
    Remote {
        client: Arc<RemoteMessageBoard>,
        location: RemoteBoardLocation,
    },
}

impl MessageBoard {
    /// Queues former board locations only for Sessions absent from the durable Session catalog.
    pub fn recover_deleted_sessions(
        &self,
        recovery: &[MessageBoardCleanupConfig],
        threads: &ThreadController,
    ) {
        if recovery.is_empty() {
            return;
        }
        for entry in recovery {
            let location = RemoteBoardLocation {
                endpoint: entry.endpoint.clone(),
                credential_env: entry.credential_env.clone(),
            };
            for session in &entry.deleted_sessions {
                match threads.read_session_catalog(session) {
                    Ok(None) => {
                        if let Err(error) = self.store.recover_remote_deletion(session, &location) {
                            log::warn!(
                                "Could not queue board cleanup for Session {session}: {error}"
                            );
                        }
                    }
                    Ok(Some(_)) => {
                        log::warn!(
                            "Skipped board cleanup for Session {session} because it still exists"
                        );
                    }
                    Err(error) => {
                        log::warn!("Could not verify deletion of Session {session}: {error}");
                    }
                }
            }
        }
        self.cleanup.resume(&self.store, &self.http);
    }

    /// Registers tools, unread context, and remote notifications as one capability.
    pub fn install(
        &self,
        registry: &mut ExtensionRegistryBuilder,
        threads: &Arc<ThreadController>,
    ) {
        let host = Arc::new(ThreadHost {
            threads: Arc::downgrade(threads),
        });
        let input = match &self.backend {
            Backend::Local => BoardInput::Local(self.store.clone()),
            Backend::Remote { client, .. } => {
                agent_message_board_client::install_notifications(
                    registry,
                    host.clone(),
                    client.clone(),
                );
                BoardInput::Remote(client.clone())
            }
        };
        agent_message_board::install(registry, host, input);
    }

    /// Closes local storage and schedules remote cleanup independently of the selected backend.
    pub fn delete_session(&self, session: &SessionId) -> Result<()> {
        let fallback = match &self.backend {
            Backend::Local => None,
            Backend::Remote { location, .. } => Some(location),
        };
        let pending = self.store.close_session(session, fallback)?;
        if let Backend::Remote { client, .. } = &self.backend {
            client.forget_session(session);
        }
        if pending {
            self.cleanup.wake(&self.store, &self.http);
        }
        Ok(())
    }
}

struct ThreadHost {
    threads: Weak<ThreadController>,
}

impl ThreadHost {
    fn controller(&self) -> Result<Arc<ThreadController>> {
        self.threads
            .upgrade()
            .ok_or_else(|| Error::Runtime("Thread owner is closed".into()))
    }
}

impl MessageBoardHost for ThreadHost {
    fn require_running_turn(
        &self,
        caller: &ThreadId,
        session: &SessionId,
        turn: &TurnId,
    ) -> Result<()> {
        let snapshot = self
            .controller()?
            .read_thread(caller)
            .map_err(runtime_error)?;
        if &snapshot.session_id != session
            || !snapshot
                .turns
                .iter()
                .any(|current| &current.turn_id == turn && current.status == TurnStatus::Running)
        {
            return Err(Error::Input(
                "board access requires the caller's current running Turn".into(),
            ));
        }
        Ok(())
    }

    fn scope(&self, caller: &ThreadId) -> Result<Scope> {
        let threads = self.controller()?;
        board_scope(&threads, caller)
    }

    fn current_time(&self) -> Result<i64> {
        match self
            .controller()?
            .sample_time_context()
            .map_err(runtime_error)?
        {
            Some(context) => i64::try_from(context.sampled_at_unix_ms.get())
                .map_err(|_| Error::Input("configured time is out of range".into())),
            None => Ok(chrono::Utc::now().timestamp_millis()),
        }
    }
}

impl BoardTurnHost for ThreadHost {
    fn tree_members(&self, caller: &ThreadId) -> Result<(Scope, Vec<ThreadId>)> {
        let threads = self.controller()?;
        let scope = board_scope(&threads, caller)?;
        let mut members = Vec::new();
        for thread in threads
            .list_session_threads(&scope.session)
            .map_err(runtime_error)?
        {
            if board_scope(&threads, &thread.thread_id)? == scope {
                members.push(thread.thread_id);
            }
        }
        Ok((scope, members))
    }

    fn with_active_turn(
        &self,
        caller: &ThreadId,
        session: &SessionId,
        turn: &TurnId,
        update: &mut dyn FnMut(),
    ) -> Result<()> {
        self.controller()?
            .with_running_turn(caller, |current_session, current_turn| {
                if current_session == session && current_turn == turn {
                    update();
                }
                Ok(())
            })
            .map_err(runtime_error)?;
        Ok(())
    }
}

// Only delegated agents inherit their parent's board. Other branches may share the
// same Session without being in the same agent tree.
fn board_scope(threads: &ThreadController, caller: &ThreadId) -> Result<Scope> {
    let mut thread = threads.read_thread(caller).map_err(runtime_error)?;
    let session = thread.session_id.clone();
    while let Some(seed) = &thread.agent_context_seed {
        thread = threads
            .read_thread(&seed.parent_thread_id)
            .map_err(runtime_error)?;
        if thread.session_id != session {
            return Err(Error::Input(
                "agent ancestry crosses Session boundaries".into(),
            ));
        }
    }
    Ok(Scope {
        session,
        root: thread.thread_id,
    })
}

fn runtime_error(error: impl std::fmt::Display) -> Error {
    Error::Runtime(error.to_string())
}

#[cfg(test)]
#[path = "board_tests.rs"]
mod board_tests;
#[cfg(test)]
#[path = "notification_tests.rs"]
mod notification_tests;
