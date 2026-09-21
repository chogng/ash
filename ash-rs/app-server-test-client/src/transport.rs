use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use app_server_transport::parse_loopback_websocket_bind;
use futures::SinkExt;
use futures::StreamExt;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::net::TcpStream;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;
use tokio::process::Command;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) enum Endpoint {
    Stdio {
        server_bin: PathBuf,
        home: Option<PathBuf>,
        workspace: Option<PathBuf>,
    },
    WebSocket {
        url: String,
        token: String,
    },
}

pub(crate) enum Connection {
    Stdio {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
        frame: Vec<u8>,
    },
    WebSocket(Box<WebSocketStream<TcpStream>>),
}

impl Connection {
    pub(crate) async fn open(endpoint: Endpoint) -> Result<Self> {
        let (server_bin, home, workspace) = match endpoint {
            Endpoint::Stdio {
                server_bin,
                home,
                workspace,
            } => (server_bin, home, workspace),
            Endpoint::WebSocket { url, token } => {
                let address = parse_loopback_websocket_bind(&url)?;
                let mut request = url.into_client_request()?;
                let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
                    .context("invalid WebSocket capability token")?;
                authorization.set_sensitive(true);
                request.headers_mut().insert("authorization", authorization);
                let stream = TcpStream::connect(address)
                    .await
                    .context("connect to App Server")?;
                let config = WebSocketConfig::default()
                    .max_message_size(Some(DEFAULT_MAX_MESSAGE_BYTES))
                    .max_frame_size(Some(DEFAULT_MAX_MESSAGE_BYTES));
                let (socket, _) = client_async_with_config(request, stream, Some(config))
                    .await
                    .context("App Server WebSocket handshake failed")?;
                return Ok(Self::WebSocket(Box::new(socket)));
            }
        };
        let mut command = Command::new(server_bin);
        command
            .args(["--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(home) = home {
            command.env("ASH_HOME", home);
        }
        // A debugging connection has directory access only when explicitly requested.
        command.env_remove("ASH_WORKSPACE_ROOT");
        if let Some(workspace) = workspace {
            command.env("ASH_WORKSPACE_ROOT", workspace);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn().context("launch ash-app-server")?;
        let stdin = child.stdin.take().context("capture App Server stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("capture App Server stdout")?);
        Ok(Self::Stdio {
            child,
            stdin,
            stdout,
            frame: Vec::new(),
        })
    }

    pub(crate) async fn send(&mut self, message: &str) -> Result<()> {
        if message.len() > DEFAULT_MAX_MESSAGE_BYTES {
            bail!("outbound JSON-RPC message exceeds transport limit");
        }
        match self {
            Self::Stdio { stdin, .. } => {
                stdin.write_all(message.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
            }
            Self::WebSocket(socket) => socket.send(Message::Text(message.into())).await?,
        }
        Ok(())
    }

    pub(crate) async fn receive(&mut self) -> Result<Option<String>> {
        match self {
            Self::Stdio { stdout, frame, .. } => loop {
                let bytes = stdout.fill_buf().await?;
                if bytes.is_empty() {
                    if frame.is_empty() {
                        return Ok(None);
                    }
                    bail!("App Server closed stdout during a JSONL message");
                }
                let newline = bytes.iter().position(|byte| *byte == b'\n');
                let count = newline.map_or(bytes.len(), |index| index + 1);
                if frame.len() + count > DEFAULT_MAX_MESSAGE_BYTES {
                    bail!("inbound JSON-RPC message exceeds transport limit");
                }
                frame.extend_from_slice(&bytes[..count]);
                stdout.consume(count);
                if newline.is_some() {
                    return Ok(Some(String::from_utf8(std::mem::take(frame))?));
                }
            },
            Self::WebSocket(socket) => {
                while let Some(message) = socket.next().await {
                    match message? {
                        Message::Text(text) => return Ok(Some(text.to_string())),
                        Message::Close(_) => return Ok(None),
                        Message::Ping(_) => socket.flush().await?,
                        Message::Pong(_) => {}
                        _ => bail!("expected a WebSocket text message"),
                    }
                }
                Ok(None)
            }
        }
    }

    pub(crate) async fn close(self) -> Result<()> {
        match self {
            Self::Stdio {
                mut child,
                stdin,
                stdout,
                ..
            } => {
                drop(stdin);
                // Keep draining while the server handles EOF, so a full stdout pipe cannot
                // block graceful shutdown. The task is owned and joined here.
                let drain = tokio::spawn(async move {
                    tokio::io::copy(&mut { stdout }, &mut tokio::io::sink()).await
                });
                let result = match tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
                    Ok(result) => result.context("wait for App Server").and_then(|status| {
                        if status.success() {
                            Ok(())
                        } else {
                            bail!("App Server exited with {status}")
                        }
                    }),
                    Err(_) => child
                        .kill()
                        .await
                        .context("stop App Server after shutdown deadline"),
                };
                drain.abort();
                let _ = drain.await;
                result
            }
            Self::WebSocket(mut socket) => {
                tokio::time::timeout(SHUTDOWN_TIMEOUT, socket.as_mut().close(None))
                    .await
                    .context("WebSocket shutdown timed out")??;
                Ok(())
            }
        }
    }
}
