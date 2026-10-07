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
            .source
            .as_ref()
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
fn compiled_listing_omits_cfg_filtered_cases_and_bounds_output() {
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
        ["r#match", "integration_passes"]
    );
    assert_eq!(catalog.tests[0].source.as_ref().unwrap().path, "src/lib.rs");
    assert_eq!(
        catalog.tests[1].source.as_ref().unwrap().path,
        "tests/flow.rs"
    );
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
        [TestState::Passed, TestState::Passed],
        "{:?}",
        run.results
            .iter()
            .map(|result| (&result.state, &result.output))
            .collect::<Vec<_>>()
    );
    assert!(run.results[0].output_truncated);
    assert_eq!(run.results[0].output.len(), 16 * 1024);
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

#[test]
fn compiled_macros_async_doctests_and_debug_preparation_use_real_toolchains() {
    let (temp, grant) = fixture();
    std::fs::write(temp.path().join("Cargo.toml"), "[package]\nname = \"testing-fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n[workspace]\n[dev-dependencies]\ntokio = { version = \"1\", features = [\"macros\", \"rt\"] }\n").unwrap();
    std::fs::write(
        temp.path().join("src/lib.rs"),
        r#"
/// ```
/// assert_eq!(2 + 2, 4);
/// ```
/// ```compile_fail
/// let _: u8 = "invalid";
/// ```
/// ```no_run
/// panic!("must not execute");
/// ```
/// ```ignore
/// panic!("ignored");
/// ```
/// ```
/// std::fs::write("unexpected-doc-run", "failed").unwrap();
/// panic!("documentation failure");
/// ```
pub fn documented() {}
#[cfg(test)] macro_rules! generated { () => { #[test] fn generated_case() { assert_eq!(3, 3); } } }
#[cfg(test)] generated!();
#[cfg(test)] #[tokio::test] async fn asynchronous() { assert_eq!(async { 4 }.await, 4); }
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
        catalog.status,
        OperationStatus::Completed,
        "{:?}",
        catalog.error
    );
    let generated = catalog
        .tests
        .iter()
        .find(|test| test.name == "generated_case")
        .unwrap();
    assert!(generated.source.is_none());
    let asynchronous = catalog
        .tests
        .iter()
        .find(|test| test.name == "asynchronous")
        .unwrap();
    assert!(asynchronous.source.is_some());
    let docs = catalog
        .tests
        .iter()
        .filter(|test| test.target_kind == crate::TargetKind::Documentation)
        .collect::<Vec<_>>();
    assert_eq!(docs.len(), 5);
    assert!(
        docs.iter()
            .all(|test| !test.debuggable && test.source.is_some())
    );
    let failing = docs
        .iter()
        .find(|test| test.source.as_ref().unwrap().line == 14)
        .unwrap();
    let selected = catalog
        .tests
        .iter()
        .filter(|test| test.id != failing.id)
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
    assert_eq!(
        run.results
            .iter()
            .filter(|result| result.state == TestState::Passed)
            .count(),
        6,
        "{:?}",
        run.results
    );
    assert_eq!(
        run.results
            .iter()
            .filter(|result| result.state == TestState::Skipped)
            .count(),
        1
    );
    assert!(
        !temp.path().join("unexpected-doc-run").exists(),
        "Selecting other doctests must not execute the failing block"
    );
    service
        .run(
            1,
            "failed-doc".into(),
            "catalog",
            &[failing.id.clone()],
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {}),
        )
        .unwrap();
    let failed = await_terminal(&service, 1, "failed-doc");
    assert_eq!(
        failed.results[0].state,
        TestState::Failed,
        "{:?}",
        failed.results
    );
    assert!(failed.results[0].output.contains("documentation failure"));
    assert!(temp.path().join("unexpected-doc-run").exists());
    assert!(matches!(
        service.prepare_debug(
            2,
            "foreign".into(),
            "catalog",
            &generated.id,
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {})
        ),
        Err(TestingError::NotFound)
    ));
    for (id, test) in [("macro-debug", generated), ("async-debug", asynchronous)] {
        service
            .prepare_debug(
                1,
                id.into(),
                "catalog",
                &test.id,
                grant.authorize(Permission::ExecuteCommands).unwrap(),
                Arc::new(|_| {}),
            )
            .unwrap();
        let prepared = await_terminal(&service, 1, id);
        assert_eq!(
            prepared.status,
            OperationStatus::Completed,
            "{:?}",
            prepared.error
        );
        let launch = prepared.launch.unwrap();
        assert!(std::path::Path::new(&launch.program).is_file());
        assert_eq!(&launch.arguments[..2], ["--exact", test.name.as_str()]);
        assert_eq!(
            std::path::Path::new(&launch.directory),
            temp.path().canonicalize().unwrap()
        );
        service.release(1, id).unwrap();
    }
    assert!(matches!(
        service.prepare_debug(
            1,
            "doc-debug".into(),
            "catalog",
            &failing.id,
            grant.authorize(Permission::ExecuteCommands).unwrap(),
            Arc::new(|_| {})
        ),
        Err(TestingError::InvalidInput)
    ));
}

#[test]
fn workspace_member_tests_use_package_directory_and_workspace_source_paths() {
    let (temp, grant) = fixture();
    let member = temp.path().join("member");
    std::fs::create_dir(&member).unwrap();
    for file in ["Cargo.toml", "src", "tests"] {
        std::fs::rename(temp.path().join(file), member.join(file)).unwrap();
    }
    std::fs::write(
        temp.path().join("Cargo.toml"),
        "[workspace]\nmembers=[\"member\"]\nresolver=\"2\"\n",
    )
    .unwrap();
    std::fs::write(
        member.join("Cargo.toml"),
        "[package]\nname=\"member-fixture\"\nversion=\"0.1.0\"\nedition=\"2024\"\n",
    )
    .unwrap();
    std::fs::write(member.join("src/lib.rs"), "/// ```\n/// assert_eq!(std::env::current_dir().unwrap().file_name().unwrap(), \"member\");\n/// ```\npub fn docs() {}\n#[test] fn package_directory() { assert_eq!(std::env::current_dir().unwrap().file_name().unwrap(), \"member\"); }\n").unwrap();
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
    assert_eq!(catalog.tests.len(), 3);
    assert!(
        catalog
            .tests
            .iter()
            .all(|test| test.source.as_ref().unwrap().path.starts_with("member/"))
    );
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
        [TestState::Passed, TestState::Passed, TestState::Passed],
        "{:?}",
        run.results
    );
}
