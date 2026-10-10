use super::support;
use ash_sandboxing::FileSystemAccess;
use ash_tool_executor::CommandInput;
use std::path::Path;

#[test]
fn system_launchers_start_with_closed_and_supplied_stdin() {
    let temp = tempfile::tempdir().unwrap();
    let scope = support::scope(temp.path());
    let probes = [
        // xcodebuild queries this through confstr before loading its runtime.
        // A successful tool exit alone can hide failed directory discovery.
        (
            "/usr/bin/getconf",
            vec!["DARWIN_USER_CACHE_DIR"],
            "/",
            Vec::new(),
        ),
        (
            "/usr/bin/python3",
            vec![
                "-c",
                "import sys; assert sys.stdin.buffer.read() == b''; print('python-started')",
            ],
            "python-started",
            Vec::new(),
        ),
        ("/usr/bin/git", vec!["--version"], "git version", Vec::new()),
        (
            "/usr/bin/xcrun",
            vec!["--find", "python3"],
            "/python3",
            Vec::new(),
        ),
        (
            "/usr/bin/python3",
            vec![
                "-c",
                "import sys; assert sys.stdin.buffer.read() == b'launcher-input'; print('python-input')",
            ],
            "python-input",
            b"launcher-input".to_vec(),
        ),
    ];
    let mut failures = Vec::new();
    for (program, arguments, expected, bytes) in probes {
        // Prove the host has the tool and that the exact invocation works before
        // attributing a failure to confinement. Do not resolve away the launcher.
        // Use the executor for the control too, so a broken host launcher has
        // the same timeout and process-tree cleanup as a sandboxed invocation.
        let control = support::run_control(
            &scope,
            Path::new(program),
            arguments
                .iter()
                .map(|argument| (*argument).into())
                .collect(),
            if bytes.is_empty() {
                CommandInput::Closed
            } else {
                CommandInput::Bytes(bytes.clone())
            },
        )
        .unwrap();
        assert_eq!(control.exit_code, Some(0), "{program}: {control:?}");
        assert!(control.stdout.contains(expected));
        for access in [
            FileSystemAccess::ReadOnly,
            FileSystemAccess::DirectoryWrite,
            FileSystemAccess::FullAccess,
        ] {
            let input = if bytes.is_empty() {
                CommandInput::Closed
            } else {
                CommandInput::Bytes(bytes.clone())
            };
            let result = support::run(
                &scope,
                access,
                Path::new(program),
                arguments
                    .iter()
                    .map(|argument| (*argument).into())
                    .collect(),
                input,
            );
            match result {
                Ok(output) if output.exit_code == Some(0) && output.stdout.contains(expected) => {}
                other => failures.push(format!("{program} ({access:?}): {other:?}")),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "launcher failures:\n{}",
        failures.join("\n")
    );
}
