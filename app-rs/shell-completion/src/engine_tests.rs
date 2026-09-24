use std::fs;
use std::path::PathBuf;

use super::ShellAlias;
use super::ShellCompletionEngine;
use super::ShellTokenKind;
use crate::completion::ShellCompletionKind;
use crate::registry::ShellCommandRegistry;
use crate::registry::ShellCommandSpec;

#[test]
fn signatures_describe_commands_subcommands_options_and_exact_values() {
    let engine = ShellCompletionEngine::for_working_directory(".");
    let snapshot = engine.analyze("git log --oneline --decorate -20");

    assert_eq!(
        kinds(&snapshot),
        vec![
            Some(ShellTokenKind::Command),
            Some(ShellTokenKind::Subcommand),
            Some(ShellTokenKind::Option),
            Some(ShellTokenKind::Option),
            Some(ShellTokenKind::Option),
        ]
    );
}

#[test]
fn pipelines_reset_command_positions_and_describe_wrapped_commands() {
    let engine = ShellCompletionEngine::for_working_directory(".");
    let snapshot = engine.analyze("find . -type f | xargs grep -n TODO && sudo git status");

    let command_tokens = snapshot
        .tokens()
        .iter()
        .filter(|token| token.position().token_index == 0)
        .map(|token| token.text())
        .collect::<Vec<_>>();
    assert_eq!(command_tokens, vec!["find", "xargs", "sudo"]);
    assert_eq!(kind(&snapshot, "grep"), Some(ShellTokenKind::Command));
    assert_eq!(kind(&snapshot, "git"), Some(ShellTokenKind::Command));
    assert_eq!(kind(&snapshot, "status"), Some(ShellTokenKind::Subcommand));
}

#[test]
fn unknown_options_and_natural_language_are_not_claimed_as_shell_evidence() {
    let engine = ShellCompletionEngine::for_working_directory(".");
    let snapshot = engine.analyze("git status 是做什么的 --invented");

    assert_eq!(kind(&snapshot, "git"), Some(ShellTokenKind::Command));
    assert_eq!(kind(&snapshot, "status"), Some(ShellTokenKind::Subcommand));
    assert_eq!(kind(&snapshot, "是做什么的"), None);
    assert_eq!(kind(&snapshot, "--invented"), None);
}

#[test]
fn aliases_expand_recursively_into_command_grammar() {
    let mut engine = ShellCompletionEngine::for_working_directory(".");
    engine.replace_aliases([
        ShellAlias::new("gco", "git checkout").unwrap(),
        ShellAlias::new("work", "gco -b").unwrap(),
    ]);

    let snapshot = engine.analyze("work feature");

    assert_eq!(kind(&snapshot, "work"), Some(ShellTokenKind::Alias));
    assert_eq!(kind(&snapshot, "feature"), None);
    assert!(
        snapshot.tokens()[0]
            .description()
            .and_then(|description| description.detail())
            .is_some_and(|detail| detail.contains("gco -b"))
    );
}

#[test]
fn cyclic_aliases_do_not_create_false_command_evidence() {
    let mut engine = ShellCompletionEngine::for_working_directory(".");
    engine.replace_aliases([
        ShellAlias::new("left", "right").unwrap(),
        ShellAlias::new("right", "left").unwrap(),
    ]);

    assert_eq!(kind(&engine.analyze("left"), "left"), None);
}

#[test]
fn dir_scripts_and_recipes_are_exact_argument_evidence() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("package.json"),
        r#"{"scripts":{"dev":"vite"}}"#,
    )
    .unwrap();
    fs::write(root.path().join("Justfile"), "build:\n    cargo build\n").unwrap();
    let commands = command_dir(&["npm", "just"]);
    let mut engine = ShellCompletionEngine::for_working_directory(root.path());
    engine.set_path_entries([commands.path().to_path_buf()]);

    assert_eq!(
        kind(&engine.analyze("npm run dev"), "dev"),
        Some(ShellTokenKind::Argument)
    );
    assert_eq!(
        kind(&engine.analyze("just build"), "build"),
        Some(ShellTokenKind::Argument)
    );
    assert_eq!(kind(&engine.analyze("npm run invented"), "invented"), None);
}

#[test]
fn path_and_redirection_evidence_require_existing_paths() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("input.txt"), "input").unwrap();
    fs::write(root.path().join("output.log"), "output").unwrap();
    let engine = ShellCompletionEngine::for_working_directory(root.path());
    let snapshot = engine.analyze("cat input.txt > output.log");

    assert_eq!(kind(&snapshot, "input.txt"), Some(ShellTokenKind::Path));
    assert_eq!(
        kind(&snapshot, "output.log"),
        Some(ShellTokenKind::RedirectionTarget)
    );
    assert_eq!(
        kind(&engine.analyze("cat missing.txt"), "missing.txt"),
        None
    );
}

#[test]
fn path_snapshot_can_be_replaced_by_the_product_environment() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("ash-demo-command");
    fs::write(&executable, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut engine = ShellCompletionEngine::with_registry(".", ShellCommandRegistry::new());
    engine.set_path_entries([PathBuf::from(root.path())]);

    assert_eq!(
        kind(&engine.analyze("ash-demo-command"), "ash-demo-command"),
        Some(ShellTokenKind::Command)
    );
}

#[test]
fn default_signatures_do_not_claim_uninstalled_external_commands() {
    let mut engine = ShellCompletionEngine::for_working_directory(".");
    engine.set_path_entries([]);

    assert_eq!(
        kind(&engine.analyze("echo"), "echo"),
        Some(ShellTokenKind::Command)
    );
    assert_eq!(kind(&engine.analyze("kubectl"), "kubectl"), None);
    assert!(
        engine
            .complete("kube", 4)
            .into_iter()
            .all(|completion| completion.replacement() != "kubectl")
    );
}

#[test]
fn completions_cover_commands_subcommands_options_dir_values_and_paths() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("package.json"),
        r#"{"scripts":{"develop":"vite"}}"#,
    )
    .unwrap();
    fs::create_dir(root.path().join("source")).unwrap();
    fs::write(root.path().join("source file.txt"), "source").unwrap();
    let commands = command_dir(&["git", "find", "npm", "cat"]);
    let mut engine = ShellCompletionEngine::for_working_directory(root.path());
    engine.set_path_entries([commands.path().to_path_buf()]);

    assert_completion(&engine, "gi", "git", ShellCompletionKind::Command, 0..2);
    assert_completion(
        &engine,
        "git ch",
        "checkout",
        ShellCompletionKind::Subcommand,
        4..6,
    );
    assert_completion(
        &engine,
        "git checkout --d",
        "--detach",
        ShellCompletionKind::Option,
        13..16,
    );
    assert_completion(
        &engine,
        "find . -type=",
        "f",
        ShellCompletionKind::Value,
        13..13,
    );
    assert_completion(
        &engine,
        "npm run de",
        "develop",
        ShellCompletionKind::Value,
        8..10,
    );
    assert_completion(
        &engine,
        "cat so",
        "source/",
        ShellCompletionKind::Path,
        4..6,
    );
    assert_completion(
        &engine,
        "cat source\\ ",
        "source\\ file.txt",
        ShellCompletionKind::Path,
        4..12,
    );
    assert_completion(
        &engine,
        "cat \"source ",
        "\"source file.txt\"",
        ShellCompletionKind::Path,
        4..12,
    );
    assert_completion(
        &engine,
        "git status && gi",
        "git",
        ShellCompletionKind::Command,
        14..16,
    );
    assert_completion_at_cursor(
        &engine,
        "git cheout",
        7,
        "checkout",
        ShellCompletionKind::Subcommand,
        4..10,
    );
}

#[test]
fn custom_registries_extend_the_engine_without_changing_the_parser() {
    let mut registry = ShellCommandRegistry::new();
    registry.register(ShellCommandSpec::new("acme", "Acme developer command"));
    let engine = ShellCompletionEngine::with_registry(".", registry);

    assert_eq!(
        kind(&engine.analyze("acme"), "acme"),
        Some(ShellTokenKind::Command)
    );
}

#[test]
fn exact_tokens_do_not_produce_noop_completions() {
    let engine = ShellCompletionEngine::for_working_directory(".");

    assert!(engine.complete_snapshot("echo", 4).has_exact_match());
    assert!(
        engine
            .complete("git", 3)
            .into_iter()
            .all(|completion| completion.replacement() != "git")
    );
    assert!(
        engine
            .complete("git checkout --detach", 21)
            .into_iter()
            .all(|completion| completion.replacement() != "--detach")
    );
}

#[test]
fn a_committed_unknown_command_does_not_restart_top_level_completion() {
    let engine = ShellCompletionEngine::for_working_directory(".");

    assert!(engine.complete("explain ", 8).is_empty());
}

#[test]
fn command_separator_completion_is_shell_syntax_aware() {
    let engine = ShellCompletionEngine::for_working_directory(".");

    let separator_completions = engine.complete("echo done\n", "echo done\n".len());
    assert!(!separator_completions.is_empty());
    assert!(separator_completions.iter().all(|completion| {
        completion.replace_range() == ("echo done\n".len().."echo done\n".len())
    }));
    assert!(engine.complete("echo \\|", "echo \\|".len()).is_empty());
    assert!(engine.complete("echo '#'", "echo '#'".len()).is_empty());
}

fn command_dir(commands: &[&str]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for command in commands {
        let path = dir.path().join(command);
        fs::write(&path, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    dir
}

fn kinds(snapshot: &super::ShellTokenSnapshot) -> Vec<Option<ShellTokenKind>> {
    snapshot
        .tokens()
        .iter()
        .map(|token| token.description().map(|description| description.kind()))
        .collect()
}

fn kind(snapshot: &super::ShellTokenSnapshot, text: &str) -> Option<ShellTokenKind> {
    snapshot
        .tokens()
        .iter()
        .find(|token| token.text() == text)
        .and_then(|token| token.description())
        .map(|description| description.kind())
}

fn assert_completion(
    engine: &ShellCompletionEngine,
    input: &str,
    replacement: &str,
    expected_kind: ShellCompletionKind,
    expected_range: std::ops::Range<usize>,
) {
    assert_completion_at_cursor(
        engine,
        input,
        input.len(),
        replacement,
        expected_kind,
        expected_range,
    );
}

fn assert_completion_at_cursor(
    engine: &ShellCompletionEngine,
    input: &str,
    cursor: usize,
    replacement: &str,
    expected_kind: ShellCompletionKind,
    expected_range: std::ops::Range<usize>,
) {
    let completion = engine
        .complete(input, cursor)
        .into_iter()
        .find(|completion| completion.replacement() == replacement)
        .unwrap_or_else(|| panic!("missing completion {replacement:?} for {input:?}"));
    assert_eq!(completion.kind(), expected_kind);
    assert_eq!(completion.replace_range(), expected_range);
}
