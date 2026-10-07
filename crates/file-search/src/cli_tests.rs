use super::*;
use std::fs;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[test]
fn parses_codex_style_search_arguments() {
    let cli = Cli::try_parse_from([
        "ash-file-search",
        "--json",
        "--limit",
        "7",
        "--threads",
        "1",
        "-C",
        "directory",
        "--compute-indices",
        "src",
    ])
    .unwrap();

    assert!(cli.json);
    assert_eq!(cli.limit.get(), 7);
    assert_eq!(cli.threads.get(), 1);
    assert_eq!(cli.cwd, Some(PathBuf::from("directory")));
    assert!(cli.compute_indices);
    assert_eq!(cli.pattern.as_deref(), Some("src"));
}

#[test]
fn json_output_uses_the_library_search_results() {
    let directory = temporary_dir();
    fs::create_dir_all(directory.join("src")).unwrap();
    fs::write(directory.join("src/lib.rs"), "contents").unwrap();
    fs::write(directory.join("notes.md"), "contents").unwrap();
    let cli = Cli::try_parse_from([
        "ash-file-search",
        "--json",
        "--compute-indices",
        "-C",
        directory.to_str().unwrap(),
        "lib",
    ])
    .unwrap();
    let mut output = Vec::new();
    let mut warnings = Vec::new();

    execute(cli, &mut output, &mut warnings, TerminalOutput::Plain).unwrap();

    let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["path"], "src/lib.rs");
    assert!(value["score"].as_u64().is_some());
    assert!(
        value["indices"]
            .as_array()
            .is_some_and(|indices| !indices.is_empty())
    );
    assert!(warnings.is_empty());
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn omitted_pattern_lists_dir_files_in_plain_text() {
    let directory = temporary_dir();
    fs::write(directory.join("alpha.rs"), "contents").unwrap();
    fs::write(directory.join("beta.rs"), "contents").unwrap();
    let cli = Cli::try_parse_from(["ash-file-search", "-C", directory.to_str().unwrap()]).unwrap();
    let mut output = Vec::new();
    let mut warnings = Vec::new();

    execute(cli, &mut output, &mut warnings, TerminalOutput::Plain).unwrap();

    assert_eq!(String::from_utf8(output).unwrap(), "alpha.rs\nbeta.rs\n");
    assert!(warnings.is_empty());
    let _ = fs::remove_dir_all(directory);
}

fn temporary_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ash-file-search-cli-tests-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
