use std::path::PathBuf;

use pretty_assertions::assert_eq;

use super::GitPatchDirection;
use super::GitPatchDisposition;
use super::GitPatchExecution;
use super::GitPatchRequest;
use super::extract_patch_paths;
use crate::GitClient;
use crate::test_support::TestRepository;

#[test]
fn extracts_quoted_renamed_and_deleted_paths() {
    let patch = concat!(
        "diff --git \"a/space name.txt\" \"b/space name.txt\"\n",
        "diff --git a/old.txt b/new.txt\n",
        "diff --git a/deleted.txt b/deleted.txt\n",
        "--- a/deleted.txt\n",
        "+++ /dev/null\n",
    );

    assert_eq!(
        extract_patch_paths(patch),
        vec![
            PathBuf::from("deleted.txt"),
            PathBuf::from("new.txt"),
            PathBuf::from("old.txt"),
            PathBuf::from("space name.txt"),
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn checks_then_applies_patch_with_structured_paths() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "old\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "new\n");
    let patch = repository.git_raw(&["diff", "--binary"]);
    repository.git(&["checkout", "--", "tracked.txt"]);

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let check = client
        .apply_patch(
            &opened,
            &GitPatchRequest::new(
                patch.clone(),
                GitPatchExecution::Check,
                GitPatchDirection::Forward,
            ),
        )
        .await
        .expect("check patch");
    assert_eq!(check.disposition(), GitPatchDisposition::Applicable);
    assert_eq!(check.referenced_paths(), &[PathBuf::from("tracked.txt")]);
    assert_eq!(check.applied_paths(), &[] as &[PathBuf]);
    assert_eq!(check.exit_code(), Some(0));
    assert_eq!(repository.read("tracked.txt"), "old\n");

    let applied = client
        .apply_patch(
            &opened,
            &GitPatchRequest::new(patch, GitPatchExecution::Apply, GitPatchDirection::Forward),
        )
        .await
        .expect("apply patch");
    assert_eq!(applied.disposition(), GitPatchDisposition::Applied);
    assert_eq!(applied.applied_paths(), &[PathBuf::from("tracked.txt")]);
    assert_eq!(applied.exit_code(), Some(0));
    assert_eq!(repository.read("tracked.txt"), "new\n");
}

#[cfg(windows)]
#[tokio::test(flavor = "current_thread")]
async fn applies_patch_when_the_repository_uses_autocrlf() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "old\n");
    repository.commit_all("initial");
    repository.git(&["config", "core.autocrlf", "true"]);
    repository.write("tracked.txt", "new\n");
    let patch = repository.git_raw(&["diff", "--binary"]);
    repository.git(&["checkout", "--", "tracked.txt"]);

    let client = GitClient::system();
    let opened = client.open_repository(repository.root()).await.unwrap();
    let applied = client
        .apply_patch(
            &opened,
            &GitPatchRequest::new(patch, GitPatchExecution::Apply, GitPatchDirection::Forward),
        )
        .await
        .unwrap();

    assert_eq!(applied.disposition(), GitPatchDisposition::Applied);
    assert_eq!(
        repository.read("tracked.txt").replace("\r\n", "\n"),
        "new\n"
    );
    assert_eq!(repository.git_raw(&["show", ":tracked.txt"]), "new\n");
}

#[tokio::test(flavor = "current_thread")]
async fn reports_git_rejection_as_a_completed_patch_result() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "old\n");
    repository.commit_all("initial");
    repository.write("tracked.txt", "new\n");
    let patch = repository.git_raw(&["diff", "--binary"]);
    repository.write("tracked.txt", "incompatible\n");

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let result = client
        .apply_patch(
            &opened,
            &GitPatchRequest::new(patch, GitPatchExecution::Apply, GitPatchDirection::Forward),
        )
        .await
        .expect("Git rejection is not a transport error");

    assert_eq!(result.disposition(), GitPatchDisposition::Rejected);
    assert_ne!(result.exit_code(), Some(0));
    assert_eq!(result.conflicted_paths(), &[PathBuf::from("tracked.txt")]);
    assert_eq!(repository.read("tracked.txt"), "incompatible\n");
}

#[tokio::test(flavor = "current_thread")]
async fn distinguishes_three_way_conflicts_from_unapplied_rejection() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "base\n");
    repository.commit_all("base");
    repository.git(&["checkout", "-b", "patch-source"]);
    repository.write("tracked.txt", "theirs\n");
    repository.commit_all("theirs");
    let patch = repository.git_raw(&["diff", "main..patch-source", "--binary"]);
    repository.git(&["checkout", "main"]);
    repository.write("tracked.txt", "ours\n");
    repository.commit_all("ours");

    let client = GitClient::system();
    let opened = client
        .open_repository(repository.root())
        .await
        .expect("open repository");
    let result = client
        .apply_patch(
            &opened,
            &GitPatchRequest::new(patch, GitPatchExecution::Apply, GitPatchDirection::Forward),
        )
        .await
        .expect("complete conflicted apply");

    assert_eq!(
        result.disposition(),
        GitPatchDisposition::AppliedWithConflicts
    );
    assert_eq!(result.conflicted_paths(), &[PathBuf::from("tracked.txt")]);
    assert_ne!(result.exit_code(), Some(0));
    assert!(repository.read("tracked.txt").contains("<<<<<<< ours"));
}
