use super::Package;
use super::resolve;

#[test]
fn resolves_only_sdk_and_package_relative_modules() {
    assert_eq!(
        resolve("lib/main.js", "../helper.mjs").unwrap(),
        "helper.mjs"
    );
    assert_eq!(
        resolve("main.js", "@ash/extension").unwrap(),
        "@ash/extension"
    );
    for path in [
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
    let package = Package::read("example".into(), root.path().into(), "main.js".into()).unwrap();
    std::fs::write(root.path().join("main.js"), "changed").unwrap();
    assert_eq!(package.sources["main.js"], "export function activate() {}");
    assert!(package.sources.contains_key("@ash/extension"));
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
