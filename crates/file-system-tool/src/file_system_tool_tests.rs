use super::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_file_system::LocalFileSystem;
use ash_protocol::{ToolCallId, TurnId};
use ash_tools::{
    EnvId, ToolBinding, ToolBindingId, ToolDefinition, ToolExecutionContext, ToolExecutionOutcome,
    ToolExecutor, ToolInvocation, ToolOperationId, ToolOutputStatus, ToolPayload,
    ToolRegistryGeneration, ToolRuntimeAuthority, ToolRuntimeKey,
};
use serde_json::json;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll, Waker};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

#[test]
fn reads_lists_and_describes_dir_paths() {
    let directory = TestWorkspace::new();
    directory.write("src/lib.rs", "hello");
    let tool = tool(&directory, FileSystemLimits::default());
    let definition = tool.definition();

    assert!(
        output(resolve(tool.execute(invocation(
            &definition,
            json!({"operation": "read", "path": "src/lib.rs"}),
        ))))
        .contains("hello")
    );
    assert!(
        output(resolve(tool.execute(invocation(
            &definition,
            json!({"operation": "list", "path": "src"}),
        ))))
        .contains("lib.rs")
    );
    assert!(
        output(resolve(tool.execute(invocation(
            &definition,
            json!({"operation": "metadata", "path": "src/lib.rs"}),
        ))))
        .contains("file")
    );
}

#[test]
fn preserves_tool_limits_and_dir_confinement() {
    let directory = TestWorkspace::new();
    directory.write("one.txt", "12345");
    directory.write("two.txt", "2");
    let tool = tool(&directory, FileSystemLimits::new(4, 1).unwrap());
    let definition = tool.definition();

    assert!(
        output(resolve(tool.execute(invocation(
            &definition,
            json!({"operation": "read", "path": "one.txt"}),
        ))))
        .contains("4-byte")
    );
    assert!(
        output(resolve(tool.execute(invocation(
            &definition,
            json!({"operation": "list", "path": ""}),
        ))))
        .contains("truncated")
    );
    let escape = resolve(tool.execute(invocation(
        &definition,
        json!({"operation": "metadata", "path": "../outside"}),
    )));
    let ToolExecutionOutcome::Returned(escape) = escape else {
        panic!("directory escape should return a model-visible error");
    };
    assert_eq!(escape.status(), ToolOutputStatus::Error);
    assert!(format!("{:?}", escape.content()).contains("outside the authorized directory"));
}

fn tool(directory: &TestWorkspace, limits: FileSystemLimits) -> FileSystemTool {
    FileSystemTool::new(
        environment_id(),
        Arc::new(LocalFileSystem::new(
            ash_file_access::Grant::for_environment(
                Dir::open_local(&directory.path).unwrap(),
                ash_file_access::GrantSource::ExplicitUser,
                ash_file_access::Permissions::new([
                    ash_file_access::Permission::ReadFiles,
                    ash_file_access::Permission::WriteFiles,
                    ash_file_access::Permission::BrowseFiles,
                ]),
            ),
        )),
        limits,
    )
    .unwrap()
}

fn environment_id() -> EnvId {
    EnvId::new("local").unwrap()
}

fn invocation(definition: &ToolDefinition, arguments: serde_json::Value) -> ToolInvocation {
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
        ToolExecutionContext::new(
            environment_id(),
            CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        ),
    )
}

fn output(outcome: ToolExecutionOutcome) -> String {
    match outcome {
        ToolExecutionOutcome::Returned(output) => format!("{:?}", output.content()),
        ToolExecutionOutcome::NotStarted(failure) => format!("{failure:?}"),
        ToolExecutionOutcome::SandboxDenied(denial) => format!("{denial:?}"),
        ToolExecutionOutcome::OutcomeUncertain(uncertain) => format!("{uncertain:?}"),
    }
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

struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-file-system-tool-tests-{}-{sequence}",
            std::process::id(),
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn write(&self, relative: impl AsRef<Path>, content: &str) {
        let target = self.path.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
