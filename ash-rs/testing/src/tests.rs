use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;

use crate::OperationStatus;
use crate::TestState;
use crate::TestingError;
use crate::TestingService;

fn fixture() -> (tempfile::TempDir, Grant) {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(temp.path().join("Cargo.toml"), "[package]\nname = \"testing-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n").unwrap();
    std::fs::write(temp.path().join("src/lib.rs"), r#"
#[cfg(test)]
mod checks {
    #[test] fn passes() { assert_eq!(2 + 2, 4); }
    #[test] fn fails() { panic!("fixture failure"); }
    #[test] #[ignore] fn ignored() {}
    #[test] fn slow() { std::fs::write("test-started", "running").unwrap(); std::thread::sleep(std::time::Duration::from_secs(20)); }
}
#[cfg(test)]
#[path = "separate checks.rs"]
mod separate;
"#).unwrap();
    std::fs::write(
        temp.path().join("src/separate checks.rs"),
        "#[test]\nfn from_file() {}\n",
    )
    .unwrap();
    std::fs::create_dir(temp.path().join("tests")).unwrap();
    std::fs::write(
        temp.path().join("tests/flow.rs"),
        "#[test]\nfn integration_passes() {}\n",
    )
    .unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let grant = Grant::for_environment(
        dir,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::ExecuteCommands]),
    );
    (temp, grant)
}

fn await_terminal(service: &TestingService, owner: u64, id: &str) -> crate::Snapshot {
    let started = Instant::now();
    loop {
        let snapshot = service.read(owner, id).unwrap();
        if snapshot.status != OperationStatus::Running {
            return snapshot;
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "operation did not finish"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn discovers_qualified_tests_and_runs_exact_pass_fail_and_ignored_cases() {
    let (_temp, grant) = fixture();
    let service = TestingService::default();
    service
        .discover(
            1,
            "catalog".into(),
            grant.authorize(Permission::ReadFiles).unwrap(),
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let catalog = await_terminal(&service, 1, "catalog");
    assert_eq!(
        catalog.status,
        OperationStatus::Completed,
        "{:?}",
        catalog.error
    );
    assert_eq!(
        catalog
            .tests
            .iter()
            .map(|test| test.name.as_str())
            .collect::<Vec<_>>(),
        [
            "checks::fails",
            "checks::ignored",
            "checks::passes",
            "checks::slow",
            "separate::from_file",
            "integration_passes"
        ]
    );
    assert!(
        catalog
            .tests
            .iter()
            .find(|test| test.name == "separate::from_file")
            .unwrap()
            .path
            .ends_with("separate checks.rs")
    );
    let selected = catalog
        .tests
        .iter()
        .filter(|test| test.name != "checks::slow")
        .map(|test| test.id.clone())
        .collect::<Vec<_>>();
    service
        .run(
            1,
            "run".into(),
            "catalog",
            &selected,
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let run = await_terminal(&service, 1, "run");
    assert_eq!(run.status, OperationStatus::Completed);
    assert_eq!(
        run.results
            .iter()
            .map(|result| result.state)
            .collect::<Vec<_>>(),
        [
            TestState::Failed,
            TestState::Skipped,
            TestState::Passed,
            TestState::Passed,
            TestState::Passed
        ],
        "{:?}",
        run.results
    );
    assert!(run.results[0].output.contains("fixture failure"));
    assert_eq!(run.results[0].failure_line, Some(5));
    service.release(1, "run").unwrap();
    assert!(matches!(
        service.read(1, "run"),
        Err(TestingError::NotFound)
    ));
}

#[test]
fn isolates_connections_and_cancel_waits_for_the_test_process() {
    let (temp, grant) = fixture();
    let service = TestingService::default();
    for owner in [1, 2] {
        service
            .discover(
                owner,
                "catalog".into(),
                grant.authorize(Permission::ReadFiles).unwrap(),
                grant.authorize(Permission::ExecuteCommands).unwrap(),
                Arc::new(|_| {}),
            )
            .unwrap();
    }
    let catalog = await_terminal(&service, 1, "catalog");
    await_terminal(&service, 2, "catalog");
    let slow = catalog
        .tests
        .iter()
        .find(|test| test.name == "checks::slow")
        .unwrap();
    service
        .run(
            1,
            "run".into(),
            "catalog",
            &[slow.id.clone()],
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    assert!(matches!(
        service.cancel(2, "run"),
        Err(TestingError::NotFound)
    ));
    let started = Instant::now();
    // The fixture marker proves the harness is running, including after Cargo compilation.
    while !temp.path().join("test-started").exists() {
        assert!(started.elapsed() < Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(10));
    }
    let snapshot = service.cancel(1, "run").unwrap();
    assert_eq!(snapshot.status, OperationStatus::Cancelled);
    assert_eq!(snapshot.results[0].state, TestState::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    service.close_owner(1);
    assert!(matches!(
        service.read(1, "catalog"),
        Err(TestingError::NotFound)
    ));
    assert_eq!(
        service.read(2, "catalog").unwrap().status,
        OperationStatus::Completed
    );
}

#[test]
fn rejects_unknown_tests_and_revoked_execution_authority() {
    let (_temp, grant) = fixture();
    let service = TestingService::default();
    service
        .discover(
            1,
            "catalog".into(),
            grant.authorize(Permission::ReadFiles).unwrap(),
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    await_terminal(&service, 1, "catalog");
    assert!(matches!(
        service.run(
            1,
            "run".into(),
            "catalog",
            &["missing".into()],
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {})
        ),
        Err(TestingError::InvalidInput)
    ));
    let read = grant.authorize(Permission::ReadFiles).unwrap();
    let execute = grant.authorize(Permission::ExecuteCommands).unwrap();
    grant.revoke();
    assert!(matches!(
        service.discover(1, "revoked".into(), read, execute, Arc::new(|_| {})),
        Err(TestingError::PermissionRequired)
    ));
}

#[test]
fn exact_execution_rejects_cfg_filtered_cases_and_bounds_output() {
    let (temp, grant) = fixture();
    std::fs::write(
        temp.path().join("src/lib.rs"),
        r#"
#[cfg(any())]
#[test] fn disabled() {}
#[test] fn r#match() { println!("{}", "x".repeat(20000)); }
"#,
    )
    .unwrap();
    let service = TestingService::default();
    service
        .discover(
            1,
            "catalog".into(),
            grant.authorize(Permission::ReadFiles).unwrap(),
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let catalog = await_terminal(&service, 1, "catalog");
    assert_eq!(
        catalog
            .tests
            .iter()
            .map(|test| test.name.as_str())
            .collect::<Vec<_>>(),
        ["disabled", "r#match", "integration_passes"]
    );
    assert!(
        catalog.tests[..2]
            .iter()
            .all(|test| test.path == "src/lib.rs")
    );
    assert_eq!(catalog.tests[2].path, "tests/flow.rs");
    service
        .run(
            1,
            "run".into(),
            "catalog",
            &catalog
                .tests
                .iter()
                .map(|test| test.id.clone())
                .collect::<Vec<_>>(),
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let run = await_terminal(&service, 1, "run");
    assert_eq!(
        run.results
            .iter()
            .map(|result| result.state)
            .collect::<Vec<_>>(),
        [TestState::Errored, TestState::Passed, TestState::Passed],
        "{:?}",
        run.results
            .iter()
            .map(|result| (&result.state, &result.output))
            .collect::<Vec<_>>()
    );
    assert!(run.results[1].output_truncated);
    assert_eq!(run.results[1].output.len(), 16 * 1024);
}

#[test]
fn source_module_cycles_fail_discovery_without_recursive_launches() {
    let (temp, grant) = fixture();
    std::fs::write(
        temp.path().join("src/lib.rs"),
        "#[path=\"lib.rs\"] mod recursive;\n",
    )
    .unwrap();
    let service = TestingService::default();
    service
        .discover(
            1,
            "catalog".into(),
            grant.authorize(Permission::ReadFiles).unwrap(),
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let catalog = await_terminal(&service, 1, "catalog");
    assert_eq!(catalog.status, OperationStatus::Failed);
    assert!(catalog.error.unwrap().contains("cycle"));
}
