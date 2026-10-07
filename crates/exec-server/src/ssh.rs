use crate::Error;
use ash_uds::UnixStream;
use remote::RemoteDirPath;
use remote::RemoteProfile;
use remote::RemoteRuntime;
use remote::SshHost;
use remote::SshTarget;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;

/// A host-selected SSH execution authority. No credentials are serialized or passed as arguments.
#[derive(Clone, Debug)]
pub struct SshEndpoint {
    profile: RemoteProfile,
    environment: String,
    executable: PathBuf,
}

impl SshEndpoint {
    pub fn new(host: &str, root: &str, runtime: &str, environment: &str) -> Result<Self, Error> {
        exec_server_protocol::validate_id(environment).map_err(Error::Remote)?;
        let host = SshHost::parse(host).map_err(|_| Error::Protocol)?;
        let root = RemoteDirPath::parse(root).map_err(|_| Error::Protocol)?;
        let runtime = RemoteRuntime::new_exact_executable(runtime).map_err(|_| Error::Protocol)?;
        Ok(Self {
            profile: RemoteProfile::new(SshTarget::new(host, root), runtime),
            environment: environment.into(),
            executable: "ssh".into(),
        })
    }

    /// The host can select its installed OpenSSH executable; model inputs cannot change it.
    pub fn with_executable(mut self, executable: PathBuf) -> Self {
        self.executable = executable;
        self
    }

    pub(crate) fn environment(&self) -> &str {
        &self.environment
    }

    fn command(&self) -> String {
        [
            "env".into(),
            format!(
                "ASH_WORKSPACE_ROOT={}",
                self.profile.target().dir().as_str()
            ),
            self.profile.runtime().executable().into(),
            "execution-connect".into(),
            self.environment.clone(),
        ]
        .into_iter()
        .map(|argument: String| format!("'{}'", argument.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
    }
}

pub(crate) struct SshStream {
    socket: UnixStream,
    child: Child,
    workers: Vec<thread::JoinHandle<()>>,
}

impl SshStream {
    pub(crate) fn open(endpoint: &SshEndpoint) -> Result<Self, Error> {
        let (socket, peer) = UnixStream::pair()?;
        socket.set_read_timeout(Some(Duration::from_secs(15)))?;
        socket.set_write_timeout(Some(Duration::from_secs(5)))?;
        let mut input = peer.try_clone()?;
        let mut output = peer;
        let mut child = Command::new(&endpoint.executable)
            .args([
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=2",
            ])
            .arg(endpoint.profile.target().host().as_str())
            .arg(endpoint.command())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("SSH stdin is piped");
        let mut stdout = child.stdout.take().expect("SSH stdout is piped");
        let mut stream = Self {
            socket,
            child,
            workers: Vec::new(),
        };
        // Socket deadlines bound each exchange even when SSH blocks on a pipe. Drop first closes
        // both socket directions and kills SSH, then joins its two owned transport workers.
        stream
            .workers
            .push(
                thread::Builder::new()
                    .name("exec-ssh-input".into())
                    .spawn(move || {
                        let _ = io::copy(&mut input, &mut stdin);
                        let _ = input.shutdown(Shutdown::Both);
                    })?,
            );
        stream.workers.push(
            thread::Builder::new()
                .name("exec-ssh-output".into())
                .spawn(move || {
                    let _ = io::copy(&mut stdout, &mut output);
                    let _ = output.shutdown(Shutdown::Both);
                })?,
        );
        Ok(stream)
    }
}

impl Read for SshStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.socket.read(bytes)
    }
}
impl Write for SshStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.socket.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}
impl Drop for SshStream {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
        let _ = self.child.kill();
        let _ = self.child.wait();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
