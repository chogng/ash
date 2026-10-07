use super::JobObject;
use filedescriptor::OwnedHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::IntoRawHandle;
use std::sync::Mutex;
use tokio::process::Command;

fn child_command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "win::job::tests::child_fixture", "--nocapture"]);
    command
}

#[test]
fn child_fixture() {
    if let Some(marker) = std::env::var_os("ASH_JOB_TEST_MARKER") {
        std::fs::write(marker, "executed").unwrap();
    }
}

#[tokio::test]
async fn failed_assignment_does_not_execute_child_code() {
    let marker = std::env::temp_dir().join(format!("ash-job-rejected-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
    // A file is a valid owned kernel handle, but AssignProcessToJobObject must reject its type.
    let job = JobObject {
        handle: unsafe { OwnedHandle::from_raw_handle(file.into_raw_handle()) },
        preserve_descendants: Mutex::new(false),
    };
    let mut command = child_command();
    command.env("ASH_JOB_TEST_MARKER", &marker);
    assert!(job.spawn_contained(&mut command).is_err());
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(!marker.exists(), "unassigned child must never execute");
}

#[tokio::test]
async fn assigned_child_runs_and_released_jobs_reject_new_children() {
    let job = JobObject::create().unwrap();
    let mut child = job.spawn_contained(&mut child_command()).unwrap();
    assert!(child.wait().await.unwrap().success());
    job.preserve_descendants().unwrap();
    assert!(job.spawn_contained(&mut child_command()).is_err());
}

#[tokio::test]
async fn missing_executable_returns_creation_error() {
    let job = JobObject::create().unwrap();
    let mut command = Command::new("ash-no-such-job-test-executable.exe");
    assert_eq!(
        job.spawn_contained(&mut command).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
}
