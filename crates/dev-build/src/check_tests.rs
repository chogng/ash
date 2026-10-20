use super::*;

fn toolchain(root: &Path) -> PathBuf {
    let toolchain = root.join("toolchain");
    std::fs::create_dir_all(toolchain.join("bin")).unwrap();
    std::fs::create_dir_all(toolchain.join("lib/rustlib/host/lib")).unwrap();
    std::fs::write(toolchain.join("bin/rustc"), "compiler").unwrap();
    std::fs::write(toolchain.join("lib/rustlib/host/lib/std.rmeta"), "stdlib").unwrap();
    toolchain
}

#[test]
fn replay_inputs_track_content_file_sets_missing_config_and_toolchain_installation() {
    let root = tempfile::tempdir().unwrap();
    let dependency = root.path().join("dependency");
    std::fs::create_dir(&dependency).unwrap();
    let source = dependency.join("lib.rs");
    std::fs::write(&source, "first").unwrap();
    let config = root.path().join("config.toml");
    let inputs = Inputs {
        trees: BTreeSet::from([dependency.clone()]),
        files: BTreeSet::from([config.clone()]),
        toolchain: toolchain(root.path()),
    };
    let first = inputs.fingerprint().unwrap();
    std::fs::write(&source, "other").unwrap();
    assert_ne!(
        first,
        inputs.fingerprint().unwrap(),
        "equal-size content edits invalidate"
    );
    std::fs::write(&source, "first").unwrap();
    assert_eq!(first, inputs.fingerprint().unwrap());
    std::fs::write(dependency.join("new.rs"), "new module").unwrap();
    assert_ne!(first, inputs.fingerprint().unwrap());
    std::fs::remove_file(dependency.join("new.rs")).unwrap();
    std::fs::write(config, "[build]").unwrap();
    assert_ne!(first, inputs.fingerprint().unwrap());
    let before = inputs.fingerprint().unwrap();
    std::fs::write(
        inputs.toolchain.join("lib/rustlib/host/lib/std.rmeta"),
        "new standard library",
    )
    .unwrap();
    assert_ne!(before, inputs.fingerprint().unwrap());
}

#[test]
fn captured_check_rechecks_the_whole_original_crate_and_never_writes_cargo_outputs() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("src")).unwrap();
    std::fs::write(
        root.path().join("src/lib.rs"),
        "mod helper; pub fn entry(value: usize) -> usize { helper::value(value) }\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("Cargo.toml"),
        "[package]\nname=\"fixture\"\nversion=\"0.0.0\"\n",
    )
    .unwrap();
    let helper = root.path().join("src/helper.rs");
    std::fs::write(
        &helper,
        "pub(super) fn value(input: usize) -> usize { input + 1 }\n",
    )
    .unwrap();
    let executable = Command::new("rustup")
        .args(["which", "rustc"])
        .output()
        .unwrap();
    assert!(executable.status.success());
    let cargo_output = root.path().join("cargo");
    std::fs::create_dir(&cargo_output).unwrap();
    let sentinel = cargo_output.join("libfixture.rmeta");
    std::fs::write(&sentinel, "Cargo owns this artifact").unwrap();
    let invocation = Invocation {
        executable: String::from_utf8(executable.stdout).unwrap().trim().into(),
        arguments: vec![
            "--crate-name".into(),
            "fixture".into(),
            "--crate-type".into(),
            "lib".into(),
            "--edition=2024".into(),
            "--error-format=json".into(),
            "--emit=dep-info,metadata".into(),
            "src/lib.rs".into(),
            "--out-dir".into(),
            cargo_output.to_str().unwrap().into(),
            "-C".into(),
            format!("incremental={}", cargo_output.join("incremental").display()),
        ],
        directory: root.path().to_path_buf(),
        environment: BTreeMap::new(),
    };
    let private = root.path().join("private");
    assert!(invocation.run(&private).unwrap());
    std::fs::write(
        &helper,
        "pub(super) fn value(input: usize) -> usize { let answer = input; answer = 0; answer }\n",
    )
    .unwrap();
    assert!(
        !invocation.run(&private).unwrap(),
        "borrow/type checks are still active"
    );
    std::fs::write(
        &helper,
        "pub(super) fn value(input: usize) -> usize { input }\nfn unrelated() -> usize { true }\n",
    )
    .unwrap();
    assert!(
        !invocation.run(&private).unwrap(),
        "an error outside the replacement graph is checked"
    );
    assert_eq!(
        std::fs::read_to_string(sentinel).unwrap(),
        "Cargo owns this artifact"
    );
    assert!(!cargo_output.join("incremental").exists());
    // A dependency can change while RA is analyzing after the initial ticket.
    // The final freshness guard must reject that otherwise-valid rustc result.
    std::fs::write(
        &helper,
        "pub(super) fn value(input: usize) -> usize { input }\n",
    )
    .unwrap();
    let dependency = root.path().join("registry-input");
    std::fs::write(&dependency, "before").unwrap();
    let package = Package::for_source(root.path(), "src/lib.rs").unwrap();
    let snapshot = package.snapshot(root.path()).unwrap();
    let inputs = Inputs {
        trees: BTreeSet::new(),
        files: BTreeSet::from([dependency.clone()]),
        toolchain: toolchain(root.path()),
    };
    let fingerprint = inputs.fingerprint().unwrap();
    let mut checker = Checker {
        checkpoint: Some(Checkpoint {
            package: package.directory.clone(),
            configuration: configuration(&snapshot),
            environment: environment().unwrap(),
            inputs,
            fingerprint,
            invocation,
        }),
        prepared: None,
    };
    assert!(!checker.inputs_changed(&package, &snapshot));
    std::fs::write(dependency, "changed during analysis").unwrap();
    assert!(
        matches!(checker.check(root.path(), &package, &snapshot, &private, Policy::Reuse), Err(error) if error.contains("dependencies changed"))
    );
    assert!(checker.checkpoint.is_none());
}

#[test]
fn dependency_inputs_cover_path_git_sources_artifacts_and_external_build_inputs() {
    let root = tempfile::tempdir().unwrap();
    let owner = root.path().join("owner");
    let dependency = root.path().join("dependency");
    for directory in [&owner, &dependency] {
        std::fs::create_dir_all(directory.join("src")).unwrap();
        std::fs::write(
            directory.join("Cargo.toml"),
            "[package]\nname=\"fixture\"\nversion=\"0.0.0\"\n",
        )
        .unwrap();
        std::fs::write(directory.join("src/lib.rs"), "pub fn entry() {}\n").unwrap();
    }
    let package = Package {
        name: "fixture".into(),
        directory: owner.canonicalize().unwrap(),
    };
    let invocation = Invocation {
        executable: toolchain(root.path()).join("bin/rustc"),
        arguments: vec![
            "--crate-type".into(),
            "lib".into(),
            "--emit=dep-info,metadata".into(),
            owner.join("src/lib.rs").to_str().unwrap().into(),
        ],
        directory: root.path().to_path_buf(),
        environment: BTreeMap::new(),
    };
    let artifact = root.path().join("libfixture-123.rmeta");
    std::fs::write(&artifact, "metadata").unwrap();
    std::fs::write(
        root.path().join("fixture-123.d"),
        format!("output: {}\n", dependency.join("src/lib.rs").display()),
    )
    .unwrap();
    let external = root.path().join("external.json");
    std::fs::write(&external, "schema").unwrap();
    let mut message = serde_json::json!({"reason":"compiler-artifact","package_id":"path+file:///dependency#fixture@0.0.0","target":{"kind":["lib"],"src_path":dependency.join("src/lib.rs")},"filenames":[artifact]});
    let initial = prepare(root.path(), &package, &[message.clone()], &invocation).unwrap();
    let first = initial.fingerprint().unwrap();
    std::fs::write(dependency.join("new.rs"), "new module").unwrap();
    assert_ne!(first, initial.fingerprint().unwrap());
    std::fs::remove_file(dependency.join("new.rs")).unwrap();
    std::fs::write(&artifact, "changed metadata").unwrap();
    assert_ne!(first, initial.fingerprint().unwrap());
    std::fs::write(&artifact, "metadata").unwrap();
    std::fs::write(dependency.join("src/lib.rs"), "invalid Rust!").unwrap();
    assert_ne!(first, initial.fingerprint().unwrap());
    message["package_id"] = "git+https://example.test/fixture?rev=123#123".into();
    assert!(prepare(root.path(), &package, &[message.clone()], &invocation).is_ok());
    let out = root.path().join("build/out");
    std::fs::create_dir_all(&out).unwrap();
    let script = serde_json::json!({"reason":"build-script-executed","package_id":message["package_id"],"out_dir":out,"linked_paths":[]});
    std::fs::write(
        out.parent().unwrap().join("output"),
        "cargo::rerun-if-changed=../external.json\ncargo:rerun-if-env-changed=SCHEMA_DIR\n",
    )
    .unwrap();
    let inputs = prepare(
        root.path(),
        &package,
        &[message.clone(), script],
        &invocation,
    )
    .unwrap();
    let before = inputs.fingerprint().unwrap();
    std::fs::write(&external, "new schema").unwrap();
    assert_ne!(before, inputs.fingerprint().unwrap());
    let before = inputs.fingerprint().unwrap();
    std::fs::write(out.join("generated.rs"), "generated code").unwrap();
    assert_ne!(before, inputs.fingerprint().unwrap());
    message["package_id"] = "registry+https://example.test#index#fixture@0.0.0".into();
    let registry = prepare(root.path(), &package, &[message], &invocation).unwrap();
    let before = registry.fingerprint().unwrap();
    std::fs::write(dependency.join("src/lib.rs"), "another edit").unwrap();
    assert_ne!(
        before,
        registry.fingerprint().unwrap(),
        "active registry sources also use content guards"
    );
    let owner_script = serde_json::json!({"reason":"build-script-executed","package_id":"path+file:///owner#fixture@0.0.0","out_dir":out});
    assert!(prepare(root.path(), &package, &[owner_script], &invocation).is_err());
}

#[test]
fn dep_info_handles_drive_letters_spaces_and_phony_rules() {
    let paths = dep_sources("C:\\build\\libtest.d: C:\\source\\lib.rs relative\\ file.rs\n\nrelative\\ file.rs:\n# env-dep:IGNORED=value\n").unwrap();
    assert_eq!(
        paths,
        [
            PathBuf::from("C:\\source\\lib.rs"),
            PathBuf::from("relative file.rs")
        ]
    );
    assert!(dep_sources("malformed").is_err());
    assert!(dep_sources("output: ").is_err());
    assert!(dep_sources("output: trailing\\").is_err());
}

#[test]
fn content_guards_read_the_entire_artifact_and_reject_oversized_inputs() {
    let root = tempfile::tempdir().unwrap();
    let artifact = root.path().join("large.rmeta");
    let mut content = vec![7; 2 * 1024 * 1024];
    std::fs::write(&artifact, &content).unwrap();
    let inputs = Inputs {
        trees: BTreeSet::new(),
        files: BTreeSet::from([artifact.clone()]),
        toolchain: toolchain(root.path()),
    };
    let before = inputs.fingerprint().unwrap();
    *content.last_mut().unwrap() = 8;
    std::fs::write(&artifact, content).unwrap();
    assert_ne!(
        before,
        inputs.fingerprint().unwrap(),
        "the tail must participate in the content guard"
    );
    std::fs::File::options()
        .write(true)
        .open(&artifact)
        .unwrap()
        .set_len(513 * 1024 * 1024)
        .unwrap();
    assert!(inputs.fingerprint().unwrap_err().contains("replay budget"));
}
