use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use ash_async_utils::CancellationToken;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use ash_sandboxing::SandboxBackends;
use exec_server::execution::CommandExecutionAuthority;
use exec_server::execution::CommandExecutionOutcome;
use exec_server::execution::CommandInput;
use exec_server::execution::CommandOutput;
use exec_server::execution::CommandRequest;
use exec_server::execution::ExecutionError;
use exec_server::execution::ExecutionLimits;
use exec_server::execution::ProcessExecutor;

use crate::OperationStatus;
use crate::TargetKind;
use crate::TestItem;
use crate::TestResult;
use crate::TestState;
use crate::TestingError;
use crate::Update;
use crate::doctest;
use crate::model::Catalog;
use crate::service::Operation;

pub(crate) fn execute(
    authorization: &Authorization,
    program: &str,
    arguments: &[&str],
    cancellation: &CancellationToken,
) -> Result<CommandOutput, TestingError> {
    execute_in_directory(
        authorization,
        program,
        arguments,
        std::path::Path::new("."),
        cancellation,
    )
}

pub(crate) fn execute_in_directory(
    authorization: &Authorization,
    program: &str,
    arguments: &[&str],
    directory: &std::path::Path,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, TestingError> {
    let executor = ProcessExecutor::new(
        authorization.dir().clone(),
        SandboxBackends::new(Vec::new()),
        ExecutionLimits {
            timeout: Duration::from_secs(600),
            max_output_bytes: 8 * 1024 * 1024,
        },
    );
    // These are user-invoked project tests under ExecuteCommands, not Agent tool calls.
    // Reuse the execution layer for process groups, cancellation and bounded pipe capture.
    let outcome = authorization
        .execute(
            authorization.subject(),
            authorization.dir(),
            Permission::ExecuteCommands,
            || {
                executor.execute(
                    CommandRequest {
                        program: program.to_owned(),
                        arguments: arguments
                            .iter()
                            .map(|argument| (*argument).to_owned())
                            .collect(),
                        working_directory: directory.to_owned(),
                        input: CommandInput::Closed,
                    },
                    CommandExecutionAuthority::Unrestricted,
                    cancellation,
                )
            },
        )
        .map_err(|_| TestingError::PermissionRequired)?;
    match outcome {
        Ok(CommandExecutionOutcome::Completed(output)) => Ok(output),
        Ok(CommandExecutionOutcome::SandboxDenied(_)) => {
            Err(TestingError::Failed("Test process was denied".into()))
        }
        Err(ExecutionError::CancelledBeforeStart(_) | ExecutionError::CancelledAfterStart(_)) => {
            Err(TestingError::Cancelled)
        }
        Err(error) => Err(TestingError::Failed(format!(
            "Test execution failed: {error:?}"
        ))),
    }
}

pub(crate) fn run(operation: &Operation, catalog: Catalog, authorization: Authorization) {
    let cancellation = operation.cancellation.token();
    let mut binaries = HashMap::new();
    let mut remaining_output = 2 * 1024 * 1024;
    for test in catalog.tests {
        if cancellation.check().is_err() {
            publish_result(
                operation,
                result(&test, TestState::Cancelled, 0, String::new(), false),
            );
            continue;
        }
        let started = Instant::now();
        publish_result(
            operation,
            result(&test, TestState::Running, 0, String::new(), false),
        );
        let key = format!("{}:{:?}:{}", test.package, test.target_kind, test.target);
        let completed = if test.target_kind == TargetKind::Documentation {
            run_documentation(
                &authorization,
                &test,
                &catalog.documentation_names[&test.package],
                &cancellation,
            )
        } else {
            let binary = binaries.entry(key).or_insert_with(|| {
                build(
                    &authorization,
                    &test.package,
                    test.target_kind,
                    &test.target,
                    &cancellation,
                )
            });
            match binary {
                Ok(binary) => execute_in_directory(
                    &authorization,
                    binary,
                    &["--exact", &test.name, "--nocapture", "--color", "never"],
                    test.directory
                        .strip_prefix(&catalog.root)
                        .expect("catalog directory is authorized"),
                    &cancellation,
                ),
                Err(error) => Err(error.clone()),
            }
        };
        let completed = completed.map(|output| {
            result(
                &test,
                output_state(&output),
                elapsed_ms(started),
                format!("{}{}", output.stdout, output.stderr),
                output.stdout_truncated || output.stderr_truncated,
            )
        });
        let completed = match completed {
            Ok(completed) => completed,
            Err(TestingError::Cancelled) => result(
                &test,
                TestState::Cancelled,
                elapsed_ms(started),
                String::new(),
                false,
            ),
            Err(error) => result(
                &test,
                TestState::Errored,
                elapsed_ms(started),
                error.to_string(),
                false,
            ),
        };
        let mut completed = completed;
        // Bound retained output for the whole run as well as each individual case.
        if completed.output.len() > remaining_output {
            let mut end = remaining_output;
            while !completed.output.is_char_boundary(end) {
                end -= 1;
            }
            completed.output.truncate(end);
            completed.output_truncated = true;
        }
        remaining_output -= completed.output.len();
        publish_result(operation, completed);
    }
    operation.update(|snapshot| {
        snapshot.status = if cancellation.check().is_err() {
            OperationStatus::Cancelled
        } else {
            OperationStatus::Completed
        };
        Update {
            operation_id: snapshot.operation_id.clone(),
            sequence: snapshot.sequence,
            status: snapshot.status,
            tests: None,
            result: None,
            error: None,
            launch: None,
        }
    });
}

fn run_documentation(
    authorization: &Authorization,
    test: &TestItem,
    names: &[String],
    cancellation: &CancellationToken,
) -> Result<CommandOutput, TestingError> {
    let mut arguments = vec![
        "test".to_owned(),
        "-p".to_owned(),
        test.package.clone(),
        "--doc".to_owned(),
        "--".to_owned(),
    ];
    arguments.extend(doctest::selection_arguments(&test.name, names)?);
    arguments.extend([
        "--nocapture".to_owned(),
        "--color".to_owned(),
        "never".to_owned(),
    ]);
    execute(
        authorization,
        "cargo",
        &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
        cancellation,
    )
}

fn output_state(output: &CommandOutput) -> TestState {
    let mut counts = [0_usize; 3];
    for summary in output
        .stdout
        .lines()
        .filter_map(|line| line.strip_prefix("test result: "))
    {
        for section in summary.split(';') {
            let words = section.split_whitespace().collect::<Vec<_>>();
            for (index, label) in ["passed", "failed", "ignored"].into_iter().enumerate() {
                if words.last() == Some(&label)
                    && let Some(count) = words
                        .get(words.len().saturating_sub(2))
                        .and_then(|count| count.parse::<usize>().ok())
                {
                    counts[index] += count;
                }
            }
        }
    }
    // rustdoc may report separate merged and standalone harnesses. Exactly one
    // selected result is required across all of them; zero matches never passes.
    match counts {
        [1, 0, 0] if output.exit_code == Some(0) => TestState::Passed,
        [0, 0, 1] if output.exit_code == Some(0) => TestState::Skipped,
        [0, 1, 0] => TestState::Failed,
        _ => TestState::Errored,
    }
}

pub(crate) fn prepare_debug(
    authorization: &Authorization,
    test: &TestItem,
    cancellation: &CancellationToken,
) -> Result<crate::DebugLaunch, TestingError> {
    if !test.debuggable {
        return Err(TestingError::InvalidInput);
    }
    let program = build(
        authorization,
        &test.package,
        test.target_kind,
        &test.target,
        cancellation,
    )?;
    #[cfg(target_os = "macos")]
    let adapter_program = {
        let output = execute(
            authorization,
            "xcrun",
            &["--find", "lldb-dap"],
            cancellation,
        )?;
        if output.exit_code != Some(0) || output.stdout.trim().is_empty() {
            return Err(TestingError::Failed(
                "LLVM lldb-dap is required to debug Rust tests".into(),
            ));
        }
        output.stdout.trim().to_owned()
    };
    #[cfg(not(target_os = "macos"))]
    let adapter_program = "lldb-dap".to_owned();
    Ok(crate::DebugLaunch {
        test_id: test.id.clone(),
        program,
        arguments: vec![
            "--exact".into(),
            test.name.clone(),
            "--nocapture".into(),
            "--color".into(),
            "never".into(),
            "--test-threads=1".into(),
        ],
        directory: test.directory.to_string_lossy().into_owned(),
        adapter_program,
    })
}

pub(crate) fn build(
    authorization: &Authorization,
    package: &str,
    kind: TargetKind,
    target: &str,
    cancellation: &CancellationToken,
) -> Result<String, TestingError> {
    let mut args = vec!["test", "-p", package];
    match kind {
        TargetKind::Library => args.push("--lib"),
        TargetKind::Binary => args.extend(["--bin", target]),
        TargetKind::Integration => args.extend(["--test", target]),
        TargetKind::Documentation => return Err(TestingError::InvalidInput),
    }
    args.extend([
        "--no-run",
        "--message-format=json",
        "--config",
        "profile.test.debug=2",
        "--config",
        "profile.test.strip=\"none\"",
    ]);
    let output = execute(authorization, "cargo", &args, cancellation)?;
    if output.exit_code != Some(0) {
        return Err(TestingError::Failed(format!(
            "{}{}",
            output.stderr, output.stdout
        )));
    }
    if output.stdout_truncated {
        return Err(TestingError::Failed(
            "Cargo build output exceeded the output limit".into(),
        ));
    }
    for line in output.stdout.lines() {
        let message: serde_json::Value =
            serde_json::from_str(line).map_err(|error| TestingError::Failed(error.to_string()))?;
        if message["reason"] == "compiler-artifact"
            && message["target"]["name"] == target
            && message["profile"]["test"] == true
            && let Some(executable) = message["executable"].as_str()
        {
            return Ok(executable.to_owned());
        }
    }
    Err(TestingError::Failed(
        "Cargo did not produce the selected test executable".into(),
    ))
}

fn result(
    test: &TestItem,
    state: TestState,
    duration_ms: u64,
    mut output: String,
    capture_truncated: bool,
) -> TestResult {
    let failure = output.lines().find_map(|line| {
        let location = line
            .strip_prefix("thread '")?
            .split_once(" panicked at ")?
            .1
            .trim_end_matches(':');
        let (path, column) = location.rsplit_once(':')?;
        column.parse::<usize>().ok()?;
        let (path, line) = path.rsplit_once(':')?;
        Some((path.to_owned(), line.parse::<usize>().ok()?))
    });
    let output_truncated = capture_truncated || output.len() > 16 * 1024;
    if output.len() > 16 * 1024 {
        let mut end = 16 * 1024;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
    }
    TestResult {
        test_id: test.id.clone(),
        state,
        duration_ms,
        output,
        output_truncated,
        failure_path: failure.as_ref().map(|(path, _)| path.clone()),
        failure_line: failure.map(|(_, line)| line),
    }
}

fn publish_result(operation: &Operation, result: TestResult) {
    operation.update(|snapshot| {
        if let Some(existing) = snapshot
            .results
            .iter_mut()
            .find(|existing| existing.test_id == result.test_id)
        {
            *existing = result.clone();
        } else {
            snapshot.results.push(result.clone());
        }
        Update {
            operation_id: snapshot.operation_id.clone(),
            sequence: snapshot.sequence,
            status: snapshot.status,
            tests: None,
            result: Some(result),
            error: None,
            launch: None,
        }
    });
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}
