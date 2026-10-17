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

#[tokio::test]
async fn transport_policy_controls_pruning_tags_and_auto_stash() {
    use super::GitTransportOptions;
    let origin = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("tracked.txt", "initial\n");
    producer.commit_all("Initial");
    producer.git(&["remote", "add", "origin", origin.root().to_str().unwrap()]);
    producer.git(&["push", "-u", "origin", "main"]);
    producer.git(&["branch", "temporary"]);
    producer.git(&["push", "origin", "temporary"]);
    let source = TestRepository::clone_from(origin.root());
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    producer.git(&["push", "origin", "--delete", "temporary"]);
    let mut options = GitTransportOptions {
        prune: false,
        ..GitTransportOptions::default()
    };
    client
        .fetch_with_options(&repository, None, true, options)
        .await
        .unwrap();
    assert!(
        source
            .git(&["for-each-ref", "refs/remotes/origin/temporary"])
            .contains("temporary")
    );
    options.prune = true;
    client
        .fetch_with_options(&repository, None, true, options)
        .await
        .unwrap();
    assert_eq!(
        source.git(&["for-each-ref", "refs/remotes/origin/temporary"]),
        ""
    );
    producer.write("remote.txt", "from origin\n");
    producer.commit_all("Remote update");
    producer.git(&["tag", "-a", "release", "-m", "Release"]);
    producer.git(&["push", "origin", "main", "--tags"]);
    source.write("tracked.txt", "local dirty buffer on disk\n");
    options.auto_stash = true;
    options.tag_policy = super::GitTagPolicy::Include;
    client
        .pull_with_options(&repository, super::GitPullMode::Rebase, options)
        .await
        .unwrap();
    assert_eq!(source.read("tracked.txt"), "local dirty buffer on disk\n");
    assert_eq!(source.read("remote.txt"), "from origin\n");
    producer.git(&["branch", "configured-prune"]);
    producer.git(&["push", "origin", "configured-prune"]);
    client
        .fetch_with_options(&repository, None, true, options)
        .await
        .unwrap();
    producer.git(&["push", "origin", "--delete", "configured-prune"]);
    source.git(&["config", "fetch.prune", "true"]);
    options.prune = false;
    client
        .fetch_with_options(&repository, None, true, options)
        .await
        .unwrap();
    assert_eq!(
        source.git(&["for-each-ref", "refs/remotes/origin/configured-prune"]),
        ""
    );
    assert!(
        source
            .git(&["tag", "--list", "release"])
            .contains("release")
    );
    source.git(&["tag", "-a", "local-release", "-m", "Local release"]);
    options.follow_tags = true;
    client
        .push_with_options(&repository, options)
        .await
        .unwrap();
    assert!(
        origin
            .git(&["tag", "--list", "local-release"])
            .contains("local-release")
    );
}

#[tokio::test]
async fn force_push_with_lease_rejects_unseen_remote_commits() {
    use super::GitPushMode;
    use super::GitTransportOptions;
    let origin = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("tracked.txt", "initial\n");
    producer.commit_all("Initial");
    producer.git(&["remote", "add", "origin", origin.root().to_str().unwrap()]);
    producer.git(&["push", "-u", "origin", "main"]);
    let source = TestRepository::clone_from(origin.root());
    producer.write("remote.txt", "unseen\n");
    producer.commit_all("Unseen remote commit");
    producer.git(&["push"]);
    let remote_head = origin.git(&["rev-parse", "main"]);
    source.write("local.txt", "divergent\n");
    source.commit_all("Local commit");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let mut options = GitTransportOptions {
        push_mode: GitPushMode::Lease,
        ..GitTransportOptions::default()
    };
    assert!(
        client
            .push_with_options(&repository, options)
            .await
            .is_err()
    );
    assert_eq!(origin.git(&["rev-parse", "main"]), remote_head);
    options.push_mode = GitPushMode::Force;
    client
        .push_with_options(&repository, options)
        .await
        .unwrap();
    assert_eq!(
        origin.git(&["rev-parse", "main"]),
        source.git(&["rev-parse", "HEAD"])
    );
}

#[tokio::test(flavor = "current_thread")]
async fn pull_replaces_only_conflicting_tags_when_requested() {
    let remote = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("base.txt", "base\n");
    producer.commit_all("base");
    producer.git(&["tag", "release"]);
    producer.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    producer.git(&["push", "-u", "origin", "main", "--tags"]);
    let source = TestRepository::clone_from(remote.root());
    source.git(&["tag", "local-only"]);
    let before = source.git(&["rev-parse", "HEAD"]);
    producer.write("update.txt", "upstream\n");
    producer.commit_all("update");
    producer.git(&["tag", "--force", "release"]);
    producer.git(&["push", "origin", "main", "--force", "--tags"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let mut options = super::GitTransportOptions {
        tag_policy: super::GitTagPolicy::Include,
        ..Default::default()
    };
    let error = client
        .pull_with_options(&repository, super::GitPullMode::Configured, options)
        .await
        .unwrap_err();
    assert!(matches!(error, crate::GitError::TagConflict { tags } if tags == ["release"]));
    assert_eq!(source.git(&["rev-parse", "HEAD"]), before);
    assert_eq!(source.git(&["rev-parse", "release"]), before);
    options.replace_tags = true;
    client
        .pull_with_options(&repository, super::GitPullMode::Configured, options)
        .await
        .unwrap();
    assert_eq!(source.read("update.txt"), "upstream\n");
    assert_eq!(
        source.git(&["rev-parse", "release"]),
        producer.git(&["rev-parse", "release"])
    );
    assert_eq!(source.git(&["rev-parse", "local-only"]), before);
}

#[tokio::test(flavor = "current_thread")]
async fn pull_warning_detects_patch_equivalence_without_reflog_history() {
    let remote = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("base.txt", "base\n");
    producer.commit_all("base");
    producer.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    producer.git(&["push", "-u", "origin", "main"]);
    let source = TestRepository::clone_from(remote.root());
    source.write("change.txt", "same patch\n");
    source.commit_all("local change");
    producer.write("change.txt", "same patch\n");
    producer.commit_all("upstream rebased change");
    producer.git(&["push", "origin", "main"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    assert!(
        !client
            .pull_upstream_was_rewritten(&repository)
            .await
            .unwrap()
    );
    client.fetch_default(&repository).await.unwrap();
    source.git(&["reflog", "expire", "--expire=all", "--all"]);
    assert!(
        client
            .pull_upstream_was_rewritten(&repository)
            .await
            .unwrap()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn reviewed_pull_accepts_a_local_tracking_branch() {
    let source = TestRepository::init();
    source.write("base.txt", "base\n");
    source.commit_all("base");
    source.git(&["branch", "upstream"]);
    source.git(&["branch", "--set-upstream-to=upstream", "main"]);
    let reviewed = super::GitUpstreamTarget {
        branch: "main".into(),
        object_id: source.git(&["rev-parse", "HEAD"]),
        upstream: "upstream".into(),
    };
    source.git(&["switch", "upstream"]);
    source.write("local.txt", "from local tracking branch\n");
    source.commit_all("upstream update");
    source.git(&["switch", "main"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .pull_reviewed(
            &repository,
            super::GitPullMode::Configured,
            &reviewed,
            Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(source.read("local.txt"), "from local tracking branch\n");
}

#[tokio::test(flavor = "current_thread")]
async fn reviewed_sync_uses_the_tracked_remote_and_branch_despite_push_defaults() {
    let remote = TestBareRepository::init();
    let decoy = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("base.txt", "base\n");
    producer.commit_all("base");
    producer.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    producer.git(&["push", "origin", "main", "main:refs/heads/release"]);
    let source = TestRepository::clone_from(remote.root());
    source.git(&["remote", "rename", "origin", "team/upstream"]);
    source.git(&["switch", "-c", "topic"]);
    source.git(&["branch", "--set-upstream-to=team/upstream/release"]);
    source.git(&["remote", "add", "decoy", decoy.root().to_str().unwrap()]);
    source.git(&["config", "remote.pushDefault", "decoy"]);
    source.git(&["config", "branch.topic.pushRemote", "decoy"]);
    source.git(&[
        "config",
        "remote.team/upstream.push",
        "HEAD:refs/heads/wrong",
    ]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let reviewed = super::GitUpstreamTarget {
        branch: "topic".into(),
        object_id: source.git(&["rev-parse", "HEAD"]),
        upstream: "team/upstream/release".into(),
    };
    producer.write("remote.txt", "upstream\n");
    producer.commit_all("upstream update");
    producer.git(&["push", "origin", "main:refs/heads/release"]);

    source.git(&["config", "branch.topic.merge", "refs/heads/main"]);
    assert!(
        client
            .pull_reviewed(
                &repository,
                super::GitPullMode::Configured,
                &reviewed,
                super::GitTransportOptions::default()
            )
            .await
            .is_err()
    );
    assert_eq!(source.git(&["rev-parse", "HEAD"]), reviewed.object_id);
    source.git(&["config", "branch.topic.merge", "refs/heads/release"]);
    client
        .pull_reviewed(
            &repository,
            super::GitPullMode::Configured,
            &reviewed,
            super::GitTransportOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(source.read("remote.txt"), "upstream\n");
    assert_eq!(
        source.git(&["rev-parse", "HEAD"]),
        producer.git(&["rev-parse", "HEAD"])
    );

    source.write("local.txt", "local\n");
    source.commit_all("local update");
    let target = super::GitUpstreamTarget {
        object_id: source.git(&["rev-parse", "HEAD"]),
        ..reviewed
    };
    client
        .push_reviewed(&repository, &target, super::GitTransportOptions::default())
        .await
        .unwrap();
    assert_eq!(
        remote.git(&["rev-parse", "refs/heads/release"]),
        target.object_id
    );
    assert_eq!(decoy.git(&["for-each-ref", "refs/heads"]), "");
    assert_eq!(remote.git(&["for-each-ref", "refs/heads/wrong"]), "");
}

#[tokio::test(flavor = "current_thread")]
async fn reviewed_push_binds_the_commit_and_tracking_branch() {
    let repository = TestRepository::init();
    let remote = TestBareRepository::init();
    repository.write("file.txt", "first");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "first"]);
    repository.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    repository.git(&["push", "--set-upstream", "origin", "HEAD:refs/heads/main"]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let status = client.snapshot(&opened).await.unwrap();
    let crate::GitHead::Branch {
        name,
        object_id,
        upstream: Some(upstream),
    } = status.head()
    else {
        panic!("tracking branch")
    };
    let reviewed = super::GitUpstreamTarget {
        branch: name.clone(),
        object_id: object_id.clone(),
        upstream: upstream.name().to_owned(),
    };
    client
        .push_reviewed(&opened, &reviewed, super::GitTransportOptions::default())
        .await
        .unwrap();
    repository.write("file.txt", "second");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "second"]);
    assert!(
        client
            .push_reviewed(&opened, &reviewed, super::GitTransportOptions::default())
            .await
            .is_err()
    );
    let current = client.snapshot(&opened).await.unwrap();
    let crate::GitHead::Branch { object_id, .. } = current.head() else {
        panic!("branch")
    };
    let current = super::GitUpstreamTarget {
        object_id: object_id.clone(),
        ..reviewed
    };
    repository.git(&[
        "config",
        &format!("branch.{}.merge", current.branch),
        "refs/heads/other",
    ]);
    assert!(
        client
            .push_reviewed(&opened, &current, super::GitTransportOptions::default())
            .await
            .is_err()
    );
    let actual = client
        .run_query(remote.root(), ["rev-parse", "refs/heads/main"])
        .await
        .unwrap()
        .require_success()
        .unwrap();
    assert_ne!(
        String::from_utf8_lossy(&actual.stdout).trim(),
        current.object_id
    );
}
