use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_utils_pty::TerminalSize;
use libtest_mimic::Trial;
use mxc_sandbox::MxcSandbox;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

const TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn trials() -> Vec<Trial> {
    vec![
        Trial::test("helper_requires_a_launch_request", || {
            let output = super::helper().command().env_clear()
                .env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
                .output().unwrap();
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(String::from_utf8(output.stderr).unwrap().contains("missing PTY launch request"));
            Ok(())
        }),
        Trial::test("psec_terminal_input_resize_large_environment_and_exit_code", || {
            let value = "🧊中文=".repeat(3000);
            let mut terminal = Terminal::start(
                tempfile::tempdir().unwrap(),
                FileSystemAccess::ReadOnly,
                &format!(
                    "$ErrorActionPreference='Stop'; \
                     if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {{ exit 80 }}; \
                     if ($env:VALUE_A.Length -ne {length} -or $env:VALUE_B -ne $env:VALUE_A) {{ exit 81 }}; \
                     if (-not $env:VALUE_A.EndsWith('🧊中文=')) {{ exit 82 }}; \
                     if (@([Environment]::GetEnvironmentVariables().Keys | Where-Object {{ $_ -like 'ASH_MXC_PTY_LAUNCH_*' }}).Count -ne 0) {{ exit 83 }}; \
                     [Console]::WriteLine('terminal-ready'); $answer=[Console]::ReadLine(); \
                     [Console]::WriteLine(('size={{0}}x{{1}}' -f [Console]::WindowWidth,[Console]::WindowHeight)); \
                     [Console]::WriteLine(('answer='+$answer)); exit 125",
                    length = value.encode_utf16().count(),
                ),
                vec![("VALUE_A".into(), value.clone()), ("VALUE_B".into(), value)],
            );
            terminal.read_until("terminal-ready");
            terminal.process.resize(TerminalSize { rows: 40, cols: 100 }).unwrap();
            terminal.input.write_all(b"hello\r").unwrap();
            terminal.read_until("answer=hello");
            assert_eq!(terminal.wait(), SandboxProcessExitStatus::Code(125));
            terminal.assert_output_closed();
            assert!(terminal.text.contains("size=100x40"), "{}", terminal.text);
            Ok(())
        }).with_ignored_flag(true),
        Trial::test("psec_terminal_keeps_read_only_files_unchanged", || {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("protected.txt");
            std::fs::write(&file, "original").unwrap();
            let mut terminal = Terminal::start(
                root,
                FileSystemAccess::ReadOnly,
                "$ErrorActionPreference='Stop'; [Console]::WriteLine('policy-ready'); \
                 [void][Console]::ReadLine(); \
                 try { [IO.File]::WriteAllText('protected.txt','modified'); exit 81 } \
                 catch { [Console]::WriteLine('write-denied') }; exit 0",
                Vec::new(),
            );
            terminal.read_until("policy-ready");
            terminal.input.write_all(b"continue\r").unwrap();
            terminal.read_until("write-denied");
            assert_eq!(terminal.wait(), SandboxProcessExitStatus::Code(0));
            terminal.assert_output_closed();
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
            Ok(())
        }).with_ignored_flag(true),
        Trial::test("psec_terminal_close_reaps_workload_and_descendants", || {
            let program = powershell().to_str().unwrap().replace('\'', "''");
            let mut terminal = Terminal::start(
                tempfile::tempdir().unwrap(),
                FileSystemAccess::ReadOnly,
                &format!(
                    "$ErrorActionPreference='Stop'; \
                     $child=Start-Process -FilePath '{program}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -NoNewWindow -PassThru; \
                     [Console]::WriteLine(('workload-pid='+$PID)); \
                     [Console]::WriteLine(('descendant-pid='+$child.Id)); \
                     [Console]::WriteLine('cleanup-ready'); Start-Sleep -Seconds 60"
                ),
                Vec::new(),
            );
            terminal.read_until("cleanup-ready");
            let workload = pid(&terminal.text, "workload-pid=");
            let descendant = pid(&terminal.text, "descendant-pid=");
            terminal.process.close().unwrap();
            terminal.wait();
            terminal.assert_output_closed();
            assert_stopped(workload);
            assert_stopped(descendant);
            Ok(())
        }).with_ignored_flag(true),
    ]
}

fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

struct Terminal {
    // The process owns the helper and workload jobs until teardown, including on assertion failure.
    process: ProcessHandle,
    input: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    reader: Option<std::thread::JoinHandle<()>>,
    text: String,
    _root: tempfile::TempDir,
}

impl Terminal {
    fn start(
        root: tempfile::TempDir,
        files: FileSystemAccess,
        script: &str,
        mut environment: Vec<(String, String)>,
    ) -> Self {
        let dir = Dir::open_local(root.path()).unwrap();
        let command = SandboxCommand::new(
            powershell(),
            ["-NoLogo", "-NoProfile", "-Command", script],
            dir.canonical_path(),
        )
        .with_pty(TerminalSize { rows: 24, cols: 80 });
        for key in ["SystemRoot", "LOCALAPPDATA", "TEMP", "TMP"] {
            environment.push((key.into(), std::env::var(key).unwrap()));
        }
        for key in ["PSModulePath", "PROGRAMFILES", "USERPROFILE"] {
            if let Ok(value) = std::env::var(key) {
                environment.push((key.into(), value));
            }
        }
        let mut process = MxcSandbox::new(InstallContext::current())
            .with_pty_helper(super::helper().executable().to_owned())
            .prepare(
                &command,
                SandboxPolicy::new(files, NetworkAccess::Denied),
                &dir,
            )
            .unwrap()
            .spawn(&environment)
            .unwrap();
        let input = process.take_stdin().unwrap();
        let mut stream = process.take_stdout().unwrap();
        let (sender, output) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            loop {
                let size = stream.read(&mut buffer).unwrap();
                if size == 0 || sender.send(buffer[..size].to_vec()).is_err() {
                    break;
                }
            }
        });
        Self {
            process,
            input,
            output,
            reader: Some(reader),
            text: String::new(),
            _root: root,
        }
    }

    fn read_until(&mut self, marker: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.text.contains(marker) {
            let bytes = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!("missing {marker:?}: {error}; output: {}", self.text)
                });
            self.text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }

    fn wait(&mut self) -> SandboxProcessExitStatus {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.process.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "PTY process did not exit: {}",
                self.text
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_output_closed(&mut self) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(bytes) => self.text.push_str(&String::from_utf8_lossy(&bytes)),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("PTY output remained open: {}", self.text)
                }
            }
        }
        self.reader.take().unwrap().join().unwrap();
    }
}

fn pid(output: &str, prefix: &str) -> u32 {
    // ConPTY can prepend cursor and color controls to an otherwise plain output line.
    output
        .split_once(prefix)
        .map(|(_, value)| {
            value
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .unwrap_or_else(|| panic!("missing {prefix}: {output}"))
        .parse()
        .unwrap()
}

fn assert_stopped(pid: u32) {
    let output = Command::new(powershell())
        .args(["-NoProfile", "-Command", &format!(
            "$ErrorActionPreference='Stop'; $p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
             if ($null -eq $p) {{ exit 0 }}; if ($p.WaitForExit(30000)) {{ exit 0 }}; exit 1"
        )])
        .output().unwrap();
    assert!(
        output.status.success(),
        "PTY process {pid} survived cleanup: {output:?}"
    );
}
