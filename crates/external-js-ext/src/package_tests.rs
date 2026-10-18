use super::Package;
use super::resolve;

#[test]
fn resolves_only_runtime_and_package_relative_modules() {
    assert_eq!(
        resolve("lib/main.js", "../helper.mjs").unwrap(),
        "helper.mjs"
    );
    assert_eq!(resolve("@ash/vscode", "./host.mjs").unwrap(), "@ash/host");
    for path in [
        "@ash/extension",
        "node:fs",
        "fs",
        "electron",
        "../../outside.js",
        "./../outside.js",
        "./a\\b.js",
    ] {
        assert!(resolve("main.js", path).is_err(), "{path}");
    }
}

#[test]
fn captures_module_bytes_before_execution_and_rejects_missing_entry() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.js"), "export function activate() {}").unwrap();
    std::fs::write(
        root.path().join("package.json"),
        r#"{"publisher":"test","name":"fixture"}"#,
    )
    .unwrap();
    let package = Package::read("example".into(), root.path().into(), "main.js".into()).unwrap();
    std::fs::write(root.path().join("main.js"), "changed").unwrap();
    assert!(package.sources["main.js"].contains("export function activate() {}"));
    assert!(package.sources.contains_key("@ash/host"));
    assert!(Package::read("example".into(), root.path().into(), "missing.js".into()).is_err());
    assert!(Package::read("example".into(), root.path().into(), "../main.js".into()).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_linked_modules() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("actual.js"),
        "export function activate() {}",
    )
    .unwrap();
    std::os::unix::fs::symlink("actual.js", root.path().join("main.js")).unwrap();
    assert!(Package::read("example".into(), root.path().into(), "main.js".into()).is_err());
}

#[test]
fn bounds_package_scan_before_reading_a_large_module() {
    let root = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(root.path().join("main.js")).unwrap();
    file.set_len(super::MAX_MODULE_BYTES as u64 + 1).unwrap();
    assert!(Package::read("example".into(), root.path().into(), "main.js".into()).is_err());
}

#[test]
fn commonjs_snapshot_captures_data_and_modules_without_compiling_unused_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("package.json"),
        "{\"publisher\":\"test\",\"name\":\"fixture\"}",
    )
    .unwrap();
    std::fs::write(root.path().join("main.cjs"), "exports.activate = () => {};").unwrap();
    std::fs::write(root.path().join("data.json"), "{\"value\":\"captured\"}").unwrap();
    std::fs::write(root.path().join("unused.js"), "unused invalid source }").unwrap();
    let package =
        Package::read_vscode("example".into(), root.path().into(), "main.cjs".into()).unwrap();
    std::fs::write(root.path().join("data.json"), "changed").unwrap();
    assert_eq!(
        package
            .sources
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "@ash/commonjs",
            "@ash/host",
            "@ash/scm.js",
            "@ash/vscode",
            "main.cjs"
        ]
    );
    assert!(package.sources["main.cjs"].contains("captured"));
    assert!(package.sources["main.cjs"].contains("unused invalid source"));
    assert!(!package.sources.contains_key("data.json"));
    assert!(
        Package::read_vscode("example".into(), root.path().into(), "data.json".into()).is_err()
    );
    let data = std::fs::File::create(root.path().join("oversized.json")).unwrap();
    data.set_len(super::MAX_MODULE_BYTES as u64 + 1).unwrap();
    assert!(Package::read_vscode("example".into(), root.path().into(), "main.cjs".into()).is_err());
}
#[test]
fn vscode_bootstrap_uses_ascii_literals_and_preserves_unicode_package_sources() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("工作区🚀");
    std::fs::create_dir(&directory).unwrap();
    let source = "exports.activate = () => '東京🚀\u{2028}\u{2029}';";
    std::fs::write(directory.join("入口.cjs"), source).unwrap();
    std::fs::write(directory.join("package.json"), r#"{"publisher":"example","name":"unicode","contributes":{"commands":[{"command":"example.open","title":"打开🚀"}]}}"#).unwrap();
    let package =
        Package::read_vscode("example.unicode".into(), directory, "入口.cjs".into()).unwrap();
    let wrapper = &package.sources["入口.cjs"];
    assert!(wrapper.is_ascii());
    let (_, literal) = wrapper.split_once("loadCommonJS(JSON.parse(").unwrap();
    let encoded_sources = serde_json::Deserializer::from_str(literal)
        .into_iter::<String>()
        .next()
        .unwrap()
        .unwrap();
    let sources: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&encoded_sources).unwrap();
    assert_eq!(sources["入口.cjs"], source);
}
