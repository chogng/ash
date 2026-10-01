use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_terminal::GridSize;
use ash_terminal::TerminalCore;
use portable_pty::CommandBuilder;
use portable_pty::ExitStatus;
use portable_pty::MasterPty;
use portable_pty::PtySize;
use portable_pty::native_pty_system;
use std::fs;
use std::io::ErrorKind;
use std::io::Read;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tempfile::TempDir;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(20);
const STATE_TIMEOUT: Duration = Duration::from_secs(30);
const REDRAW_QUIET_PERIOD: Duration = Duration::from_millis(40);
const SCREEN_QUIET_PERIOD: Duration = Duration::from_millis(250);
const OUTPUT_LIMIT: usize = 512 * 1024;

#[path = "tui_process_tests.rs"]
mod synchronization_tests;
pub const LARGE_SIZE: PtySize = PtySize {
    rows: 32,
    cols: 100,
    pixel_width: 0,
    pixel_height: 0,
};
pub const SMALL_SIZE: PtySize = PtySize {
    rows: 16,
    cols: 60,
    pixel_width: 0,
    pixel_height: 0,
};

fn ash_executable() -> PathBuf {
    match option_env!("ASH_BAZEL_ASH") {
        Some(path) => bazel_runfile(path),
        None => PathBuf::from(option_env!("CARGO_BIN_EXE_ash").expect("Cargo ash executable")),
    }
}

fn daemon_executable() -> PathBuf {
    match option_env!("ASH_BAZEL_DAEMON") {
        Some(path) => bazel_runfile(path),
        None => ash_executable().with_file_name(format!(
            "ash-app-server-daemon{}",
            std::env::consts::EXE_SUFFIX
        )),
    }
}

fn app_server_executable() -> PathBuf {
    match option_env!("ASH_BAZEL_APP_SERVER") {
        Some(path) => bazel_runfile(path),
        None => ash_executable()
            .with_file_name(format!("ash-app-server{}", std::env::consts::EXE_SUFFIX)),
    }
}

fn bazel_runfile(path: &str) -> PathBuf {
    if let Some(directory) = std::env::var_os("RUNFILES_DIR") {
        return PathBuf::from(directory).join(path);
    }
    let manifest = std::env::var("RUNFILES_MANIFEST_FILE").expect("Bazel runfiles manifest");
    let contents = fs::read_to_string(manifest).expect("read Bazel runfiles manifest");
    let value = contents
        .lines()
        .filter_map(|line| line.split_once(' '))
        .find_map(|(key, value)| (key == path).then_some(value))
        .unwrap_or_else(|| panic!("missing Bazel runfile: {path}"));
    PathBuf::from(value)
}

fn cpp_runtime_environment(library: &Path) -> (&'static str, PathBuf) {
    assert!(
        library.is_file(),
        "missing declared C++ runtime: {}",
        library.display()
    );
    (
        "LD_LIBRARY_PATH",
        library.parent().expect("C++ runtime directory").to_owned(),
    )
}

struct StagedBinaries {
    _directory: TempDir,
    ash: PathBuf,
    daemon: PathBuf,
    app_server: PathBuf,
}

impl StagedBinaries {
    fn new() -> Self {
        // Bazel exposes executable runfiles as symlinks; the daemon requires regular files.
        // Keep one real copy of each binary shared by this test process.
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let staged = |source: PathBuf| {
            let destination = bin.join(source.file_name().expect("executable name"));
            fs::copy(source, &destination).unwrap();
            destination
        };
        let binaries = Self {
            ash: staged(ash_executable()),
            daemon: staged(daemon_executable()),
            app_server: staged(app_server_executable()),
            _directory: directory,
        };
        // Bazel build directories disappear after compilation. Exercise packaged resource
        // discovery instead of relying on the app-server's development source directory.
        let root = binaries._directory.path();
        fs::create_dir(root.join("ash-path")).unwrap();
        for (name, contents) in [
            (
                "create-instructions",
                include_str!("../../../ash-rs/skills/assets/create-instructions/SKILL.md"),
            ),
            (
                "skill-creator",
                include_str!("../../../ash-rs/skills/assets/skill-creator/SKILL.md"),
            ),
        ] {
            let skill = root.join("ash-resources/skills").join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), contents).unwrap();
        }
        use sha2::Digest;
        let build_id = format!(
            "sha256:{:x}",
            sha2::Sha256::digest(fs::read(&binaries.app_server).unwrap())
        );
        fs::write(
            root.join("ash-package.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "buildId": build_id,
                "buildProfile": "dev-small",
                "files": {},
                "javascriptRuntime": { "kind": "systemNode" },
            }))
            .unwrap(),
        )
        .unwrap();
        binaries
    }
}

static STAGED_BINARIES: OnceLock<StagedBinaries> = OnceLock::new();

pub struct Fixture {
    _root: TempDir,
    root: PathBuf,
    workspace: PathBuf,
    profile: PathBuf,
    ash: PathBuf,
    app_server: PathBuf,
    product_services: Option<PathBuf>,
    voice_host: Option<PathBuf>,
}

impl Fixture {
    pub fn new() -> Self {
        #[cfg(unix)]
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        #[cfg(unix)]
        let root = tempfile::Builder::new()
            .prefix("zt-")
            .tempdir_in(base)
            .unwrap();
        #[cfg(windows)]
        let root = tempfile::Builder::new().prefix("zt-").tempdir().unwrap();
        #[cfg(unix)]
        let path = {
            // Path clipping in text snapshots must be identical on macOS and Linux.
            const LENGTH: usize = 66;
            let path = fs::canonicalize(root.path()).unwrap();
            let padding = LENGTH
                .checked_sub(path.as_os_str().len())
                .expect("Unix PTY fixture root exceeds the fixed snapshot path length");
            let path = if padding == 0 {
                path
            } else {
                assert!(
                    padding > 1,
                    "Unix PTY fixture path cannot be padded by one byte"
                );
                let padded = path.join("x".repeat(padding - 1));
                fs::create_dir(&padded).unwrap();
                padded
            };
            assert_eq!(path.as_os_str().len(), LENGTH);
            path
        };
        #[cfg(windows)]
        let path = root.path().to_path_buf();
        let workspace = path.join("workspace");
        let profile = path.join("profile");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&profile).unwrap();
        let (ash, daemon, app_server) = if option_env!("ASH_BAZEL_ASH").is_some() {
            let staged = STAGED_BINARIES.get_or_init(StagedBinaries::new);
            (
                staged.ash.clone(),
                staged.daemon.clone(),
                staged.app_server.clone(),
            )
        } else {
            (
                ash_executable(),
                daemon_executable(),
                app_server_executable(),
            )
        };
        assert!(
            daemon.is_file(),
            "build the matching daemon with `just test-tui`"
        );
        Self {
            _root: root,
            root: path,
            workspace,
            profile,
            ash,
            app_server,
            product_services: None,
            voice_host: None,
        }
    }

    pub fn with_product_services(mut self, document: serde_json::Value) -> Self {
        let path = self.root.join("product-services.json");
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        self.product_services = Some(path);
        self
    }

    pub fn with_missing_voice_host(mut self) -> Self {
        self.voice_host = Some(self.root.join("missing-voice-host"));
        self
    }

    fn environment(&self) -> Vec<(&'static str, PathBuf)> {
        let mut environment = vec![
            ("ASH_HOME", self.profile.clone()),
            ("ASH_WORKSPACE_ROOT", self.workspace.clone()),
            ("CODEX_HOME", self.codex_home()),
            ("ASH_APP_SERVER_PATH", self.app_server.clone()),
        ];
        if let Some(path) = option_env!("ASH_BAZEL_LIBSTDCXX") {
            // Staged executables no longer have Bazel's relative library layout.
            // Keep every child on the declared runtime instead of the host copy.
            environment.push(cpp_runtime_environment(&bazel_runfile(path)));
        }
        if let Some(path) = &self.product_services {
            environment.push(("ASH_PRODUCT_SERVICES_PATH", path.clone()));
        }
        if let Some(path) = &self.voice_host {
            environment.push(("ASH_VOICE_HOST_PATH", path.clone()));
        }
        #[cfg(windows)]
        let environment = {
            let mut environment = environment;
            environment.push((
                "ASH_WINDOWS_COMMAND_RUNNER_PATH",
                self.ash.with_file_name("ash-command-runner.exe"),
            ));
            environment
        };
        environment
    }

    #[cfg(unix)]
    pub fn install_issue_provider(&self) {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let issue = serde_json::json!({"number":3,"title":"Repair first issue","body":"First requirement","html_url":"https://github.com/team/repo/issues/3","updated_at":"2026-09-07T00:00:00Z","state":"open"});
        let mut second = issue.clone();
        second["number"] = 5.into();
        second["title"] = "Repair second issue".into();
        second["html_url"] = "https://github.com/team/repo/issues/5".into();
        for (name, data) in [
            (
                "issues.json",
                serde_json::json!([issue.clone(), second.clone()]),
            ),
            ("3.json", issue),
            ("5.json", second),
        ] {
            fs::write(bin.join(name), serde_json::to_vec(&data).unwrap()).unwrap();
        }
        let script = bin.join("gh");
        fs::write(&script, include_str!("issue_provider.py")).unwrap();
        fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
    }

    pub fn write_config(&self, base_url: &str) {
        fs::write(
            self.profile.join("config.toml"),
            format!(
                r#"[agent.model]
provider = "openai-compatible"
model = "ash-real-scenario"

[providers."openai-compatible"]
provider = "openai-compatible"
baseUrl = "{base_url}"
"#,
            ),
        )
        .unwrap();
    }

    pub fn append_config(&self, fragment: &str) {
        let mut config = fs::OpenOptions::new()
            .append(true)
            .open(self.profile.join("config.toml"))
            .unwrap();
        config.write_all(fragment.as_bytes()).unwrap();
    }

    pub fn config_source(&self) -> String {
        fs::read_to_string(self.profile.join("config.toml")).unwrap()
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn codex_home(&self) -> PathBuf {
        self.profile.join("codex")
    }

    pub fn find_file(&self, name: &str) -> Option<PathBuf> {
        find_named(&self.root, name)
    }

    pub fn sessions(&self) -> Vec<ash_protocol::Session> {
        let mut command = StdioAppServerCommand::new(&self.ash)
            .with_argument("app-server")
            .with_argument("connect");
        for (name, value) in self.environment() {
            command = command.with_environment_variable(name, value);
        }
        eprintln!("PTY inspector: connecting");
        let session = AppServerSession::start_stdio(
            command,
            ClientInfo {
                name: "ash-tui-real-scenario-inspector".into(),
                version: "1".into(),
            },
            ash_tui::client_capabilities(),
        )
        .unwrap();
        eprintln!("PTY inspector: listing sessions");
        let sessions = session.client().list_sessions().unwrap().sessions;
        eprintln!("PTY inspector: shutting down");
        session.shutdown().unwrap();
        eprintln!("PTY inspector: closed");
        sessions
    }

    pub fn only_thread(&self) -> (String, String) {
        let sessions = self.sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].threads.len(), 1);
        (
            sessions[0].session_id.to_string(),
            sessions[0].threads[0].thread_id.to_string(),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if thread::panicking() {
            if let Ok(entries) = fs::read_dir(self.profile.join("run")) {
                for entry in entries.flatten() {
                    if entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "log")
                    {
                        if let Ok(log) = fs::read_to_string(entry.path()) {
                            eprintln!("Test daemon log ({}):\n{log}", entry.path().display());
                        }
                    }
                }
            }
        }
        // Stop only the daemon belonging to this isolated fixture before deleting it.
        let _ = std::process::Command::new(&self.ash)
            .args(["app-server", "daemon", "stop"])
            .envs(self.environment())
            .output();
    }
}

fn find_named(root: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            if let Some(found) = find_named(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|file_name| file_name == name) {
            return Some(path);
        }
    }
    None
}

pub struct TuiProcess {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: ChildGuard,
    capture: Arc<Mutex<TerminalCapture>>,
    reader: Option<thread::JoinHandle<()>>,
    snapshot_paths: Vec<String>,
}

impl TuiProcess {
    pub fn start(fixture: &Fixture, args: &[&str], size: PtySize) -> Self {
        Self::start_with_terminal(fixture, args, size, None)
    }

    pub fn start_in_vscode(fixture: &Fixture, args: &[&str], size: PtySize) -> Self {
        Self::start_with_terminal(fixture, args, size, Some(("vscode", "1.136.1")))
    }

    fn start_with_terminal(
        fixture: &Fixture,
        args: &[&str],
        size: PtySize,
        terminal: Option<(&str, &str)>,
    ) -> Self {
        let pair = native_pty_system().openpty(size).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let reply_writer = Arc::clone(&writer);
        let capture = Arc::new(Mutex::new(TerminalCapture::new(size)));
        let reader_capture = Arc::clone(&capture);
        let reader_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 8_192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let replies = {
                            let mut capture = reader_capture.lock().unwrap();
                            capture.push(&buffer[..read]);
                            capture.core.take_reply_bytes()
                        };
                        if !replies.is_empty() {
                            let mut writer = reply_writer.lock().unwrap();
                            if writer
                                .write_all(&replies)
                                .and_then(|_| writer.flush())
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        let mut command = CommandBuilder::new(&fixture.ash);
        command.args(args);
        command.cwd(&fixture.workspace);
        command.env("TERM", "xterm-256color");
        if let Some((program, version)) = terminal {
            command.env("TERM_PROGRAM", program);
            command.env("TERM_PROGRAM_VERSION", version);
        }
        let fixture_bin = fixture.root.join("bin");
        if fixture_bin.is_dir() {
            let mut paths = vec![fixture_bin];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            command.env("PATH", std::env::join_paths(paths).unwrap());
        }
        // Never let an offline PTY scenario reuse the developer's actual Codex subscription.
        fs::create_dir_all(fixture.codex_home()).unwrap();
        for (name, value) in fixture.environment() {
            command.env(name, value);
        }
        command.env("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "5000");
        let child = ChildGuard::new(pair.slave.spawn_command(command).unwrap());
        drop(pair.slave);
        let mut snapshot_paths = vec![fixture.root.to_string_lossy().into_owned()];
        if let Ok(path) = fs::canonicalize(&fixture.root) {
            let path = path.to_string_lossy().into_owned();
            if !snapshot_paths.contains(&path) {
                snapshot_paths.push(path);
            }
        }
        if let Some(profile) = std::env::var_os("USERPROFILE")
            && let Ok(relative) = fixture.root.strip_prefix(profile)
        {
            snapshot_paths.push(format!(
                "~{}{}",
                std::path::MAIN_SEPARATOR,
                relative.display()
            ));
        }
        for path in snapshot_paths.clone() {
            if path.starts_with("/var/") {
                snapshot_paths.push(format!("/private{path}"));
            }
        }
        Self {
            master: Some(pair.master),
            writer,
            child,
            capture,
            reader: Some(reader_thread),
            snapshot_paths,
        }
    }

    pub fn submit(&mut self, text: &str) {
        self.type_text(text);
        self.enter();
    }

    pub fn type_text(&mut self, text: &str) {
        self.send_input(text.as_bytes());
    }

    pub fn enter(&mut self) {
        self.send_input(b"\r");
    }

    pub fn tab(&mut self) {
        self.send_input(b"\t");
    }

    pub fn back_tab(&mut self) {
        self.send_input(b"\x1b[Z");
    }

    pub fn refresh_policy_tip(&mut self) {
        // Confirming the current policy refreshes the hint without changing its value.
        self.wait_for_clipboard_tip_to_expire();
        self.submit("/policy");
        self.wait_for_stable_screen("bypass-permissions");
        self.enter();
        self.wait_for_stable_screen("/policy to change permissions");
    }

    pub fn up(&mut self) {
        self.send_input(b"\x1b[A");
    }

    pub fn alt_up(&mut self) {
        self.send_input(b"\x1b[1;3A");
    }

    pub fn control_up(&mut self) {
        self.send_input(b"\x1b[1;5A");
    }

    pub fn control_home(&mut self) {
        self.send_input(b"\x1b[1;5H");
    }

    pub fn control_end(&mut self) {
        self.send_input(b"\x1b[1;5F");
    }

    pub fn down(&mut self) {
        self.send_input(b"\x1b[B");
    }

    pub fn right(&mut self) {
        self.send_input(b"\x1b[C");
    }

    pub fn space(&mut self) {
        self.send_input(b" ");
    }

    pub fn escape(&mut self) {
        self.send_input(b"\x1b");
    }

    pub fn scroll_up(&mut self, column: u16, row: u16) {
        self.send_input(
            format!(
                "\x1b[<64;{};{}M",
                column.saturating_add(1),
                row.saturating_add(1)
            )
            .as_bytes(),
        );
    }

    pub fn send(&mut self, bytes: &[u8]) {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes).unwrap();
        writer.flush().unwrap();
    }

    fn send_input(&mut self, bytes: &[u8]) {
        let revision = self.capture.lock().unwrap().revision();
        self.send(bytes);
        self.wait_for_output_after(revision);
    }

    fn wait_for_output_after(&mut self, revision: u64) {
        // Pace separate input writes, but do not interpret an animation frame as an input
        // acknowledgement. Callers must wait for their screen state or protocol/side effect.
        self.wait_for_terminal(TerminalWaitFor::OutputAfter(revision));
    }

    pub fn resize(&mut self, size: PtySize) {
        let revision = {
            let mut capture = self.capture.lock().unwrap();
            if capture.size.rows == size.rows && capture.size.cols == size.cols {
                return;
            }
            capture.resize(size);
            capture.revision()
        };
        self.master
            .as_ref()
            .expect("running PTY")
            .resize(size)
            .unwrap();
        self.wait_for_output_after(revision);
    }

    /// Observe a business marker immediately, including a short-lived hint during animation.
    /// The marker must distinguish the target from the screen before the action.
    pub fn wait_for_screen(&mut self, expected: &str) {
        self.wait_for_terminal(TerminalWaitFor::ScreenContains(expected));
    }

    /// Wait for the target state and stable visible text; raw ANSI activity is irrelevant.
    pub fn wait_for_stable_screen(&mut self, expected: &str) {
        self.wait_for_terminal(TerminalWaitFor::StableScreenContains(expected));
    }

    pub fn screen(&self) -> String {
        self.capture.lock().unwrap().screen()
    }

    pub fn wait_for_screen_to_omit(&mut self, unexpected: &str) {
        self.wait_for_terminal(TerminalWaitFor::StableScreenOmits(unexpected));
    }

    fn wait_for_terminal(&mut self, condition: TerminalWaitFor<'_>) -> String {
        let mut wait = TerminalWait::new(condition, Instant::now());
        loop {
            let exited = self.child.try_wait().unwrap();
            let result = wait.observe(&self.capture.lock().unwrap(), exited, Instant::now());
            match result {
                Ok(Some(screen)) => return screen,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(error) => panic!("{error}"),
            }
        }
    }

    pub fn raw_text(&self) -> String {
        self.capture.lock().unwrap().raw_text()
    }

    pub fn terminal_text(&self) -> String {
        let capture = self.capture.lock().unwrap();
        capture
            .core
            .grid()
            .scrollback_lines()
            .iter()
            .chain(capture.core.grid().lines().iter())
            .map(|line| line.text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Snapshot only a settled target state. Animated states belong in fixed-clock App tests.
    pub fn assert_snapshot(&mut self, name: &str, expected: &str) {
        self.wait_for_clipboard_tip_to_expire();
        let screen = self.wait_for_terminal(TerminalWaitFor::StableScreenContains(expected));
        // Use the exact frame that satisfied the predicate and stability check, not a later read.
        let screen = normalize_snapshot(screen, &self.snapshot_paths);
        assert_named_snapshot(name, screen);
    }

    fn wait_for_clipboard_tip_to_expire(&mut self) {
        // The host clipboard belongs to the user, not these conversation fixtures.
        if self.screen().contains("image in clipboard") {
            self.wait_for_screen_to_omit("image in clipboard");
        }
    }

    pub fn quit(&mut self) {
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        let mut sent_revision = self.capture.lock().unwrap().revision();
        let mut observed_revision = sent_revision;
        let mut changed_at = Instant::now();
        self.send(&[0x03]);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.close_terminal();
                assert!(
                    status.success(),
                    "TUI exited unsuccessfully ({status:?}); output:\n{}",
                    self.raw_text()
                );
                break;
            }
            let (revision, interactive) = {
                let capture = self.capture.lock().unwrap();
                (capture.revision(), capture.core.modes().bracketed_paste())
            };
            if revision != observed_revision {
                observed_revision = revision;
                changed_at = Instant::now();
            }
            // An interrupt may only close a panel. Retry after that redraw settles,
            // but never send another control event once terminal restoration starts.
            if interactive
                && revision > sent_revision
                && changed_at.elapsed() >= REDRAW_QUIET_PERIOD
            {
                self.send(&[0x03]);
                sent_revision = revision;
            }
            if Instant::now() >= deadline {
                panic!("TUI did not exit; screen:\n{}", self.screen());
            }
            thread::sleep(Duration::from_millis(20));
        }
        self.close_terminal();
    }

    fn close_terminal(&mut self) {
        *self.writer.lock().unwrap() = Box::new(std::io::sink());
        // ConPTY keeps its output pipe open until the pseudoconsole is closed.
        // Keep the reader draining while closing, then join it after EOF.
        drop(self.master.take());
        if let Some(reader) = self.reader.take() {
            if let Err(error) = reader.join() {
                if !thread::panicking() {
                    std::panic::resume_unwind(error);
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum TerminalWaitFor<'a> {
    OutputAfter(u64),
    ScreenContains(&'a str),
    StableScreenContains(&'a str),
    StableScreenOmits(&'a str),
}

struct TerminalWait<'a> {
    condition: TerminalWaitFor<'a>,
    deadline: Instant,
    matching_text: Option<(u64, Instant)>,
}

impl<'a> TerminalWait<'a> {
    fn new(condition: TerminalWaitFor<'a>, now: Instant) -> Self {
        Self {
            condition,
            deadline: now + STATE_TIMEOUT,
            matching_text: None,
        }
    }

    fn observe(
        &mut self,
        capture: &TerminalCapture,
        exited: Option<ExitStatus>,
        now: Instant,
    ) -> Result<Option<String>, String> {
        // A matching last frame cannot turn an exited process into a successful interaction.
        if let Some(status) = exited {
            return Err(format!(
                "TUI exited while waiting for {:?}: {status:?}; screen:\n{}\nraw:\n{}",
                self.condition,
                capture.screen(),
                capture.raw_text(),
            ));
        }
        if now >= self.deadline {
            return Err(format!(
                "TUI timed out waiting for {:?}; screen:\n{}\nraw:\n{}",
                self.condition,
                capture.screen(),
                capture.raw_text(),
            ));
        }
        let screen = capture.screen();
        let matches = match self.condition {
            TerminalWaitFor::OutputAfter(revision) => capture.revision() > revision,
            TerminalWaitFor::ScreenContains(expected)
            | TerminalWaitFor::StableScreenContains(expected) => screen.contains(expected),
            TerminalWaitFor::StableScreenOmits(unexpected) => !screen.contains(unexpected),
        };
        if !matches {
            self.matching_text = None;
            return Ok(None);
        }
        match self.condition {
            TerminalWaitFor::OutputAfter(_) | TerminalWaitFor::ScreenContains(_) => {
                Ok(Some(screen))
            }
            TerminalWaitFor::StableScreenContains(_) | TerminalWaitFor::StableScreenOmits(_) => {
                let revision = capture.text_revision();
                match self.matching_text {
                    Some((observed, since)) if observed == revision => {
                        Ok((now.duration_since(since) >= SCREEN_QUIET_PERIOD).then_some(screen))
                    }
                    _ => {
                        // Revision, rather than text equality, catches A→B→A between polls.
                        self.matching_text = Some((revision, now));
                        Ok(None)
                    }
                }
            }
        }
    }
}

fn normalize_snapshot(mut screen: String, paths: &[String]) -> String {
    let mut full_paths = paths.iter().map(String::as_str).collect::<Vec<_>>();
    full_paths.sort_unstable_by_key(|path| std::cmp::Reverse(path.len()));
    for path in full_paths {
        screen = screen.replace(path, "<FIXTURE>");
    }
    let screen = screen
        .replace("macOS Seatbelt", "platform sandbox")
        .replace("Linux Bubblewrap", "platform sandbox")
        .lines()
        .map(|line| normalize_elapsed_time(&normalize_truncated_fixture_path(line, paths)))
        .collect::<Vec<_>>()
        .join("\n");
    normalize_assessment_ids(&normalize_session_thread_ids(&screen))
}

fn normalize_elapsed_time(line: &str) -> String {
    let Some(total) = line.find(" total · ") else {
        return line.into();
    };
    let Some(start) = line[..total].rfind(" · ").map(|start| start + " · ".len()) else {
        return line.into();
    };
    let Some((minutes, seconds)) = line[start..total].split_once("m ") else {
        return line.into();
    };
    let Some(seconds) = seconds.strip_suffix('s') else {
        return line.into();
    };
    if minutes.is_empty()
        || seconds.len() != 2
        || !minutes.bytes().all(|byte| byte.is_ascii_digit())
        || !seconds.bytes().all(|byte| byte.is_ascii_digit())
    {
        return line.into();
    }
    format!("{}0m 00s{}", &line[..start], &line[total..])
}

fn normalize_truncated_fixture_path(line: &str, paths: &[String]) -> String {
    const MINIMUM_PREFIX_BYTES: usize = 12;

    let mut matched = None;
    for path in paths {
        for (end, _) in path.char_indices().rev() {
            if end < MINIMUM_PREFIX_BYTES {
                break;
            }
            let prefix = &path[..end];
            if line.contains(prefix) {
                if matched.is_none_or(|current: &str| prefix.len() > current.len()) {
                    matched = Some(prefix);
                }
                break;
            }
        }
    }
    let Some(prefix) = matched else {
        return line.to_string();
    };
    let replacement = format!(
        "<FIXTURE…>{}",
        " ".repeat(
            prefix
                .chars()
                .count()
                .saturating_sub("<FIXTURE…>".chars().count())
        )
    );
    line.replacen(prefix, &replacement, 1)
}

fn normalize_session_thread_ids(screen: &str) -> String {
    const PREFIX: &str = "thread:session-";
    const REPLACEMENT: &str = "thread:session-<ID>";

    let mut normalized = String::with_capacity(screen.len());
    let mut remaining = screen;
    while let Some(start) = remaining.find(PREFIX) {
        normalized.push_str(&remaining[..start]);
        let candidate = &remaining[start + PREFIX.len()..];
        let length = candidate
            .bytes()
            .take_while(|byte| byte.is_ascii_digit() || *byte == b'-')
            .count();
        if length == 0 {
            normalized.push_str(PREFIX);
            remaining = candidate;
        } else {
            normalized.push_str(REPLACEMENT);
            remaining = &candidate[length..];
        }
    }
    normalized.push_str(remaining);
    normalized
}

fn normalize_assessment_ids(screen: &str) -> String {
    const PREFIX: &str = "assessment_id\":\"";
    const REPLACEMENT: &str = "<ID>";
    const ID_LENGTH: usize = 64;

    let mut normalized = String::with_capacity(screen.len());
    let mut remaining = screen;
    while let Some(start) = remaining.find(PREFIX) {
        let value_start = start + PREFIX.len();
        normalized.push_str(&remaining[..value_start]);
        let candidate = &remaining[value_start..];
        let mut digits = 0;
        let mut end = 0;
        for (index, byte) in candidate.bytes().enumerate() {
            if byte.is_ascii_hexdigit() {
                digits += 1;
            } else if byte != b'\n' {
                break;
            }
            end = index + 1;
            if digits == ID_LENGTH {
                break;
            }
        }
        if digits != ID_LENGTH {
            normalized.push_str(candidate);
            return normalized;
        }
        let mut wrote_replacement = false;
        let mut wrapped = false;
        for byte in candidate[..end].bytes() {
            if byte == b'\n' {
                normalized.push('\n');
                wrapped = true;
            } else if !wrote_replacement {
                normalized.push_str(REPLACEMENT);
                wrote_replacement = true;
            } else if wrapped {
                normalized.push(' ');
            } else {
                continue;
            }
        }
        remaining = &candidate[end..];
    }
    normalized.push_str(remaining);
    normalized
}

#[test]
fn cpp_runtime_environment_configures_only_the_child() {
    let directory = tempfile::tempdir().unwrap();
    let library = directory.path().join("libstdc++.so.6");
    fs::write(&library, b"runtime fixture").unwrap();
    let inherited = std::env::var_os("LD_LIBRARY_PATH");
    let (name, value) = cpp_runtime_environment(&library);
    let mut command = std::process::Command::new("unused-test-child");
    command.env(name, &value);
    assert_eq!(name, "LD_LIBRARY_PATH");
    assert_eq!(value, directory.path());
    assert_eq!(
        command.get_envs().collect::<Vec<_>>(),
        vec![(std::ffi::OsStr::new(name), Some(value.as_os_str()))]
    );
    assert_eq!(std::env::var_os("LD_LIBRARY_PATH"), inherited);
}

#[test]
#[should_panic(expected = "missing declared C++ runtime")]
fn cpp_runtime_environment_rejects_a_missing_runfile() {
    let directory = tempfile::tempdir().unwrap();
    cpp_runtime_environment(&directory.path().join("libstdc++.so.6"));
}

#[test]
fn snapshot_normalization_freezes_elapsed_status_without_changing_other_text() {
    let screen =
        "○ Waiting for approval · 0m 01s total · ctrl+c to interrupt\nresponse took 0m 01s";
    assert_eq!(
        normalize_snapshot(screen.into(), &[]),
        "○ Waiting for approval · 0m 00s total · ctrl+c to interrupt\nresponse took 0m 01s"
    );
}

#[test]
fn snapshot_normalization_replaces_fixture_paths_and_generated_thread_ids() {
    let truncated = "/private/var/folders/account/T/ash-fixt";
    let padding = " ".repeat(truncated.chars().count() - "<FIXTURE…>".chars().count());
    assert_eq!(
        normalize_snapshot(
            format!(
                "read /private/var/folders/account/T/ash-fixture/workspace\n{truncated}\nthread:session-42-9001\nthread:session-label\nassessment_id\":\"0123456789abcdef0123456789abcdef\n0123456789abcdef0123456789abcdef\""
            ),
            &["/private/var/folders/account/T/ash-fixture".into()],
        ),
        format!(
            "read <FIXTURE>/workspace\n<FIXTURE…>{padding}\nthread:session-<ID>\nthread:session-label\nassessment_id\":\"<ID>{}\n{}\"",
            "",
            " ".repeat(32),
        )
    );
}

#[test]
fn snapshot_normalization_prefers_the_longest_path_and_short_clipped_prefix() {
    let private = "/private/var/folders/account/T/ash-fixture";
    let visible = "/private/var/fold";
    let padding = " ".repeat(visible.chars().count() - "<FIXTURE…>".chars().count());
    assert_eq!(
        normalize_snapshot(
            format!("{private}/workspace\n{visible}…"),
            &["/var/folders/account/T/ash-fixture".into(), private.into(),],
        ),
        format!("<FIXTURE>/workspace\n<FIXTURE…>{padding}…")
    );
}

#[test]
fn terminal_revision_advances_after_raw_capture_reaches_its_limit() {
    let mut capture = TerminalCapture::new(PtySize {
        rows: 1,
        cols: 1,
        pixel_width: 0,
        pixel_height: 0,
    });
    capture.raw.resize(OUTPUT_LIMIT, b'x');
    capture.revision = 41;

    capture.push(b"y");

    assert_eq!(capture.raw.len(), OUTPUT_LIMIT);
    assert_eq!(capture.revision(), 42);
}

#[test]
fn terminal_text_revision_ignores_cursor_and_style_only_redraws() {
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"> Approve once\r\n/policy to change permissions");
    capture.push(b"\r\x1b[2K");
    let text_revision = capture.text_revision();
    let output_revision = capture.revision();
    for _ in 0..20 {
        capture.push(b"\x1b[?25l\x1b[2;1H\x1b[0m");
    }
    assert_eq!(capture.text_revision(), text_revision);
    assert_eq!(capture.revision(), output_revision + 20);
    assert!(capture.screen().contains("> Approve once"));
    assert!(!capture.screen().contains("/policy to change permissions"));
}

#[test]
fn terminal_text_revision_tracks_changes_even_when_the_text_returns() {
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"old");
    let screen = capture.screen();
    let revision = capture.text_revision();
    capture.push(b"\rnew");
    assert_eq!(capture.text_revision(), revision + 1);
    capture.push(b"\rold");
    assert_eq!(capture.screen(), screen);
    assert_eq!(capture.text_revision(), revision + 2);
}

#[test]
fn terminal_capture_answers_fragmented_cursor_queries() {
    let mut capture = TerminalCapture::new(LARGE_SIZE);
    capture.push(b"\x1b[");
    assert!(capture.core.take_reply_bytes().is_empty());
    capture.push(b"6n");
    assert_eq!(capture.core.take_reply_bytes(), b"\x1b[1;1R");
    capture.push(b"\x1b[4;9H\x1b[6n");
    assert_eq!(capture.core.take_reply_bytes(), b"\x1b[4;9R");
}

fn assert_named_snapshot(name: &str, screen: String) {
    let name = Path::new(name);
    let snapshot_name = name
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| panic!("snapshot name must end in valid UTF-8: {}", name.display()));
    let snapshot_file = match option_env!("ASH_BAZEL_ASH") {
        Some(_) => bazel_runfile(&format!(
            "{}/ash-cli/tests/snapshots/{}.snap",
            std::env::var("TEST_WORKSPACE").expect("Bazel test workspace"),
            name.display()
        )),
        None => PathBuf::from(option_env!("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"))
            .join("tests/snapshots")
            .join(name)
            .with_extension("snap"),
    };
    let snapshot_dir = snapshot_file.parent().expect("snapshot parent directory");

    let mut settings = insta::Settings::clone_current();
    settings.set_prepend_module_to_snapshot(false);
    settings.set_snapshot_path(snapshot_dir);
    settings.bind(|| insta::assert_snapshot!(snapshot_name, screen));
}

impl Drop for TuiProcess {
    fn drop(&mut self) {
        self.child.terminate();
        self.close_terminal();
    }
}

struct TerminalCapture {
    core: TerminalCore,
    raw: Vec<u8>,
    revision: u64,
    text_revision: u64,
    size: PtySize,
}

impl TerminalCapture {
    fn new(size: PtySize) -> Self {
        Self {
            core: TerminalCore::new(GridSize::new(size.rows, size.cols)),
            raw: Vec::new(),
            revision: 0,
            text_revision: 0,
            size,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let previous_screen = self.screen();
        self.revision += 1;
        let remaining = OUTPUT_LIMIT.saturating_sub(self.raw.len());
        self.raw
            .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        self.core.process_output(bytes);
        // Cursor/style-only redraws must not prevent a text snapshot from settling.
        if self.screen() != previous_screen {
            self.text_revision += 1;
        }
    }

    fn resize(&mut self, size: PtySize) {
        self.revision += 1;
        self.text_revision += 1;
        self.core.resize(GridSize::new(size.rows, size.cols));
        self.size = size;
    }

    fn screen(&self) -> String {
        self.core
            .grid()
            .lines()
            .iter()
            .map(|line| line.text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn raw_text(&self) -> String {
        String::from_utf8_lossy(&self.raw).into_owned()
    }

    fn revision(&self) -> u64 {
        self.revision
    }

    fn text_revision(&self) -> u64 {
        self.text_revision
    }
}

struct ChildGuard {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    running: bool,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl ChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self {
            child,
            running: true,
        }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.running = false;
        }
        Ok(status)
    }

    fn terminate(&mut self) {
        if self.running {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.running = false;
        }
    }
}
