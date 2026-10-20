use ash_app_server_protocol::WebWorkspaceFolder;
use ash_app_server_protocol::WebWorkspaceState;
use ash_app_server_protocol::WebWorkspaceUpdateRequest;
use std::future::Future;
use std::io;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::ManagedConnection;
use ash_app_server_protocol::WebLaunchOptions;
use ash_app_server_protocol::WebListenInfo;
use ash_app_server_protocol::WebSessionInfo;
use ash_app_server_protocol::WebWorkspaceDirectory;
use ash_app_server_protocol::WebWorkspaceListRequest;
use ash_app_server_protocol::WebWorkspaceListResult;
use ash_app_server_protocol::WebWorkspaceOpenRequest;
use ash_app_server_transport::BrowserListener;
use ash_app_server_transport::BrowserOptions;
use ash_app_server_transport::BrowserWorkspaceOperations;
use ash_app_server_transport::start_browser_listener;

use super::registry::ProfileAppServerRegistry;
use crate::AppServer;

struct PendingWorkspace {
    transaction: String,
    next: WebWorkspaceState,
    rollback: crate::server::WebWorkspaceRollback,
}

struct WebWorkspaceSession {
    current: WebWorkspaceState,
    pending: Option<PendingWorkspace>,
    completed: Option<(String, bool)>,
}

struct WebWorkspaces {
    registry: Arc<ProfileAppServerRegistry>,
    connection: ConnectionOptions,
    launch: WebLaunchOptions,
    listeners: Mutex<Vec<(BrowserListener, Arc<AppServer>)>>,
    active: Arc<Mutex<bool>>,
}

impl WebWorkspaces {
    fn listen(
        self: &Arc<Self>,
        server: Arc<AppServer>,
        root: PathBuf,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<BrowserListener>> + Send + '_>> {
        Box::pin(async move {
            let workspace_root = root.to_string_lossy().into_owned();
            let identity_server = Arc::clone(&server);
            let identity_root = root.clone();
            let workspace_id = tokio::task::spawn_blocking(move || {
                identity_server.browser_workspace_id(&identity_root)
            })
            .await
            .map_err(io::Error::other)?
            .map_err(io::Error::other)?;
            let session_directory = ash_app_server_transport::browser_session_directory(
                self.connection.profile_root(),
                &root,
                self.launch.origin.as_deref(),
                &self.launch.lease_id,
            );
            let workspace = Arc::new(Mutex::new(WebWorkspaceSession {
                current: WebWorkspaceState {
                    id: workspace_id.clone(),
                    configuration: None,
                    folders: vec![WebWorkspaceFolder {
                        id: workspace_id.clone(),
                        path: workspace_root.clone(),
                        name: None,
                    }],
                },
                pending: None,
                completed: None,
            }));
            let active = Arc::clone(&self.active);
            let update_workspace = Arc::clone(&workspace);
            let update_server = Arc::clone(&server);
            // Serialize authorizations and replacements per listener. No cached Desktop runtime
            // is involved, and two requests cannot approve against an obsolete folder set.
            let update_gate = Arc::new(tokio::sync::Mutex::new(()));
            let update = Arc::new(move |body: String| {
                let workspace = Arc::clone(&update_workspace);
                let server = Arc::clone(&update_server);
                let gate = Arc::clone(&update_gate);
                let active = Arc::clone(&active);
                Box::pin(async move {
                    let _update = gate.lock().await;
                    tokio::task::spawn_blocking(move || {
                        update_workspace_state(
                            &server,
                            &workspace,
                            &active,
                            &body,
                            show_workspace_approval,
                        )
                    })
                    .await
                    .map_err(io::Error::other)?
                }) as ash_app_server_transport::BrowserWorkspaceFuture
            });
            let list_root = root.clone();
            let list = Arc::new(move |body: String| {
                let root = list_root.clone();
                Box::pin(async move {
                    tokio::task::spawn_blocking(move || list_directories(&root, &body))
                        .await
                        .map_err(io::Error::other)?
                }) as ash_app_server_transport::BrowserWorkspaceFuture
            });
            let weak = Arc::downgrade(self);
            let open_server = Arc::clone(&server);
            let open = Arc::new(move |body: String| {
                let weak = weak.clone();
                let server = Arc::clone(&open_server);
                Box::pin(async move {
                    let workspaces = weak
                        .upgrade()
                        .ok_or_else(|| io::Error::other("Web listener stopped"))?;
                    workspaces.open(server, &body).await
                }) as ash_app_server_transport::BrowserWorkspaceFuture
            });
            start_browser_listener(
                BrowserOptions {
                    port,
                    assets: self.launch.assets.clone(),
                    origin: self.launch.origin.clone(),
                    session_directory: Some(session_directory),
                    workspace: Some(BrowserWorkspaceOperations {
                        list,
                        open,
                        update: Some(update),
                    }),
                },
                move |reader, writer| {
                    if let Err(error) = server.serve_browser_jsonl(BufReader::new(reader), writer)
                        && !super::is_peer_disconnect(&error)
                    {
                        eprintln!("Browser App Server connection failed: {error}");
                    }
                },
                move |token| {
                    serde_json::to_string(&WebSessionInfo {
                        token,
                        workspace_id: workspace_id.clone(),
                        workspace_root: workspace_root.clone(),
                        workspace: workspace
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .current
                            .clone(),
                    })
                    .expect("browser metadata contains only strings")
                },
            )
            .await
        })
    }

    async fn open(
        self: Arc<Self>,
        current_server: Arc<AppServer>,
        body: &str,
    ) -> io::Result<String> {
        let request: WebWorkspaceOpenRequest = serde_json::from_str(body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        if !request.approved {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Directory authorization required",
            ));
        }
        let registry = Arc::clone(&self.registry);
        let connection = self.connection.clone();
        let root =
            tokio::task::spawn_blocking(move || canonical_directory(Path::new(&request.path)))
                .await
                .map_err(io::Error::other)??;
        let selected_directory =
            ash_file_access::Dir::open_local(&root).map_err(io::Error::other)?;
        let approved_directory = selected_directory.clone();
        let (approved_grant, authority_revision) = tokio::task::spawn_blocking(move || {
            if !current_server.web_workspace_authorizes_directory(&approved_directory)
                && !show_workspace_approval(approved_directory.canonical_path())
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Directory authorization declined",
                ));
            }
            approved_directory
                .directory()
                .ensure_current()
                .map_err(io::Error::other)?;
            let revision = current_server
                .config
                .as_ref()
                .ok_or_else(|| io::Error::other("Config authority unavailable"))?
                .read_snapshot()
                .map_err(io::Error::other)?
                .revision;
            let grant = current_server
                .approve_web_directory(approved_directory)
                .map_err(workspace_error)?;
            Ok((grant, revision))
        })
        .await
        .map_err(io::Error::other)??;
        let selected = ConnectionOptions::new(
            connection.profile_root(),
            Some(root.clone()),
            GrantSource::UserConfig,
            connection.product_services().map(Path::to_path_buf),
        );
        let active = Arc::clone(&self.active);
        let server = tokio::task::spawn_blocking(move || {
            let lease = active
                .lock()
                .map_err(|_| io::Error::other("Web lease lock poisoned"))?;
            if !*lease {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Web listener stopped",
                ));
            }
            registry
                .open_native_web_workspace(&selected, approved_grant, authority_revision)
                .map_err(io::Error::other)
        })
        .await
        .map_err(io::Error::other)??;
        if selected_directory.directory().ensure_current().is_err()
            || server
                .browser_workspace_id(&root)
                .map_err(io::Error::other)?
                != selected_directory.id().to_string()
        {
            server.close_web_workspace();
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Workspace directory changed during authorization",
            ));
        }
        let listener = self.listen(Arc::clone(&server), root, 0).await?;
        {
            let lease = self
                .active
                .lock()
                .map_err(|_| io::Error::other("Web lease lock poisoned"))?;
            if *lease {
                let info = WebListenInfo {
                    endpoint: listener.endpoint(),
                    ticket: listener.ticket().to_owned(),
                    pid: std::process::id(),
                };
                self.listeners
                    .lock()
                    .map_err(|_| io::Error::other("Web listener lock poisoned"))?
                    .push((listener, server));
                return serde_json::to_string(&info).map_err(io::Error::other);
            }
        }
        server.close_web_workspace();
        listener.shutdown().await?;
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Web listener stopped",
        ))
    }
}

fn update_workspace_state(
    server: &AppServer,
    workspace: &Mutex<WebWorkspaceSession>,
    active: &Mutex<bool>,
    body: &str,
    mut prompt: impl FnMut(&Path) -> bool,
) -> io::Result<String> {
    let request: WebWorkspaceUpdateRequest = serde_json::from_str(body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let (transaction, configuration, requested, approved) = match request {
        WebWorkspaceUpdateRequest::Finish {
            transaction,
            accepted,
        } => {
            let lease = active
                .lock()
                .map_err(|_| io::Error::other("Web lease lock poisoned"))?;
            if !*lease {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Web listener stopped",
                ));
            }
            let mut session = workspace
                .lock()
                .map_err(|_| io::Error::other("Workspace lock poisoned"))?;
            if let Some((completed, outcome)) = &session.completed {
                if completed == &transaction {
                    if *outcome != accepted {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "Workspace transaction already has a different outcome",
                        ));
                    }
                    return serde_json::to_string(&session.current).map_err(io::Error::other);
                }
            }
            let pending = session
                .pending
                .as_mut()
                .filter(|pending| pending.transaction == transaction)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "Unknown workspace transaction")
                })?;
            if !accepted {
                server
                    .restore_web_workspace(&mut pending.rollback)
                    .map_err(io::Error::other)?;
            }
            let pending = session.pending.take().expect("transaction was matched");
            if accepted {
                session.current = pending.next;
            }
            session.completed = Some((transaction, accepted));
            return serde_json::to_string(&session.current).map_err(io::Error::other);
        }
        WebWorkspaceUpdateRequest::Apply {
            transaction,
            configuration,
            folders,
            approved,
        } => (transaction, configuration, folders, approved),
    };
    if !approved {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Directory authorization required",
        ));
    }
    if transaction.len() != 36
        || !transaction
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || requested.len() > 256
        || configuration
            .as_ref()
            .is_some_and(|value| value.len() > 16_384)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid workspace update",
        ));
    }
    {
        let session = workspace
            .lock()
            .map_err(|_| io::Error::other("Workspace lock poisoned"))?;
        if let Some(pending) = &session.pending {
            if pending.transaction == transaction {
                return serde_json::to_string(&pending.next).map_err(io::Error::other);
            }
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Workspace update is awaiting completion",
            ));
        }
    }
    let mut folders = Vec::new();
    for folder in requested {
        if !*active
            .lock()
            .map_err(|_| io::Error::other("Web lease lock poisoned"))?
        {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Web listener stopped",
            ));
        }
        if folder.path.len() > 4096 || folder.name.len() > 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Workspace folder is too large",
            ));
        }
        let path = canonical_directory(Path::new(&folder.path))?;
        let directory = ash_file_access::Dir::open_local(&path).map_err(io::Error::other)?;
        if !server.web_workspace_authorizes_directory(&directory) && !prompt(&path) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Directory authorization declined",
            ));
        }
        directory
            .directory()
            .ensure_current()
            .map_err(io::Error::other)?;
        folders.push((directory, folder.name));
    }
    let lease = active
        .lock()
        .map_err(|_| io::Error::other("Web lease lock poisoned"))?;
    if !*lease {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Web listener stopped",
        ));
    }
    let rollback = server.snapshot_web_workspace().map_err(io::Error::other)?;
    let next = server
        .bind_web_workspace(configuration, folders)
        .map_err(workspace_error)?;
    let result = serde_json::to_string(&next).map_err(io::Error::other)?;
    workspace
        .lock()
        .map_err(|_| io::Error::other("Workspace lock poisoned"))?
        .pending = Some(PendingWorkspace {
        transaction,
        next,
        rollback,
    });
    Ok(result)
}

fn workspace_error(error: crate::server::EnvRuntimeError) -> io::Error {
    let kind = match &error {
        crate::server::EnvRuntimeError::PermissionRequired => io::ErrorKind::PermissionDenied,
        crate::server::EnvRuntimeError::Busy
        | crate::server::EnvRuntimeError::AccessRevisionConflict => io::ErrorKind::WouldBlock,
        crate::server::EnvRuntimeError::Unavailable | crate::server::EnvRuntimeError::Failed(_) => {
            io::ErrorKind::Other
        }
    };
    io::Error::new(kind, error)
}

fn canonical_directory(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workspace path must be absolute",
        ));
    }
    let root = dunce::canonicalize(path)?;
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workspace must be a directory",
        ));
    }
    Ok(root)
}

fn show_workspace_approval(selected: &Path) -> bool {
    // Managed servers have no AppKit event loop. RFD's synchronous dialog
    // requires its main thread on macOS; the async API uses a system alert
    // that can also be awaited by this authorization worker.
    pollster::block_on(
        rfd::AsyncMessageDialog::new()
            .set_title("Ash: Authorize Server Folder")
            .set_description(format!(
                "Allow this Ash Web session to read and change files in {}?",
                selected.display()
            ))
            .set_buttons(rfd::MessageButtons::YesNo)
            .show(),
    ) == rfd::MessageDialogResult::Yes
}

fn list_directories(initial: &Path, body: &str) -> io::Result<String> {
    let request: WebWorkspaceListRequest = serde_json::from_str(body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let path = canonical_directory(if request.path.is_empty() {
        initial
    } else {
        Path::new(&request.path)
    })?;
    let mut directories = Vec::new();
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        if entry.metadata().is_ok_and(|metadata| metadata.is_dir()) {
            directories.push(WebWorkspaceDirectory {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
            });
        }
        if directories.len() > 10_000 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Too many directories",
            ));
        }
    }
    #[cfg(windows)]
    if path.parent().is_none() {
        for drive in b'A'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", char::from(drive)));
            if root != path && root.is_dir() {
                directories.push(WebWorkspaceDirectory {
                    name: format!("{}:", char::from(drive)),
                    path: root.to_string_lossy().into_owned(),
                });
            }
        }
    }
    directories.sort_by(|left, right| left.name.cmp(&right.name));
    let parent = path
        .parent()
        .filter(|parent| parent != &path)
        .map(|parent| parent.to_string_lossy().into_owned());
    serde_json::to_string(&WebWorkspaceListResult {
        path: path.to_string_lossy().into_owned(),
        parent,
        directories,
    })
    .map_err(io::Error::other)
}

/// Runs a listener inside the shared process for the lifetime of its authenticated launch lease.
pub(super) fn serve(
    _server: Arc<AppServer>,
    registry: Arc<ProfileAppServerRegistry>,
    connection: ManagedConnection,
    options: WebLaunchOptions,
) -> io::Result<()> {
    let workspace_root = connection.options.dir_root().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Web launch requires a workspace",
        )
    })?;
    let workspace_root = canonical_directory(workspace_root)?;
    let server = registry
        .open_web_workspace(&connection.options)
        .map_err(io::Error::other)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    // AppServer owns domain runtimes. Keep this strong reference on the synchronous
    // stack, including listener setup errors, so its last drop cannot run inside Tokio.
    runtime.block_on(async {
        let workspaces = Arc::new(WebWorkspaces {
            registry,
            connection: connection.options.clone(),
            launch: options.clone(),
            listeners: Mutex::new(Vec::new()),
            active: Arc::new(Mutex::new(true)),
        });
        let listener = workspaces
            .listen(Arc::clone(&server), workspace_root, options.port)
            .await?;
        let mut writer = connection.writer;
        serde_json::to_writer(
            &mut writer,
            &WebListenInfo {
                endpoint: listener.endpoint(),
                ticket: listener.ticket().to_owned(),
                pid: std::process::id(),
            },
        )?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        // A launcher is a lease, never a carrier for browser business messages.
        let mut reader = connection.reader;
        tokio::task::spawn_blocking(move || reader.read(&mut [0_u8; 1]))
            .await
            .map_err(io::Error::other)??;
        *workspaces
            .active
            .lock()
            .map_err(|_| io::Error::other("Web lease lock poisoned"))? = false;
        server.close_web_workspace();
        let children = std::mem::take(
            &mut *workspaces
                .listeners
                .lock()
                .map_err(|_| io::Error::other("Web listener lock poisoned"))?,
        );
        for (child, server) in children {
            server.close_web_workspace();
            child.shutdown().await?;
        }
        listener.shutdown().await
    })
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
