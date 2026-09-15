use std::env;
use std::io::BufReader;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppServer;
use crate::LocalAppServerOptions;
use crate::LocalProductServicesConfig;
use crate::open_local_app_server;
use ash_app_server_protocol::AppServerListenInfo;
use ash_app_server_transport::CapabilityTokenSha256;
use ash_app_server_transport::parse_loopback_websocket_bind;
use ash_app_server_transport::start_websocket_acceptor;
use ash_install_context::discovered_product_services_path;

const DIR_GRANT_SOURCE: &str = "ASH_DIR_GRANT_SOURCE";

/// Starts the App Server using explicit process arguments and environment configuration.
pub fn run(arguments: impl IntoIterator<Item = String>) -> Result<(), String> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    if arguments.as_slice() == [ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT] {
        return crate::managed::run(
            ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
        );
    }
    if arguments.as_slice() == ["--version"] {
        println!(
            "{}",
            serde_json::to_string(&build_info::BuildInfo::current())
                .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    let (command, product_services) = parse_arguments(&arguments)?;
    let options = StartupOptions::from_environment(
        product_services.or_else(discovered_product_services_path),
    )?;
    match command {
        Command::Stdio => {
            let server = Arc::new(open_server(&options)?);
            let _queue = server.start_queue()?;
            server.serve_stdio().map_err(|error| error.to_string())
        }
        Command::WebSocket(websocket) => serve_websocket(open_server(&options)?, websocket),
    }
}

fn parse_arguments(arguments: &[String]) -> Result<(Command, Option<PathBuf>), String> {
    let (command, remaining) = match arguments {
        [listen, address, remaining @ ..] if listen == "--listen" && address == "stdio://" => {
            (Command::Stdio, remaining)
        }
        [listen, address, remaining @ ..]
            if listen == "--listen" && address.starts_with("ws://") =>
        {
            let bind_address = parse_loopback_websocket_bind(address)
                .map_err(|error| format!("invalid App Server WebSocket listener: {error}"))?;
            let (websocket, remaining) = parse_websocket_options(bind_address, remaining)?;
            (Command::WebSocket(websocket), remaining)
        }
        _ => return Err(usage().into()),
    };
    let product_services = match remaining {
        [] => None,
        [product, path] if product == "--product-services" => Some(PathBuf::from(path)),
        _ => return Err(usage().into()),
    };
    Ok((command, product_services))
}

fn usage() -> &'static str {
    "usage: ash-app-server (--listen stdio:// | --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 HEX --emit-listen-info stdout-json) [--product-services PATH]"
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Command {
    Stdio,
    WebSocket(WebSocketOptions),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WebSocketOptions {
    bind_address: SocketAddr,
    token_sha256: CapabilityTokenSha256,
}

fn parse_websocket_options<'a>(
    bind_address: SocketAddr,
    arguments: &'a [String],
) -> Result<(WebSocketOptions, &'a [String]), String> {
    let [
        auth_flag,
        auth,
        token_flag,
        token,
        emit_flag,
        emit,
        remaining @ ..,
    ] = arguments
    else {
        return Err(usage().into());
    };
    if auth_flag != "--ws-auth"
        || auth != "capability-token"
        || token_flag != "--ws-token-sha256"
        || emit_flag != "--emit-listen-info"
        || emit != "stdout-json"
    {
        return Err(usage().into());
    }
    let token_sha256 = CapabilityTokenSha256::from_hex(token)
        .map_err(|error| format!("invalid App Server WebSocket authentication: {error}"))?;
    Ok((
        WebSocketOptions {
            bind_address,
            token_sha256,
        },
        remaining,
    ))
}

fn serve_websocket(server: AppServer, options: WebSocketOptions) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let server = Arc::new(server);
        let _queue = server.start_queue()?;
        let connection_server = Arc::clone(&server);
        let listener = start_websocket_acceptor(
            options.bind_address,
            options.token_sha256,
            move |reader, writer| {
                if let Err(error) =
                    connection_server.serve_product_host_jsonl(BufReader::new(reader), writer)
                    && !is_peer_disconnect(&error)
                {
                    eprintln!("App Server WebSocket connection failed: {error}");
                }
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        let listen_info = AppServerListenInfo::loopback_websocket(listener.address())
            .map_err(|error| error.to_string())?;
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &listen_info).map_err(|error| error.to_string())?;
        stdout.write_all(b"\n").map_err(|error| error.to_string())?;
        stdout.flush().map_err(|error| error.to_string())?;
        listener
            .run_until(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
            .map_err(|error| error.to_string())
    })
}

fn is_peer_disconnect(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct StartupOptions {
    profile_root: PathBuf,
    dir_root: Option<PathBuf>,
    dir_grant_source: GrantSource,
    product_services: Option<PathBuf>,
}

impl StartupOptions {
    pub(super) fn new(
        profile_root: impl Into<PathBuf>,
        dir_root: Option<PathBuf>,
        dir_grant_source: GrantSource,
        product_services: Option<PathBuf>,
    ) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root,
            dir_grant_source,
            product_services,
        }
    }

    fn from_environment(product_services: Option<PathBuf>) -> Result<Self, String> {
        let dir_grant_source = match env::var(DIR_GRANT_SOURCE).as_deref() {
            Ok("userConfig") => GrantSource::UserConfig,
            Ok("hostConfiguration") | Err(env::VarError::NotPresent) => {
                GrantSource::HostConfiguration
            }
            Ok(_) | Err(env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "{DIR_GRANT_SOURCE} must be userConfig or hostConfiguration"
                ));
            }
        };
        Ok(Self::new(
            ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
            env::var_os("ASH_WORKSPACE_ROOT").map(PathBuf::from),
            dir_grant_source,
            product_services,
        ))
    }

    pub(super) fn profile_root(&self) -> &Path {
        &self.profile_root
    }

    pub(super) fn dir_root(&self) -> Option<&Path> {
        self.dir_root.as_deref()
    }

    pub(super) fn dir_grant_source(&self) -> GrantSource {
        self.dir_grant_source
    }

    pub(super) fn product_services(&self) -> Option<&Path> {
        self.product_services.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GrantSource {
    HostConfiguration,
    UserConfig,
}

pub(super) fn open_server(host: &StartupOptions) -> Result<AppServer, String> {
    let mut options = LocalAppServerOptions::new(host.profile_root())
        .with_pty_helper(env::current_exe().map_err(|error| error.to_string())?);
    if let Some(dir_root) = host.dir_root() {
        options = match host.dir_grant_source() {
            GrantSource::UserConfig => options.with_user_config_dir_root(dir_root),
            GrantSource::HostConfiguration => options.with_dir_root(dir_root),
        };
    }
    if let Some(path) = host.product_services() {
        options = options.with_product_services(
            LocalProductServicesConfig::load(path, host.profile_root())
                .map_err(|error| error.to_string())?,
        );
    }
    if let Some(path) = env::var_os("ASH_EXEC_ENVIRONMENTS") {
        options = options.with_execution_environments(
            crate::execution_environments::load_environments(Path::new(&path))?,
        );
    }
    open_local_app_server(options).map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;
