use super::*;
use std::time::Duration;
use std::time::Instant;

#[test]
fn dropping_an_execution_terminates_its_descendants() {
    let temp = tempfile::tempdir().unwrap();
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "(sleep 0.3; touch escaped) & touch ready; wait"]);
    command.current_dir(temp.path());
    let process = ProcessHandle::spawn_command(command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !temp.path().join("ready").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(process);
    std::thread::sleep(Duration::from_millis(400));
    assert!(!temp.path().join("escaped").exists());
}
