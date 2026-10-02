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
use crate::model::Catalog;
use crate::service::Operation;

pub(crate) fn execute(
    authorization: &Authorization,
    program: &str,
    arguments: &[&str],
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
                        working_directory: std::path::PathBuf::from("."),
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
        let binary = binaries
            .entry(key)
            .or_insert_with(|| build(&authorization, &test, &cancellation));
        let completed = match binary {
            Ok(binary) => execute(
                &authorization,
                binary,
                &["--exact", &test.name, "--nocapture", "--color", "never"],
                &cancellation,
            )
            .map(|output| {
                let summary = output
                    .stdout
                    .lines()
                    .rev()
                    .find(|line| line.starts_with("test result: "))
                    .unwrap_or("");
                let state = if summary.contains("1 ignored;") {
                    TestState::Skipped
                } else if summary.contains("1 passed;") && output.exit_code == Some(0) {
                    TestState::Passed
                } else if summary.contains("1 failed;") {
                    TestState::Failed
                } else {
                    // Source discovery is not proof that cfg or the harness exposes a test.
                    // In particular, a successful invocation matching zero tests must not pass.
                    TestState::Errored
                };
                let text = format!("{}{}", output.stdout, output.stderr);
                result(
                    &test,
                    state,
                    elapsed_ms(started),
                    text,
                    output.stdout_truncated || output.stderr_truncated,
                )
            }),
            Err(error) => Err(error.clone()),
        };
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
        }
    });
}

fn build(
    authorization: &Authorization,
    test: &TestItem,
    cancellation: &CancellationToken,
) -> Result<String, TestingError> {
    let mut args = vec!["test", "-p", &test.package];
    match test.target_kind {
        TargetKind::Library => args.push("--lib"),
        TargetKind::Binary => args.extend(["--bin", &test.target]),
        TargetKind::Integration => args.extend(["--test", &test.target]),
    }
    args.extend(["--no-run", "--message-format=json"]);
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
            && message["target"]["name"] == test.target
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
        }
    });
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}
