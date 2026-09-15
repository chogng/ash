#![allow(clippy::expect_used)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Barrier;

use ash_file_access::Dir;
use ash_git::GitClient;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use tempfile::TempDir;

use crate::ManagedDirCleanupEligibility;
use crate::ManagedDirKind;
use crate::ManagedDirOwner;
use crate::ManagedDirProvisionRequest;
use crate::ManagedDirSource;
use crate::ManagedDirTarget;
use crate::WorktreeAvailability;
use crate::WorktreeKind;
use crate::WorktreeManager;
use crate::WorktreeOwner;
use crate::WorktreeSelector;
use crate::WorktreeSettings;

struct RepositoryFixture {
    _temp_dir: TempDir,
    codex_home: PathBuf,
    repository: PathBuf,
}

impl RepositoryFixture {
    fn new() -> Self {
        let temp_dir = tempfile::tempdir().expect("create temporary test directory");
        let temp_root = dunce::canonicalize(temp_dir.path()).expect("canonicalize temporary root");
        let codex_home = temp_root.join("codex-home");
        let repository = temp_root.join("project");
        fs::create_dir_all(&codex_home).expect("create Codex home");
        initialize_repository(&repository);
        Self {
            _temp_dir: temp_dir,
            codex_home,
            repository,
        }
    }

    fn manager(&self) -> WorktreeManager {
        WorktreeManager::new(WorktreeSettings::defaults(&self.codex_home))
    }

    fn add_managed_worktree(&self, bucket: &str, name: &str, branch: &str) -> PathBuf {
        let checkout = self.manager().settings().root.join(bucket).join(name);
        fs::create_dir_all(checkout.parent().expect("worktree parent"))
            .expect("create managed bucket");
        run_git(
            &self.repository,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                checkout.to_str().expect("UTF-8 checkout path"),
                "HEAD",
            ],
        );
        checkout
    }
}

#[tokio::test(flavor = "current_thread")]
async fn list_and_resolve_preserve_the_source_relative_directory() {
    let fixture = RepositoryFixture::new();
    let checkout = fixture.add_managed_worktree("a1b2", "topic", "topic");
    let source_directory = fixture.repository.join("nested/component");

    let worktrees = fixture
        .manager()
        .list(&source_directory)
        .await
        .expect("list worktrees");

    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[0].kind(), WorktreeKind::Primary);
    assert!(worktrees[0].is_current());
    assert_eq!(worktrees[0].dir(), source_directory.as_path());
    assert_eq!(worktrees[1].kind(), WorktreeKind::Linked);
    assert_eq!(worktrees[1].branch(), Some("topic"));
    assert_eq!(worktrees[1].dir(), checkout.join("nested/component"));

    let target = fixture
        .manager()
        .resolve(
            &source_directory,
            &WorktreeSelector::Branch("topic".to_string()),
        )
        .await
        .expect("resolve branch worktree");
    assert_eq!(target.checkout_root(), checkout);
    assert_eq!(target.dir(), checkout.join("nested/component"));
}

#[tokio::test(flavor = "current_thread")]
async fn thread_binding_matches_codex_metadata_and_rejects_other_checkouts() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let checkout = fixture.add_managed_worktree("c3d4", "owned", "owned");
    let thread_id = "019f1234-5678-7000-8000-000000000001";

    assert_eq!(manager.owner(&checkout).await.expect("read owner"), None);
    manager
        .bind_thread(&checkout, thread_id)
        .await
        .expect("bind managed worktree");
    manager
        .bind_thread(&checkout, thread_id)
        .await
        .expect("repeat same binding");
    assert_eq!(
        manager.owner(&checkout).await.expect("read bound owner"),
        Some(thread_id.to_string())
    );

    let git_dir = PathBuf::from(run_git(&checkout, &["rev-parse", "--absolute-git-dir"]));
    let record: Value = serde_json::from_slice(
        &fs::read(git_dir.join("codex-thread.json")).expect("read owner metadata"),
    )
    .expect("parse owner metadata");
    assert_eq!(
        record,
        json!({
            "version": 1,
            "ownerThreadId": thread_id,
        })
    );

    assert!(
        manager
            .bind_thread(&checkout, "another-thread")
            .await
            .is_err()
    );
    assert!(
        manager
            .bind_thread(&fixture.repository, "primary")
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn locked_worktrees_resolve_while_prunable_worktrees_are_rejected() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let locked = fixture.add_managed_worktree("e5f6", "locked", "locked");
    run_git(
        &fixture.repository,
        &[
            "worktree",
            "lock",
            "--reason",
            "in use",
            locked.to_str().expect("UTF-8 checkout path"),
        ],
    );
    let prunable = fixture.add_managed_worktree("a7b8", "prunable", "prunable");
    fs::remove_dir_all(&prunable).expect("remove linked checkout contents");

    let worktrees = manager
        .list(&fixture.repository)
        .await
        .expect("list worktrees");
    let locked_entry = worktrees
        .iter()
        .find(|worktree| worktree.branch() == Some("locked"))
        .expect("locked worktree entry");
    assert_eq!(
        locked_entry.availability(),
        &WorktreeAvailability::Locked {
            reason: Some("in use".to_string())
        }
    );
    let prunable_entry = worktrees
        .iter()
        .find(|worktree| worktree.branch() == Some("prunable"))
        .expect("prunable worktree entry");
    assert!(matches!(
        prunable_entry.availability(),
        WorktreeAvailability::Prunable { .. }
    ));

    assert_eq!(
        manager
            .resolve(
                &fixture.repository,
                &WorktreeSelector::Branch("locked".to_string())
            )
            .await
            .expect("resolve locked worktree")
            .checkout_root(),
        locked
    );
    assert!(
        manager
            .resolve(
                &fixture.repository,
                &WorktreeSelector::Branch("prunable".to_string())
            )
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn thread_binding_rejects_unmanaged_linked_worktree() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    fs::create_dir_all(&manager.settings().root).expect("create managed root");
    let checkout = fixture.codex_home.join("outside-layout");
    run_git(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            checkout.to_str().expect("UTF-8 checkout path"),
            "HEAD",
        ],
    );

    assert!(manager.bind_thread(&checkout, "unmanaged").await.is_err());
    assert!(manager.owner(&checkout).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn listing_reports_invalid_owner_without_hiding_other_worktrees() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let checkout = fixture.add_managed_worktree("b1c2", "invalid-owner", "invalid-owner");
    let git_dir = PathBuf::from(run_git(&checkout, &["rev-parse", "--absolute-git-dir"]));
    fs::write(git_dir.join("codex-thread.json"), b"not json").expect("write invalid owner");

    let worktrees = manager
        .list(&fixture.repository)
        .await
        .expect("list worktrees");

    assert_eq!(worktrees.len(), 2);
    let invalid = worktrees
        .iter()
        .find(|worktree| worktree.checkout_root() == checkout)
        .expect("invalid owner remains in inventory");
    assert_eq!(invalid.owner(), &WorktreeOwner::Invalid);
}

#[tokio::test(flavor = "current_thread")]
async fn thread_recovery_repairs_links_after_the_source_repository_moves() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    fs::write(fixture.repository.join(".gitignore"), "embedded/\n")
        .expect("ignore nested repository");
    run_git(&fixture.repository, &["add", ".gitignore"]);
    run_git(
        &fixture.repository,
        &["commit", "--quiet", "--no-gpg-sign", "-m", "ignore nested"],
    );
    initialize_repository(&fixture.repository.join("embedded"));
    let source_dir_id = Dir::open_local(&fixture.repository)
        .expect("open source directory")
        .id();
    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: fixture.repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: source_dir_id.to_string(),
            owner: thread_owner("moved-repository-thread"),
        })
        .await
        .expect("provision managed worktree");
    let repository_ids = binding
        .repositories()
        .iter()
        .map(|repository| repository.repository_id().to_string())
        .collect::<Vec<_>>();
    let moved_repository = fixture.repository.with_file_name("moved-project");
    fs::rename(&fixture.repository, &moved_repository).expect("move source repository");
    let moved_dir_id = Dir::open_local(&moved_repository)
        .expect("open moved source directory")
        .id();

    let recovered = manager
        .recover_threads(&moved_repository, moved_dir_id.as_str())
        .await
        .expect("recover Thread after moving its source repository");

    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].0, "moved-repository-thread");
    let recovered = &recovered[0].1;
    assert_eq!(recovered.checkout_root(), binding.checkout_root());
    assert_ne!(source_dir_id, moved_dir_id);
    assert_eq!(recovered.source_dir_id(), moved_dir_id.as_str());
    assert_eq!(recovered.source_repository_root(), moved_repository);
    assert_eq!(recovered.repositories().len(), 2);
    assert_eq!(
        recovered.repositories()[0].source_repository_root(),
        moved_repository
    );
    assert_eq!(
        recovered.repositories()[1].source_repository_root(),
        moved_repository.join("embedded")
    );
    assert_eq!(
        recovered
            .repositories()
            .iter()
            .map(|repository| repository.repository_id().to_string())
            .collect::<Vec<_>>(),
        repository_ids
    );
    for repository in recovered.repositories() {
        GitClient::system()
            .open_repository(repository.worktree_root())
            .await
            .expect("open repaired linked worktree");
    }
    let nested_repository = GitClient::system()
        .open_repository(recovered.repositories()[1].worktree_root())
        .await
        .expect("open repaired nested worktree");
    let nested_record =
        crate::binding::read(nested_repository.git_dir()).expect("read relocated nested binding");
    assert_eq!(nested_record.source_dir_id, moved_dir_id.as_str());
    assert_eq!(
        nested_record.source_repository_root,
        moved_repository.join("embedded")
    );
    assert_eq!(
        manager
            .recover_threads(&moved_repository, moved_dir_id.as_str())
            .await
            .expect("repeat recovery after repository move"),
        vec![("moved-repository-thread".into(), recovered.clone())]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn pending_codex_owner_is_unbound_and_can_be_claimed() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let checkout = fixture.add_managed_worktree("c7d8", "pending", "pending");
    let git_dir = PathBuf::from(run_git(&checkout, &["rev-parse", "--absolute-git-dir"]));
    fs::write(
        git_dir.join("codex-thread.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "ownerThreadId": null,
        }))
        .expect("serialize pending owner"),
    )
    .expect("write pending owner");

    assert_eq!(
        manager.owner(&checkout).await.expect("read pending owner"),
        None
    );
    manager
        .bind_thread(&checkout, "claimed-thread")
        .await
        .expect("claim pending owner");
    assert_eq!(
        manager.owner(&checkout).await.expect("read claimed owner"),
        Some("claimed-thread".to_string())
    );
}

#[tokio::test(flavor = "current_thread")]
async fn checkout_selector_requires_an_existing_absolute_worktree_root() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let checkout = fixture.add_managed_worktree("d3e4", "path-target", "path-target");

    let resolved = manager
        .resolve(
            &fixture.repository,
            &WorktreeSelector::CheckoutRoot(checkout.clone()),
        )
        .await
        .expect("resolve absolute checkout root");
    assert_eq!(resolved.checkout_root(), checkout);

    for root in [
        PathBuf::from("relative/path"),
        fixture.codex_home.join("missing"),
    ] {
        assert!(
            manager
                .resolve(&fixture.repository, &WorktreeSelector::CheckoutRoot(root))
                .await
                .is_err()
        );
    }
    assert!(
        manager
            .resolve(
                &fixture.repository,
                &WorktreeSelector::Branch("  ".to_string())
            )
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn thread_provision_freezes_dirty_source_and_recovers_the_binding() {
    let fixture = RepositoryFixture::new();
    fs::write(fixture.repository.join(".gitignore"), "ignored/\n").expect("write ignore rules");
    run_git(&fixture.repository, &["add", ".gitignore"]);
    run_git(
        &fixture.repository,
        &["commit", "--quiet", "--no-gpg-sign", "-m", "ignore outputs"],
    );
    fs::write(fixture.repository.join("README.md"), "dirty source\n")
        .expect("modify tracked source");
    fs::write(
        fixture.repository.join("untracked.txt"),
        "untracked source\n",
    )
    .expect("write untracked source");
    fs::create_dir_all(fixture.repository.join("ignored")).expect("create ignored directory");
    fs::write(fixture.repository.join("ignored/output.bin"), b"ignored")
        .expect("write ignored output");

    let manager = fixture.manager();
    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: fixture.repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "dir-1".into(),
            owner: thread_owner("thread-1"),
        })
        .await
        .expect("provision Thread worktree");

    assert_eq!(binding.target_branch(), Some("main"));
    assert_eq!(
        fs::read_to_string(binding.checkout_root().join("README.md")).unwrap(),
        "dirty source\n"
    );
    assert_eq!(
        fs::read_to_string(binding.checkout_root().join("untracked.txt")).unwrap(),
        "untracked source\n"
    );
    assert!(!binding.checkout_root().join("ignored/output.bin").exists());
    assert_eq!(
        manager
            .recover(binding.checkout_root(), &thread_owner("thread-1"))
            .await
            .expect("recover Thread worktree"),
        binding
    );

    manager
        .cleanup(&binding, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .expect("cleanup settled Thread worktree");
    assert!(!binding.checkout_root().exists());
    assert!(run_git(&fixture.repository, &["for-each-ref", "refs/ash/threads"]).is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn thread_provision_supports_an_unborn_target_without_creating_its_branch() {
    let temporary = tempfile::tempdir().unwrap();
    let repository = temporary.path().join("unborn");
    let profile = temporary.path().join("profile");
    fs::create_dir_all(&repository).unwrap();
    fs::create_dir_all(&profile).unwrap();
    run_git(&repository, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(repository.join("baseline.txt"), "initial baseline\n").unwrap();
    let manager = WorktreeManager::new(WorktreeSettings::defaults(&profile));

    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "unborn-dir".into(),
            owner: thread_owner("unborn-thread"),
        })
        .await
        .unwrap();

    assert_eq!(binding.target_branch(), Some("main"));
    assert!(binding.target_unborn());
    assert_eq!(
        fs::read_to_string(binding.dir().join("baseline.txt")).unwrap(),
        "initial baseline\n"
    );
    let branch = Command::new("git")
        .current_dir(&repository)
        .args(["show-ref", "--verify", "--quiet", "refs/heads/main"])
        .status()
        .unwrap();
    assert!(!branch.success());

    manager
        .cleanup(&binding, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
}

#[tokio::test]
async fn thread_recovery_ignores_checkouts_owned_by_another_profile() {
    let fixture = RepositoryFixture::new();
    let manager = fixture.manager();
    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: fixture.repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "repository".into(),
            owner: thread_owner("other-profile-thread"),
        })
        .await
        .unwrap();
    let profile = TempDir::new().unwrap();
    let settings = WorktreeSettings::defaults(profile.path());
    let root = settings.root.clone();
    let other = WorktreeManager::new(settings);
    assert!(
        other
            .recover_threads(&fixture.repository, "repository")
            .await
            .unwrap()
            .is_empty()
    );
    fs::create_dir_all(root).unwrap();
    assert!(
        other
            .recover_threads(&fixture.repository, "repository")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        manager
            .recover_threads(&fixture.repository, "repository")
            .await
            .unwrap()
            .len(),
        1
    );
    manager
        .cleanup(&binding, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn thread_provision_maps_nested_repositories_to_independent_linked_worktrees() {
    let fixture = RepositoryFixture::new();
    fs::write(fixture.repository.join(".gitignore"), "nested/\n").unwrap();
    run_git(&fixture.repository, &["add", ".gitignore"]);
    run_git(
        &fixture.repository,
        &["commit", "--quiet", "--no-gpg-sign", "-m", "ignore nested"],
    );
    let nested = fixture.repository.join("nested");
    fs::create_dir_all(&nested).unwrap();
    run_git(&nested, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(nested.join("nested.txt"), "nested baseline\n").unwrap();
    run_git(&nested, &["add", "nested.txt"]);
    run_git(
        &nested,
        &[
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "-m",
            "nested baseline",
        ],
    );
    let manager = fixture.manager();

    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: fixture.repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "nested-dir".into(),
            owner: thread_owner("nested-thread"),
        })
        .await
        .unwrap();

    assert_eq!(binding.repositories().len(), 2);
    let nested_binding = binding
        .repositories()
        .iter()
        .find(|repository| repository.relative_path() == Path::new("nested"))
        .unwrap();
    assert_eq!(
        fs::read_to_string(nested_binding.worktree_root().join("nested.txt")).unwrap(),
        "nested baseline\n"
    );
    fs::write(
        nested_binding.worktree_root().join("nested.txt"),
        "nested checkpoint\n",
    )
    .unwrap();
    let git = ash_git::GitClient::system();
    let nested_repository = git
        .open_repository(nested_binding.worktree_root())
        .await
        .unwrap();
    let nested_checkpoint = git.capture_worktree_tree(&nested_repository).await.unwrap();
    fs::write(
        nested_binding.worktree_root().join("nested.txt"),
        "parent moved on\n",
    )
    .unwrap();
    let child = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::ImmutableTree {
                source_directory: binding.dir().to_path_buf(),
                tree_id: binding.baseline_tree().to_string(),
                repository_trees: BTreeMap::from([
                    (PathBuf::from("."), binding.baseline_tree().to_string()),
                    (
                        PathBuf::from("nested"),
                        nested_checkpoint.as_str().to_string(),
                    ),
                ]),
            },
            target: ManagedDirTarget::Branch {
                name: binding.target_branch().unwrap().to_string(),
                object_id: binding.target_head().to_string(),
            },
            repository_targets: BTreeMap::new(),
            source_dir_id: "nested-dir".into(),
            owner: thread_owner("nested-child"),
        })
        .await
        .unwrap();
    let child_nested = child
        .repositories()
        .iter()
        .find(|repository| repository.relative_path() == Path::new("nested"))
        .unwrap();
    assert_eq!(
        fs::read_to_string(child_nested.worktree_root().join("nested.txt")).unwrap(),
        "nested checkpoint\n"
    );
    assert_eq!(child_nested.target_branch(), Some("main"));
    manager
        .cleanup(&child, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
    fs::write(nested.join("nested.txt"), "source moved on\n").unwrap();
    assert_eq!(
        fs::read_to_string(nested_binding.worktree_root().join("nested.txt")).unwrap(),
        "parent moved on\n"
    );
    assert_eq!(
        manager
            .recover(binding.checkout_root(), &thread_owner("nested-thread"),)
            .await
            .unwrap(),
        binding
    );

    manager
        .cleanup(&binding, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
    assert!(!binding.checkout_root().exists());
    assert_eq!(
        run_git(&nested, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
}

#[test]
fn concurrent_thread_binding_publishes_exactly_one_owner() {
    let fixture = RepositoryFixture::new();
    let checkout = fixture.add_managed_worktree("f5a6", "concurrent", "concurrent");
    let git_dir = PathBuf::from(run_git(&checkout, &["rev-parse", "--absolute-git-dir"]));
    let barrier = Arc::new(Barrier::new(3));
    let attempts = ["thread-one", "thread-two"]
        .into_iter()
        .map(|thread_id| {
            let barrier = Arc::clone(&barrier);
            let git_dir = git_dir.clone();
            std::thread::spawn(move || {
                barrier.wait();
                crate::metadata::bind_thread(&git_dir, thread_id)
            })
        })
        .collect::<Vec<_>>();

    barrier.wait();
    let results = attempts
        .into_iter()
        .map(|attempt| attempt.join().expect("binding thread completed"))
        .collect::<Vec<_>>();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let owner = crate::metadata::owner(&git_dir)
        .expect("read concurrent owner")
        .expect("owner was published");
    assert!(owner == "thread-one" || owner == "thread-two");
}

#[tokio::test]
async fn non_git_threads_use_isolated_managed_directory_copies() {
    let temporary = tempfile::tempdir().expect("create temporary directory");
    let dir = temporary.path().join("plain-dir");
    let profile = temporary.path().join("profile");
    fs::create_dir_all(&dir).expect("create dir");
    fs::create_dir_all(&profile).expect("create profile");
    fs::write(dir.join("source.txt"), "baseline\n").expect("write source");
    let manager = WorktreeManager::new(WorktreeSettings::defaults(&profile));
    let binding = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: dir.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "dir-id".into(),
            owner: thread_owner("plain-thread"),
        })
        .await
        .expect("provision plain Thread");

    assert_eq!(binding.kind(), ManagedDirKind::Directory);
    assert_eq!(
        fs::read_to_string(binding.dir().join("source.txt")).unwrap(),
        "baseline\n"
    );
    assert!(!binding.dir().join(".git").exists());
    assert!(binding.repositories().is_empty());
    fs::write(dir.join("source.txt"), "main dir changed\n").unwrap();
    assert_eq!(
        fs::read_to_string(binding.dir().join("source.txt")).unwrap(),
        "baseline\n"
    );

    let binding_path = binding.checkout_root().join("ash-thread-dir.json");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding_path).unwrap()).unwrap();
    legacy["version"] = serde_json::json!(5);
    legacy["snapshotStore"] = serde_json::json!(profile.join("retired-directory-objects"));
    legacy.as_object_mut().unwrap().remove("owner");
    fs::write(&binding_path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let recovered = manager
        .recover_threads(&dir, "dir-id")
        .await
        .expect("recover plain Thread");
    assert_eq!(recovered, vec![("plain-thread".into(), binding.clone())]);
    let upgraded: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding_path).unwrap()).unwrap();
    assert_eq!(upgraded["version"], 6);
    assert!(upgraded.get("snapshotStore").is_none());
    assert_eq!(upgraded["owner"]["thread_id"], "plain-thread");
    manager
        .cleanup(&binding, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .expect("clean plain Thread");
    assert!(!binding.checkout_root().exists());
}

#[tokio::test]
async fn repository_identity_is_stable_across_different_selected_dirs() {
    let temp = TempDir::new().unwrap();
    let profile = temp.path().join("profile");
    let repository = temp.path().join("repository");
    fs::create_dir_all(&profile).unwrap();
    initialize_repository(&repository);
    let manager = WorktreeManager::new(WorktreeSettings::defaults(&profile));
    let first = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: repository.clone(),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "repository-root".into(),
            owner: ManagedDirOwner::Thread {
                thread_id: "thread-a".into(),
            },
        })
        .await
        .unwrap();
    let second = manager
        .provision(&ManagedDirProvisionRequest {
            source: ManagedDirSource::CurrentDirectory {
                source_directory: repository.join("nested/component"),
            },
            target: ManagedDirTarget::SourceHead,
            repository_targets: BTreeMap::new(),
            source_dir_id: "component-root".into(),
            owner: ManagedDirOwner::Thread {
                thread_id: "thread-b".into(),
            },
        })
        .await
        .unwrap();

    assert_eq!(
        first.repositories()[0].repository_id(),
        second.repositories()[0].repository_id()
    );

    manager
        .cleanup(&second, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
    manager
        .cleanup(&first, ManagedDirCleanupEligibility::AllChangeSetsSettled)
        .await
        .unwrap();
}

#[test]
fn desktop_settings_match_codex_defaults_and_validate_overrides() {
    let fixture = RepositoryFixture::new();
    let defaults = WorktreeSettings::defaults(&fixture.codex_home);
    assert_eq!(defaults.root, fixture.codex_home.join("worktrees"));
    assert!(defaults.auto_cleanup_enabled);
    assert_eq!(defaults.keep_count, 15);

    let custom_root = fixture.codex_home.join("custom-worktrees");
    let desktop = HashMap::from([
        (
            "git-worktree-root".to_string(),
            json!(custom_root.to_string_lossy().into_owned()),
        ),
        ("worktree-auto-cleanup-enabled".to_string(), json!(false)),
        ("worktree-keep-count".to_string(), json!(4)),
    ]);
    let custom = WorktreeSettings::from_desktop_config(&fixture.codex_home, &desktop)
        .expect("load custom settings");
    assert_eq!(custom.root, custom_root);
    assert!(!custom.auto_cleanup_enabled);
    assert_eq!(custom.keep_count, 4);

    for desktop in [
        HashMap::from([("git-worktree-root".to_string(), json!("relative/worktrees"))]),
        HashMap::from([("worktree-auto-cleanup-enabled".to_string(), json!("yes"))]),
        HashMap::from([("worktree-keep-count".to_string(), json!(0))]),
        HashMap::from([("worktree-keep-count".to_string(), json!(-1))]),
        HashMap::from([("worktree-keep-count".to_string(), json!(1.5))]),
    ] {
        assert!(WorktreeSettings::from_desktop_config(&fixture.codex_home, &desktop).is_err());
    }
}

fn initialize_repository(repository: &Path) {
    fs::create_dir_all(repository.join("nested/component")).expect("create repository directories");
    run_git(repository, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(repository.join("README.md"), "initial contents\n").expect("write README");
    fs::write(
        repository.join("nested/component/tracked.txt"),
        "nested contents\n",
    )
    .expect("write nested file");
    run_git(repository, &["add", "."]);
    run_git(
        repository,
        &["commit", "--quiet", "--no-gpg-sign", "-m", "initial"],
    );
}

fn run_git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(repository)
        .args([
            "-c",
            "user.name=Ash Worktree Test",
            "-c",
            "user.email=ash-worktree-test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
        ])
        .args(args)
        .output();
    let output = match output {
        Ok(output) => output,
        Err(error) => panic!("run git {args:?} in {repository:?}: {error}"),
    };
    assert!(
        output.status.success(),
        "git {args:?} failed in {repository:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("Git output is UTF-8")
        .trim()
        .to_string()
}

fn thread_owner(thread_id: &str) -> ManagedDirOwner {
    ManagedDirOwner::Thread {
        thread_id: thread_id.into(),
    }
}
