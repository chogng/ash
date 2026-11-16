use super::JobObject;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::IntoRawHandle;
use std::os::windows::io::OwnedHandle;
use std::sync::Mutex;
use tokio::process::Command;

fn child_command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "job::tests::child_fixture", "--nocapture"]);
    command
}

#[test]
fn child_fixture() {
    if let Some(marker) = std::env::var_os("ASH_JOB_TEST_MARKER") {
        std::fs::write(marker, "executed").unwrap();
    }
}

#[test]
fn current_job_reports_explicit_breakaway_permission() {
    const EXPECTED: &str = "ASH_TEST_JOB_BREAKAWAY_PERMISSION";
    if let Ok(expected) = std::env::var(EXPECTED) {
        assert_eq!(
            JobObject::current_allows_breakaway().unwrap(),
            expected == "allowed"
        );
        return;
    }
    for allowed in [false, true] {
        use winapi::um::winnt::JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        use winapi::um::winnt::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let job = JobObject::create().unwrap();
        JobObject::set_limit_flags(
            &job.handle,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | if allowed {
                    JOB_OBJECT_LIMIT_BREAKAWAY_OK
                } else {
                    0
                },
        )
        .unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "job::tests::current_job_reports_explicit_breakaway_permission",
                "--nocapture",
            ])
            .env(EXPECTED, if allowed { "allowed" } else { "restricted" });
        let mut child = job.spawn_contained_std(&mut command).unwrap();
        assert!(child.wait().unwrap().success());
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
