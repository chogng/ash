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
