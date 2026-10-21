use super::*;
use crate::ReloadableModule;

// These native-emission tests isolate rustc/publication. The real bridge gate is
// covered through the compiler process and workspace integration scenario.
fn build(repository: &Path, directory: &Path) -> Result<bool, String> {
    super::build(
        repository,
        directory,
        &compiler()?,
        &mut |_| Ok(Some(serde_json::json!({"fixture": true}))),
        &mut crate::check::Checker::default(),
    )
}

const ORIGINAL: &str = "// 😀 source offsets are bytes\nconst OTHER: usize = 1;\nfn zero_based_line_index(line_number: usize) -> usize {\n    line_number.saturating_sub(1)\n}\n";

fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(SOURCE)).unwrap();
    std::fs::create_dir_all(root.path().join(".cargo")).unwrap();
    std::fs::write(root.path().join(SOURCE).join("lib.rs"), ORIGINAL).unwrap();
    std::fs::write(
        root.path().join("crates/app-server-diff/Cargo.toml"),
        "[package]\nname=\"ash-app-server-diff\"\nversion=\"0.0.0\"\nedition=\"2024\"\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("Cargo.toml"),
        r#"
[workspace]
[profile.dev]
opt-level = 1
[profile.dev.package.ash-app-server-diff]
opt-level = "s"
[profile.dev-small]
inherits = "dev"
debug = "none"
strip = "symbols"
lto = "off"
[profile.dev-small.package.ash-app-server-diff]
codegen-units = 256
"#,
    )
    .unwrap();
    std::fs::write(root.path().join("Cargo.lock"), "version = 4\n").unwrap();
    std::fs::write(
        root.path().join("rust-toolchain.toml"),
        include_str!("../../../rust-toolchain.toml"),
    )
    .unwrap();
    // Use the real host linker/CRT settings; the generated function manifest has
    // no copy of these settings and must discover its caller's Cargo config.
    std::fs::write(
        root.path().join(".cargo/config.toml"),
        include_str!("../../../.cargo/config.toml"),
    )
    .unwrap();
    root
}

fn edit(root: &Path, expression: &str) {
    std::fs::write(
        root.join(SOURCE).join("lib.rs"),
        ORIGINAL.replace("line_number.saturating_sub(1)", expression),
    )
    .unwrap();
}

#[test]
fn extraction_rejects_contextual_names_and_context_changes() {
    let root = repository();
    let first = snapshot(root.path()).unwrap();
    assert!(
        first
            .files
            .contains_key("crates/app-server-diff/src/lib.rs")
    );
    assert!(first.files.keys().all(|path| !path.contains('\\')));
    for expression in [
        "line_number.saturating_sub(0)",
        "if line_number > 0 { line_number - 1 } else { 0 }",
        "line_number + true", // rustc, rather than the selector, diagnoses types.
    ] {
        edit(root.path(), expression);
        let next = snapshot(root.path()).unwrap();
        assert_eq!(first.context, next.context);
        assert!(next.function.is_some());
    }
    edit(root.path(), "\nline_number.saturating_sub(0)");
    assert_ne!(
        first.context,
        snapshot(root.path()).unwrap().context,
        "changing the position of later macros requires a module build"
    );
    for expression in [
        "OTHER",
        "usize::MAX",
        "helper(line_number)",
        "line_number.custom_method()",
        "{ let other = line_number; other }",
        "{ fn nested() -> usize { 1 } nested() }",
        "line!()",
        "unsafe { line_number }",
        "loop {}",
        "{ use std::usize; line_number }",
        "{ #[cfg(any())] line_number; 0 }",
    ] {
        edit(root.path(), expression);
        assert!(
            snapshot(root.path()).unwrap().function.is_none(),
            "{expression}"
        );
    }
    std::fs::write(
        root.path().join(SOURCE).join("lib.rs"),
        ORIGINAL.replace("OTHER: usize = 1", "OTHER: usize = 2"),
    )
    .unwrap();
    assert_ne!(first.context, snapshot(root.path()).unwrap().context);
    std::fs::write(
        root.path().join(SOURCE).join("lib.rs"),
        ORIGINAL.replace("-> usize", "-> u32"),
    )
    .unwrap();
    assert!(snapshot(root.path()).unwrap().context.is_none());
    edit(root.path(), "line_number.saturating_sub(1)");
    std::fs::write(root.path().join(SOURCE).join("new.rs"), "fn other() {}\n").unwrap();
    assert_ne!(first.context, snapshot(root.path()).unwrap().context);
    let manifest: toml::Value = toml::from_str(&function_manifest(root.path()).unwrap()).unwrap();
    assert_eq!(manifest["profile"]["dev"]["opt-level"].as_str(), Some("s"));
    assert_eq!(
        manifest["profile"]["dev-small"]["codegen-units"].as_integer(),
        Some(256)
    );
}

#[test]
fn a_stale_module_baseline_preserves_the_current_module_and_function_namespace() {
    let root = repository();
    let directory = root.path().join("published");
    std::fs::create_dir(&directory).unwrap();
    let current = directory.join("current.json");
    std::fs::write(&current, b"old module").unwrap();
    let source = snapshot(root.path()).unwrap();
    save_baseline(
        root.path(),
        &directory,
        &source,
        &digest(b"old"),
        b"old module",
    )
    .unwrap();
    let baseline = std::fs::read(directory.join("baseline.json")).unwrap();
    edit(root.path(), "line_number.saturating_sub(2)");
    assert!(
        save_baseline(
            root.path(),
            &directory,
            &source,
            &digest(b"new"),
            b"pending module"
        )
        .is_err()
    );
    assert_eq!(std::fs::read(current).unwrap(), b"old module");
    assert_eq!(
        std::fs::read(directory.join("baseline.json")).unwrap(),
        baseline
    );
}

#[test]
fn native_function_updates_without_rebuilding_module_and_retains_failed_generation() {
    let root = repository();
    let directory = root.path().join("published");
    std::fs::create_dir_all(&directory).unwrap();
    let module_manifest = b"full module remains unchanged";
    std::fs::write(directory.join("current.json"), module_manifest).unwrap();
    let generation = digest(b"test module");
    save_baseline(
        root.path(),
        &directory,
        &snapshot(root.path()).unwrap(),
        &generation,
        module_manifest,
    )
    .unwrap();
    let function_directory = directory.join("functions").join(&generation).join(FUNCTION);
    let loader = ReloadableModule::new_usize(function_directory.clone());
    assert!(loader.usize_function().is_err());
    edit(root.path(), "line_number.saturating_sub(0)");
    assert!(
        !super::build(
            root.path(),
            &directory,
            &compiler().unwrap(),
            &mut |_| Ok(None),
            &mut crate::check::Checker::default()
        )
        .unwrap()
    );
    assert!(
        loader.usize_function().is_err(),
        "failed semantic gate cannot publish a function"
    );
    assert!(build(root.path(), &directory).unwrap());
    let first = loader.usize_function().unwrap();
    assert_eq!(first.call(3).unwrap(), 3);
    edit(root.path(), "line_number.saturating_sub(2)");
    assert!(build(root.path(), &directory).unwrap());
    assert_eq!(loader.usize_function().unwrap().call(3).unwrap(), 1);
    assert_eq!(first.call(3).unwrap(), 3, "old request retains old image");
    assert_eq!(
        std::fs::read(directory.join("current.json")).unwrap(),
        module_manifest
    );
    let pointer = std::fs::read(function_directory.join("current.json")).unwrap();
    edit(root.path(), "line_number.saturating_sub(true)");
    assert!(build(root.path(), &directory).is_err());
    assert_eq!(
        std::fs::read(function_directory.join("current.json")).unwrap(),
        pointer
    );
    assert_eq!(loader.usize_function().unwrap().call(3).unwrap(), 1);
    edit(root.path(), "line_number / (line_number - 1)");
    assert!(build(root.path(), &directory).unwrap());
    let function = loader.usize_function().unwrap();
    assert!(
        function.call(1).is_err(),
        "panic is contained inside the DLL"
    );
    assert_eq!(function.call(3).unwrap(), 1);
    let mut wrong: crate::reload::Manifest =
        serde_json::from_slice(&std::fs::read(function_directory.join("current.json")).unwrap())
            .unwrap();
    wrong.kind = ImageKind::Json;
    std::fs::write(
        function_directory.join("current.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert_eq!(loader.usize_function().unwrap().call(3).unwrap(), 1);
    edit(root.path(), "OTHER");
    assert!(!build(root.path(), &directory).unwrap());
    std::fs::write(
        root.path().join(SOURCE).join("lib.rs"),
        ORIGINAL.replace("OTHER: usize = 1", "OTHER: usize = 2"),
    )
    .unwrap();
    assert!(!build(root.path(), &directory).unwrap());
    edit(root.path(), "line_number.saturating_sub(0)");
    std::fs::write(directory.join("current.json"), b"different full module").unwrap();
    assert!(!build(root.path(), &directory).unwrap());
    std::fs::write(directory.join("current.json"), module_manifest).unwrap();
    let mut baseline: Baseline =
        serde_json::from_slice(&std::fs::read(directory.join("baseline.json")).unwrap()).unwrap();
    baseline.native_configuration = false;
    std::fs::write(
        directory.join("baseline.json"),
        serde_json::to_vec(&baseline).unwrap(),
    )
    .unwrap();
    assert!(
        !build(root.path(), &directory).unwrap(),
        "removing flags cannot reuse a custom baseline"
    );
}

#[test]
fn dependent_body_edits_require_an_exclusive_graph_and_preserve_other_native_context() {
    use ash_rust_build_ir as ir;
    let root_path = "crates/app-server-diff/src/lib.rs";
    let helper_path = "crates/app-server-diff/src/projection.rs";
    let root = "mod projection;\nfn zero_based_line_index(line_number: usize) -> usize {\n    projection::index(line_number)\n}\n";
    let helper = "pub(super) fn index(value: usize) -> usize {\n    value.saturating_sub(1)\n}\n";
    let previous = BTreeMap::from([
        (root_path.into(), root.into()),
        (helper_path.into(), helper.into()),
    ]);
    let mut current = previous.clone();
    current.insert(helper_path.into(), helper.replace("sub(1)", "sub(2)"));
    let definition = |name: &str, path: &str| ir::Function {
        name: name.into(),
        source_path: path.into(),
        name_start: 0,
        exclusive: true,
        public: false,
        source: String::new(),
        source_start: 0,
        body_start: 1,
        body_end: 2,
        parameters: vec![],
        result: ir::Scalar::Unit,
        locals: vec![ir::Scalar::Unit],
        blocks: vec![],
    };
    // These descriptors only select source bodies for invalidation; execution IR
    // is separately checked at the bridge boundary.
    let mut graph = ir::Program {
        version: ir::VERSION,
        root: 0,
        crate_root: String::new(),
        functions: vec![
            definition(FUNCTION, root_path),
            definition("index", helper_path),
        ],
        sources: vec![],
        check: ir::CheckMode::Package,
    };
    assert!(graph_context_matches(&previous, &current, &graph).unwrap());
    graph.functions[1].exclusive = false;
    assert!(!graph_context_matches(&previous, &current, &graph).unwrap());
    graph.functions[1].exclusive = true;
    current.insert(
        helper_path.into(),
        helper.replace("value: usize", "value: u32"),
    );
    assert!(!graph_context_matches(&previous, &current, &graph).unwrap());
    current.insert(
        helper_path.into(),
        helper.replace("sub(1)", "sub(2)") + "\nconst OTHER: usize = 1;\n",
    );
    assert!(!graph_context_matches(&previous, &current, &graph).unwrap());
}
