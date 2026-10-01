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
async fn graph_tags_point_to_commits_for_lightweight_and_annotated_tags() {
    let repository = TestRepository::init();
    repository.write("file.txt", "base\n");
    repository.commit_all("base");
    let head = repository.git(&["rev-parse", "HEAD"]);
    repository.git(&["tag", "lightweight"]);
    repository.git(&["tag", "-a", "annotated", "-m", "reviewed"]);
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
}
