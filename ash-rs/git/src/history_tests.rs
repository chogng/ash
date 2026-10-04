use std::path::Path;

use pretty_assertions::assert_eq;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn commit_details_include_author_message_and_root_statistics() {
    let source = TestRepository::init();
    source.git(&["config", "user.name", "History Author"]);
    source.git(&["config", "user.email", "history@example.invalid"]);
    source.write("first.txt", "first\nsecond\n");
    source.write("binary.dat", "\0binary");
    source.commit_all("Root subject\n\nFull explanation.");
    let object_id = source.git(&["rev-parse", "HEAD"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let details = client
        .commit_details(&repository, &object_id)
        .await
        .unwrap();
    assert_eq!(details.author_name, "History Author");
    assert_eq!(details.author_email, "history@example.invalid");
    assert_eq!(details.message, "Root subject\n\nFull explanation.");
    assert_eq!(
        details.timestamp_seconds.to_string(),
        source.git(&["show", "-s", "--format=%ct", "HEAD"])
    );
    assert_eq!(
        details.statistics,
        crate::GitCommitStatistics {
            files: 2,
            additions: 2,
            deletions: 0
        }
    );
    assert_eq!(source.git(&["status", "--porcelain"]), "");
}

#[tokio::test]
async fn commit_details_count_renames_once_and_use_the_first_parent_of_merges() {
    let source = TestRepository::init();
    source.write("old.txt", "old\n");
    source.commit_all("Root");
    source.git(&["branch", "topic"]);
    source.git(&["mv", "old.txt", "new.txt"]);
    source.commit_all("Rename");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let rename = source.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        client
            .commit_details(&repository, &rename)
            .await
            .unwrap()
            .statistics,
        crate::GitCommitStatistics {
            files: 1,
            additions: 0,
            deletions: 0
        }
    );
    source.git(&["switch", "topic"]);
    source.write("topic.txt", "topic\n");
    source.commit_all("Topic");
    source.git(&["switch", "main"]);
    source.git(&["merge", "--no-ff", "topic", "-m", "Merge"]);
    let merge = source.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        client
            .commit_details(&repository, &merge)
            .await
            .unwrap()
            .statistics,
        crate::GitCommitStatistics {
            files: 1,
            additions: 1,
            deletions: 0
        }
    );
    source.git(&["commit", "--allow-empty", "-m", "Empty"]);
    let empty = source.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        client
            .commit_details(&repository, &empty)
            .await
            .unwrap()
            .statistics,
        crate::GitCommitStatistics::default()
    );
}

#[tokio::test]
async fn commit_changes_and_content_follow_the_first_parent() {
    let repository = TestRepository::init();
    repository.write("modified.txt", "before\n");
    repository.write("renamed.txt", "rename me\n");
    repository.commit_all("initial");
    repository.write("modified.txt", "after\n");
    repository.git(&["mv", "renamed.txt", "moved.txt"]);
    repository.write("added.txt", "added\n");
    repository.commit_all("change files");
    let object_id = repository.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let (parent, changes) = client.commit_changes(&opened, &object_id).await.unwrap();

    assert!(parent.is_some());
    assert!(changes.iter().any(|change| {
        change.path() == Path::new("modified.txt") && change.status() == GitChangeStatus::Modified
    }));
    let renamed = changes
        .iter()
        .find(|change| change.path() == Path::new("moved.txt"))
        .expect("renamed change");
    assert_eq!(renamed.original_path(), Some(Path::new("renamed.txt")));
    assert_eq!(renamed.status(), GitChangeStatus::Renamed);

    let content = client
        .commit_file(
            &opened,
            &object_id,
            parent.as_deref(),
            Path::new("modified.txt"),
            None,
            1024,
        )
        .await
        .unwrap();
    assert_eq!(content.original(), Some(b"before\n".as_slice()));
    assert_eq!(content.modified(), Some(b"after\n".as_slice()));
}

#[tokio::test]
async fn root_commit_changes_have_no_parent_or_original_content() {
    let repository = TestRepository::init();
    repository.write("first.txt", "first\n");
    repository.commit_all("root");
    let object_id = repository.git(&["rev-parse", "HEAD"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let (parent, changes) = client.commit_changes(&opened, &object_id).await.unwrap();
    assert_eq!(parent, None);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].status(), GitChangeStatus::Added);

    let content = client
        .commit_file(
            &opened,
            &object_id,
            None,
            Path::new("first.txt"),
            None,
            1024,
        )
        .await
        .unwrap();
    assert_eq!(content.original(), None);
    assert_eq!(content.modified(), Some(b"first\n".as_slice()));
}

#[tokio::test]
async fn comparison_uses_selected_base_and_common_ancestor_without_changing_head() {
    let source = TestRepository::init();
    source.write("shared.txt", "base\n");
    source.write("old.txt", "rename\n");
    source.commit_all("Root");
    let root = source.git(&["rev-parse", "HEAD"]);
    source.git(&["branch", "topic"]);
    source.write("main-only.txt", "main\n");
    source.commit_all("Main");
    let main = source.git(&["rev-parse", "HEAD"]);
    source.git(&["switch", "topic"]);
    source.git(&["mv", "old.txt", "new.txt"]);
    source.write("shared.txt", "topic\n");
    source.commit_all("Topic\n\nFull explanation\nwith another line.");
    let topic = source.git(&["rev-parse", "HEAD"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    let (base, changes) = client
        .compare_changes(
            &repository,
            &topic,
            "main",
            super::GitComparisonMode::Direct,
        )
        .await
        .unwrap();
    assert_eq!(base, main);
    assert!(
        changes
            .iter()
            .any(|change| change.path() == Path::new("main-only.txt")
                && change.status() == GitChangeStatus::Deleted)
    );
    let (base, changes) = client
        .compare_changes(
            &repository,
            &topic,
            "main",
            super::GitComparisonMode::MergeBase,
        )
        .await
        .unwrap();
    assert_eq!(base, root);
    assert_eq!(changes.len(), 2);
    let renamed = changes
        .iter()
        .find(|change| change.path() == Path::new("new.txt"))
        .unwrap();
    let content = client
        .commit_file(
            &repository,
            &topic,
            Some(&base),
            renamed.path(),
            renamed.original_path(),
            1024,
        )
        .await
        .unwrap();
    assert_eq!(content.original(), Some(b"rename\n".as_slice()));
    assert_eq!(content.modified(), Some(b"rename\n".as_slice()));
    assert_eq!(
        client.commit_message(&repository, &topic).await.unwrap(),
        "Topic\n\nFull explanation\nwith another line."
    );
    assert_eq!(source.git(&["rev-parse", "HEAD"]), topic);
    assert!(
        client
            .compare_changes(
                &repository,
                &topic,
                "--help",
                super::GitComparisonMode::Direct
            )
            .await
            .is_err()
    );
}
