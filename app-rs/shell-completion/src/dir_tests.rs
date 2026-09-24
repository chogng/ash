use std::fs;

use super::DirCatalog;
use super::MAX_DIR_SOURCE_BYTES;

#[test]
fn discovers_package_scripts_and_dir_recipes() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("package.json"),
        r#"{"scripts":{"dev":"vite","test:unit":"vitest"}}"#,
    )
    .unwrap();
    fs::write(root.path().join("Justfile"), "build:\n    cargo build\n").unwrap();
    fs::write(
        root.path().join("Makefile"),
        "release: build\n\techo done\n",
    )
    .unwrap();
    let nested = root.path().join("src");
    fs::create_dir(&nested).unwrap();

    let catalog = DirCatalog::discover(&nested);

    assert!(catalog.description(&path(&["npm", "run"]), "dev").is_some());
    assert!(catalog.description(&path(&["pnpm"]), "dev").is_some());
    assert!(catalog.description(&path(&["yarn"]), "test:unit").is_some());
    assert!(catalog.description(&path(&["just"]), "build").is_some());
    assert!(catalog.description(&path(&["make"]), "release").is_some());
}

#[test]
fn oversized_dir_sources_are_ignored() {
    let root = tempfile::tempdir().unwrap();
    let mut package = r#"{"scripts":{"dev":"vite"}}"#.to_owned();
    package.push_str(&" ".repeat(MAX_DIR_SOURCE_BYTES as usize + 1));
    fs::write(root.path().join("package.json"), package).unwrap();

    let catalog = DirCatalog::discover(root.path());

    assert!(catalog.description(&path(&["npm", "run"]), "dev").is_none());
}

fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}
