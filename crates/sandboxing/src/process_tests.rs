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

#[test]
fn session_child() {
    let Some(directory) = std::env::var_os("ASH_TEST_SESSION_CHILD") else {
        return;
    };
    ash_utils_pty::process_group::set_process_group().unwrap();
    let directory = std::path::PathBuf::from(directory);
    std::fs::write(directory.join("ready"), "").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    std::fs::write(directory.join("escaped"), "").unwrap();
}

#[test]
fn dropping_a_session_terminates_children_in_their_own_process_groups() {
    let temp = tempfile::tempdir().unwrap();
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        "\"$ASH_TEST_EXE\" --exact process::tests::session_child --nocapture & wait",
    ]);
    command.env("ASH_TEST_EXE", std::env::current_exe().unwrap());
    command.env("ASH_TEST_SESSION_CHILD", temp.path());
    let process = ProcessHandle::spawn_command(command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !temp.path().join("ready").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(process);
    std::thread::sleep(Duration::from_millis(800));
    assert!(!temp.path().join("escaped").exists());
}
