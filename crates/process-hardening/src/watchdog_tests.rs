use super::ProcessWatchdog;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::TcpListener;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

struct Child(std::process::Child);

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn watchdog_child() {
    let Ok(mode) = std::env::var("ASH_TEST_WATCHDOG_MODE") else {
        return;
    };
    let watchdog = ProcessWatchdog::start(Duration::from_millis(200)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("ASH_WATCHDOG_LISTENER={}", listener.local_addr().unwrap());
    std::io::stdout().flush().unwrap();
    if mode == "healthy" {
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            watchdog.tick();
            thread::sleep(Duration::from_millis(10));
        }
    } else {
        loop {
            thread::park();
        }
    }
}

#[test]
fn a_stalled_owner_exits_and_releases_its_port_while_a_progressing_owner_survives() {
    for mode in ["healthy", "stalled"] {
        let mut child = Child(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "watchdog::tests::watchdog_child", "--nocapture"])
                .env("ASH_TEST_WATCHDOG_MODE", mode)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if let Some(value) = line.strip_prefix("ASH_WATCHDOG_LISTENER=") {
                    let _ = sender.send(value.to_owned());
                }
            }
        });
        let address = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.0.kill();
                let _ = child.0.wait();
                panic!("watchdog fixture did not exit: {mode}");
            }
            thread::sleep(Duration::from_millis(10));
        };
        reader.join().unwrap();
        assert_eq!(status.success(), mode == "healthy", "{status}");
        assert!(TcpListener::bind(address).is_ok());
    }
}
