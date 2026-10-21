use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::RmcpClientError;
use rmcp::RoleClient;
use rmcp::service::RxJsonRpcMessage;
use rmcp::service::TxJsonRpcMessage;
use rmcp::transport::Transport;
use rmcp::transport::async_rw::AsyncRwTransport;
use std::io;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::ChildStdout;

/// Local child-process command used by the stdio convenience connector.
#[derive(Clone, Debug)]
pub struct StdioServerCommand {
    program: OsString,
    args: Vec<OsString>,
    env: BTreeMap<OsString, OsString>,
    current_dir: Option<PathBuf>,
}

impl StdioServerCommand {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            current_dir: None,
        }
    }

    pub fn with_arg(mut self, argument: impl Into<OsString>) -> Self {
        self.args.push(argument.into());
        self
    }

    pub fn with_args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }

    pub fn with_current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    fn into_command(self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(self.program);
        command.args(self.args).envs(self.env).kill_on_drop(true);
        if let Some(current_dir) = self.current_dir {
            command.current_dir(current_dir);
        }
        command
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn current_dir(&self) -> Option<&Path> {
        self.current_dir.as_deref()
    }
}

/// Owns the stdio launcher's entire process tree, including npm/npx descendants.
/// Cleanup lives with the transport so failed or cancelled initialization is covered too.
pub(crate) struct StdioTransport {
    child: Child,
    #[cfg(windows)]
    job: ash_utils_pty::JobObject,
    transport: AsyncRwTransport<RoleClient, ChildStdout, ChildStdin>,
}

impl StdioTransport {
    pub(crate) fn spawn(command: StdioServerCommand) -> io::Result<Self> {
        let mut command = command.into_command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(unix)]
        ash_utils_pty::process_group::configure_command_session(command.as_std_mut());
        #[cfg(windows)]
        let job = ash_utils_pty::JobObject::create()?;
        #[cfg(windows)]
        let mut child = job.spawn_contained(&mut command)?;
        #[cfg(not(windows))]
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().expect("piped MCP stdout");
        let stdin = child.stdin.take().expect("piped MCP stdin");
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
            transport: AsyncRwTransport::new(stdout, stdin),
        })
    }

    fn terminate_tree(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        self.job.terminate()?;
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // No wait/try_wait may reap the leader before its session is cleaned up.
            ash_utils_pty::process_group::kill_process_session(pid)?;
        }
        self.child.start_kill()
    }

    async fn shutdown(&mut self) -> io::Result<()> {
        let closed = self.transport.close().await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            #[cfg(unix)]
            let exited = match self.child.id() {
                Some(pid) => ash_utils_pty::process_group::child_has_exited(pid)?,
                None => true,
            };
            #[cfg(not(unix))]
            let exited = self.child.try_wait()?.is_some();
            if exited {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let terminated = self.terminate_tree();
        let reaped = self.child.wait().await;
        terminated?;
        reaped?;
        closed
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        // Synchronous signalling still works when the Tokio runtime is already shutting down.
        // Tokio's child owner handles reaping after start_kill; no cleanup task must be spawned.
        let _ = self.terminate_tree();
    }
}

impl Transport<RoleClient> for StdioTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.transport.send(item)
    }

    fn receive(
        &mut self,
    ) -> impl std::future::Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.transport.receive()
    }

    fn close(&mut self) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        self.shutdown()
    }
}

/// Secret bearer token material supplied by the host at connection time.
///
/// This type intentionally does not implement `Clone` or expose `Debug` content.
pub struct BearerToken(String);

impl BearerToken {
    pub fn new(value: impl Into<String>) -> Result<Self, RmcpClientError> {
        let value = value.into();
        if value.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err(RmcpClientError::InvalidBearerToken);
        }
        Ok(Self(value))
    }

    pub(crate) fn into_inner(self) -> String {
        self.0
    }
}

impl std::fmt::Debug for BearerToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BearerToken([REDACTED])")
    }
}

/// Authorization material for one Streamable HTTP connection.
#[derive(Debug, Default)]
pub enum HttpAuthorization {
    #[default]
    Unauthenticated,
    Bearer(BearerToken),
    Managed(ManagedHttpCredential),
}

pub struct ManagedHttpCredential(pub(crate) std::sync::Arc<dyn crate::HttpCredentialProvider>);
impl std::fmt::Debug for ManagedHttpCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ManagedHttpCredential([REDACTED])")
    }
}

/// Streamable HTTP endpoint and connection-time authorization.
#[derive(Debug)]
pub struct StreamableHttpServer {
    uri: String,
    authorization: HttpAuthorization,
}

impl StreamableHttpServer {
    pub fn new(uri: impl Into<String>) -> Result<Self, RmcpClientError> {
        let uri = uri.into();
        if !(uri.starts_with("https://") || uri.starts_with("http://"))
            || uri.contains(['\r', '\n'])
        {
            return Err(RmcpClientError::InvalidHttpEndpoint);
        }
        Ok(Self {
            uri,
            authorization: HttpAuthorization::Unauthenticated,
        })
    }

    pub fn with_bearer_token(mut self, token: BearerToken) -> Self {
        self.authorization = HttpAuthorization::Bearer(token);
        self
    }

    pub fn with_credentials(
        mut self,
        credentials: std::sync::Arc<dyn crate::HttpCredentialProvider>,
    ) -> Self {
        self.authorization = HttpAuthorization::Managed(ManagedHttpCredential(credentials));
        self
    }

    pub fn uri(&self) -> &str {
        &self.uri
    }

    pub(crate) fn into_parts(self) -> (String, HttpAuthorization) {
        (self.uri, self.authorization)
    }
}
