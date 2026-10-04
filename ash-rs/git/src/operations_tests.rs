use super::GitCommand;
use super::GitCommandOutcome;
use super::GitIntegration;
use crate::GitClient;
use crate::test_support::TestRepository;

#[tokio::test]
async fn refs_and_stashes_are_reviewed_by_identity_and_keep_working_files() {
    let source = TestRepository::init();
    source.write("file.txt", "original\n");
    source.commit_all("Initial");
    source.git(&["branch", "topic"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::RenameBranch {
                name: "topic".into(),
                new_name: "review".into(),
            },
        )
        .await
        .unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::CreateTag {
                name: "v1".into(),
                reference: "HEAD".into(),
            },
        )
        .await
        .unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::AddRemote {
                name: "backup".into(),
                url: source.root().display().to_string(),
            },
        )
        .await
        .unwrap();
    source.write("file.txt", "local edits\n");
    source.write("untracked.txt", "keep me\n");
    client
        .execute_command(
            &repository,
            &GitCommand::Stash {
                message: "review edits".into(),
                mode: super::GitStashMode::IncludeUntracked,
            },
        )
        .await
        .unwrap();
    let catalog = client.catalog(&repository).await.unwrap();
    assert_eq!(catalog.tags[0].0, "v1");
    assert_eq!(catalog.remotes, ["backup"]);
    assert_eq!(catalog.stashes.len(), 1);
    let object_id = catalog.stashes[0].0.clone();
    assert_eq!(source.read("file.txt"), "original\n");
    assert!(!source.path("untracked.txt").exists());
    client
        .execute_command(
            &repository,
            &GitCommand::PopStash {
                object_id: object_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(source.read("file.txt"), "local edits\n");
    assert_eq!(source.read("untracked.txt"), "keep me\n");
    assert!(
        client
            .execute_command(&repository, &GitCommand::DropStash { object_id })
            .await
            .is_err()
    );
    client
        .execute_command(&repository, &GitCommand::DeleteTag { name: "v1".into() })
        .await
        .unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::RemoveRemote {
                name: "backup".into(),
            },
        )
        .await
        .unwrap();
    assert!(client.catalog(&repository).await.unwrap().tags.is_empty());
}

#[tokio::test]
async fn integration_conflicts_can_be_inspected_aborted_and_continued() {
    let source = TestRepository::init();
    source.write("file.txt", "base\n");
    source.commit_all("Initial");
    source.git(&["switch", "-c", "topic"]);
    source.write("file.txt", "topic\n");
    source.commit_all("Topic");
    let topic = source.git(&["rev-parse", "HEAD"]);
    source.git(&["switch", "main"]);
    source.write("file.txt", "main\n");
    source.commit_all("Main");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    for command in [
        GitCommand::Merge {
            reference: "topic".into(),
        },
        GitCommand::Rebase {
            reference: "topic".into(),
        },
        GitCommand::CherryPick {
            mainline: None,
            reference: topic.clone(),
        },
    ] {
        assert_eq!(
            client.execute_command(&repository, &command).await.unwrap(),
            GitCommandOutcome::Conflicted
        );
        let operation = client
            .catalog(&repository)
            .await
            .unwrap()
            .operation
            .unwrap();
        assert_eq!(
            client
                .execute_command(&repository, &GitCommand::Continue { operation })
                .await
                .unwrap(),
            GitCommandOutcome::Conflicted
        );
        client
            .execute_command(&repository, &GitCommand::Abort { operation })
            .await
            .unwrap();
        assert_eq!(source.read("file.txt"), "main\n");
        assert_eq!(client.catalog(&repository).await.unwrap().operation, None);
    }
    assert_eq!(
        client
            .execute_command(
                &repository,
                &GitCommand::Merge {
                    reference: "topic".into()
                }
            )
            .await
            .unwrap(),
        GitCommandOutcome::Conflicted
    );
    source.write("file.txt", "resolved\n");
    source.git(&["add", "file.txt"]);
    assert_eq!(
        client
            .execute_command(
                &repository,
                &GitCommand::Continue {
                    operation: GitIntegration::Merge
                }
            )
            .await
            .unwrap(),
        GitCommandOutcome::Completed
    );
    assert_eq!(client.catalog(&repository).await.unwrap().operation, None);
    assert_eq!(
        source
            .git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[tokio::test]
async fn amend_and_undo_keep_index_and_reject_a_stale_head() {
    let source = TestRepository::init();
    source.write("file.txt", "initial\n");
    source.commit_all("Initial");
    let initial = source.git(&["rev-parse", "HEAD"]);
    source.write("file.txt", "second\n");
    source.commit_all("Second");
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::Amend {
                message: "Reviewed second".into(),
            },
        )
        .await
        .unwrap();
    let reviewed = source.git(&["rev-parse", "HEAD"]);
    assert!(
        client
            .execute_command(
                &repository,
                &GitCommand::UndoCommit {
                    expected_head: initial.clone()
                }
            )
            .await
            .is_err()
    );
    client
        .execute_command(
            &repository,
            &GitCommand::UndoCommit {
                expected_head: reviewed,
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["rev-parse", "HEAD"]), initial);
    assert_eq!(source.git(&["show", ":file.txt"]), "second");
    assert_eq!(source.read("file.txt"), "second\n");
}

#[tokio::test]
async fn initialization_rejects_nested_repositories_and_remote_deletion_uses_a_named_remote() {
    let directory = tempfile::tempdir().unwrap();
    let client = GitClient::system();
    client
        .initialize_repository(directory.path(), "review")
        .await
        .unwrap();
    let repository = client.open_repository(directory.path()).await.unwrap();
    assert!(matches!(
        client.snapshot(&repository).await.unwrap().head(),
        crate::GitHead::Unborn { .. }
    ));
    let nested = directory.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    assert!(client.initialize_repository(&nested, "main").await.is_err());
    assert!(!nested.join(".git").exists());

    let source = TestRepository::init();
    let remote = crate::test_support::TestBareRepository::init();
    source.write("file.txt", "initial\n");
    source.commit_all("Initial");
    source.git(&["remote", "add", "origin", remote.root().to_str().unwrap()]);
    source.git(&["push", "origin", "HEAD:topic"]);
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::DeleteRemoteBranch {
                remote: "origin".into(),
                name: "topic".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        remote.git(&["for-each-ref", "--format=%(refname)", "refs/heads/topic"]),
        ""
    );
    assert!(
        client
            .execute_command(
                &repository,
                &GitCommand::DeleteRemoteBranch {
                    remote: "--all".into(),
                    name: "main".into()
                }
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn graph_commands_create_at_selected_commit_and_checkout_without_discarding_edits() {
    let source = TestRepository::init();
    source.write("file.txt", "before\n");
    source.commit_all("Root");
    let root = source.git(&["rev-parse", "HEAD"]);
    source.write("file.txt", "after\n");
    source.commit_all("Latest");
    let latest = source.git(&["rev-parse", "HEAD"]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::CreateBranchAt {
                name: "from-root".into(),
                object_id: root.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["rev-parse", "from-root"]), root);
    assert_eq!(source.git(&["rev-parse", "HEAD"]), latest);
    assert!(
        client
            .execute_command(
                &repository,
                &GitCommand::CreateBranchAt {
                    name: "from-root".into(),
                    object_id: root.clone()
                }
            )
            .await
            .is_err()
    );
    source.write("file.txt", "local edits\n");
    assert!(
        client
            .execute_command(
                &repository,
                &GitCommand::CheckoutDetached {
                    object_id: root.clone()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(source.read("file.txt"), "local edits\n");
    assert_eq!(source.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    source.git(&["restore", "file.txt"]);
    client
        .execute_command(
            &repository,
            &GitCommand::CheckoutDetached {
                object_id: root.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["rev-parse", "HEAD"]), root);
    assert_eq!(source.read("file.txt"), "before\n");
    source.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/test/history.git",
    ]);
    source.git(&["update-ref", "refs/remotes/origin/topic", &latest]);
    client
        .execute_command(
            &repository,
            &GitCommand::CheckoutRemoteBranch {
                name: "tracked".into(),
                reference: "origin/topic".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(source.git(&["symbolic-ref", "--short", "HEAD"]), "tracked");
    assert_eq!(
        source.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/topic"
    );
}

#[tokio::test]
async fn graph_cherry_pick_replays_a_merge_relative_to_the_chosen_parent() {
    let source = TestRepository::init();
    source.write("base.txt", "base\n");
    source.commit_all("Root");
    let root = source.git(&["rev-parse", "HEAD"]);
    source.git(&["switch", "-c", "topic"]);
    source.write("topic.txt", "topic\n");
    source.commit_all("Topic");
    source.git(&["switch", "main"]);
    source.write("main.txt", "main\n");
    source.commit_all("Main");
    source.git(&["merge", "--no-ff", "topic", "-m", "Merge"]);
    let merge = source.git(&["rev-parse", "HEAD"]);
    source.git(&["switch", "-c", "replay", &root]);
    let client = GitClient::system();
    let repository = client.open_repository(source.root()).await.unwrap();
    client
        .execute_command(
            &repository,
            &GitCommand::CherryPick {
                reference: merge,
                mainline: Some(2),
            },
        )
        .await
        .unwrap();
    assert_eq!(source.read("main.txt"), "main\n");
    assert!(!source.path("topic.txt").exists());
    assert_eq!(source.git(&["rev-parse", "HEAD^"]), root);
}
