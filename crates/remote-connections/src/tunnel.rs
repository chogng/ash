use std::fmt;
use std::io;
use std::net::Ipv4Addr;
use std::net::SocketAddrV4;
use std::net::TcpListener;
use std::net::TcpStream;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use ash_remote::SshHost;

const DEFAULT_CONNECT_TIMEOUT_SECONDS: NonZeroU16 = NonZeroU16::new(10).expect("non-zero");
const READINESS_STABILITY: Duration = Duration::from_millis(50);

/// Selects a currently unused TCP port on the local loopback interface.
///
/// The temporary listener is released before this function returns because OpenSSH must create
/// the real listener itself. Callers should start the tunnel immediately and rely on
/// `ExitOnForwardFailure=yes` to detect a concurrent claim.
pub fn select_available_loopback_port() -> Result<NonZeroU16, SshTunnelError> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(SshTunnelError::SelectLocalPort)?;
    let port = listener
        .local_addr()
        .map_err(SshTunnelError::SelectLocalPort)?
        .port();
    NonZeroU16::new(port).ok_or(SshTunnelError::NoLocalPort)
}

/// Controls whether the host process receives OpenSSH diagnostics.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SshTunnelDiagnostics {
    /// Discards diagnostics for a graphical host that reports typed lifecycle state elsewhere.
    #[default]
    Discard,
    /// Inherits the host stderr for an interactive command-line owner.
    InheritStderr,
}

/// Host-owned inputs for a loopback-only SSH local port forward.
///
/// The local bind address is deliberately fixed to `127.0.0.1`; products must add a separate
/// authorization surface before exposing a forwarded port on a non-loopback interface. The
/// remote endpoint is addressed from the SSH server's network namespace and is not a local URL.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshTunnelOptions {
    host: SshHost,
    local_port: NonZeroU16,
    remote_host: String,
    remote_port: NonZeroU16,
    ssh_executable: PathBuf,
    connect_timeout_seconds: NonZeroU16,
    diagnostics: SshTunnelDiagnostics,
}

impl SshTunnelOptions {
    /// Creates a loopback forward from `local_port` to `127.0.0.1:remote_port` on the SSH host.
    pub fn new(host: SshHost, local_port: NonZeroU16, remote_port: NonZeroU16) -> Self {
        Self {
            host,
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port,
            ssh_executable: PathBuf::from("ssh"),
            connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
            diagnostics: SshTunnelDiagnostics::Discard,
        }
    }

    /// Selects a validated hostname or IPv4 address visible from the SSH host.
    pub fn with_remote_host(
        mut self,
        remote_host: impl AsRef<str>,
    ) -> Result<Self, SshTunnelError> {
        self.remote_host = validate_remote_host(remote_host.as_ref())?;
        Ok(self)
    }

    /// Selects the local OpenSSH executable controlled by the product host.
    pub fn with_ssh_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.ssh_executable = executable.into();
        self
    }

    /// Selects the OpenSSH TCP connection timeout in whole seconds.
    pub fn with_connect_timeout_seconds(mut self, timeout: NonZeroU16) -> Self {
        self.connect_timeout_seconds = timeout;
        self
    }

    /// Selects how the product host receives OpenSSH diagnostics.
    pub fn with_diagnostics(mut self, diagnostics: SshTunnelDiagnostics) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    /// Returns the loopback port selected on the local host.
    pub const fn local_port(&self) -> NonZeroU16 {
        self.local_port
    }

    /// Returns the endpoint port selected on the Remote host.
    pub const fn remote_port(&self) -> NonZeroU16 {
        self.remote_port
    }

    /// Returns the endpoint hostname selected on the Remote host.
    pub fn remote_host(&self) -> &str {
        &self.remote_host
    }

    /// Builds the direct child command without starting a process.
    pub fn command(&self) -> SshTunnelCommand {
        SshTunnelCommand {
            executable: self.ssh_executable.clone(),
            arguments: vec![
                "-N".into(),
                "-T".into(),
                "-o".into(),
                "BatchMode=yes".into(),
                "-o".into(),
                "ExitOnForwardFailure=yes".into(),
                "-o".into(),
                format!("ConnectTimeout={}", self.connect_timeout_seconds),
                "-L".into(),
                self.forward_spec(),
                self.host.as_str().into(),
            ],
        }
    }

    /// Starts the local OpenSSH process that owns the tunnel.
    pub fn start(&self) -> Result<SshTunnel, SshTunnelError> {
        let command = self.command();
        let stderr = match self.diagnostics {
            SshTunnelDiagnostics::Discard => Stdio::null(),
            SshTunnelDiagnostics::InheritStderr => Stdio::inherit(),
        };
        let mut child = Command::new(&command.executable)
            .args(&command.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .map_err(SshTunnelError::Spawn)?;
        if let Some(status) = child.try_wait().map_err(SshTunnelError::Wait)? {
            return Err(SshTunnelError::ProcessExited(status));
        }
        Ok(SshTunnel {
            child: Some(child),
            local_port: self.local_port,
            listener_observed_at: None,
        })
    }

    fn forward_spec(&self) -> String {
        format!(
            "127.0.0.1:{}:{}:{}",
            self.local_port, self.remote_host, self.remote_port
        )
    }
}

/// An SSH child command for one loopback port forward.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshTunnelCommand {
    executable: PathBuf,
    arguments: Vec<String>,
}

impl SshTunnelCommand {
    /// Returns the local OpenSSH executable.
    pub fn executable(&self) -> &std::path::Path {
        &self.executable
    }

    /// Returns the direct process arguments; no shell parsing is involved.
    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }
}

/// Owns the local OpenSSH process for one tunnel.
pub struct SshTunnel {
    child: Option<Child>,
    local_port: NonZeroU16,
    listener_observed_at: Option<Instant>,
}

impl SshTunnel {
    /// Returns the local loopback port owned by this tunnel.
    pub const fn local_port(&self) -> NonZeroU16 {
        self.local_port
    }

    /// Polls whether OpenSSH has established a stable local loopback listener.
    ///
    /// Readiness requires two successful loopback connections separated by a short stability
    /// interval while the SSH child remains alive. The probe opens no public listener and sends no
    /// application bytes. It confirms the local forward, not the availability of the service at
    /// the Remote endpoint. Product hosts own timeout and cancellation policy around this poll.
    pub fn poll_readiness(&mut self) -> Result<SshTunnelReadiness, SshTunnelError> {
        if let Some(status) = self.try_wait()? {
            return Err(SshTunnelError::ProcessExited(status));
        }
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.local_port.get());
        if TcpStream::connect(address).is_err() {
            self.listener_observed_at = None;
            return Ok(SshTunnelReadiness::Pending);
        }
        let now = Instant::now();
        let Some(observed_at) = self.listener_observed_at else {
            self.listener_observed_at = Some(now);
            return Ok(SshTunnelReadiness::Pending);
        };
        if now.duration_since(observed_at) < READINESS_STABILITY {
            return Ok(SshTunnelReadiness::Pending);
        }
        if let Some(status) = self.try_wait()? {
            return Err(SshTunnelError::ProcessExited(status));
        }
        Ok(SshTunnelReadiness::Ready)
    }

    /// Checks whether the SSH process has exited and returns its status when it has.
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, SshTunnelError> {
        let status = self
            .child
            .as_mut()
            .ok_or(SshTunnelError::Stopped)?
            .try_wait()
            .map_err(SshTunnelError::Wait)?;
        if status.is_some() {
            self.child = None;
        }
        Ok(status)
    }

    /// Terminates the SSH process and waits for it to leave the process table.
    pub fn stop(mut self) -> Result<(), SshTunnelError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let _ = child.kill();
        child.wait().map(|_| ()).map_err(SshTunnelError::Wait)
    }
}

/// Current readiness of an SSH local port forward.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SshTunnelReadiness {
    /// OpenSSH is still running but a stable local listener has not been observed yet.
    Pending,
    /// The local loopback listener is accepting connections and OpenSSH remains alive.
    Ready,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn validate_remote_host(value: &str) -> Result<String, SshTunnelError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(SshTunnelError::InvalidRemoteHost);
    }
    Ok(value.to_owned())
}

/// A failure while validating or owning one SSH tunnel process.
#[derive(Debug)]
pub enum SshTunnelError {
    InvalidRemoteHost,
    SelectLocalPort(io::Error),
    NoLocalPort,
    Spawn(io::Error),
    Wait(io::Error),
    ProcessExited(ExitStatus),
    Stopped,
}

impl fmt::Display for SshTunnelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRemoteHost => formatter.write_str("SSH tunnel remote host is invalid"),
            Self::SelectLocalPort(error) => {
                write!(formatter, "could not select a local loopback port: {error}")
            }
            Self::NoLocalPort => formatter.write_str("the operating system selected port zero"),
            Self::Spawn(error) => write!(formatter, "could not start SSH tunnel: {error}"),
            Self::Wait(error) => write!(formatter, "could not inspect SSH tunnel: {error}"),
            Self::ProcessExited(status) => {
                write!(
                    formatter,
                    "SSH tunnel exited before it became ready: {status}"
                )
            }
            Self::Stopped => formatter.write_str("SSH tunnel has already stopped"),
        }
    }
}

impl std::error::Error for SshTunnelError {}
