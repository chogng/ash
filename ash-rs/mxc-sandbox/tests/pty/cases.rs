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
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

const TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn trials() -> Vec<Trial> {
    vec![
        Trial::test("terminal_input_resize_environment_and_exit_code", || {
            let mut terminal = Terminal::start(
                "test -t 0 && test -t 1 || exit 80; printf 'ready:%s\\n' \"$PTY_TEST_VALUE\"; read answer; stty size; printf 'answer=%s\\n' \"$answer\"; exit 23",
            );
            terminal.read_until("ready:workload");
            terminal
                .process
                .resize(TerminalSize {
                    rows: 40,
                    cols: 100,
                })
                .unwrap();
            terminal.input.write_all(b"hello\n").unwrap();
            terminal.read_until("answer=hello");
            assert!(terminal.text.contains("40 100"), "{}", terminal.text);
            assert_eq!(terminal.wait(), SandboxProcessExitStatus::Code(23));
            terminal.assert_output_closed();
            Ok(())
        }),
        Trial::test("terminal_preserves_read_only_policy", || {
            let mut terminal = Terminal::start(
                "test -t 0 || exit 80; printf 'terminal-ready\\n'; printf forbidden > denied",
            );
            terminal.read_until("terminal-ready");
            assert_ne!(terminal.wait(), SandboxProcessExitStatus::Code(0));
            terminal.assert_output_closed();
            assert!(
                terminal.text.contains("permitted") || terminal.text.contains("denied"),
                "{}",
                terminal.text
            );
            assert!(!terminal.root.path().join("denied").exists());
            Ok(())
        }),
        Trial::test("closing_terminal_reaps_the_workload", || {
            let mut terminal = Terminal::start("printf 'pid=%s\\n' \"$$\"; exec sleep 60");
            terminal.read_until("\n");
            let pid = workload_pid(&terminal.text);
            terminal.process.close().unwrap();
            terminal.wait();
            terminal.assert_output_closed();
            assert_stopped(pid);
            Ok(())
        }),
        Trial::test("interrupt_reaches_the_terminal_workload", || {
            let mut terminal = Terminal::start("printf 'pid=%s\\n' \"$$\"; exec sleep 60");
            terminal.read_until("\n");
            let pid = workload_pid(&terminal.text);
            terminal.process.interrupt().unwrap();
            assert_ne!(terminal.wait(), SandboxProcessExitStatus::Code(0));
            terminal.assert_output_closed();
            assert_stopped(pid);
            Ok(())
        }),
        Trial::test("dropping_terminal_reaps_the_workload", || {
            let mut terminal = Terminal::start("printf 'pid=%s\\n' \"$$\"; exec sleep 60");
            terminal.read_until("\n");
            let pid = workload_pid(&terminal.text);
            drop(terminal);
            assert_stopped(pid);
            Ok(())
        }),
    ]
}

struct Terminal {
    // Close the process before deleting its working directory, including on assertion failure.
    process: ProcessHandle,
    input: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    reader: Option<std::thread::JoinHandle<()>>,
    text: String,
    root: tempfile::TempDir,
}

impl Terminal {
    fn start(script: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(root.path()).unwrap();
        let backend = MxcSandbox::new(InstallContext::current())
            .with_pty_helper(super::helper().executable().to_owned());
        let command = SandboxCommand::new("/bin/sh", ["-c", script], dir.canonical_path())
            .with_pty(TerminalSize { rows: 24, cols: 80 });
        let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
        let mut process = backend
            .prepare(&command, policy, &dir)
            .unwrap()
            .spawn(&[("PTY_TEST_VALUE".into(), "workload".into())])
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
            root,
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

fn workload_pid(output: &str) -> u32 {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("pid="))
        .unwrap_or_else(|| panic!("missing workload PID: {output}"))
        .parse()
        .unwrap()
}

fn assert_stopped(pid: u32) {
    let deadline = Instant::now() + TIMEOUT;
    while Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
    {
        assert!(
            Instant::now() < deadline,
            "PTY workload {pid} survived cleanup"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
