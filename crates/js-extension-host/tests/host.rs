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
use host::ExtensionInvocationTarget;
use host::ExtensionLaunchCommand;
use host::HostErrorCode;
use host::PackageBinding;
use host::ProcessIsolationPolicy;
use host::RestartPolicy;
use host::TrustedDevelopmentLauncher;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

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
    let (isolation, launcher): (_, Arc<dyn host::ExtensionHostLauncher>) =
        if host::ProductJavaScriptLauncher::supports_platform() {
            (
                ProcessIsolationPolicy::RequireJavaScriptEnforcement(
                    host::JavaScriptMemoryLimits::default(),
                ),
                Arc::new(host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
                    "CARGO_BIN_EXE_ash-js-extension-host"
                )))),
            )
        } else {
            (
                ProcessIsolationPolicy::TrustedDevelopment,
                Arc::new(TrustedDevelopmentLauncher),
            )
        };
    start_with_api(
        source,
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
        ],
        isolation,
        launcher,
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
    start_with_environment(
        source,
        capabilities,
        isolation,
        launcher,
        api,
        Default::default(),
    )
}

fn start_with_environment(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
    api: TestApi,
    environment: Option<std::collections::BTreeMap<String, Option<String>>>,
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
    let command = match environment {
        Some(environment) => command.with_extension_environment(environment).unwrap(),
        None => command,
    };
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

fn product_params() -> ActivateParams {
    let manifest = include_str!("../../../extensions/remote-ssh/package.json");
    let source = include_str!("../../../extensions/remote-ssh/src/extension.js");
    let sdk = include_str!("../../../extension-sdk/index.js");
    ActivateParams {
        extension_id: "ash.remote-ssh".into(),
        package: PackageBinding {
            package_id: "ash.remote-ssh@1.0.0".into(),
            package_digest: format!(
                "sha256:{:x}",
                Sha256::digest(format!("{manifest}\0{source}\0{sdk}"))
            ),
            entrypoint: "src/extension.js".into(),
        },
        runtime_api_version: 1,
        activation_events: vec!["startup".into()],
        capabilities: vec![
            ExtensionCapability::RemoteAuthorityResolver,
            ExtensionCapability::ProductRemoteAuthorityResolver,
        ],
    }
}

fn start_product(params: ActivateParams) -> Result<Running, ExtensionHostError> {
    // The product loader must work without a package directory or workspace grant.
    let directory = tempfile::tempdir().unwrap();
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-js-extension-host"));
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let running = Running {
        supervisor: ExtensionHostSupervisor::new(
            Arc::new(host::ProductJavaScriptLauncher::new(executable.clone())),
            ExtensionLaunchCommand::product_javascript(executable, "remote-ssh", directory.path())
                .unwrap(),
            ExtensionActivationSpec::new(params, NonZeroU64::new(1).unwrap(), authority.clone()),
            ExtensionHostLimits {
                isolation: ProcessIsolationPolicy::RequireJavaScriptEnforcement(
                    host::JavaScriptMemoryLimits::default(),
                ),
                ..ExtensionHostLimits::default()
            },
            RestartPolicy::default(),
        )?,
        authority,
        _package: directory,
    };
    running.supervisor.start()?;
    Ok(running)
}

fn ssh_invocation() -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: "remote:ssh".into(),
        operation: "resolveConnection".into(),
        payload: json!({"authority": "ssh+build"}),
        deadline_unix_millis: invocation("unused", json!(null), Duration::from_secs(5))
            .deadline_unix_millis,
    }
}

#[test]
fn compiled_ssh_uses_the_sdk_and_fences_old_incarnations_after_restart() {
    let running = start_product(product_params()).unwrap();
    let initial = running.supervisor.snapshot();
    assert_eq!(initial.registrations.len(), 1);
    assert_eq!(
        running.supervisor.invoke(ssh_invocation()).unwrap().payload,
        json!({"connectionName": "build"})
    );
    running.supervisor.shutdown().unwrap();
    assert!(running.supervisor.snapshot().registrations.is_empty());
    let restarted = running.supervisor.start().unwrap();
    assert!(restarted.incarnation > initial.incarnation);
    assert!(matches!(
        running.supervisor.begin_fenced_invoke(
            ExtensionInvocationTarget {
                incarnation: NonZeroU64::new(initial.incarnation).unwrap(),
                activation_generation: NonZeroU64::new(1).unwrap(),
            },
            ssh_invocation()
        ),
        Err(ExtensionHostError::RegistrationNotFound)
    ));
    assert_eq!(
        running.supervisor.invoke(ssh_invocation()).unwrap().payload,
        json!({"connectionName": "build"})
    );
}

#[test]
fn compiled_ssh_rejects_a_stale_release_binding() {
    let mut params = product_params();
    params.package.package_digest = format!("sha256:{}", "a".repeat(64));
    assert!(start_product(params).is_err());
}

#[test]
fn installed_sdk_packages_cannot_acquire_the_product_ssh_authority() {
    let source = "import { workspace } from '@ash/extension'; export function activate(context) { context.subscriptions.push(workspace.registerRemoteConnectionResolver('ssh', { resolve() { return { connectionName: 'build' }; } })); }";
    assert!(
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .is_err()
    );
    assert!(
        start_with_capabilities(
            source,
            vec![
                ExtensionCapability::RemoteAuthorityResolver,
                ExtensionCapability::ProductRemoteAuthorityResolver
            ]
        )
        .is_err()
    );
}
fn run(running: &Running, id: &str, arguments: Value) -> Result<Value, ExtensionHostError> {
    running
        .supervisor
        .invoke(invocation(id, arguments, Duration::from_secs(5)))
        .map(|result| result.payload)
}

#[test]
fn vscode_status_bar_replaces_hidden_arguments_and_releases_published_entries() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const item = v.window.createStatusBarItem('status', v.StatusBarAlignment.Right, 1.5);
        exports.activate = context => {
            const defaultItem = v.window.createStatusBarItem();
            if (defaultItem.alignment !== v.StatusBarAlignment.Left || defaultItem.priority !== undefined || defaultItem.id !== 'test.example') throw Error('Invalid default status bar overload');
            defaultItem.dispose();
            item.text = 'Initial'; item.tooltip = 'Run'; item.accessibilityInformation = { label: 'Run extension status' };
            item.command = { command: 'example.probe', title: 'Probe', arguments: [{ value: 0 }] };
            item.show();
            context.subscriptions.push(item, v.commands.registerCommand('example.probe', arg => arg.value));
            context.subscriptions.push(v.commands.registerCommand('example.hello', mode => {
                if (mode === 'hide') {
                    item.hide();
                    // Retaining the previous argument on every hidden replacement exceeds the isolate's heap budget.
                    for (let index = 0; index < 512; index++) item.command = { command: 'example.probe', title: 'Probe', arguments: [Array(32768).fill(index)] };
                    item.command = { command: 'example.probe', title: 'Probe', arguments: [{ value: 512 }] };
                } else if (mode === 'show') { item.text = 'Current'; item.show(); }
                else if (mode === 'dispose') { item.dispose(); item.dispose(); if (item.command !== undefined) throw Error('Disposed item retained command'); }
            }));
        };
    "#).unwrap();
    let initial = running.supervisor.snapshot();
    let status = initial
        .registrations
        .iter()
        .find(|registration| registration.registration_id == "vscode.statusBar")
        .unwrap();
    let extension_protocol::RegistrationKind::StatusBar { entries, .. } = &status.kind else {
        panic!("missing status bar");
    };
    assert_eq!(entries[0].priority.as_f64(), Some(1.5));
    assert_eq!(entries[0].text, "Initial");
    assert_eq!(
        entries[0].aria_label.as_deref(),
        Some("Run extension status")
    );
    drop(initial);
    for (mode, expected_count) in [("hide", 0), ("show", 1), ("dispose", 0)] {
        let handle = running
            .supervisor
            .begin_invoke(invocation("hello", json!([mode]), Duration::from_secs(10)))
            .unwrap();
        let mut requests = 0;
        handle
            .wait_with_client(|operation, _, _| {
                let ExtensionClientOperation::SetStatusBarEntries {
                    registration_id,
                    entries,
                    ..
                } = operation
                else {
                    panic!("unexpected operation");
                };
                requests += 1;
                assert_eq!(registration_id, "vscode.statusBar");
                assert_eq!(entries.len(), expected_count);
                if expected_count == 1 {
                    assert_eq!(entries[0].text, "Current");
                    assert_eq!(
                        entries[0].command.as_ref().unwrap().arguments,
                        json!([{ "value": 512 }]).as_array().unwrap().clone()
                    );
                }
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        assert_eq!(requests, 1);
        let snapshot = running.supervisor.snapshot();
        let status = snapshot
            .registrations
            .iter()
            .find(|registration| registration.registration_id == "vscode.statusBar")
            .unwrap();
        let extension_protocol::RegistrationKind::StatusBar { entries, .. } = &status.kind else {
            panic!("missing status bar");
        };
        assert_eq!(entries.len(), expected_count);
    }
    assert_eq!(
        run(&running, "probe", json!([{ "value": 512 }])).unwrap(),
        json!(512)
    );
    running.supervisor.shutdown().unwrap();
}

#[test]
fn status_bar_snapshots_accept_only_acknowledged_updates_for_owned_registrations() {
    let running = start_with_capabilities(r#"
        import { commands, window } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(window.registerStatusBar('status', () => ({ revision: 1, entries: [] })));
            context.subscriptions.push(commands.registerCommand('example.update', 'Update', async (call, id, revision) => {
                try { await call.window.setStatusBarEntries(id, revision, []); return 'ok'; }
                catch (error) { return error.code; }
            }));
        }
    "#, vec![ExtensionCapability::Command, ExtensionCapability::StatusBar]).unwrap();
    for (id, revision, permit, expected) in [
        ("foreign", 2, true, "registrationNotFound"),
        ("example.update", 2, true, "registrationNotFound"),
        ("status", 2, true, "ok"),
        ("status", 1, true, "ok"),
        ("status", 3, false, "permissionDenied"),
    ] {
        let handle = running
            .supervisor
            .begin_invoke(invocation(
                "update",
                json!([id, revision]),
                Duration::from_secs(5),
            ))
            .unwrap();
        let mut calls = 0;
        let result = handle
            .wait_with_client(|_, _, _| {
                calls += 1;
                if permit {
                    Ok(ExtensionClientResult::Done)
                } else {
                    Err(host::HostFailure {
                        code: HostErrorCode::PermissionDenied,
                        message: "Rejected".into(),
                    })
                }
            })
            .unwrap();
        assert_eq!(result.payload, json!(expected));
        assert_eq!(calls, usize::from(id == "status"));
    }
    let snapshot = running.supervisor.snapshot();
    let status = snapshot
        .registrations
        .iter()
        .find(|registration| registration.registration_id == "status")
        .unwrap();
    assert!(matches!(
        status.kind,
        extension_protocol::RegistrationKind::StatusBar { revision: 2, .. }
    ));
    running.supervisor.shutdown().unwrap();
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
fn author_sdk_document_callbacks_publish_diagnostics_and_completion_ranges() {
    let running = start_with_capabilities(r#"
        import { workspace, languages } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerTextDocumentEvents('example.documents', async (call, event) => {
                await call.languages.setDiagnostics('lint', [{ uri:event.document.uri, version:event.document.version, diagnostics:[{
                    start:{line:0,character:2}, end:{line:0,character:4}, message:'Check word', severity:'hint', source:'example', code:null
                }] }]);
            }), languages.registerCompletionProvider('example.complete', ['typescript'], {
                provideCompletionItems(call, document, position, trigger) {
                    if (document.getText() !== '😀ab' || position.character !== 4 || trigger.kind !== 'invoke') throw Error('Author completion context lost');
                    return { isIncomplete:false, items:[{ id:'word', label:'abcd', kind:'text', range:{start:{line:0,character:2},end:position}, insertText:'abcd', insertTextFormat:'plainText' }] };
                }
            }, ['.']));
        }
    "#, vec![ExtensionCapability::LanguageProvider]).unwrap();
    let mut request = hover_invocation("😀ab");
    request.registration_id = "example.documents".into();
    request.operation = "documentEvent".into();
    request.payload = json!({"type":"open","document":{"uri":"file:///main.ts","version":7,"languageId":"typescript","text":"😀ab"}});
    running.supervisor.begin_invoke(request).unwrap().wait_with_client(|operation, _, _| {
        assert!(matches!(operation, ExtensionClientOperation::SetDiagnostics { entries, .. } if entries[0].version == Some(7) && entries[0].diagnostics[0].end.character == 4));
        Ok(ExtensionClientResult::Done)
    }).unwrap();
    let mut completion = hover_invocation("😀ab");
    completion.registration_id = "example.complete".into();
    completion.operation = "completion".into();
    completion.payload["position"]["columnIndex"] = json!(4);
    completion.payload["context"] = json!({"kind":"invoke"});
    let result = running.supervisor.invoke(completion).unwrap();
    assert_eq!(
        result.payload["items"][0]["range"],
        json!({"start":{"lineIndex":0,"columnIndex":2},"end":{"lineIndex":0,"columnIndex":4}})
    );
}

#[test]
fn diagnostics_keep_the_version_read_before_an_await_when_live_documents_change() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const collection = v.languages.createDiagnosticCollection('lint');
            context.subscriptions.push(collection, v.commands.registerCommand('example.hello', async () => {
                const document = v.workspace.textDocuments[0];
                const original = document.getText();
                await v.window.showInformationMessage('pause');
                const first = new v.Diagnostic(new v.Range(0,0,0,original.length), original);
                const second = new v.Diagnostic(new v.Range(0,0,0,original.length), 'Second');
                collection.set([[document.uri,[first]],[document.uri,[second]]]);
                if (collection.get(document.uri).length !== 2) throw Error('Duplicate tuples were not merged');
            }));
        };
        exports.deactivate = () => {
            if (v.workspace.textDocuments[0].getText() !== 'new text') throw Error('Cached reads require no client call');
        };
    "#).unwrap();
    let mut event = invocation("unused", json!([]), Duration::from_secs(5));
    event.registration_id = "vscode.documents".into();
    event.operation = "documentEvent".into();
    event.payload = json!({"type":"open","document":{"uri":"file:///main.ts","version":1,"languageId":"typescript","text":"old"}});
    running.supervisor.invoke(event.clone()).unwrap();
    let command = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap();
    let mut version = None;
    command.wait_with_client(|operation, _, _| {
        match operation {
            ExtensionClientOperation::ShowMessage { .. } => {
                event.payload = json!({"type":"change","document":{"uri":"file:///main.ts","version":2,"languageId":"typescript","text":"new text"},"reason":"edit","contentChanges":[]});
                running.supervisor.invoke(event.clone()).unwrap();
            }
            ExtensionClientOperation::SetDiagnostics { entries, .. } => {
                assert_eq!(entries[0].diagnostics.len(), 2);
                assert_eq!(entries[0].diagnostics[0].message, "old");
                version = entries[0].version;
            }
            operation => panic!("unexpected request {operation:?}"),
        }
        Ok(ExtensionClientResult::Done)
    }).unwrap();
    assert_eq!(version, Some(1));
    running.supervisor.shutdown().unwrap();
}

#[test]
fn vscode_document_events_drive_diagnostics_with_unsaved_versions_and_close_lifetimes() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const collection = v.languages.createDiagnosticCollection('lint');
            let opened;
            context.subscriptions.push(collection,
                v.workspace.onDidOpenTextDocument(doc => { opened = doc; }),
                v.workspace.onDidChangeTextDocument(event => {
                    if (event.document !== opened || event.document.getText() !== '😀bad') throw Error('Document identity/text changed');
                    if (event.contentChanges[0].range.start.character !== 2) throw Error('UTF16 change range lost');
                    collection.set(event.document.uri, [new v.Diagnostic(new v.Range(0,2,0,5), 'Bad word', v.DiagnosticSeverity.Warning)]);
                }),
                v.workspace.onDidCloseTextDocument(doc => {
                    if (!doc.isClosed || v.workspace.textDocuments.length) throw Error('Closed document retained');
                    collection.delete(doc.uri);
                }));
        };
    "#).unwrap();
    for (kind, version, text) in [
        ("open", 1, "😀"),
        ("change", 2, "😀bad"),
        ("close", 2, "😀bad"),
    ] {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "vscode.documents".into();
        request.operation = "documentEvent".into();
        request.payload = json!({"type":kind,"document":{"uri":"file:///main.ts","languageId":"typescript","version":version,"text":text},"reason":"edit","contentChanges":[{"range":{"start":{"line":0,"character":2},"end":{"line":0,"character":2}},"rangeOffset":2,"rangeLength":0,"text":"bad"}]});
        let mut calls = Vec::new();
        running
            .supervisor
            .begin_invoke(request)
            .unwrap()
            .wait_with_client(|operation, _, _| {
                calls.push(operation);
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        if kind == "open" {
            assert!(calls.is_empty());
        } else if kind == "change" {
            assert!(
                matches!(&calls[0], ExtensionClientOperation::SetDiagnostics { entries, .. } if entries[0].version == Some(2) && entries[0].diagnostics[0].start.character == 2)
            );
        } else {
            assert!(
                matches!(&calls[0], ExtensionClientOperation::SetDiagnostics { entries, .. } if entries.is_empty())
            );
        }
    }
}

#[test]
fn vscode_completion_preserves_trigger_context_snippets_utf16_and_provider_disposal() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const registration = v.languages.registerCompletionItemProvider('typescript', {
                provideCompletionItems(doc, position, token, trigger) {
                    if (doc.getText() !== '😀al' || position.character !== 4 || trigger.triggerKind !== 1 || trigger.triggerCharacter !== '.') throw Error('Completion context lost');
                    const item = new v.CompletionItem('alpha', v.CompletionItemKind.Function);
                    item.insertText = new v.SnippetString('alpha(${1:value})');
                    return new v.CompletionList([item], true);
                }
            }, '.');
            context.subscriptions.push(registration, v.commands.registerCommand('example.hello', () => registration.dispose()));
        };
    "#).unwrap();
    let mut request = hover_invocation("😀al");
    request.registration_id = "vscode.completion.1".into();
    request.operation = "completion".into();
    request.payload["position"]["columnIndex"] = json!(4);
    request.payload["context"] = json!({"kind":"triggerCharacter","triggerCharacter":"."});
    let result = running.supervisor.invoke(request.clone()).unwrap();
    assert_eq!(
        result.payload,
        json!({"isIncomplete":true,"items":[{"id":"0","label":"alpha","kind":"function","range":{"start":{"lineIndex":0,"columnIndex":2},"end":{"lineIndex":0,"columnIndex":4}},"insertText":"alpha(${1:value})","insertTextFormat":"snippet"}]})
    );
    run(&running, "hello", json!([])).unwrap();
    assert!(running.supervisor.invoke(request).is_err());
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
            ExtensionCapability::StatusBar,
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
            ExtensionCapability::StatusBar,
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
            ExtensionCapability::StatusBar,
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

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
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

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
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

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
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

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
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

#[test]
fn remote_resolver_runs_in_javascript_and_connection_intent_uses_the_invocation_broker() {
    let source = r#"
        import { commands, workspace } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteConnectionResolver('team', {
                resolve(_call, authority) { if (authority !== 'team+linux') throw Error('Wrong authority'); return { connectionName: 'build' }; }
            }));
            context.subscriptions.push(commands.registerCommand('example.connect', 'Connect', async call => {
                await call.workspace.openRemoteConnection('team+linux'); return 'requested';
            }));
        }
    "#;
    assert!(
        start(source).is_err(),
        "registration requires its declared capability"
    );
    let running = start_with_capabilities(
        source,
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::RemoteAuthorityResolver,
        ],
    )
    .unwrap();
    let mut resolve = invocation("unused", json!([]), Duration::from_secs(5));
    resolve.registration_id = "remote:team".into();
    resolve.operation = "resolveConnection".into();
    resolve.payload = json!({"authority":"team+linux"});
    assert_eq!(
        running.supervisor.invoke(resolve).unwrap().payload,
        json!({"connectionName":"build"})
    );
    let mut calls = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation("connect", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            calls.push(operation);
            Ok(ExtensionClientResult::Done)
        })
        .unwrap();
    assert_eq!(result.payload, json!("requested"));
    assert_eq!(
        calls,
        vec![ExtensionClientOperation::OpenRemoteConnection {
            authority: "team+linux".into()
        }]
    );
}

#[test]
fn remote_connection_calls_without_an_active_resolver_do_not_reach_the_client() {
    let running = start(r#"
        import { commands } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(commands.registerCommand('example.connect', 'Connect', async call => {
                try { await call.workspace.openRemoteConnection('ssh+build'); }
                catch (error) { return error.code; }
                throw Error('Expected refusal');
            }));
        }
    "#).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("connect", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|_, _, _| panic!("Unauthorized request reached the client"))
        .unwrap();
    assert_eq!(result.payload, json!("permissionDenied"));
}

#[test]
fn standard_authority_resolution_preserves_endpoints_attempts_and_error_categories() {
    let source = r#"
        import { workspace, ResolvedAuthority, RemoteAuthorityResolverError } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve(authority, context) {
                    if (authority === 'test+offline') throw RemoteAuthorityResolverError.NotAvailable('Offline', true);
                    return new ResolvedAuthority('127.0.0.1', 4000 + context.resolveAttempt, 'capability');
                }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |authority| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "remote-authority:test".into();
        request.operation = "resolveAuthority".into();
        request.payload = json!({"authority":authority,"resolveAttempt":2,"__connectionOwner":"7"});
        request
    };
    assert_eq!(
        running
            .supervisor
            .invoke(request("test+target"))
            .unwrap()
            .payload,
        json!({"type":"webSocket","host":"127.0.0.1","port":4002,"connectionToken":"capability"})
    );
    assert_eq!(
        running
            .supervisor
            .invoke(request("test+offline"))
            .unwrap()
            .payload,
        json!({"error":{"code":"NotAvailable","message":"Offline","handled":true}})
    );
    assert!(running.supervisor.invoke(request("other+target")).is_err());
}

#[test]
fn canonical_uri_and_resolver_options_cross_the_sdk_boundary_without_session_tokens() {
    let source = r#"
        import { workspace, ResolvedAuthority } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve(authority) {
                    return Object.assign(new ResolvedAuthority('localhost', 5000), {
                        isTrusted: authority === 'test+invalid' ? 'yes' : false,
                        extensionHostEnv: { SET: 'value', REMOVE: null },
                        authenticationSessionForInitializingExtensions: {
                            id: 'session', providerId: 'provider', accessToken: 'secret',
                            account: { id: 'account', label: 'Account' }, scopes: []
                        }
                    });
                },
                getCanonicalURI(uri) {
                    if (uri.path === '/identity') return undefined;
                    if (uri.path === '/invalid') return { scheme: 'file' };
                    return uri.with({ fragment: 'canonical' });
                }
            }));
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('identity', {
                resolve() { return new ResolvedAuthority('localhost', 5000); }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |registration: &str, operation: &str, payload| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = registration.into();
        request.operation = operation.into();
        request.payload = payload;
        request
    };
    let resolved = running
        .supervisor
        .invoke(request(
            "remote-authority:test",
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":1,"__connectionOwner":"7"}),
        ))
        .unwrap()
        .payload;
    assert_eq!(
        resolved,
        json!({
            "type":"webSocket","host":"localhost","port":5000,"connectionToken":null,
            "options":{"isTrusted":false,"extensionHostEnv":{"SET":"value","REMOVE":null},
                "authenticationSession":{"id":"session","providerId":"provider"}}
        })
    );
    assert!(!resolved.to_string().contains("secret"));
    let canonical_request = |prefix: &str, path: &str, external: &str| {
        request(
            &format!("remote-authority:{prefix}"),
            "getCanonicalURI",
            json!({
                "authority":format!("{prefix}+target"),"__connectionOwner":"7",
                "uri":{"scheme":"ash-remote","authority":format!("{prefix}+target"),
                    "path":path,"query":"q=1","fragment":"old","external":external}
            }),
        )
    };
    assert_eq!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/alias/child/文件",
                "ash-remote://test+target/alias%2Fchild/%E6%96%87%E4%BB%B6?q=1#old"
            ))
            .unwrap()
            .payload,
        json!({
            "scheme":"ash-remote","authority":"test+target","path":"/alias/child/文件",
            "query":"q=1","fragment":"canonical",
            "external":"ash-remote://test+target/alias%2Fchild/%E6%96%87%E4%BB%B6?q=1#canonical"
        })
    );
    for (prefix, path) in [("test", "/identity"), ("identity", "/any")] {
        assert_eq!(
            running
                .supervisor
                .invoke(canonical_request(
                    prefix,
                    path,
                    &format!("ash-remote://{prefix}+target{path}?q=1#old")
                ))
                .unwrap()
                .payload,
            json!(null)
        );
    }
    assert!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/invalid",
                "ash-remote://test+target/invalid?q=1#old"
            ))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/identity",
                "ash-remote://test+target/another-path?q=1#old"
            ))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request(
                "remote-authority:test",
                "resolveAuthority",
                json!({"authority":"test+invalid","resolveAttempt":1,"__connectionOwner":"7"})
            ))
            .is_err()
    );
}

#[test]
fn managed_authority_sockets_preserve_bytes_and_retire_on_resolution_and_restart() {
    let source = r#"
        import { workspace, ManagedResolvedAuthority } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve() {
                    return new ManagedResolvedAuthority(async () => {
                        const data = new Set(), closed = new Set(), ended = new Set();
                        const event = listeners => callback => { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; };
                        return { onDidReceiveMessage: event(data), onDidClose: event(closed), onDidEnd: event(ended),
                            send(bytes) { for (const callback of data) callback(bytes); },
                            end() { for (const callback of closed) callback(); }, async drain() {} };
                    });
                }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |operation: &str, payload: Value| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "remote-authority:test".into();
        request.operation = operation.into();
        request.payload = payload;
        request
            .payload
            .as_object_mut()
            .unwrap()
            .insert("__connectionOwner".into(), json!("7"));
        request
    };
    let resolved = running
        .supervisor
        .invoke(request(
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":1}),
        ))
        .unwrap()
        .payload;
    let id = resolved["id"].as_u64().unwrap();
    let connected = running
        .supervisor
        .invoke(request("remoteConnect", json!({"id":id})))
        .unwrap()
        .payload;
    let socket = connected["id"].as_u64().unwrap();
    running
        .supervisor
        .invoke(request(
            "remoteWrite",
            json!({"id":socket,"data":"00f09f9880ff"}),
        ))
        .unwrap();
    running
        .supervisor
        .invoke(request("remoteDrain", json!({"id":socket})))
        .unwrap();
    assert_eq!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .unwrap()
            .payload,
        json!({"data":"00f09f9880ff","closed":false,"ended":false,"error":null})
    );
    let owner_request = |owner: &str, operation: &str, payload: Value| {
        let mut invocation = request(operation, payload);
        invocation
            .payload
            .as_object_mut()
            .unwrap()
            .insert("__connectionOwner".into(), json!(owner));
        invocation
    };
    let second = running
        .supervisor
        .invoke(owner_request(
            "8",
            "resolveAuthority",
            json!({"authority":"test+other","resolveAttempt":1}),
        ))
        .unwrap()
        .payload;
    let second_socket = running
        .supervisor
        .invoke(owner_request(
            "8",
            "remoteConnect",
            json!({"id":second["id"]}),
        ))
        .unwrap()
        .payload["id"]
        .as_u64()
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(owner_request("8", "remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_ok()
    );
    running
        .supervisor
        .invoke(owner_request("7", "remoteReleaseOwner", json!({})))
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(owner_request(
                "8",
                "remoteRead",
                json!({"id":second_socket})
            ))
            .is_ok()
    );
    running
        .supervisor
        .invoke(request(
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":2}),
        ))
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(owner_request(
                "8",
                "remoteRead",
                json!({"id":second_socket})
            ))
            .is_ok()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteConnect", json!({"id":id})))
            .is_err()
    );
    let old = NonZeroU64::new(running.supervisor.snapshot().incarnation).unwrap();
    running.supervisor.shutdown().unwrap();
    running.supervisor.start().unwrap();
    assert!(
        running
            .supervisor
            .begin_fenced_invoke(
                ExtensionInvocationTarget {
                    activation_generation: NonZeroU64::new(1).unwrap(),
                    incarnation: old
                },
                request("remoteConnect", json!({"id":id}))
            )
            .is_err()
    );
}

#[test]
fn extension_environment_is_available_during_module_loading_and_isolated_per_process() {
    let source = r#"
        import { commands } from '@ash/extension';
        if (process.exit !== undefined || process.dlopen !== undefined || process.binding !== undefined || process.cwd !== undefined) throw new Error('Unexpected Node capability');
        const loaded = { set: process.env.SET ?? null, removed: process.env.REMOVE ?? null, prototype: process.env.__proto__ ?? null };
        export function activate(context) {
            context.subscriptions.push(commands.registerCommand('example.env', 'Env', () => loaded));
        }
    "#;
    let launch = |value: &str| {
        start_with_environment(
            source,
            vec![ExtensionCapability::Command],
            ProcessIsolationPolicy::TrustedDevelopment,
            Arc::new(TrustedDevelopmentLauncher),
            TestApi::Ash,
            Some(
                [
                    ("SET".into(), Some(value.into())),
                    ("REMOVE".into(), None),
                    ("__proto__".into(), Some("exact key".into())),
                ]
                .into(),
            ),
        )
        .unwrap()
    };
    let first = launch("one");
    let second = launch("two");
    for (runtime, expected) in [(&first, "one"), (&second, "two"), (&first, "one")] {
        assert_eq!(
            runtime
                .supervisor
                .invoke(invocation("env", json!([]), Duration::from_secs(5)))
                .unwrap()
                .payload,
            json!({"set": expected, "removed": null, "prototype": "exact key"})
        );
    }
    first.supervisor.shutdown().unwrap();
    first.supervisor.start().unwrap();
    assert_eq!(
        first
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload,
        json!({"set":"one", "removed":null, "prototype":"exact key"})
    );
    let empty = start_with_environment(
        source,
        vec![ExtensionCapability::Command],
        ProcessIsolationPolicy::TrustedDevelopment,
        Arc::new(TrustedDevelopmentLauncher),
        TestApi::Ash,
        Some(Default::default()),
    )
    .unwrap();
    assert_eq!(
        empty
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload,
        json!({"set":null, "removed":null, "prototype":null})
    );
    // Match the SDK's JavaScript string limit for non-ASCII values as well.
    let value = "界".repeat(8192);
    let unicode = launch(&value);
    assert_eq!(
        unicode
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload["set"],
        json!(value)
    );
}
