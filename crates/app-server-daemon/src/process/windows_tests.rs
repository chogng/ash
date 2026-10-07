use super::start_identity;
use super::terminate;
use std::process::Child;
use std::process::Command;
use std::thread;
use std::time::Duration;

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn waiting_child() {
    if std::env::var_os("ASH_PID_TEST_CHILD").is_some() {
        thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn a_mismatched_creation_time_cannot_terminate_a_live_process() {
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process::windows::tests::waiting_child"])
            .env("ASH_PID_TEST_CHILD", "1")
            .spawn()
            .unwrap(),
    );
    let pid = child.0.id();
    let created = start_identity(pid).unwrap().unwrap();
    assert!(terminate(pid, "different-creation-time").is_err());
    assert!(child.0.try_wait().unwrap().is_none());
    terminate(pid, &created).unwrap();
    assert!(child.0.wait().unwrap().code().is_some());
    assert!(start_identity(pid).unwrap().is_none());
}
