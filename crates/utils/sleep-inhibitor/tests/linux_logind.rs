#![cfg(target_os = "linux")]

use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use ash_utils_sleep_inhibitor::SleepInhibitor;

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Manager {
    descriptors: mpsc::Sender<UnixStream>,
    deny_first: AtomicBool,
}

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Manager {
    fn inhibit(
        &self,
        what: &str,
        who: &str,
        why: &str,
        mode: &str,
    ) -> zbus::fdo::Result<zbus::OwnedFd> {
        assert_eq!(
            (what, who, why, mode),
            ("idle", "Ash", "fixture operation", "block")
        );
        if self.deny_first.swap(false, Ordering::SeqCst) {
            return Err(zbus::fdo::Error::AccessDenied("fixture denial".into()));
        }
        let (reader, writer) = UnixStream::pair().unwrap();
        self.descriptors.send(reader).unwrap();
        Ok(std::os::fd::OwnedFd::from(writer).into())
    }
}

#[test]
fn logind_descriptor_lives_until_the_last_lease() {
    // A private bus and logind fixture exercise the production system-bus client and
    // UNIX_FD transfer without changing the host's power policy or environment.
    let mut bus = Process(
        Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("install dbus-daemon to run the Linux logind integration test"),
    );
    let mut address = String::new();
    BufReader::new(bus.0.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    let (sender, receiver) = mpsc::channel();
    let _service = zbus::block_on(
        zbus::connection::Builder::address(address.trim())
            .name("org.freedesktop.login1")
            .serve_at(
                "/org/freedesktop/login1",
                Manager {
                    descriptors: sender,
                    deny_first: AtomicBool::new(true),
                },
            )
            .build(),
    )
    .unwrap();

    let mut worker = Process(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "logind_worker", "--nocapture"])
            .env("DBUS_SYSTEM_BUS_ADDRESS", address.trim())
            .env("ASH_LOGIND_TEST_WORKER", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let output = BufReader::new(worker.0.stdout.take().unwrap());
    let (progress_sender, progress) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in output.lines() {
            if progress_sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut input = worker.0.stdin.take().unwrap();
    let mut descriptor = None;
    for step in [
        "denied",
        "acquired",
        "shared",
        "first-released",
        "controller-released",
        "last-released",
    ] {
        loop {
            let line = progress
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|error| panic!("worker failed before {step}: {error}"));
            if line.trim() == step {
                break;
            }
        }
        if step == "denied" {
            assert!(matches!(
                receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            writeln!(input, "continue").unwrap();
            input.flush().unwrap();
            continue;
        }
        if step == "acquired" {
            descriptor = Some(receiver.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        let descriptor = descriptor.as_mut().unwrap();
        descriptor
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let result = descriptor.read(&mut [0]);
        if step == "last-released" {
            assert_eq!(
                result.unwrap(),
                0,
                "last lease must close logind's descriptor"
            );
        } else {
            assert!(
                matches!(result, Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
            );
        }
        assert!(
            matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "overlapping leases must share one Inhibit call"
        );
        writeln!(input, "continue").unwrap();
        input.flush().unwrap();
    }
    assert!(worker.0.wait().unwrap().success());
    reader.join().unwrap();
}

#[test]
#[ignore = "child process for the isolated logind integration test"]
fn logind_worker() {
    if std::env::var_os("ASH_LOGIND_TEST_WORKER").is_none() {
        return;
    }
    let step = |name| {
        println!("{name}");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    };
    let inhibitor = SleepInhibitor::new("fixture operation");
    assert!(inhibitor.acquire().is_err());
    step("denied");
    let first = inhibitor.acquire().unwrap();
    step("acquired");
    let last = inhibitor.acquire().unwrap();
    step("shared");
    drop(first);
    step("first-released");
    drop(inhibitor);
    step("controller-released");
    drop(last);
    step("last-released");
}
