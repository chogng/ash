use std::num::NonZeroUsize;

use pretty_assertions::assert_eq;

use super::GitReferenceKind;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test(flavor = "current_thread")]
async fn graph_includes_local_and_fetched_remote_refs() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.commit_all("initial");
    repository.git(&["branch", "topic"]);
    repository.git(&["switch", "topic"]);
    repository.write("tracked.txt", "topic\n");
    repository.commit_all("topic commit");
    let topic_oid = repository.git(&["rev-parse", "topic"]);
    repository.git(&["switch", "main"]);
    repository.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/example/ash.git",
    ]);
    repository.git(&["update-ref", "refs/remotes/origin/topic", &topic_oid]);
    repository.git(&["branch", "-D", "topic"]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let mut cursor = client.start_graph(&opened).await.expect("graph cursor");
    let graph = cursor
        .page(NonZeroUsize::new(20).expect("non-zero"))
        .await
        .expect("repository graph");

    assert!(graph.references().iter().any(|reference| {
        reference.name() == "main"
            && reference.kind() == GitReferenceKind::LocalBranch
            && reference.is_current()
    }));
    assert!(graph.references().iter().any(|reference| {
        reference.name() == "origin/topic"
            && reference.kind() == GitReferenceKind::RemoteBranch
            && reference.remote_name() == Some("origin")
            && reference.object_id() == topic_oid
    }));
    assert!(
        graph
            .commits()
            .iter()
            .any(|commit| commit.object_id() == topic_oid)
    );
    assert_eq!(graph.remotes().len(), 1);
    assert_eq!(
        graph.remotes()[0]
            .identity()
            .expect("remote identity")
            .repository(),
        "ash"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn graph_pages_commits_and_reports_more() {
    let repository = TestRepository::init();
    for (index, message) in ["first", "second", "third"].iter().enumerate() {
        repository.write("tracked.txt", &format!("{index}\n"));
        repository.commit_all(message);
    }

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let mut cursor = client.start_graph(&opened).await.expect("graph cursor");
    let first_page = cursor
        .page(NonZeroUsize::new(2).expect("non-zero"))
        .await
        .expect("first graph page");
    let second_page = cursor
        .page(NonZeroUsize::new(2).expect("non-zero"))
        .await
        .expect("second graph page");

    assert_eq!(first_page.commits().len(), 2);
    assert!(first_page.has_more());
    assert_eq!(second_page.commits().len(), 1);
    assert!(!second_page.has_more());
    assert_eq!(first_page.commits()[0].subject(), "third");
    assert_eq!(first_page.commits()[1].subject(), "second");
    assert_eq!(second_page.commits()[0].subject(), "first");
}

#[tokio::test(flavor = "current_thread")]
async fn graph_excludes_stash_and_private_ref_commits() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    let base = repository.git(&["rev-parse", "HEAD"]);

    repository.write("tracked.txt", "staged\n");
    repository.git(&["add", "tracked.txt"]);
    repository.write("tracked.txt", "unstaged\n");
    repository.write("untracked.txt", "untracked\n");
    repository.git(&["stash", "push", "--include-untracked", "-m", "saved work"]);
    let stash = repository.git(&["rev-parse", "refs/stash"]);
    let stash_parents = repository.git(&["rev-list", "--parents", "-n1", &stash]);
    assert_eq!(stash_parents.split_whitespace().count(), 4);

    repository.git(&["switch", "--detach"]);
    repository.write("tracked.txt", "snapshot\n");
    repository.commit_all("private snapshot");
    let snapshot = repository.git(&["rev-parse", "HEAD"]);
    repository.git(&["update-ref", "refs/ash/test-snapshot", &snapshot]);
    repository.git(&["switch", "main"]);
    repository.write("tracked.txt", "latest\n");
    repository.commit_all("latest");
    let latest = repository.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let mut cursor = client.start_graph(&opened).await.unwrap();
    let first = cursor.page(NonZeroUsize::new(1).unwrap()).await.unwrap();
    let second = cursor.page(NonZeroUsize::new(1).unwrap()).await.unwrap();

    assert_eq!(first.commits()[0].object_id(), latest);
    assert!(first.has_more());
    assert_eq!(second.commits()[0].object_id(), base);
    assert!(!second.has_more());
    assert_eq!(repository.git(&["rev-parse", "refs/stash"]), stash);
    assert_eq!(
        repository.git(&["rev-parse", "refs/ash/test-snapshot"]),
        snapshot
    );
}

#[tokio::test(flavor = "current_thread")]
async fn graph_includes_only_current_detached_head_commits() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    let other_worktree = tempfile::tempdir().unwrap();
    let other_root = other_worktree.path().join("other");
    let other_path = other_root.to_str().unwrap();
    repository.git(&["worktree", "add", "--detach", other_path]);
    std::fs::write(other_root.join("tracked.txt"), "other worktree\n").unwrap();
    repository.git(&["-C", other_path, "add", "tracked.txt"]);
    repository.git(&["-C", other_path, "commit", "-m", "other worktree commit"]);
    repository.git(&["switch", "--detach"]);
    repository.write("tracked.txt", "detached\n");
    repository.commit_all("detached commit");
    let head = repository.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let mut cursor = client.start_graph(&opened).await.unwrap();
    let graph = cursor.page(NonZeroUsize::new(20).unwrap()).await.unwrap();

    assert_eq!(graph.commits().len(), 2);
    assert_eq!(graph.commits()[0].object_id(), head);
    assert!(!graph.has_more());
}

#[tokio::test(flavor = "current_thread")]
async fn graph_is_empty_for_unborn_repository() {
    let repository = TestRepository::init();
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let mut cursor = client.start_graph(&opened).await.unwrap();
    let graph = cursor.page(NonZeroUsize::new(20).unwrap()).await.unwrap();

    assert!(graph.commits().is_empty());
    assert!(graph.references().is_empty());
    assert!(!graph.has_more());
}

#[tokio::test(flavor = "current_thread")]
async fn graph_tags_point_to_commits_for_lightweight_and_annotated_tags() {
    let repository = TestRepository::init();
    repository.write("file.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["switch", "--detach"]);
    repository.write("file.txt", "tagged\n");
    repository.commit_all("tagged commit");
    let head = repository.git(&["rev-parse", "HEAD"]);
    repository.git(&["tag", "lightweight"]);
    repository.git(&["tag", "-a", "annotated", "-m", "reviewed"]);
    repository.git(&["switch", "main"]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let refs = client.references(&opened).await.unwrap();
    let tags = refs
        .iter()
        .filter(|reference| reference.kind() == GitReferenceKind::Tag)
        .collect::<Vec<_>>();
    assert_eq!(tags.len(), 2);
    assert!(
        tags.iter()
            .all(|tag| tag.object_id() == head && !tag.is_current() && tag.remote_name().is_none())
    );
    let mut cursor = client.start_graph(&opened).await.unwrap();
    let graph = cursor.page(NonZeroUsize::new(20).unwrap()).await.unwrap();
    assert_eq!(graph.commits().len(), 2);
    assert_eq!(graph.commits()[0].object_id(), head);
    assert!(!graph.has_more());
}
