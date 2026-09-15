use std::io;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;

use ash_app_server_daemon::ManagedConnection;
use ash_app_server_protocol::WebLaunchOptions;
use ash_app_server_protocol::WebListenInfo;
use ash_app_server_protocol::WebSessionInfo;
use ash_app_server_transport::BrowserOptions;
use ash_app_server_transport::start_browser_listener;

use crate::AppServer;

/// Runs a listener inside the shared process for the lifetime of its authenticated launch lease.
pub(super) fn serve(
    server: Arc<AppServer>,
    connection: ManagedConnection,
    options: WebLaunchOptions,
) -> io::Result<()> {
    let workspace_root = connection.options.dir_root().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Web launch requires a workspace",
        )
    })?;
    let workspace_root = dunce::canonicalize(workspace_root)?
        .to_string_lossy()
        .into_owned();
    let workspace_id = server
        .browser_workspace_id(std::path::Path::new(&workspace_root))
        .map_err(io::Error::other)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let listener = start_browser_listener(
            BrowserOptions {
                port: options.port,
                assets: options.assets,
                origin: options.origin,
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
        listener.shutdown().await
    })
}
