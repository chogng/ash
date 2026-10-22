use std::num::NonZeroUsize;
use std::path::Path;

use pretty_assertions::assert_eq;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn file_history_pages_complete_history_across_renames_and_head_updates() {
    #[derive(Debug, Default)]
    struct Observer(std::sync::atomic::AtomicUsize);
    impl crate::GitProcessObserver for Observer {
        fn observe(&self, _: crate::GitProcessTiming) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let repository = TestRepository::init();
    let stable = "stable content for rename detection\n".repeat(30);
    let mut path = "old.txt";
    for index in 0..137 {
        if index == 64 {
            repository.git(&["mv", "old.txt", "renamed.txt"]);
            path = "renamed.txt";
        }
        repository.write(path, &format!("{stable}version {index}\n"));
        repository.commit_all(&format!("Version {index}"));
    }
    let expected = repository.git(&["log", "--follow", "--format=%H", "--", path]);
    let observer = std::sync::Arc::new(Observer::default());
    let client = GitClient::system().with_process_observer(observer.clone());
    let opened = client.open_repository(repository.root()).await.unwrap();
    let limit = NonZeroUsize::new(9).unwrap();
    let before = observer.0.load(std::sync::atomic::Ordering::Relaxed);
    let first = client
        .file_history(&opened, Path::new(path), limit, None)
        .await
        .unwrap();
    assert_eq!(first.items.len(), 9);
    assert!(
        observer.0.load(std::sync::atomic::Ordering::Relaxed) - before <= 2 * limit.get() + 4,
        "The first page must not resolve rename metadata for the entire history"
    );
    let cursor = first.next_cursor.clone().unwrap();
    assert!(
        client
            .file_history(&opened, Path::new("other.txt"), limit, Some(cursor.clone()))
            .await
            .is_err()
    );
    let other = TestRepository::init();
    let other_opened = client.open_repository(other.root()).await.unwrap();
    assert!(
        client
            .file_history(&other_opened, Path::new(path), limit, Some(cursor))
            .await
            .is_err()
    );

    // Continuations belong to the first page's snapshot even when HEAD advances.
    repository.write(path, &format!("{stable}new HEAD\n"));
    repository.commit_all("After snapshot");
    let mut items = first.items;
    let mut cursor = first.next_cursor;
    while let Some(next) = cursor {
        let page = client
            .file_history(&opened, Path::new(path), limit, Some(next))
            .await
            .unwrap();
        assert!(!page.items.is_empty());
        assert!(page.items.len() <= limit.get());
        items.extend(page.items);
        cursor = page.next_cursor;
    }
    assert_eq!(
        items
            .iter()
            .map(|item| item.object_id.as_str())
            .collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    assert_eq!(items.len(), 137);
    assert_eq!(
        items
            .iter()
            .filter(|item| item.path == Path::new("old.txt"))
            .count(),
        64
    );
    let refreshed = client
        .file_history(&opened, Path::new(path), limit, None)
        .await
        .unwrap();
    assert_eq!(refreshed.items[0].subject, "After snapshot");
}

#[tokio::test]
async fn file_history_pages_preserve_merge_traversal_and_terminate_at_the_root() {
    let repository = TestRepository::init();
    let middle = "middle\n".repeat(20);
    repository.write("file.txt", &format!("base\n{middle}base\n"));
    repository.commit_all("Root");
    repository.git(&["checkout", "-b", "side"]);
    repository.write("file.txt", &format!("base\n{middle}side\n"));
    repository.commit_all("Side");
    repository.git(&["checkout", "main"]);
    repository.write("file.txt", &format!("main\n{middle}base\n"));
    repository.commit_all("Main");
    repository.git(&["merge", "--no-ff", "--no-edit", "side"]);
    let expected = repository.git(&["log", "--follow", "--format=%H", "--", "file.txt"]);
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let mut cursor = None;
    let mut ids = Vec::new();
    loop {
        let page = client
            .file_history(
                &opened,
                Path::new("file.txt"),
                NonZeroUsize::new(1).unwrap(),
                cursor,
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        ids.push(page.items[0].object_id.clone());
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        ids.iter().map(String::as_str).collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    assert!(ids.len() >= 3);
    let empty = TestRepository::init();
    let empty_opened = client.open_repository(empty.root()).await.unwrap();
    let page = client
        .file_history(
            &empty_opened,
            Path::new("untracked.txt"),
            NonZeroUsize::new(1).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert!(page.items.is_empty());
    assert!(page.next_cursor.is_none());
}

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

#[tokio::test]
async fn file_history_follows_renames_and_blame_uses_unsaved_contents() {
    let repository = TestRepository::init();
    repository.write("old.txt", "first line\nsecond line\n");
    repository.write("unrelated.txt", "unrelated\n");
    repository.commit_all("Initial author record");
    let initial = repository.git(&["rev-parse", "HEAD"]);
    repository.git(&["mv", "old.txt", "renamed.txt"]);
    repository.commit_all("Rename file");
    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let items = client
        .file_history(
            &opened,
            std::path::Path::new("renamed.txt"),
            std::num::NonZeroUsize::new(50).unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        items
            .items
            .iter()
            .map(|item| item.path.to_str().unwrap())
            .collect::<Vec<_>>(),
        ["renamed.txt", "old.txt"]
    );
    assert_eq!(items.items[1].object_id, initial);
    let line = client
        .blame_line(&opened, std::path::Path::new("renamed.txt"), 1, false, None)
        .await
        .unwrap();
    assert_eq!(line.object_id, initial);
    assert_eq!(line.author_email, "ash@example.invalid");
    let dirty = client
        .blame_line(
            &opened,
            std::path::Path::new("renamed.txt"),
            1,
            false,
            Some("unsaved first line\nsecond line\n"),
        )
        .await
        .unwrap();
    assert!(dirty.object_id.chars().all(|value| value == '0'));
    assert_eq!(repository.read("renamed.txt"), "first line\nsecond line\n");
    repository.write("renamed.txt", "    first line\nsecond line\n");
    repository.commit_all("Whitespace only");
    assert_ne!(
        client
            .blame_line(&opened, std::path::Path::new("renamed.txt"), 1, false, None)
            .await
            .unwrap()
            .object_id,
        initial
    );
    assert_eq!(
        client
            .blame_line(&opened, std::path::Path::new("renamed.txt"), 1, true, None)
            .await
            .unwrap()
            .object_id,
        initial
    );
    assert!(
        client
            .blame_line(&opened, std::path::Path::new("../outside"), 1, false, None)
            .await
            .is_err()
    );
}
