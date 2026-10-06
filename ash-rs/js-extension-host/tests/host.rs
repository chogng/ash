use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use extension_protocol::ExtensionClientOperation;
use extension_protocol::ExtensionClientResult;
use extension_protocol::ExtensionDocumentSnapshot;
use host::ActivateParams;
use host::ActivationAuthority;
use host::ActivationLease;
use host::ExtensionActivationSpec;
use host::ExtensionCapability;
use host::ExtensionHostError;
use host::ExtensionHostLimits;
use host::ExtensionHostStatus;
use host::ExtensionHostSupervisor;
use host::ExtensionInvocation;
use host::ExtensionLaunchCommand;
use host::HostErrorCode;
use host::PackageBinding;
use host::ProcessIsolationPolicy;
use host::RestartPolicy;
use host::TrustedDevelopmentLauncher;
use serde_json::Value;
use serde_json::json;

struct Authority(AtomicBool);
struct Lease;
impl ActivationLease for Lease {}
impl ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Lease) as Box<dyn ActivationLease>)
    }
}

struct Running {
    supervisor: ExtensionHostSupervisor,
    authority: Arc<Authority>,
    _package: tempfile::TempDir,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.supervisor.shutdown();
    }
}
fn start(source: &str) -> Result<Running, ExtensionHostError> {
    start_with_capabilities(source, vec![ExtensionCapability::Command])
}
fn start_with_capabilities(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
) -> Result<Running, ExtensionHostError> {
    start_with_launcher(
        source,
        capabilities,
        ProcessIsolationPolicy::TrustedDevelopment,
        Arc::new(TrustedDevelopmentLauncher),
    )
}

fn start_with_launcher(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
) -> Result<Running, ExtensionHostError> {
    start_with_api(source, capabilities, isolation, launcher, TestApi::Ash)
}

#[derive(Clone, Copy)]
enum TestApi {
    Ash,
    Vscode,
}

fn start_vscode(source: &str) -> Result<Running, ExtensionHostError> {
    start_with_api(
        source,
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
        ],
        ProcessIsolationPolicy::TrustedDevelopment,
        Arc::new(TrustedDevelopmentLauncher),
        TestApi::Vscode,
    )
}

fn start_with_api(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
    api: TestApi,
) -> Result<Running, ExtensionHostError> {
    let package = tempfile::tempdir().unwrap();
    std::fs::write(package.path().join("main.js"), source).unwrap();
    std::fs::write(
        package.path().join("helper.js"),
        include_str!("fixtures/helper.js"),
    )
    .unwrap();
    let mut arguments: Vec<String> = vec![
        "--extension-id".into(),
        "example".into(),
        "--package".into(),
        package.path().to_str().unwrap().into(),
        "--entry".into(),
        "main.js".into(),
    ];
    if matches!(api, TestApi::Vscode) {
        arguments.extend(["--api".into(), "vscode".into()]);
        std::fs::write(
            package.path().join("package.json"),
            serde_json::to_vec(&json!({
                "name": "example", "publisher": "test", "version": "1.0.0", "browser": "main.js",
                "contributes": { "commands": [
                    {"command": "example.hello", "title": "Hello"},
                    {"command": "example.async", "title": "Async"},
                    {"command": "example.probe", "title": "Probe"}
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
    }
    let command = ExtensionLaunchCommand::javascript(
        PathBuf::from(env!("CARGO_BIN_EXE_ash-js-extension-host")),
        arguments,
        package.path(),
    )
    .unwrap();
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let activation = ExtensionActivationSpec::new(
        ActivateParams {
            extension_id: "example".into(),
            package: PackageBinding {
                package_id: "example@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "main.js".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["startup".into()],
            capabilities,
        },
        NonZeroU64::new(1).unwrap(),
        authority.clone(),
    );
    let supervisor = ExtensionHostSupervisor::new(
        launcher,
        command,
        activation,
        ExtensionHostLimits {
            isolation,
            cancellation_grace: Duration::from_millis(200),
            ..ExtensionHostLimits::default()
        },
        RestartPolicy::default(),
    )
    .unwrap();
    supervisor.start()?;
    Ok(Running {
        supervisor,
        authority,
        _package: package,
    })
}
fn invocation(id: &str, arguments: Value, timeout: Duration) -> ExtensionInvocation {
    let deadline =
        (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + timeout).as_millis() as u64;
    ExtensionInvocation {
        registration_id: format!("example.{id}"),
        operation: "execute".into(),
        payload: json!({"arguments": arguments}),
        deadline_unix_millis: NonZeroU64::new(deadline).unwrap(),
    }
}
fn run(running: &Running, id: &str, arguments: Value) -> Result<Value, ExtensionHostError> {
    running
        .supervisor
        .invoke(invocation(id, arguments, Duration::from_secs(5)))
        .map(|result| result.payload)
}

fn hover_invocation(text: &str) -> ExtensionInvocation {
    let mut request = invocation("hover", json!([]), Duration::from_secs(5));
    request.operation = "hover".into();
    request.payload = json!({
        "resource": "file:///workspace/data.ts", "languageId": "typescript",
        "version": 7, "text": text, "position": {"lineIndex": 0, "columnIndex": 1}
    });
    request
}

#[test]
fn vscode_commonjs_commands_keep_standard_arguments_and_drain_unawaited_notifications() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        const topLevelExports = this === exports;
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.hello', function(value) {
            if (!topLevelExports) throw new Error('CommonJS receiver changed');
            vscode.window.showInformationMessage(this.prefix + value);
            return value;
        }, {prefix: 'hello:'}));
    "#).unwrap();
    let mut messages = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation(
            "hello",
            json!(["world"]),
            Duration::from_secs(5),
        ))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            messages.push(operation);
            Ok(ExtensionClientResult::Done)
        })
        .unwrap();
    assert_eq!(result.payload, json!("world"));
    assert_eq!(
        messages,
        vec![ExtensionClientOperation::ShowMessage {
            message: "hello:world".into(),
            severity: extension_protocol::ExtensionMessageSeverity::Information
        }]
    );
}

#[test]
fn vscode_callbacks_can_handle_a_service_rejection() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.hello', async () => {
            try { await vscode.workspace.openTextDocument(vscode.Uri.file('/workspace/missing.txt')); }
            catch (error) { return error.message; }
            throw new Error('Expected a rejected document read');
        }));
    "#).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|_, _, _| {
            Err(extension_protocol::HostFailure {
                code: HostErrorCode::InvalidRequest,
                message: "Document read denied".into(),
            })
        })
        .unwrap();
    assert!(
        result
            .payload
            .as_str()
            .unwrap()
            .contains("Document read denied")
    );
}

#[test]
fn vscode_await_continuations_keep_each_overlapping_invocations_identity() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.async', async name => {
            await vscode.window.showInformationMessage('begin:' + name);
            await Promise.resolve();
            await vscode.window.showInformationMessage('end:' + name);
            return name;
        }));
    "#).unwrap();
    let first = running
        .supervisor
        .begin_invoke(invocation(
            "async",
            json!(["first"]),
            Duration::from_secs(5),
        ))
        .unwrap();
    let second = running
        .supervisor
        .begin_invoke(invocation(
            "async",
            json!(["second"]),
            Duration::from_secs(5),
        ))
        .unwrap();
    for (pending, name) in [(first, "first"), (second, "second")] {
        let mut calls = Vec::new();
        let result = pending
            .wait_with_client(|operation, _, _| {
                calls.push(operation);
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        assert_eq!(result.payload, json!(name));
        assert_eq!(calls.len(), 2);
        assert!(
            matches!(&calls[1], ExtensionClientOperation::ShowMessage { message, .. } if message == &format!("end:{name}"))
        );
    }
}

#[test]
fn vscode_detached_continuations_cannot_borrow_a_later_invocations_authority() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        let release, detached;
        exports.activate = context => {
            context.subscriptions.push(vscode.commands.registerCommand('example.hello', () => {
                detached = new Promise(resolve => release = resolve).then(() => vscode.window.showInformationMessage('escaped')).catch(error => error.message);
            }));
            context.subscriptions.push(vscode.commands.registerCommand('example.probe', async () => { release(); return await detached; }));
        };
    "#).unwrap();
    assert_eq!(run(&running, "hello", json!([])).unwrap(), Value::Null);
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!("VS Code service call has no active invocation")
    );
}

#[test]
fn vscode_hover_and_document_reads_keep_unsaved_text_and_utf16_positions() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.languages.registerHoverProvider('typescript', {
            async provideHover(document, position, token) {
                const opened = await vscode.workspace.openTextDocument(document.uri);
                const range = new vscode.Range(new vscode.Position(0, 0), position);
                return new vscode.Hover(new vscode.MarkdownString(JSON.stringify({
                    text: document.getText(range), opened: opened.getText(), uri: opened.uri.toString(),
                    version: document.version, language: document.languageId, character: position.character,
                    cancelled: token.isCancellationRequested
                })), range);
            }
        }));
    "#).unwrap();
    let mut request = hover_invocation("😀ab\r\nunsaved");
    request.registration_id = "vscode.hover.1".into();
    request.payload["position"]["columnIndex"] = json!(4);
    let result = running
        .supervisor
        .begin_invoke(request)
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert_eq!(
                operation,
                ExtensionClientOperation::ReadDocument {
                    uri: "file:///workspace/data.ts".into()
                }
            );
            Ok(ExtensionClientResult::Document {
                document: ExtensionDocumentSnapshot {
                    uri: "file:///workspace/data.ts".into(),
                    version: 7,
                    language_id: "typescript".into(),
                    text: "unsaved editor content".into(),
                },
            })
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(result.payload["contents"][0]["value"].as_str().unwrap())
            .unwrap(),
        json!({
            "text": "😀ab", "opened": "unsaved editor content", "uri": "file:///workspace/data.ts",
            "version": 7, "language": "typescript", "character": 4, "cancelled": false
        })
    );
    assert_eq!(
        result.payload["range"],
        json!({"start": {"lineIndex": 0, "columnIndex": 0}, "end": {"lineIndex": 0, "columnIndex": 4}})
    );
}

#[test]
fn vscode_node_modules_and_unimplemented_apis_are_rejected_explicitly() {
    assert!(start_vscode("require('fs'); exports.activate = () => {};").is_err());
    assert!(
        start_vscode("require('vscode').authentication; exports.activate = () => {};").is_err()
    );
    assert!(start_vscode("exports.activate = () => require('vscode').commands.registerCommand('undeclared', () => {});").is_err());
}

#[test]
fn hover_receives_frozen_unsaved_utf16_snapshot_and_can_call_authorized_services() {
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
        ],
    )
    .unwrap();
    let mut request = hover_invocation("😀ab\r\nsecond");
    request.payload["position"]["columnIndex"] = json!(4);
    let result = running
        .supervisor
        .begin_invoke(request)
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert_eq!(
                operation,
                ExtensionClientOperation::ReadWorkspaceFile {
                    path: "data.txt".into()
                }
            );
            Ok(ExtensionClientResult::File {
                text: "disk content".into(),
            })
        })
        .unwrap();
    let mut actual = result.payload;
    actual["contents"][0] = serde_json::from_str(actual["contents"][0].as_str().unwrap()).unwrap();
    assert_eq!(
        actual,
        json!({
            "contents": [json!({
                "uri": "file:///workspace/data.ts", "version": 7, "text": "😀ab\r\nsecond",
                "position": {"line": 0, "character": 4}, "disk": "disk content", "frozen": true
        }), {"language": "typescript", "value": "const value = 1;"}],
            "range": {"start": {"lineIndex": 0, "columnIndex": 0}, "end": {"lineIndex": 0, "columnIndex": 4}}
        })
    );
}

#[test]
fn hover_requires_declared_capability_and_rejects_invalid_snapshots_and_disposed_callback() {
    assert!(start(include_str!("fixtures/hover.js")).is_err());
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
        ],
    )
    .unwrap();
    for (field, value) in [
        ("languageId", json!("rust")),
        ("version", json!(0)),
        ("position", json!({"lineIndex": 0, "columnIndex": 100})),
    ] {
        let mut request = hover_invocation("unsaved");
        request.payload[field] = value;
        assert!(matches!(
            running.supervisor.invoke(request),
            Err(ExtensionHostError::HostRejected { .. })
        ));
    }
    assert!(
        running
            .supervisor
            .invoke(hover_invocation("reversed"))
            .is_err()
    );
    assert_eq!(
        running
            .supervisor
            .invoke(hover_invocation("absent"))
            .unwrap()
            .payload,
        Value::Null
    );
    assert!(
        running
            .supervisor
            .invoke(invocation("hover", json!([]), Duration::from_secs(5)))
            .is_err()
    );
    run(&running, "disposeHover", json!([])).unwrap();
    assert!(matches!(
        running.supervisor.invoke(hover_invocation("absent")),
        Err(ExtensionHostError::HostRejected { .. })
    ));
}

#[test]
fn cancelling_a_pending_hover_retires_its_isolate_and_restores_the_provider_in_a_new_one() {
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
        ],
    )
    .unwrap();
    let before = running.supervisor.snapshot().incarnation;
    let pending = running
        .supervisor
        .begin_invoke(hover_invocation("pending"))
        .unwrap();
    // Completing a later command proves the engine reached the pending provider before cancellation.
    run(&running, "disposeHover", json!([])).unwrap();
    pending.cancel(host::CancelReason::Caller).unwrap();
    assert!(pending.wait().is_err());
    assert_eq!(
        running
            .supervisor
            .invoke(hover_invocation("absent"))
            .unwrap()
            .payload,
        Value::Null
    );
    assert!(running.supervisor.snapshot().incarnation > before);
}

#[test]
fn activates_esm_sdk_and_releases_subscriptions_without_node_globals() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    assert_eq!(running.supervisor.snapshot().registrations.len(), 15);
    assert_eq!(
        run(&running, "globals", json!([])).unwrap(),
        json!(["undefined", "undefined", "undefined", "undefined"])
    );
    assert_eq!(
        run(&running, "echo", json!([{"nested": [1, true]}])).unwrap(),
        json!({"nested": [1, true]})
    );
    running.supervisor.shutdown().unwrap();
    assert_eq!(
        running.supervisor.snapshot().status,
        ExtensionHostStatus::Stopped
    );
}

#[test]
fn editor_snapshot_and_rust_disk_read_stay_distinct() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use ash_file_system::FileSystem;
    use ash_file_system::LocalFileSystem;
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("data.txt"), "on disk").unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(workspace.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let mut calls = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation(
            "inspect",
            json!(["file:///workspace/data.txt", "data.txt"]),
            Duration::from_secs(5),
        ))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            calls.push(operation.clone());
            Ok(match operation {
                ExtensionClientOperation::ReadDocument { uri } => ExtensionClientResult::Document {
                    document: ExtensionDocumentSnapshot {
                        uri,
                        version: 7,
                        language_id: "plaintext".into(),
                        text: "unsaved editor".into(),
                    },
                },
                ExtensionClientOperation::ReadWorkspaceFile { path } => {
                    ExtensionClientResult::File {
                        text: String::from_utf8(
                            files
                                .read_file(std::path::Path::new(&path), 256 * 1024)
                                .unwrap(),
                        )
                        .unwrap(),
                    }
                }
                ExtensionClientOperation::ShowMessage { .. } => ExtensionClientResult::Done,
                operation => panic!("unexpected request {operation:?}"),
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!({"editor": "unsaved editor", "version": 7, "disk": "on disk", "frozen": true})
    );
    assert_eq!(calls.len(), 3);
}

#[test]
fn callback_failures_and_forged_operations_do_not_break_the_next_command() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    for id in ["fail", "forge"] {
        assert!(matches!(
            run(&running, id, json!([])),
            Err(ExtensionHostError::HostRejected {
                code: HostErrorCode::Internal,
                ..
            })
        ));
    }
    assert_eq!(
        run(&running, "echo", json!(["after failure"])).unwrap(),
        json!("after failure")
    );
}

#[test]
fn invocation_authority_cannot_be_kept_for_background_calls() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    run(&running, "capture", json!([])).unwrap();
    assert!(matches!(
        run(&running, "retired", json!([])),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Internal,
            ..
        })
    ));
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        run(&running, "echo", json!([])),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}

#[test]
fn deadlines_stop_synchronous_code_promise_continuations_rejection_coercion_and_pending_promises() {
    for id in ["spin", "continuationSpin", "rejectionSpin", "wait"] {
        let running = start(include_str!("fixtures/main.js")).unwrap();
        let before = std::time::Instant::now();
        assert!(
            running
                .supervisor
                .invoke(invocation(id, json!([]), Duration::from_millis(250)))
                .is_err()
        );
        assert!(
            before.elapsed() < Duration::from_secs(3),
            "{id} exceeded the shutdown bound"
        );
    }
}

#[test]
fn rejects_node_imports_and_rejected_module_initialization() {
    for source in [
        "import fs from 'node:fs'; export function activate() {}",
        "throw new Error('module failed'); export function activate() {}",
        "await new Promise(() => {}); export function activate() {}",
    ] {
        assert!(start(source).is_err());
    }
}

#[test]
fn rust_failure_code_is_available_to_the_extension_author() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("readFailure", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert!(matches!(
                operation,
                ExtensionClientOperation::ReadWorkspaceFile { .. }
            ));
            Err(extension_protocol::HostFailure {
                code: HostErrorCode::InvalidRequest,
                message: "path outside workspace".into(),
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!({"typed": true, "code": "invalidRequest"})
    );
}

#[test]
fn cancellation_retires_the_isolate_and_a_new_command_uses_a_new_incarnation() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let before = running.supervisor.snapshot().incarnation;
    let pending = running
        .supervisor
        .begin_invoke(invocation("wait", json!([]), Duration::from_secs(5)))
        .unwrap();
    // A second completed command proves the engine accepted the waiting invocation first.
    assert_eq!(
        run(&running, "echo", json!(["ready"])).unwrap(),
        json!("ready")
    );
    pending.cancel(host::CancelReason::Caller).unwrap();
    assert!(pending.wait().is_err());
    assert_eq!(
        run(&running, "echo", json!(["recovered"])).unwrap(),
        json!("recovered")
    );
    assert!(running.supervisor.snapshot().incarnation > before);
}

#[test]
fn quick_pick_preserves_selection_and_cancellation() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    for (index, expected) in [(Some(1), json!("second")), (None, Value::Null)] {
        let result = running
            .supervisor
            .begin_invoke(invocation("pick", json!([]), Duration::from_secs(5)))
            .unwrap()
            .wait_with_client(|operation, _, _| {
                assert!(matches!(
                    operation,
                    ExtensionClientOperation::ShowQuickPick { .. }
                ));
                Ok(ExtensionClientResult::Selection { index })
            })
            .unwrap();
        assert_eq!(result.payload, expected);
    }
}

#[test]
fn heap_quota_retires_only_the_extension_process() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    assert!(
        running
            .supervisor
            .invoke(invocation("heap", json!([]), Duration::from_secs(3)))
            .is_err()
    );
    assert_eq!(
        run(&running, "echo", json!(["after heap quota"])).unwrap(),
        json!("after heap quota")
    );
}

#[cfg(target_os = "macos")]
fn start_confined(source: &str) -> Result<Running, ExtensionHostError> {
    start_with_launcher(
        source,
        vec![ExtensionCapability::Command],
        ProcessIsolationPolicy::RequireJavaScriptEnforcement(host::JavaScriptMemoryLimits {
            heap_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
            array_buffer_bytes: std::num::NonZeroUsize::new(8 * 1024 * 1024).unwrap(),
        }),
        Arc::new(host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
            "CARGO_BIN_EXE_ash-js-extension-host"
        )))),
    )
}

#[cfg(target_os = "macos")]
#[test]
fn product_js_launcher_enforces_aggregate_and_implicit_backing_store_budgets() {
    struct ObservedLauncher {
        inner: host::ProductJavaScriptLauncher,
        processes: Arc<std::sync::Mutex<Vec<Arc<dyn host::ExtensionHostProcess>>>>,
    }
    impl host::ExtensionHostLauncher for ObservedLauncher {
        fn spawn(
            &self,
            command: &ExtensionLaunchCommand,
            limits: &ExtensionHostLimits,
        ) -> Result<Arc<dyn host::ExtensionHostProcess>, ExtensionHostError> {
            let process = self.inner.spawn(command, limits)?;
            self.processes.lock().unwrap().push(process.clone());
            Ok(process)
        }
    }
    for expression in [
        "new ArrayBuffer(8 * 1024 * 1024 + 1)",
        "new Uint8Array(8 * 1024 * 1024 + 1)",
        "(retained = [new ArrayBuffer(4 * 1024 * 1024), new ArrayBuffer(4 * 1024 * 1024)], new ArrayBuffer(1))",
        "(retained = [new Uint8Array(4 * 1024 * 1024), new Uint8Array(4 * 1024 * 1024)], new Uint8Array(4096))",
        "(retained = new ArrayBuffer(5 * 1024 * 1024), retained.slice(0))",
        "(retained = new Uint8Array(5 * 1024 * 1024), retained.map(x => x))",
    ] {
        let source = format!(
            r#"
import {{ commands }} from '@ash/extension';
let retained;
export function activate(context) {{
    context.subscriptions.push(commands.registerCommand('example.echo', 'Echo', (_, value) => value));
    context.subscriptions.push(commands.registerCommand('example.allocate', 'Allocate', () => {{
        try {{ {expression}; return 'unexpected allocation'; }} catch (error) {{ return error.name; }}
    }}));
}}"#
        );
        let processes: Arc<std::sync::Mutex<Vec<Arc<dyn host::ExtensionHostProcess>>>> =
            Arc::default();
        let running = start_with_launcher(
            &source,
            vec![ExtensionCapability::Command],
            ProcessIsolationPolicy::RequireJavaScriptEnforcement(host::JavaScriptMemoryLimits {
                heap_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
                array_buffer_bytes: std::num::NonZeroUsize::new(8 * 1024 * 1024).unwrap(),
            }),
            Arc::new(ObservedLauncher {
                inner: host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
                    "CARGO_BIN_EXE_ash-js-extension-host"
                ))),
                processes: processes.clone(),
            }),
        )
        .unwrap();
        let result = run(&running, "allocate", json!([]));
        if expression.starts_with("new ") {
            assert_eq!(result.unwrap(), json!("RangeError"), "{expression}");
        } else {
            assert!(
                matches!(result, Err(ExtensionHostError::HostExited)),
                "{expression}: {result:?}"
            );
            assert!(
                processes.lock().unwrap()[0]
                    .stderr()
                    .contains("ArrayBuffer quota exceeded"),
                "{expression}"
            );
            assert_eq!(
                run(&running, "echo", json!(["recovered"])).unwrap(),
                json!("recovered")
            );
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn product_js_context_excludes_unbudgeted_memory_and_constructor_paths() {
    let running = start_confined(r#"
import { commands } from '@ash/extension';
export function activate(context) {
    context.subscriptions.push(commands.registerCommand('example.buffers', 'Buffers', () => {
        const buffer = new Uint8Array(4).buffer;
        const constructors = [ArrayBuffer, buffer.constructor, Object.getPrototypeOf(buffer).constructor,
            buffer.slice(0).constructor, new Uint8Array(4).buffer.transfer().constructor];
        const failures = constructors.map(Constructor => {
            try { new Constructor(1, {maxByteLength: 1024}); return 'escaped'; }
            catch (error) { return error.name; }
        });
        class Derived extends ArrayBuffer {}
        const capture = {};
        const valueOf = Function('capture', 'return function() { try { capture.caller = arguments.callee.caller; } catch {} return 4; }')(capture);
        new ArrayBuffer({ valueOf });
        return [typeof SharedArrayBuffer, typeof WebAssembly, failures,
            new Derived(4) instanceof Derived, ArrayBuffer.isView(new Uint8Array(4)), capture.caller == null];
    }));
}"#).unwrap();
    assert_eq!(
        run(&running, "buffers", json!([])).unwrap(),
        json!([
            "undefined",
            "undefined",
            [
                "TypeError",
                "TypeError",
                "TypeError",
                "TypeError",
                "TypeError"
            ],
            true,
            true,
            true
        ])
    );
}

#[cfg(target_os = "macos")]
#[test]
fn product_js_process_recovers_after_execution_deadline() {
    let running = start_confined(include_str!("fixtures/main.js")).unwrap();
    assert!(
        running
            .supervisor
            .invoke(invocation("spin", json!([]), Duration::from_millis(100)))
            .is_err()
    );
    assert_eq!(
        run(&running, "echo", json!(["after timeout"])).unwrap(),
        json!("after timeout")
    );
}
