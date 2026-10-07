use super::GitRemote;
use crate::GitClient;
use crate::test_support::TestBareRepository;
use crate::test_support::TestRepository;
use pretty_assertions::assert_eq;
#[tokio::test(flavor = "current_thread")]
async fn lists_remote_fetch_and_push_urls() {
    let repository = TestRepository::init();
    repository.git(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/repo.git",
    ]);
    repository.git(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "ssh://git@example.invalid/repo.git",
    ]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let remotes = client.remotes(&opened).await.expect("list remotes");

    assert_eq!(
        remotes,
        vec![GitRemote {
            name: "origin".to_string(),
            fetch_urls: vec!["https://example.invalid/repo.git".to_string()],
            push_urls: vec!["ssh://git@example.invalid/repo.git".to_string()],
        }]
    );
}

#[test]
fn projects_github_identity_without_credentials() {
    let remote = GitRemote {
        name: "origin".to_string(),
        fetch_urls: vec!["https://token@example.com/ignored/repo.git".to_string()],
        push_urls: vec!["git@github.com:chogng/ash.git".to_string()],
    };

    let identity = remote.identity().expect("remote identity");
    assert_eq!(identity.host(), "example.com");
    assert_eq!(identity.owner(), "ignored");
    assert_eq!(identity.repository(), "repo");
    assert_eq!(identity.provider(), super::GitRemoteProvider::Other);

    let github = GitRemote {
        name: "origin".to_string(),
        fetch_urls: vec!["ssh://git@github.com:22/chogng/ash.git?transport=ssh".to_string()],
        push_urls: Vec::new(),
    };
    let identity = github.identity().expect("GitHub identity");
    assert_eq!(identity.host(), "github.com");
    assert_eq!(identity.owner(), "chogng");
    assert_eq!(identity.repository(), "ash");
    assert_eq!(identity.provider(), super::GitRemoteProvider::Github);
}

#[tokio::test]
async fn named_fetch_updates_only_the_selected_remote_and_keeps_local_changes() {
    let origin = TestBareRepository::init();
    let backup = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("file.txt", "initial\n");
    producer.commit_all("Initial");
    producer.git(&["remote", "add", "origin", origin.root().to_str().unwrap()]);
    producer.git(&["remote", "add", "backup", backup.root().to_str().unwrap()]);
    producer.git(&["push", "origin", "main"]);
    producer.git(&["push", "backup", "main"]);
    let source = TestRepository::clone_from(origin.root());
    source.git(&["remote", "add", "backup", backup.root().to_str().unwrap()]);
    source.git(&["fetch", "--all"]);
    let initial = source.git(&["rev-parse", "HEAD"]);
    source.write("file.txt", "staged\n");
    source.git(&["add", "file.txt"]);
    source.write("file.txt", "unstaged\n");
    source.write("untracked.txt", "keep me\n");
    let index = source.git(&["ls-files", "--stage"]);
    let status = source.git(&["status", "--porcelain=v1"]);
    producer.write("remote.txt", "origin update\n");
    producer.commit_all("Origin update");
    producer.git(&["push", "origin", "main"]);
    let origin_head = producer.git(&["rev-parse", "HEAD"]);
    producer.write("remote.txt", "backup update\n");
    producer.commit_all("Backup update");
    producer.git(&["push", "backup", "main"]);
    let backup_head = producer.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client.fetch_remote(&repository, "backup").await.unwrap();
    assert_eq!(
        source.git(&["rev-parse", "refs/remotes/backup/main"]),
        backup_head
    );
    assert_eq!(
        source.git(&["rev-parse", "refs/remotes/origin/main"]),
        initial
    );
    assert_eq!(source.git(&["rev-parse", "HEAD"]), initial);
    assert_eq!(source.git(&["ls-files", "--stage"]), index);
    assert_eq!(source.git(&["status", "--porcelain=v1"]), status);
    assert_eq!(source.read("file.txt"), "unstaged\n");
    assert_eq!(source.read("untracked.txt"), "keep me\n");

    for name in ["", "--all", "missing", origin.root().to_str().unwrap()] {
        assert!(
            client.fetch_remote(&repository, name).await.is_err(),
            "{name}"
        );
    }
    source.git(&["remote", "remove", "backup"]);
    assert!(client.fetch_remote(&repository, "backup").await.is_err());
    assert_eq!(
        source.git(&["rev-parse", "refs/remotes/origin/main"]),
        initial
    );
    client.fetch_remote(&repository, "origin").await.unwrap();
    assert_eq!(
        source.git(&["rev-parse", "refs/remotes/origin/main"]),
        origin_head
    );
}
