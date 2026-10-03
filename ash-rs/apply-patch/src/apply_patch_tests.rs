use super::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_protocol::{ToolCallId, TurnId};
use ash_tools::{
    EnvId, ToolBinding, ToolBindingId, ToolDefinition, ToolExecutionContext, ToolExecutionOutcome,
    ToolExecutor, ToolInvocation, ToolInvocationKind, ToolOperationId, ToolOutputStatus,
    ToolPayload, ToolRegistryGeneration, ToolRuntimeAuthority, ToolRuntimeKey,
};
use serde_json::json;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

#[test]
fn exposes_the_canonical_apply_patch_schema() {
    let dir = TestDir::new();
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let definition = tool.definition();

    assert_eq!(definition.name().as_str(), "apply_patch");
    assert!(definition.description().contains("Prefer this tool"));
    let ToolInvocationKind::Function { input_schema } = definition.invocation() else {
        panic!("apply_patch must use function arguments");
    };
    assert_eq!(
        input_schema.as_value(),
        &json!({
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": "Patch text using the documented Begin/End Patch grammar."
                }
            },
            "required": ["patch"],
            "additionalProperties": false
        })
    );
}

#[test]
fn applies_an_update_and_an_add_after_preparing_the_whole_patch() {
    let dir = TestDir::new();
    dir.write("src/lib.rs", "pub fn old() {}\n");
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-pub fn old() {}\n+pub fn new() {}\n*** Add File: src/new.rs\n+pub fn added() {}\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation(&definition, json!({"patch": patch}))));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("patch should return a tool output");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert_eq!(
        fs::read_to_string(dir.path().join("src/lib.rs")).unwrap(),
        "pub fn new() {}\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("src/new.rs")).unwrap(),
        "pub fn added() {}\n"
    );
}

#[test]
fn applies_only_to_its_bound_dir() {
    let primary = TestDir::new();
    let tool = ApplyPatchTool::new(
        environment_id(),
        primary.root(),
        ApplyPatchLimits::default(),
    )
    .unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Add File: selected.txt\n+selected\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation(&definition, json!({"patch": patch}))));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("patch should return a tool output");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert_eq!(
        fs::read_to_string(primary.path().join("selected.txt")).unwrap(),
        "selected\n"
    );
}

#[test]
fn applies_to_the_host_selected_authorized_dir() {
    let configured = TestDir::new();
    let selected = TestDir::new();
    let tool = ApplyPatchTool::new(
        environment_id(),
        configured.root(),
        ApplyPatchLimits::default(),
    )
    .unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Add File: selected.txt\n+selected\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation_with_dir(
        &definition,
        json!({"patch": patch}),
        selected.path(),
    )));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("patch should return a tool output");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert!(!configured.path().join("selected.txt").exists());
    assert_eq!(
        fs::read_to_string(selected.path().join("selected.txt")).unwrap(),
        "selected\n"
    );
}

#[test]
fn failed_later_operation_does_not_commit_an_earlier_add() {
    let dir = TestDir::new();
    dir.write("src/lib.rs", "actual\n");
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Add File: src/new.rs\n+new\n*** Update File: src/lib.rs\n@@\n-expected\n+replacement\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation(&definition, json!({"patch": patch}))));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("invalid hunk should return a tool error");
    };
    assert_eq!(output.status(), ToolOutputStatus::Error);
    assert!(!dir.path().join("src/new.rs").exists());
    assert_eq!(
        fs::read_to_string(dir.path().join("src/lib.rs")).unwrap(),
        "actual\n"
    );
}

#[test]
fn deletes_an_existing_dir_file() {
    let dir = TestDir::new();
    dir.write("src/obsolete.rs", "obsolete\n");
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Delete File: src/obsolete.rs\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation(&definition, json!({"patch": patch}))));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("delete should return a tool output");
    };
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert!(!dir.path().join("src/obsolete.rs").exists());
    assert!(format!("{:?}", output.content()).contains("src/obsolete.rs"));
}

#[test]
fn rejects_parent_directory_paths() {
    let dir = TestDir::new();
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let definition = tool.definition();
    let patch = "*** Begin Patch\n*** Add File: ../outside.txt\n+no\n*** End Patch\n";

    let outcome = resolve(tool.execute(invocation(&definition, json!({"patch": patch}))));

    let ToolExecutionOutcome::Returned(output) = outcome else {
        panic!("invalid patch path should return a tool error");
    };
    assert_eq!(output.status(), ToolOutputStatus::Error);
    assert!(format!("{:?}", output.content()).contains("must be relative"));
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

#[test]
fn updates_preserve_line_endings_and_eof_independently_of_model_output() {
    let cases = [
        ("before\nafter\n", "changed\ninserted\nafter\n"),
        ("before\r\nafter\r\n", "changed\r\ninserted\r\nafter\r\n"),
        ("before\nafter", "changed\ninserted\nafter"),
        ("before\r\nafter", "changed\r\ninserted\r\nafter"),
        ("before\rafter\r", "changed\rinserted\rafter\r"),
        (
            "before\r\nafter\r\ntail\n",
            "changed\r\ninserted\r\nafter\r\ntail\n",
        ),
        ("before", "changed\ninserted"),
        ("before\n", "changed\ninserted\n"),
    ];
    for (original, expected) in cases {
        for patch_eol in ["\n", "\r\n"] {
            let dir = TestDir::new();
            dir.write("file.txt", original);
            let tool =
                ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default())
                    .unwrap();
            let patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+changed\n+inserted\n*** End Patch\n".replace('\n', patch_eol);
            let outcome =
                resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
            assert!(
                matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
            );
            assert_eq!(
                fs::read_to_string(dir.path().join("file.txt")).unwrap(),
                expected
            );
        }
    }
}

#[test]
fn patch_context_preserves_mixed_endings_and_appending_preserves_eof() {
    for (original, patch, expected) in [
        (
            "head\r\nbefore\ntail\r\n",
            " head\n-before\n+changed\n tail\n",
            "head\r\nchanged\r\ntail\r\n",
        ),
        ("head\r\nlast", " last\n+added\n", "head\r\nlast\r\nadded"),
        ("before\r\n", "-before\n", ""),
        ("", "+added\n", "added"),
    ] {
        let dir = TestDir::new();
        dir.write("file.txt", original);
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch =
            format!("*** Begin Patch\n*** Update File: file.txt\n@@\n{patch}*** End Patch\n");
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            expected
        );
    }
}

#[test]
fn added_files_follow_editorconfig_patterns_and_directory_inheritance() {
    let dir = TestDir::new();
    dir.write(
        ".editorconfig",
        "root = true\n[*]\nend_of_line = lf\n[{*.bat,*.cmd}]\nend_of_line = crlf\n",
    );
    dir.write(
        "src/.editorconfig",
        "[*.txt]\nend_of_line = crlf\ninsert_final_newline = false\n",
    );
    for (path, expected) in [
        ("new.rs", "one\ntwo\n"),
        ("new.bat", "one\r\ntwo\r\n"),
        ("new.cmd", "one\r\ntwo\r\n"),
        ("src/new.txt", "one\r\ntwo"),
        ("src/new.rs", "one\ntwo\n"),
    ] {
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = format!("*** Begin Patch\n*** Add File: {path}\n+one\n+two\n*** End Patch\n");
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
        );
        assert_eq!(fs::read_to_string(dir.path().join(path)).unwrap(), expected);
    }
}

#[test]
fn editorconfig_changes_do_not_convert_existing_files() {
    let dir = TestDir::new();
    dir.write(
        ".editorconfig",
        "root = true\n[*]\nend_of_line = lf\ninsert_final_newline = true\n",
    );
    dir.write("file.txt", "before\r\nlast");
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let patch =
        "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+changed\n*** End Patch\n";
    let outcome = resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
    assert!(
        matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "changed\r\nlast"
    );
}

#[test]
fn new_file_rules_respect_root_unset_and_the_selected_directory_boundary() {
    let dir = TestDir::new();
    dir.write(".editorconfig", "root = true\n[*]\nend_of_line = crlf\n");
    dir.write(
        "src/.editorconfig",
        "root = true\n[*.txt]\nend_of_line = cr\n",
    );
    dir.write("unset/.editorconfig", "[*]\nend_of_line = unset\n");
    for (path, expected) in [
        ("root.txt", "one\r\n"),
        ("src/new.txt", "one\r"),
        ("src/new.rs", "one\n"),
        ("unset/new.txt", "one\n"),
    ] {
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = format!("*** Begin Patch\n*** Add File: {path}\n+one\n*** End Patch\n");
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
        );
        assert_eq!(fs::read_to_string(dir.path().join(path)).unwrap(), expected);
    }
    // Selecting a subdirectory must not import settings from outside its grant.
    dir.write("bounded/marker", "");
    let selected = Dir::open_local(dir.path().join("bounded")).unwrap();
    let tool =
        ApplyPatchTool::new(environment_id(), selected, ApplyPatchLimits::default()).unwrap();
    let patch = "*** Begin Patch\n*** Add File: selected.txt\n+one\n*** End Patch\n";
    let outcome = resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
    assert!(
        matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("bounded/selected.txt")).unwrap(),
        "one\n"
    );
}

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-apply-patch-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn root(&self) -> Dir {
        Dir::open_local(&self.path).unwrap()
    }

    fn write(&self, relative: impl AsRef<Path>, content: &str) {
        let target = self.path.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn environment_id() -> EnvId {
    EnvId::new("test-environment").unwrap()
}

fn invocation(definition: &ToolDefinition, arguments: serde_json::Value) -> ToolInvocation {
    invocation_with_context(
        definition,
        arguments,
        ToolExecutionContext::new(
            environment_id(),
            CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    )
}

fn invocation_with_dir(
    definition: &ToolDefinition,
    arguments: serde_json::Value,
    dir: &Path,
) -> ToolInvocation {
    invocation_with_context(
        definition,
        arguments,
        ToolExecutionContext::new(
            environment_id(),
            CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        )
        .with_execution_dir(dir),
    )
}

fn invocation_with_context(
    definition: &ToolDefinition,
    arguments: serde_json::Value,
    context: ToolExecutionContext,
) -> ToolInvocation {
    ToolInvocation::new(
        ToolOperationId::new("operation-1").unwrap(),
        ToolCallId::new("call-1").unwrap(),
        TurnId::new("turn-1").unwrap(),
        ToolBinding::new(
            ToolRegistryGeneration::new(1),
            ToolBindingId::new("binding-1").unwrap(),
            definition.name().clone(),
            definition.digest(),
            ToolRuntimeKey::new("local:test").unwrap(),
        ),
        ToolPayload::FunctionArguments(arguments),
        context,
    )
}

fn resolve(
    mut future: Pin<Box<dyn Future<Output = ToolExecutionOutcome> + Send + '_>>,
) -> ToolExecutionOutcome {
    let waker: &Waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(outcome) => outcome,
        Poll::Pending => panic!("local tool future should complete synchronously"),
    }
}

#[test]
fn changed_paths_uses_execution_grammar_and_limits() {
    let patch =
        "*** Begin Patch\n*** Add File: new.rs\n+new\n*** Delete File: old.rs\n*** End Patch";
    assert_eq!(
        changed_paths(patch, ApplyPatchLimits::default()).unwrap(),
        vec![
            std::path::PathBuf::from("new.rs"),
            std::path::PathBuf::from("old.rs")
        ]
    );
    assert!(changed_paths(patch, ApplyPatchLimits::new(1024, 1).unwrap()).is_err());
    assert!(changed_paths("*** Add File: new.rs", ApplyPatchLimits::default()).is_err());
}

#[test]
fn context_anchors_select_the_requested_function_and_missing_anchors_reject_all_changes() {
    for (anchor, succeeds) in [("fn second() {", true), ("fn absent() {", false)] {
        let dir = TestDir::new();
        let original = "fn first() {\nold\n}\nfn second() {\nold\n}\n";
        dir.write("file.rs", original);
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: file.rs\n@@ {anchor}\n-old\n+changed\n*** End Patch\n"
        );
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        let ToolExecutionOutcome::Returned(output) = outcome else {
            panic!("expected a tool result");
        };
        assert_eq!(
            output.status(),
            if succeeds {
                ToolOutputStatus::Success
            } else {
                ToolOutputStatus::Error
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("file.rs")).unwrap(),
            if succeeds {
                "fn first() {\nold\n}\nfn second() {\nchanged\n}\n"
            } else {
                original
            }
        );
        assert_eq!(dir.path().join("new.txt").exists(), succeeds);
    }
}

#[test]
fn eof_marker_targets_the_final_duplicate_and_rejects_nonfinal_context() {
    for (original, expected, status) in [
        (
            "old\nother\nold\n",
            "old\nother\nchanged\n",
            ToolOutputStatus::Success,
        ),
        ("old\nother\n", "old\nother\n", ToolOutputStatus::Error),
    ] {
        let dir = TestDir::new();
        dir.write("file.txt", original);
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+changed\n*** End of File\n*** End Patch\n";
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == status)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            expected
        );
    }
}

#[test]
fn addition_only_hunks_append_with_the_existing_format() {
    for (original, expected) in [
        ("old\n", "old\nadded\n"),
        ("old\r\n", "old\r\nadded\r\n"),
        ("old", "old\nadded"),
    ] {
        let dir = TestDir::new();
        dir.write("file.txt", original);
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n+added\n*** End Patch\n";
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            expected
        );
    }
}

#[test]
fn moves_can_update_or_retain_content_and_review_both_paths() {
    for (hunk, expected) in [
        ("@@\n-old\n+changed\n", "changed\r\nlast"),
        ("", "old\r\nlast"),
    ] {
        let dir = TestDir::new();
        dir.write("old.txt", "old\r\nlast");
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n{hunk}*** End Patch\n"
        );
        assert_eq!(
            changed_paths(&patch, ApplyPatchLimits::default()).unwrap(),
            vec![PathBuf::from("old.txt"), PathBuf::from("new.txt")]
        );
        assert!(changed_paths(&patch, ApplyPatchLimits::new(1024, 1).unwrap()).is_err());
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Success && format!("{:?}", output.content()).contains("moved_files"))
        );
        assert!(!dir.path().join("old.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            expected
        );
    }
}

#[test]
fn moves_reject_existing_destinations_escape_and_overlapping_operations() {
    for (target, extra) in [
        ("existing.txt", ""),
        ("../outside.txt", ""),
        ("new.txt", "*** Add File: new.txt\n+other\n"),
    ] {
        let dir = TestDir::new();
        dir.write("old.txt", "old\n");
        dir.write("existing.txt", "existing\n");
        let tool =
            ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
        let patch = format!(
            "*** Begin Patch\n*** Add File: earlier.txt\n+earlier\n*** Update File: old.txt\n*** Move to: {target}\n{extra}*** End Patch\n"
        );
        let outcome =
            resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
        assert!(
            matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Error)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("old.txt")).unwrap(),
            "old\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("existing.txt")).unwrap(),
            "existing\n"
        );
        assert!(!dir.path().join("earlier.txt").exists());
    }
}

#[test]
fn commit_checks_all_source_revisions_before_publishing_any_file() {
    for operation in [
        "*** Update File: old.txt\n@@\n-old\n+changed\n",
        "*** Delete File: old.txt\n",
        "*** Update File: old.txt\n*** Move to: moved.txt\n",
    ] {
        let dir = TestDir::new();
        dir.write("old.txt", "old\n");
        let patch = format!(
            "*** Begin Patch\n*** Add File: earlier.txt\n+earlier\n{operation}*** End Patch\n"
        );
        let document = PatchDocument::parse(&patch).unwrap_or_else(|error| panic!("{error}"));
        let prepared = ApplyPatchTool::prepare(&dir.root(), document)
            .unwrap_or_else(|error| panic!("{error}"));
        dir.write("old.txt", "external edit\n");
        let error = match commit(&dir.root(), prepared) {
            Ok(_) => panic!("stale patch must fail"),
            Err(error) => error,
        };
        assert!(matches!(
            error.source,
            ash_file_system::FileSystemError::RevisionConflict(_)
        ));
        assert!(!error.publication_started);
        assert!(error.completed_paths.is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join("old.txt")).unwrap(),
            "external edit\n"
        );
        assert!(!dir.path().join("earlier.txt").exists());
        assert!(!dir.path().join("moved.txt").exists());
    }
}

#[test]
fn staging_failure_leaves_no_earlier_changes_or_temporary_files() {
    let dir = TestDir::new();
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let patch = "*** Begin Patch\n*** Add File: earlier.txt\n+earlier\n*** Add File: missing/later.txt\n+later\n*** End Patch\n";
    let outcome = resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
    assert!(
        matches!(outcome, ToolExecutionOutcome::Returned(output) if output.status() == ToolOutputStatus::Error)
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn add_rejects_a_destination_created_after_preparation() {
    let dir = TestDir::new();
    let patch = "*** Begin Patch\n*** Add File: new.txt\n+model\n*** End Patch\n";
    let document = PatchDocument::parse(patch).unwrap_or_else(|error| panic!("{error}"));
    let prepared =
        ApplyPatchTool::prepare(&dir.root(), document).unwrap_or_else(|error| panic!("{error}"));
    dir.write("new.txt", "external\n");
    let error = match commit(&dir.root(), prepared) {
        Ok(_) => panic!("existing destination must fail"),
        Err(error) => error,
    };
    assert!(matches!(
        error.source,
        ash_file_system::FileSystemError::AlreadyExists(_)
    ));
    assert!(!error.publication_started);
    assert_eq!(
        fs::read_to_string(dir.path().join("new.txt")).unwrap(),
        "external\n"
    );
}

#[cfg(windows)]
#[test]
fn failed_move_publication_reports_the_completed_destination() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = TestDir::new();
    dir.write("old.txt", "old\n");
    // Permit the tool to read the source, but hold it open without delete sharing
    // so failure happens after the destination has actually been published.
    let _held_source = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(dir.path().join("old.txt"))
        .unwrap();
    let tool =
        ApplyPatchTool::new(environment_id(), dir.root(), ApplyPatchLimits::default()).unwrap();
    let patch = "*** Begin Patch\n*** Add File: earlier.txt\n+earlier\n*** Update File: old.txt\n*** Move to: moved.txt\n*** End Patch\n";
    let outcome = resolve(tool.execute(invocation(&tool.definition(), json!({"patch": patch}))));
    let ToolExecutionOutcome::OutcomeUncertain(error) = outcome else {
        panic!("partial publication must be reported");
    };
    let message = format!("{error:?}");
    assert!(message.contains("earlier.txt") && message.contains("moved.txt"));
    assert_eq!(
        fs::read_to_string(dir.path().join("earlier.txt")).unwrap(),
        "earlier\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("moved.txt")).unwrap(),
        "old\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("old.txt")).unwrap(),
        "old\n"
    );
}
