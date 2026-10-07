use std::path::Path;

use ash_async_utils::CancellationToken;
use ash_file_access::Authorization;

use crate::TargetKind;
use crate::TestItem;
use crate::TestSource;
use crate::TestingError;
use crate::discovery::test_id;
use crate::runner::execute;

/// rustdoc owns code-block attributes, cfg, crate injection and compilation expectations.
pub(crate) fn discover(
    read: &Authorization,
    command: &Authorization,
    package: &str,
    target: &str,
    directory: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<TestItem>, TestingError> {
    let output = execute(
        command,
        "cargo",
        &[
            "test", "-p", package, "--doc", "--", "--list", "--format", "terse",
        ],
        cancellation,
    )?;
    if output.exit_code != Some(0) || output.stdout_truncated {
        return Err(TestingError::Failed(format!(
            "Documentation test listing failed: {}",
            output.stderr
        )));
    }
    output
        .stdout
        .lines()
        .filter_map(|line| line.strip_suffix(": test"))
        .map(|name| {
            let (location, line) = name.rsplit_once(" (line ").ok_or_else(|| {
                TestingError::Failed("rustdoc returned an invalid test location".into())
            })?;
            let line = line
                .strip_suffix(')')
                .and_then(|line| line.parse::<usize>().ok())
                .filter(|line| *line > 0)
                .ok_or(TestingError::InvalidInput)?;
            let (file, _) = location
                .split_once(" - ")
                .ok_or(TestingError::InvalidInput)?;
            // Cargo invokes rustdoc from the workspace root, including for member packages.
            let path = read
                .dir()
                .canonical_path()
                .join(file)
                .canonicalize()
                .map_err(|error| TestingError::Failed(error.to_string()))?;
            let path = path
                .strip_prefix(read.dir().canonical_path())
                .map_err(|_| TestingError::PermissionRequired)?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(TestItem {
                id: test_id(package, TargetKind::Documentation, target, name),
                package: package.to_owned(),
                target: target.to_owned(),
                target_kind: TargetKind::Documentation,
                name: name.to_owned(),
                source: Some(TestSource { path, line }),
                debuggable: false,
                directory: directory.to_owned(),
            })
        })
        .collect()
}

/// rustdoc splits each --test-args value on whitespace, including names from --list.
/// Build a filter that selects precisely this catalog identity without changing the source.
pub(crate) fn selection_arguments(
    name: &str,
    names: &[String],
) -> Result<Vec<String>, TestingError> {
    if let Some(token) = name.split_whitespace().find(|token| {
        names
            .iter()
            .all(|other| other == name || !other.contains(token))
    }) {
        return Ok(vec![token.to_owned()]);
    }
    let mut arguments = Vec::new();
    for other in names.iter().filter(|other| other.as_str() != name) {
        let token = other
            .split_whitespace()
            .find(|token| !name.contains(token))
            .ok_or_else(|| {
                TestingError::Failed(
                    "rustdoc cannot uniquely select these whitespace-separated test names".into(),
                )
            })?;
        arguments.extend(["--skip".to_owned(), token.to_owned()]);
    }
    Ok(arguments)
}
