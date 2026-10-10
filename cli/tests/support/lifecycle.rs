use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::LifecycleCommand;
use ash_app_server_daemon::LifecycleStatus;
use ash_app_server_daemon::run_lifecycle;

pub fn backend_executable() -> PathBuf {
    Path::new(env!("CARGO_BIN_EXE_ash"))
        .parent()
        .unwrap()
        .join("ash-app-server")
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn isolate(command: &mut Command, root: &Path) {
    let home = root.join("home");
    let codex = root.join("codex");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&codex).unwrap();
    command
        .env("HOME", home)
        .env("CODEX_HOME", codex)
        .env("ZCODE_DATA_BASE_DIR", root.join("zcode"))
        .env("ASH_HOME", root.join("profile"))
        .env_remove("ASH_PRODUCT_SERVICES_PATH")
        .env_remove("ASH_APP_SERVER_SHA256")
        .env_remove("ASH_WORKSPACE_ROOT");
}

pub fn stdio_command(command: StdioAppServerCommand, root: &Path) -> StdioAppServerCommand {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root.join("codex")).unwrap();
    std::fs::create_dir_all(root.join("home")).unwrap();
    let wrapper = root.join("backend-wrapper");
    std::fs::write(
        &wrapper,
        "#!/bin/sh\nprintf '%s' \"$$\" > \"$ASH_STDIO_TEST_BACKEND_PID\"\nexec \"$ASH_STDIO_TEST_BACKEND\" \"$@\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    // exec preserves the PID while forwarding into the real server, rather than
    // mistaking the CLI intermediary's exit for server and database cleanup.
    command
        .with_environment_variable("ASH_APP_SERVER_PATH", wrapper)
        .with_environment_variable("ASH_STDIO_TEST_BACKEND", backend_executable())
        .with_environment_variable("ASH_STDIO_TEST_BACKEND_PID", root.join("backend.pid"))
        .with_environment_variable("HOME", root.join("home"))
        .with_environment_variable("CODEX_HOME", root.join("codex"))
        .with_environment_variable("ZCODE_DATA_BASE_DIR", root.join("zcode"))
        .without_environment_variable("ASH_PRODUCT_SERVICES_PATH")
        .without_environment_variable("ASH_APP_SERVER_SHA256")
}

pub fn assert_process_exited(pid: u32) {
    let output = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "process {pid} survived close: {output:?}"
    );
}

pub fn descendant_processes(pid: u32) -> Vec<u32> {
    let output = Command::new("ps")
        .args(["-ax", "-o", "pid=", "-o", "ppid="])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let processes: Vec<(u32, u32)> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next().unwrap().parse().unwrap();
            let parent = fields.next().unwrap().parse().unwrap();
            assert!(fields.next().is_none());
            (pid, parent)
        })
        .collect();
    let mut owned = vec![pid];
    loop {
        let children: Vec<u32> = processes
            .iter()
            .filter(|(pid, parent)| owned.contains(parent) && !owned.contains(pid))
            .map(|(pid, _)| *pid)
            .collect();
        if children.is_empty() {
            break;
        }
        owned.extend(children);
    }
    owned.remove(0);
    owned
}

fn directory_handles(root: &Path) -> std::process::Output {
    Command::new("lsof")
        .args(["-n", "-P", "-t", "+D"])
        .arg(root)
        .output()
        .expect("lsof is required to verify Unix file-handle cleanup")
}

pub fn assert_profile_in_use(root: &Path, pid: u32) {
    // +D can return 1 when some directory entries are not open, even while
    // listing other matches. A single database proves this process holds its profile.
    let handles = Command::new("lsof")
        .args(["-n", "-P", "-a", "-p", &pid.to_string(), "-t", "--"])
        .arg(root.join("profile/state.sqlite3"))
        .output()
        .unwrap();
    assert!(handles.status.success(), "{handles:?}");
    assert!(
        String::from_utf8(handles.stdout)
            .unwrap()
            .lines()
            .any(|line| line == pid.to_string()),
        "server {pid} did not own the profile's open files"
    );
}

pub fn assert_no_open_files(root: &Path) {
    let handles = directory_handles(root);
    assert_eq!(
        handles.status.code(),
        Some(1),
        "open files survived close: {handles:?}"
    );
    assert!(
        handles.stdout.is_empty() && handles.stderr.is_empty(),
        "{handles:?}"
    );
}

pub fn stdio_processes(root: &Path) -> Vec<u32> {
    let backend_pid = std::fs::read_to_string(root.join("backend.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_profile_in_use(root, backend_pid);
    let mut processes = descendant_processes(backend_pid);
    processes.push(backend_pid);
    processes
}

pub fn assert_stdio_closed(root: &Path, transport_pid: u32, server_processes: &[u32]) {
    assert_process_exited(transport_pid);
    for &pid in server_processes {
        assert_process_exited(pid);
    }
    // Unix unlink succeeds with live descriptors, so check before deleting the fixture.
    assert_no_open_files(root);
}

pub struct LoggedChild {
    child: Option<Child>,
    reader: Option<JoinHandle<Vec<String>>>,
}

impl LoggedChild {
    pub fn start(mut command: Command, ready: &str) -> Self {
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut process = Self {
            child: Some(child),
            reader: None,
        };
        let stderr = process.child.as_mut().unwrap().stderr.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        process.reader = Some(std::thread::spawn(move || {
            BufReader::new(stderr)
                .lines()
                .map(|line| {
                    let line = line.unwrap();
                    let _ = sender.send(line.clone());
                    line
                })
                .collect()
        }));
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut log = Vec::new();
        loop {
            let line = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| panic!("process readiness failed: {error}; {log:?}"));
            let is_ready = line.contains(ready);
            log.push(line);
            if is_ready {
                break;
            }
        }
        process
    }

    pub fn id(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    pub fn assert_running(&mut self) {
        assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none());
    }

    pub fn wait(&mut self) -> ExitStatus {
        let status = self.child.as_mut().unwrap().wait().unwrap();
        self.child.take();
        self.reader.take().unwrap().join().unwrap();
        status
    }

    pub fn stop(&mut self) {
        self.child.as_mut().unwrap().kill().unwrap();
        self.wait();
    }
}

impl Drop for LoggedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            if let Ok(lines) = reader.join() {
                if std::thread::panicking() {
                    eprintln!("child stderr during fixture cleanup:\n{}", lines.join("\n"));
                }
            }
        }
    }
}

pub struct ManagedBackend {
    process: LoggedChild,
    root: PathBuf,
}

impl ManagedBackend {
    pub fn start(root: &Path) -> Self {
        let mut command = Command::new(backend_executable());
        command.arg("--managed");
        isolate(&mut command, root);
        // Keep a direct Child so stop can reap it synchronously, including on Unix
        // where an orphan's temporary zombie otherwise makes PID checks racy.
        let process = LoggedChild::start(command, "managed App Server endpoint ready:");
        Self {
            process,
            root: root.to_path_buf(),
        }
    }

    pub fn assert_running(&mut self) {
        self.process.assert_running();
        assert_profile_in_use(&self.root, self.process.id());
    }

    pub fn stop(&mut self) {
        let pid = self.process.id();
        let descendants = descendant_processes(pid);
        let output = run_lifecycle(
            LifecycleCommand::Stop,
            ConnectionOptions::new(
                self.root.join("profile"),
                None,
                GrantSource::HostConfiguration,
                None,
            ),
            &backend_executable(),
        )
        .unwrap();
        assert_eq!(output.status, LifecycleStatus::Stopped);
        assert_eq!(output.pid, Some(pid));
        assert!(self.process.wait().success());
        assert_process_exited(pid);
        for pid in descendants {
            assert_process_exited(pid);
        }
        assert_no_open_files(&self.root);
    }
}

impl Drop for ManagedBackend {
    fn drop(&mut self) {
        if self.process.child.is_some() {
            let _ = run_lifecycle(
                LifecycleCommand::Stop,
                ConnectionOptions::new(
                    self.root.join("profile"),
                    None,
                    GrantSource::HostConfiguration,
                    None,
                ),
                &backend_executable(),
            );
        }
    }
}
