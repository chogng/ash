use super::AshHome;
use ash_utils_absolute_path::AbsolutePathBuf;
use std::fs;

#[test]
fn loads_shared_and_ash_user_instructions_and_refreshes() {
    let root = tempfile::tempdir().unwrap();
    let instructions = root.path().join("instructions");
    fs::create_dir(&instructions).unwrap();
    fs::write(root.path().join("AGENTS.md"), "Shared instructions.").unwrap();
    fs::write(
        instructions.join("global.md"),
        "---\nname: global\nload: global\n---\n\nFirst version.\n",
    )
    .unwrap();
    let home = AshHome::new(AbsolutePathBuf::from_absolute(root.path()).unwrap());

    let first = home.instructions();
    assert_eq!(first.entries().len(), 1);
    assert!(first.global_content().unwrap().contains("First version."));
    assert!(
        first
            .global_content()
            .unwrap()
            .contains("Shared instructions.")
    );

    fs::write(
        instructions.join("global.md"),
        "---\nname: global\nload: global\n---\n\nSecond version.\n",
    )
    .unwrap();
    let second = home.instructions();
    assert!(second.generation() > first.generation());
    assert!(second.global_content().unwrap().contains("Second version."));
}

#[test]
fn missing_home_instructions_are_empty() {
    let root = tempfile::tempdir().unwrap();
    let home = AshHome::new(AbsolutePathBuf::from_absolute(root.path()).unwrap());

    let snapshot = home.instructions();
    assert!(snapshot.entries().is_empty());
    assert!(snapshot.diagnostics().is_empty());
}
