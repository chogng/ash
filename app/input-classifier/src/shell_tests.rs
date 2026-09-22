use std::fs;

use super::ShellContext;
use crate::tests::command_dir;

#[test]
fn cargo_workspace_commands_and_described_arguments_cross_the_strict_threshold() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("Cargo.toml"), "[workspace]\n").unwrap();
    let commands = command_dir(&["cargo"]);
    let mut context = ShellContext::new(root.path());
    context.set_path_entries([commands.path().to_path_buf()]);

    assert!(
        context
            .analyze("cargo build --release --workspace")
            .is_likely_shell_command(4)
    );
    assert!(
        !context
            .analyze("cargo build is failing")
            .is_likely_shell_command(4)
    );
}

#[test]
fn a_known_first_command_is_enough_only_for_short_input() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("Justfile"), "build:\n    cargo build\n").unwrap();
    let commands = command_dir(&["just"]);
    let mut context = ShellContext::new(root.path());
    context.set_path_entries([commands.path().to_path_buf()]);

    assert!(context.analyze("just build").is_likely_shell_command(2));
    assert!(
        !context
            .analyze("just explain this failure")
            .is_likely_shell_command(4)
    );
}

#[test]
fn an_existing_path_inside_prose_is_not_enough_shell_evidence() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("trace.log"), "failure\n").unwrap();
    let context = ShellContext::new(root.path());

    assert!(
        !context
            .analyze("look at trace.log please")
            .is_likely_shell_command(4)
    );
}
