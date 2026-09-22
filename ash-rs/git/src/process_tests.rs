use super::GitClient;
use super::GitExecutionLimits;
use super::GitInvocation;
use crate::GitError;
use crate::client::FsmonitorOverride;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const FIXTURE: &str = "client::tests::process::child_fixture";

#[test]
fn child_fixture() {
    let Ok(mode) = std::env::var("ASH_GIT_TEST_MODE") else {
        return;
    };
    let root = std::path::PathBuf::from(std::env::var_os("ASH_GIT_TEST_ROOT").unwrap());
    if mode == "child" {
        std::fs::write(root.join("ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(3));
        std::fs::write(root.join("survived"), b"survived").unwrap();
        return;
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FIXTURE, "--nocapture"])
        .env("ASH_GIT_TEST_MODE", "child")
        .spawn()
        .unwrap();
    if mode == "parent" {
        child.wait().unwrap();
    }
    // In orphan mode the test exits while its child retains the stdout/stderr pipes.
}

fn invocation(root: &Path, mode: &str) -> GitInvocation {
    std::fs::hard_link(
        std::env::current_exe().unwrap(),
        root.join("git-job-fixture.exe"),
    )
    .unwrap();
    let mut exec_path = OsString::from("--exec-path=");
    exec_path.push(root);
    GitInvocation::query(
        root,
        [
            exec_path,
            "job-fixture".into(),
            "--exact".into(),
            FIXTURE.into(),
            "--nocapture".into(),
        ],
        FsmonitorOverride::Disabled,
    )
    .with_environment("ASH_GIT_TEST_ROOT", root.as_os_str())
    .with_environment("ASH_GIT_TEST_MODE", OsStr::new(mode))
}

async fn assert_descendant_stopped(root: &Path) {
    assert!(
        root.join("ready").exists(),
        "fixture child must actually have started"
    );
    tokio::time::sleep(Duration::from_millis(3300)).await;
    assert!(
        !root.join("survived").exists(),
        "Git descendant survived cleanup"
    );
}

#[tokio::test]
async fn deadline_covers_pipes_held_after_git_exits() {
    let directory = tempfile::tempdir().unwrap();
    let mut client = GitClient::system();
    client.limits =
        GitExecutionLimits::new(Duration::from_millis(900), Duration::from_secs(5), 4096).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        client.run(invocation(directory.path(), "orphan")),
    )
    .await
    .unwrap();
    assert!(
        matches!(result, Err(GitError::TimedOut { .. })),
        "Git output collection must reach its deadline"
    );
    assert_descendant_stopped(directory.path()).await;
}

#[tokio::test]
async fn cancelling_git_work_kills_its_running_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let invocation = invocation(directory.path(), "parent");
    let task = tokio::spawn(async move { GitClient::system().run(invocation).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.path().join("ready").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.err().expect("cancelled task").is_cancelled());
    assert_descendant_stopped(directory.path()).await;
}

#[tokio::test]
async fn cancelling_last_discovery_waiter_kills_its_running_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let invocation = invocation(directory.path(), "parent");
    let client = GitClient::system();
    let key = crate::discovery::Key {
        cwd: directory.path().to_path_buf(),
        executable: client.executable().unwrap(),
        search_path: None,
        limits: client.limits(),
    };
    let query =
        crate::discovery::coordinator().query(key, async move { client.run(invocation).await });
    let survivor = query.clone();
    let task = tokio::spawn(query);
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.path().join("ready").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(survivor);
    assert_descendant_stopped(directory.path()).await;
}
