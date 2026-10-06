use super::GitRemote;
use crate::GitClient;
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
