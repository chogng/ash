use crate::GitClient;
use crate::test_support::TestBareRepository;
use crate::test_support::TestRepository;

#[tokio::test]
async fn creating_a_local_branch_keeps_the_current_checkout() {
    let repository = TestRepository::init();
    repository.write("tracked", "base");
    repository.commit_all("base");
    let git = GitClient::system();
    let opened = git.open_repository(repository.root()).await.unwrap();
    git.create_branch(&opened, "ash/topic").await.unwrap();
    assert!(
        git.local_branches(&opened)
            .await
            .unwrap()
            .iter()
            .any(|branch| branch.name() == "ash/topic" && !branch.is_current())
    );
    assert!(
        git.local_branches(&opened)
            .await
            .unwrap()
            .iter()
            .any(|branch| branch.name() == "main" && branch.is_current())
    );
    assert!(git.create_branch(&opened, "ash/topic").await.is_err());
    assert!(git.create_branch(&opened, "../escape").await.is_err());
}

#[tokio::test]
async fn deleting_a_branch_requires_merge_and_no_checkout() {
    let repository = TestRepository::init();
    repository.write("tracked", "base");
    repository.commit_all("base");
    let git = GitClient::system();
    let opened = git.open_repository(repository.root()).await.unwrap();

    git.create_branch(&opened, "merged").await.unwrap();
    git.delete_merged_branch(&opened, "merged").await.unwrap();
    assert!(git.delete_merged_branch(&opened, "main").await.is_err());

    repository.git(&["switch", "-c", "unmerged"]);
    repository.write("tracked", "topic");
    repository.commit_all("topic");
    repository.git(&["switch", "main"]);
    assert!(git.delete_merged_branch(&opened, "unmerged").await.is_err());
    assert!(
        git.local_branches(&opened)
            .await
            .unwrap()
            .iter()
            .any(|branch| branch.name() == "unmerged")
    );

    let linked_root = tempfile::tempdir().unwrap();
    let linked = linked_root.path().join("occupied");
    repository.git(&[
        "worktree",
        "add",
        "-b",
        "occupied",
        linked.to_str().unwrap(),
    ]);
    assert!(git.delete_merged_branch(&opened, "occupied").await.is_err());
}

#[tokio::test]
async fn task_branch_uses_head_without_copying_dirty_files_or_switching_checkout() {
    let repository = TestRepository::init();
    repository.write("tracked", "original");
    repository.commit_all("base");
    repository.write("tracked", "uncommitted");
    repository.write("untracked", "private draft");
    let git = GitClient::system();
    let opened = git.open_repository(repository.root()).await.unwrap();
    let head = git.resolve_commit(&opened, "HEAD").await.unwrap();
    git.create_branch_at(&opened, "issue/3-test", &head)
        .await
        .unwrap();
    git.create_branch_at(&opened, "issue/3-test", &head)
        .await
        .unwrap();
    assert_eq!(
        git.resolve_commit(&opened, "refs/heads/issue/3-test")
            .await
            .unwrap(),
        head
    );
    assert_eq!(repository.read("tracked"), "uncommitted");
    assert_eq!(repository.read("untracked"), "private draft");
    assert!(
        git.local_branches(&opened)
            .await
            .unwrap()
            .iter()
            .any(|branch| branch.name() == "main" && branch.is_current())
    );
    repository.commit_all("later");
    let next = git.resolve_commit(&opened, "HEAD").await.unwrap();
    assert!(
        git.create_branch_at(&opened, "issue/3-test", &next)
            .await
            .is_err()
    );
    assert!(
        git.create_branch_at(&opened, "../escape", &head)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn fetching_main_uses_remote_commit_without_touching_local_head() {
    let remote = TestBareRepository::init();
    let repository = TestRepository::init();
    repository.write("file", "base");
    repository.commit_all("base");
    repository.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    repository.git(&["push", "origin", "main"]);
    let git = GitClient::system();
    let opened = git.open_repository(repository.root()).await.unwrap();
    let base = git.resolve_commit(&opened, "HEAD").await.unwrap();
    repository.write("file", "local only");
    repository.commit_all("local");
    let local = git.resolve_commit(&opened, "HEAD").await.unwrap();
    assert_eq!(git.fetch_main(&opened).await.unwrap(), base);
    assert_eq!(git.resolve_commit(&opened, "HEAD").await.unwrap(), local);
    assert_eq!(repository.read("file"), "local only");
}

#[tokio::test]
async fn checkout_fast_forwards_only_branches_without_local_commits() {
    let origin = TestBareRepository::init();
    let producer = TestRepository::init();
    producer.write("initial.txt", "initial\n");
    producer.commit_all("Initial");
    producer.git(&["remote", "add", "origin", origin.root().to_str().unwrap()]);
    producer.git(&["push", "-u", "origin", "main"]);
    producer.git(&["switch", "-c", "topic"]);
    producer.git(&["push", "-u", "origin", "topic"]);
    let source = TestRepository::clone_from(origin.root());
    source.git(&["branch", "--track", "topic", "origin/topic"]);
    producer.write("remote.txt", "remote update\n");
    producer.commit_all("Remote topic update");
    producer.git(&["push"]);
    let client = GitClient::system();
    let opened = client.open_repository(source.root()).await.unwrap();
    let branch = client
        .local_branches(&opened)
        .await
        .unwrap()
        .into_iter()
        .find(|branch| branch.name() == "topic")
        .unwrap();
    client
        .switch_branch_with_policy(&opened, &branch, crate::GitCheckoutPolicy::FastForward)
        .await
        .unwrap();
    assert_eq!(
        source.git(&["rev-parse", "HEAD"]),
        producer.git(&["rev-parse", "HEAD"])
    );
    source.write("local.txt", "local commit\n");
    source.commit_all("Local topic update");
    let local = source.git(&["rev-parse", "HEAD"]);
    source.git(&["switch", "main"]);
    producer.write("other-remote.txt", "divergent remote\n");
    producer.commit_all("Other remote update");
    producer.git(&["push"]);
    let branch = client
        .local_branches(&opened)
        .await
        .unwrap()
        .into_iter()
        .find(|branch| branch.name() == "topic")
        .unwrap();
    client
        .switch_branch_with_policy(&opened, &branch, crate::GitCheckoutPolicy::FastForward)
        .await
        .unwrap();
    assert_eq!(source.git(&["rev-parse", "HEAD"]), local);
}
