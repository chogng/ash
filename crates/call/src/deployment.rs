use crate::CallError;
use crate::MemberCredential;
use ash_http_client::HttpClient;
use ash_package_store::CapabilitySource;
use std::net::TcpListener;
use std::net::TcpStream;
use std::net::UdpSocket;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

/// Executables resolved by the product installation owner, never by PATH discovery.
pub struct ServicePaths {
    pub media: PathBuf,
    pub collaboration: PathBuf,
}

/// Owns only the two child processes started for this local deployment.
/// Its private configuration directory is retained until both children have exited.
pub struct LocalDeployment {
    collaboration: Option<Child>,
    media: Child,
    _directory: tempfile::TempDir,
    url: String,
    administrator: MemberCredential,
    _media_lease: Option<ash_package_store::PackageLease>,
}

impl LocalDeployment {
    /// Resolves or installs the SFU only when the product explicitly hosts a local call.
    /// Joining an external room and dictation do not resolve this deployment dependency.
    pub fn livekit_server(home: &Path, http: &dyn HttpClient) -> Result<PathBuf, CallError> {
        if let Some(path) = std::env::var_os("ASH_LIVEKIT_SERVER_PATH") {
            return executable(PathBuf::from(path));
        }
        let offline = std::env::var_os("ASH_LIVEKIT_PACKAGE").map(PathBuf::from);
        let source = if let Some(path) = offline.as_deref() {
            CapabilitySource::Directory(path)
        } else {
            // Existing installations can still provide the server alongside the runtime.
            let context = ash_install_context::InstallContext::current();
            if let Some(layout) = context.package_layout() {
                let legacy = layout
                    .binary_directory()
                    .join(format!("livekit-server{}", std::env::consts::EXE_SUFFIX));
                if legacy.is_file() {
                    return executable(legacy);
                }
            }
            CapabilitySource::ProductBound
        };
        let root = ash_package_store::install_capability(home, "livekit", source, http)
            .map_err(|_| CallError::Deployment)?;
        executable(
            root.join("bin")
                .join(format!("livekit-server{}", std::env::consts::EXE_SUFFIX)),
        )
    }

    pub fn start(paths: &ServicePaths, database: &Path) -> Result<Self, CallError> {
        let media_lease = ash_package_store::acquire_package_lease_for_executable(&paths.media)
            .map_err(|_| CallError::Deployment)?;
        for executable in [&paths.media, &paths.collaboration] {
            if !executable.is_absolute()
                || executable
                    .canonicalize()
                    .map_err(|_| CallError::Deployment)?
                    != *executable
            {
                return Err(CallError::Deployment);
            }
        }
        let mut version = command(&paths.media)
            .arg("--version")
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| CallError::Deployment)?;
        let started = Instant::now();
        loop {
            if version
                .try_wait()
                .map_err(|_| CallError::Deployment)?
                .is_some()
            {
                break;
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = version.kill();
                let _ = version.wait();
                return Err(CallError::Deployment);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let version = version
            .wait_with_output()
            .map_err(|_| CallError::Deployment)?;
        if !version.status.success() || version.stdout != b"livekit-server version 1.13.7\n" {
            return Err(CallError::Deployment);
        }
        let directory = tempfile::Builder::new()
            .prefix("ash-call-")
            .tempdir()
            .map_err(|_| CallError::Deployment)?;
        let signal = TcpListener::bind("127.0.0.1:0").map_err(|_| CallError::Deployment)?;
        let control = TcpListener::bind("127.0.0.1:0").map_err(|_| CallError::Deployment)?;
        let udp = UdpSocket::bind("127.0.0.1:0").map_err(|_| CallError::Deployment)?;
        let signal_port = signal
            .local_addr()
            .map_err(|_| CallError::Deployment)?
            .port();
        let control_port = control
            .local_addr()
            .map_err(|_| CallError::Deployment)?
            .port();
        let udp_port = udp.local_addr().map_err(|_| CallError::Deployment)?.port();
        let secret = MemberCredential::generate();
        let config = directory.path().join("media.yaml");
        std::fs::write(&config, format!("port: {signal_port}\nbind_addresses: [127.0.0.1]\nrtc:\n  udp_port: {udp_port}\n  tcp_port: 0\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ash: {}\nlogging:\n  level: error\n", secret.expose())).map_err(|_| CallError::Deployment)?;
        drop(signal);
        drop(udp);
        let media = command(&paths.media)
            .arg("--config")
            .arg(config)
            .spawn()
            .map_err(|_| CallError::Deployment)?;
        let mut deployment = Self {
            media,
            collaboration: None,
            _directory: directory,
            url: format!("http://127.0.0.1:{control_port}"),
            administrator: MemberCredential::generate(),
            _media_lease: media_lease,
        };
        ready(&mut deployment.media, signal_port)?;
        if let Some(parent) = database.parent() {
            std::fs::create_dir_all(parent).map_err(|_| CallError::Deployment)?;
        }
        drop(control);
        deployment.collaboration = Some(
            command(&paths.collaboration)
                .arg(format!("127.0.0.1:{control_port}"))
                .arg(database)
                .env(
                    "ASH_COLLABORATION_BEARER_TOKEN",
                    deployment.administrator.expose(),
                )
                .env(
                    "ASH_LIVEKIT_SERVER_URL",
                    format!("ws://127.0.0.1:{signal_port}"),
                )
                .env(
                    "ASH_LIVEKIT_API_URL",
                    format!("http://127.0.0.1:{signal_port}"),
                )
                .env("ASH_LIVEKIT_API_KEY", "ash")
                .env("ASH_LIVEKIT_API_SECRET", secret.expose())
                .spawn()
                .map_err(|_| CallError::Deployment)?,
        );
        ready(
            deployment
                .collaboration
                .as_mut()
                .expect("child was started"),
            control_port,
        )?;
        Ok(deployment)
    }

    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn administrator(&self) -> &str {
        self.administrator.expose()
    }
}

impl Drop for LocalDeployment {
    fn drop(&mut self) {
        if let Some(child) = &mut self.collaboration {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = self.media.kill();
        let _ = self.media.wait();
    }
}

fn executable(path: PathBuf) -> Result<PathBuf, CallError> {
    if !path.is_absolute() || !path.is_file() {
        return Err(CallError::Deployment);
    }
    path.canonicalize().map_err(|_| CallError::Deployment)
}

fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

fn ready(child: &mut Child, port: u16) -> Result<(), CallError> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|_| CallError::Deployment)?
            .is_some()
        {
            return Err(CallError::Deployment);
        }
        if TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(100))
            .is_ok()
        {
            return Ok(());
        }
        if started.elapsed() >= Duration::from_secs(10) {
            return Err(CallError::Deployment);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
#[path = "deployment_tests.rs"]
mod tests;
