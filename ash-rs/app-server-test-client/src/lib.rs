//! Standalone command-line probes for the Ash App Server wire protocol.

mod transport;

use std::io::Write;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use app_server_protocol::protocol::common::ClientCapabilities;
use app_server_protocol::protocol::common::ClientInfo;
use app_server_protocol::protocol::common::EmptyParams;
use app_server_protocol::protocol::common::SessionId;
use app_server_protocol::protocol::initialize::InitializeParams;
use app_server_protocol::protocol::initialize::InitializeResult;
use app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use app_server_protocol::protocol::model::ModelListParams;
use app_server_protocol::protocol::model::ModelListView;
use app_server_protocol::protocol::registry::ClientMethod;
use app_server_protocol::protocol::session::SessionSubscribeParams;
use app_server_protocol::rpc::JsonRpcError;
use app_server_protocol::rpc::JsonRpcFailure;
use app_server_protocol::rpc::JsonRpcId;
use app_server_protocol::rpc::JsonRpcNotification;
use app_server_protocol::rpc::JsonRpcRequest;
use app_server_protocol::rpc::JsonRpcResponse;
use clap::Parser;
use clap::Subcommand;
use clap::ValueEnum;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use transport::Connection;
use transport::Endpoint;

#[derive(Parser)]
#[command(version, about = "Inspect and exercise the Ash App Server protocol")]
struct Cli {
    /// App Server executable to launch over stdio; defaults to ash-app-server on PATH.
    #[arg(long, env = "ASH_APP_SERVER_BIN", conflicts_with = "url")]
    server_bin: Option<PathBuf>,
    /// Existing loopback WebSocket endpoint, for example ws://127.0.0.1:4222.
    #[arg(long, env = "ASH_APP_SERVER_URL")]
    url: Option<String>,
    /// WebSocket capability token. Prefer the environment variable to command history.
    #[arg(
        long,
        env = "ASH_APP_SERVER_TOKEN",
        hide_env_values = true,
        requires = "url"
    )]
    token: Option<String>,
    /// Isolated profile directory passed to the stdio child as ASH_HOME.
    #[arg(long, conflicts_with = "url")]
    home: Option<PathBuf>,
    /// Explicit directory grant passed to the stdio child as ASH_WORKSPACE_ROOT.
    #[arg(long, conflicts_with = "url")]
    workspace: Option<PathBuf>,
    /// Deadline for connection, initialization and each request, in seconds.
    #[arg(long, default_value = "30")]
    timeout: NonZeroU64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the initialization result, including protocol version and capabilities.
    Initialize,
    /// List the observed models or the fixed product catalog.
    ModelList {
        #[arg(long, value_enum, default_value_t = ModelListViewArg::Discovered)]
        view: ModelListViewArg,
    },
    /// List stored sessions.
    SessionList,
    /// Send any RPC method with inline JSON parameters or @path/to/params.json.
    Request {
        method: String,
        #[arg(default_value = "{}")]
        params: String,
        /// Keep printing notifications after the response until Ctrl+C.
        #[arg(long)]
        watch: bool,
    },
    /// Initialize and print notifications until Ctrl+C; optionally subscribe to a session.
    Watch {
        #[arg(long)]
        session_id: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum ModelListViewArg {
    BuiltIn,
    Discovered,
}

impl From<ModelListViewArg> for ModelListView {
    fn from(value: ModelListViewArg) -> Self {
        match value {
            ModelListViewArg::BuiltIn => Self::BuiltIn,
            ModelListViewArg::Discovered => Self::Discovered,
        }
    }
}

/// Runs the developer client using command-line arguments and JSON output on stdout.
pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    // Parse user input before spawning a process or opening a connection.
    let command = PreparedCommand::new(cli.command)?;
    let deadline = Duration::from_secs(cli.timeout.get());
    let endpoint = match cli.url {
        Some(url) => Endpoint::WebSocket {
            url,
            token: cli
                .token
                .filter(|token| !token.is_empty())
                .context("--url requires --token or ASH_APP_SERVER_TOKEN")?,
        },
        None => Endpoint::Stdio {
            server_bin: cli.server_bin.unwrap_or_else(|| "ash-app-server".into()),
            home: cli.home,
            workspace: cli.workspace,
        },
    };
    let connection = tokio::time::timeout(deadline, Connection::open(endpoint))
        .await
        .context("App Server connection timed out")??;
    let mut client = Client {
        connection,
        deadline,
        next_id: 1,
    };
    let outcome = tokio::select! {
        result = client.execute(command) => result,
        result = tokio::signal::ctrl_c() => result.context("listen for Ctrl+C"),
    };
    let shutdown = client.connection.close().await;
    outcome.and(shutdown)
}

enum PreparedCommand {
    Initialize,
    Request {
        method: String,
        params: Value,
        follow: Follow,
    },
    Watch {
        session_id: Option<SessionId>,
    },
}

enum Follow {
    Finish,
    Watch,
}

impl PreparedCommand {
    fn new(command: Command) -> Result<Self> {
        Ok(match command {
            Command::Initialize => Self::Initialize,
            Command::ModelList { view } => Self::Request {
                method: ClientMethod::ModelList.as_str().into(),
                params: serde_json::to_value(ModelListParams { view: view.into() })?,
                follow: Follow::Finish,
            },
            Command::SessionList => Self::Request {
                method: ClientMethod::SessionList.as_str().into(),
                params: serde_json::to_value(EmptyParams {})?,
                follow: Follow::Finish,
            },
            Command::Request {
                method,
                params,
                watch,
            } => {
                if method == ClientMethod::Initialize.as_str() {
                    bail!(
                        "use the initialize command; every connection is initialized automatically"
                    );
                }
                if method.trim().is_empty() {
                    bail!("RPC method must not be empty");
                }
                let json = match params.strip_prefix('@') {
                    Some(path) => std::fs::read_to_string(path)
                        .with_context(|| format!("read parameters from {path}"))?,
                    None => params,
                };
                let params: Value =
                    serde_json::from_str(&json).context("parse request parameters")?;
                if !params.is_object() {
                    bail!("Ash RPC parameters must be a JSON object");
                }
                Self::Request {
                    method,
                    params,
                    follow: if watch { Follow::Watch } else { Follow::Finish },
                }
            }
            Command::Watch { session_id } => Self::Watch {
                session_id: session_id.map(SessionId::new).transpose()?,
            },
        })
    }
}

struct Client {
    connection: Connection,
    deadline: Duration,
    next_id: u64,
}

// Use the shared strict envelopes so malformed traffic is not mistaken for a notification.
#[derive(Deserialize)]
#[serde(untagged)]
enum Inbound {
    Request(JsonRpcRequest<Value>),
    Notification(JsonRpcNotification<Value>),
    Response(JsonRpcResponse<Value, JsonRpcError>),
}

impl Client {
    async fn execute(&mut self, command: PreparedCommand) -> Result<()> {
        let initialized = self
            .request(
                ClientMethod::Initialize.as_str(),
                serde_json::to_value(InitializeParams {
                    client_info: ClientInfo {
                        name: "ash-app-server-test-client".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    capabilities: ClientCapabilities {
                        notifications: Some(true),
                        ..Default::default()
                    },
                })?,
            )
            .await?;
        let result: InitializeResult =
            serde_json::from_value(initialized.clone()).context("decode initialization result")?;
        ensure_protocol_compatible(&result, &[])?;
        match command {
            PreparedCommand::Initialize => output(&initialized),
            PreparedCommand::Request {
                method,
                params,
                follow,
            } => {
                output(&self.request(&method, params).await?)?;
                match follow {
                    Follow::Finish => Ok(()),
                    Follow::Watch => self.watch().await,
                }
            }
            PreparedCommand::Watch { session_id } => {
                output(&initialized)?;
                if let Some(session_id) = session_id {
                    output(
                        &self
                            .request(
                                ClientMethod::SessionSubscribe.as_str(),
                                serde_json::to_value(SessionSubscribeParams { session_id })?,
                            )
                            .await?,
                    )?;
                }
                self.watch().await
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        tokio::time::timeout(self.deadline, self.exchange(method, params))
            .await
            .with_context(|| format!("{method} timed out"))?
    }

    async fn exchange(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = JsonRpcId::Number(self.next_id);
        self.next_id += 1;
        let request = JsonRpcRequest::new(id.clone(), method.into(), params);
        self.connection
            .send(&serde_json::to_string(&request)?)
            .await?;
        loop {
            match self.receive().await? {
                Inbound::Response(JsonRpcResponse::Success(response)) => {
                    if response.id != id {
                        bail!("unexpected response id {:?}; expected {id:?}", response.id);
                    }
                    return Ok(response.result);
                }
                Inbound::Response(JsonRpcResponse::Failure(response)) => {
                    if response.id != id {
                        bail!("unexpected error id {:?}; expected {id:?}", response.id);
                    }
                    bail!(
                        "{method}: RPC error {}: {} ({})",
                        response.error.code,
                        response.error.message,
                        response.error.data
                    );
                }
                message => self.event(message).await?,
            }
        }
    }

    async fn receive(&mut self) -> Result<Inbound> {
        let message = self
            .connection
            .receive()
            .await?
            .context("App Server disconnected")?;
        serde_json::from_str(&message).context("invalid App Server JSON-RPC message")
    }

    async fn event(&mut self, message: Inbound) -> Result<()> {
        match message {
            Inbound::Notification(notification) => output(&notification),
            Inbound::Request(request) => {
                output(&request)?;
                let response = JsonRpcFailure::new(
                    request.id,
                    JsonRpcError {
                        code: -32601,
                        message: format!("test client does not implement {}", request.method),
                        data: Value::Null,
                    },
                );
                self.connection
                    .send(&serde_json::to_string(&response)?)
                    .await
            }
            Inbound::Response(_) => bail!("received a response without a pending request"),
        }
    }

    async fn watch(&mut self) -> Result<()> {
        loop {
            let message = self.receive().await?;
            self.event(message).await?;
        }
    }
}

fn output(value: &impl Serialize) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
