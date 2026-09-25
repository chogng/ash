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

struct WebWorkspaces {
    registry: Arc<ProfileAppServerRegistry>,
    connection: ConnectionOptions,
    launch: WebLaunchOptions,
    listeners: Mutex<Vec<BrowserListener>>,
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
            let grant_root = root.clone();
            let open = Arc::new(move |body: String| {
                let weak = weak.clone();
                let grant_root = grant_root.clone();
                Box::pin(async move {
                    let workspaces = weak
                        .upgrade()
                        .ok_or_else(|| io::Error::other("Web listener stopped"))?;
                    workspaces.open(&grant_root, &body).await
                }) as ash_app_server_transport::BrowserWorkspaceFuture
            });
            start_browser_listener(
                BrowserOptions {
                    port,
                    assets: self.launch.assets.clone(),
                    origin: self.launch.origin.clone(),
                    session_directory: Some(session_directory),
                    workspace: Some(BrowserWorkspaceOperations { list, open }),
                },
                move |reader, writer| {
                    if let Err(error) = server.serve_jsonl(BufReader::new(reader), writer)
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
                    })
                    .expect("browser metadata contains only strings")
                },
            )
            .await
        })
    }

    async fn open(self: Arc<Self>, current_root: &Path, body: &str) -> io::Result<String> {
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
        let current_root = current_root.to_path_buf();
        let root =
            tokio::task::spawn_blocking(move || canonical_directory(Path::new(&request.path)))
                .await
                .map_err(io::Error::other)??;
        let approval_root = root.clone();
        tokio::task::spawn_blocking(move || {
            authorize_workspace_root(&current_root, &approval_root, show_workspace_approval)
        })
        .await
        .map_err(io::Error::other)??;
        let selected = ConnectionOptions::new(
            connection.profile_root(),
            Some(root.clone()),
            GrantSource::UserConfig,
            connection.product_services().map(Path::to_path_buf),
        );
        let server = tokio::task::spawn_blocking(move || registry.server_for(selected))
            .await
            .map_err(io::Error::other)?
            .map_err(io::Error::other)?;
        let listener = self.listen(server, root, 0).await?;
        let info = WebListenInfo {
            endpoint: listener.endpoint(),
            ticket: listener.ticket().to_owned(),
            pid: std::process::id(),
        };
        self.listeners
            .lock()
            .map_err(|_| io::Error::other("Web listener lock poisoned"))?
            .push(listener);
        serde_json::to_string(&info).map_err(io::Error::other)
    }
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

fn authorize_workspace_root(
    current: &Path,
    selected: &Path,
    prompt: impl FnOnce(&Path) -> bool,
) -> io::Result<()> {
    if selected.starts_with(current) {
        return Ok(());
    }
    if prompt(selected) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Directory authorization declined",
        ))
    }
}

fn show_workspace_approval(selected: &Path) -> bool {
    rfd::MessageDialog::new()
        .set_title("Ash: Authorize Server Folder")
        .set_description(format!(
            "Allow this Ash Web session to read and change files in {}?",
            selected.display()
        ))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
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
    server: Arc<AppServer>,
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
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let workspaces = Arc::new(WebWorkspaces {
            registry,
            connection: connection.options.clone(),
            launch: options.clone(),
            listeners: Mutex::new(Vec::new()),
        });
        let listener = workspaces
            .listen(server, workspace_root, options.port)
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
        let children = std::mem::take(
            &mut *workspaces
                .listeners
                .lock()
                .map_err(|_| io::Error::other("Web listener lock poisoned"))?,
        );
        for child in children {
            child.shutdown().await?;
        }
        listener.shutdown().await
    })
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
