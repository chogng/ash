use super::*;
use std::fs;
use std::sync::Arc;
use test_binary_support::TestBinary;

fn dir_fixture() -> (tempfile::TempDir, Dir, ResolvedFilePath) {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join(".git")).unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let authorization = ash_file_access::Authorization::evaluate(
        ash_file_access::GrantSubject::Environment(root.env().clone()),
        root.clone(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([ash_file_access::Permission::InspectRepository]),
        ash_file_access::Permission::InspectRepository,
    )
    .unwrap();
    let resolved = ResolvedFilePath {
        root: root.clone(),
        authorization,
        relative: PathBuf::new(),
        absolute: root.canonical_path().to_path_buf(),
    };
    (directory, root, resolved)
}

#[test]
fn fast_regex_backend_is_agent_scoped_and_tracks_watcher_changes() {
    let (directory, root, resolved) = dir_fixture();
    let source = directory.path().join("source.rs");
    fs::write(&source, "before_marker\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let service = AgentGrepService::new(AgentGrepBackend::FastRegex, ripgrep, None);
    let cancellation = ash_async_utils::CancellationSource::new();
    assert!(!service.has_active_index(&root));

    let first = service
        .execute(
            "before_marker".into(),
            &resolved,
            None,
            false,
            &cancellation.token(),
        )
        .unwrap();
    assert!(matches!(first, ToolExecutionOutput::Success(text) if text.contains("before_marker")));
    assert!(service.has_active_index(&root));

    fs::write(&source, "after_marker\n").unwrap();
    service.apply_watcher_event(
        &root,
        &FileWatcherEvent::PathsChanged {
            paths: vec![source],
        },
    );
    let second = service
        .execute(
            "after_marker".into(),
            &resolved,
            None,
            false,
            &cancellation.token(),
        )
        .unwrap();
    assert!(matches!(second, ToolExecutionOutput::Success(text) if text.contains("after_marker")));

    let ripgrep_service = service.reconfigured(AgentGrepBackend::Ripgrep, service.ripgrep.clone());
    assert_eq!(service.backend, AgentGrepBackend::FastRegex);
    assert_eq!(ripgrep_service.backend, AgentGrepBackend::Ripgrep);
    assert!(Arc::ptr_eq(&service.indexes, &ripgrep_service.indexes));
    assert!(!service.watches_fast_regex());
    assert!(!service.has_active_index(&root));
}

#[test]
fn fast_regex_backend_uses_the_private_worker_client() {
    let (directory, root, resolved) = dir_fixture();
    let storage = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("source.rs"), "worker_marker\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let binary = worker_binary();
    let command = FastRegexWorkerCommand::new(binary.executable(), binary.arguments());
    let service = AgentGrepService::new_with_worker(
        AgentGrepBackend::FastRegex,
        ripgrep,
        Arc::new(ash_state::StateRuntime::open(storage.path()).unwrap()),
        command,
    );

    let output = service
        .execute(
            "worker_marker".into(),
            &resolved,
            None,
            false,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();

    let ToolExecutionOutput::Success(output) = output else {
        panic!("worker-backed search failed: {output:?}");
    };
    assert!(
        output.contains("worker_marker"),
        "worker-backed search returned: {output}"
    );
    assert!(service.has_active_index(&root));
}

#[test]
fn disabling_fast_regex_releases_but_preserves_its_project_index() {
    let (directory, root, resolved) = dir_fixture();
    let profile = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("source.rs"), "disable_marker\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let storage = Arc::new(ash_state::StateRuntime::open(profile.path()).unwrap());
    let service = AgentGrepService::new(
        AgentGrepBackend::FastRegex,
        ripgrep.clone(),
        Some(Arc::clone(&storage)),
    );
    service
        .execute(
            "disable_marker".into(),
            &resolved,
            None,
            false,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    let index_directory = storage.index_directory(&root.id(), DirIndexKind::AgentGrep);
    assert!(index_directory.join("manifests").is_dir());

    let disabled = service.reconfigured(AgentGrepBackend::Ripgrep, ripgrep);

    assert!(!disabled.watches_fast_regex());
    assert!(!disabled.has_active_index(&root));
    assert!(index_directory.is_dir());
    assert_eq!(
        storage
            .clear_index(&root.id(), DirIndexKind::AgentGrep)
            .unwrap(),
        ash_state::ClearOutcome::Cleared
    );
}

fn worker_binary() -> TestBinary {
    TestBinary::test(module_path!(), "fast_regex_worker_child").unwrap()
}

#[test]
#[ignore = "started by the worker-backed Agent grep test"]
fn fast_regex_worker_child() {
    worker_binary().dispatch(|| ash_fast_regex_search::serve_worker_from_environment().map(|()| 0));
}

#[test]
fn fast_regex_backend_applies_regex_glob_case_and_result_limit_semantics() {
    let (directory, _, resolved) = dir_fixture();
    fs::write(
        directory.path().join("source.rs"),
        (0..101)
            .map(|index| format!("AUTH_{index}_TOKEN\n"))
            .collect::<String>(),
    )
    .unwrap();
    fs::write(directory.path().join("source.txt"), "AUTH_999_TOKEN\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let service = AgentGrepService::new(AgentGrepBackend::FastRegex, ripgrep, None);

    let output = service
        .execute(
            r"auth_[0-9]+_token".into(),
            &resolved,
            Some("*.rs".into()),
            true,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();

    let ToolExecutionOutput::Success(output) = output else {
        panic!("fast regex search should succeed");
    };
    assert_eq!(
        output
            .lines()
            .filter(|line| line.contains(":AUTH_"))
            .count(),
        100
    );
    assert!(output.contains("[more than 100 matches, showing first 100]"));
    assert!(!output.contains("source.txt"));
}

#[test]
fn fast_regex_backend_returns_validation_failures_and_honors_pre_cancellation() {
    let (directory, _, resolved) = dir_fixture();
    fs::write(directory.path().join("source.rs"), "marker\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let service = AgentGrepService::new(AgentGrepBackend::FastRegex, ripgrep, None);
    let invalid = service
        .execute(
            "(".into(),
            &resolved,
            None,
            false,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert!(
        matches!(invalid, ToolExecutionOutput::Failure(message) if message.contains("regular expression is invalid"))
    );

    let cancellation = ash_async_utils::CancellationSource::new();
    cancellation.cancel();
    let cancelled = service.execute(
        "marker".into(),
        &resolved,
        None,
        false,
        &cancellation.token(),
    );
    assert!(matches!(cancelled, Err(CoreError::Cancelled(_))));
}

#[cfg(unix)]
#[test]
fn ripgrep_backend_executes_the_frozen_binary_without_creating_an_index() {
    use std::os::unix::fs::PermissionsExt;

    let (directory, root, resolved) = dir_fixture();
    let executable = directory.path().join("rg-test");
    fs::write(&executable, "#!/bin/sh\nprintf '%s' \"$*\"\n").unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&executable, permissions).unwrap();
    let ripgrep = RipgrepExecutable::from_path(executable).unwrap();
    let service = AgentGrepService::new(AgentGrepBackend::Ripgrep, ripgrep, None);

    let output = service
        .execute(
            "-leading-dash".into(),
            &resolved,
            Some("*.rs".into()),
            true,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();

    let ToolExecutionOutput::Success(text) = output else {
        panic!("ripgrep should succeed: {output:?}");
    };
    assert!(text.contains("--no-config -n --no-heading -i --glob *.rs"));
    assert!(text.contains("-- -leading-dash"));
    for glob in crate::local_tools::LOCAL_DENIED_GLOBS {
        assert!(text.contains(&format!("--glob !{glob}")));
    }
    assert!(!service.watches_fast_regex());
    assert!(!service.has_active_index(&root));
}
