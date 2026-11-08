use super::StorageWorktreeCleanupParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_async_utils::CancellationSource;
use ash_protocol::CommandId;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionKind;
use ash_protocol::ThreadArchiveReason;
use core_api::AgentRuntime;
use core_api::StartThreadRequest;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

#[test]
fn storage_cleanup_rechecks_archive_after_restore_from_another_directory_host() {
    let profile = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let other_directory = tempfile::tempdir().unwrap();
    for args in [
        &["init", "--quiet", "--initial-branch=main"][..],
        &[
            "-c",
            "user.name=Ash Test",
            "-c",
            "user.email=ash@example.test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        let output = Command::new("git")
            .current_dir(repo.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }
    let profile_runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |directory: &Path| {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .without_built_in_skills()
                .with_profile_runtime(Arc::clone(&profile_runtime))
                .with_dir_root(directory),
            ash_app_server_diff::compute,
        )
        .unwrap()
    };
    let storage_host = open(repo.path());
    let restore_host = open(other_directory.path());
    let thread = storage_host
        .start_thread(StartThreadRequest {
            kind: SessionKind::Code,
            execution_target: Some(SessionExecutionTarget::Local {
                root: repo.path().to_path_buf(),
            }),
            branch_name: None,
            worktree_start: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("storage-create").unwrap(),
            title: "Storage fixture".into(),
        })
        .unwrap();
    storage_host
        .agent_runtime()
        .archive_session(
            &thread.session_id,
            &CommandId::new("storage-archive").unwrap(),
            ThreadArchiveReason::Completed,
        )
        .unwrap();
    let overview = storage_host
        .storage_overview(
            &storage_host.product_host_connection(),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let params: StorageWorktreeCleanupParams =
        serde_json::from_value(overview["worktrees"][0]["identity"].clone()).unwrap();
    storage_host.validate_archived_worktree(&params).unwrap();

    // Restore between the pre-hook check and the protected removal phase.
    restore_host
        .agent_runtime()
        .restore_session(&thread.session_id)
        .unwrap();

    let runtime = storage_host.git_turn_changes.as_ref().unwrap();
    let refused = storage_host
        .remove_authorized_worktree(runtime, &params)
        .unwrap_err();
    assert_eq!(refused.message, AppServerErrorName::CommandConflict);
    assert!(Path::new(&params.checkout_root).is_dir());
}
