use super::GitClient;
use super::GitExecutionLimits;
use super::GitInvocation;
use crate::GitError;
use crate::client::FsmonitorOverride;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;
use std::time::Duration;

const FIXTURE: &str = "client::tests::process::child_fixture";

#[cfg(windows)]
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
    #[cfg(windows)]
    std::fs::hard_link(
        std::env::current_exe().unwrap(),
        root.join("git-job-fixture.exe"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = root.join("git-job-fixture");
        // A shell child avoids loading the entire test binary while unrelated Git tests run.
        // Both modes leave a real descendant holding the captured pipes.
        std::fs::write(&executable, "#!/bin/sh\n(printf ready > \"$ASH_GIT_TEST_ROOT/ready\"; sleep 3; printf survived > \"$ASH_GIT_TEST_ROOT/survived\") &\nif [ \"$ASH_GIT_TEST_MODE\" = parent ]; then wait; fi\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
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

#[tokio::test(start_paused = true)]
async fn deadline_covers_pipes_held_after_git_exits() {
    let executable = std::env::current_exe().unwrap();
    let directory = tempfile::tempdir_in(executable.parent().unwrap()).unwrap();
    let mut client = GitClient::system();
    client.limits =
        GitExecutionLimits::new(Duration::from_millis(900), Duration::from_secs(5), 4096).unwrap();
    let invocation = invocation(directory.path(), "orphan");
    let task = tokio::spawn(async move { client.run(invocation).await });
    // The deadline must exercise inherited pipes, rather than a child that has not been
    // scheduled yet. Keep the timer frozen and the runtime runnable until the real child starts.
    let startup_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !directory.path().join("ready").exists() {
        assert!(std::time::Instant::now() < startup_deadline);
        assert!(
            !task.is_finished(),
            "Git finished before its descendant started"
        );
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(900)).await;
    // Killing and reaping the OS process need real scheduling after the deadline fires.
    tokio::time::resume();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(result, Err(GitError::TimedOut { .. })),
        "Git output collection must reach its deadline"
    );
    assert_descendant_stopped(directory.path()).await;
}

#[tokio::test]
async fn cancelling_git_work_kills_its_running_descendants() {
    let executable = std::env::current_exe().unwrap();
    let directory = tempfile::tempdir_in(executable.parent().unwrap()).unwrap();
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
    let executable = std::env::current_exe().unwrap();
    let directory = tempfile::tempdir_in(executable.parent().unwrap()).unwrap();
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
