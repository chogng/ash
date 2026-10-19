use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

use ash_external_ext::ActivateParams;
use ash_external_ext::ExtensionCapability;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::PackageBinding;
use ash_external_ext::ProductNodeLauncher;
use ash_external_ext::RestartPolicy;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::ExtensionHostInitialization;
use serde_json::Value;
use serde_json::json;

use super::super::EditorClientScope;
use super::super::ExtensionHostInvocationRead;
use super::super::ExtensionHostInvocationRequest;
use super::super::ExtensionHostRuntime;
use super::super::ExtensionHostRuntimeError;
use super::super::RuntimeEntry;
use super::super::projection::ExtensionHostExtensionSnapshot;
use super::super::projection::ExtensionHostLifecycle;
use super::super::source::ActivationEvent;
use super::super::source::ActivationPlan;
use super::super::source::BuiltInEditorExtensions;
use super::super::source::EditorExtensionDeployment;
use super::super::source::EditorExtensionScope;
use super::super::source::WorkspaceReadAccess;
use super::AllowedActivation;
use super::test_files_unavailable;

struct EditorPeer {
    queue: crate::server::notification_queue::NotificationQueue,
    worker: Option<JoinHandle<()>>,
}

impl EditorPeer {
    fn start(client: Arc<crate::client_host::ClientHost>, owner: u64, name: &str) -> Self {
        let queue = crate::server::notification_queue::NotificationQueue::default();
        client.register(owner, false, queue.clone());
        let listener = queue.listener();
        let name = name.to_owned();
        let worker = std::thread::spawn(move || {
            while listener.wait() {
                for request in listener.drain() {
                    let operation: ExtensionClientOperation =
                        serde_json::from_value(request["params"]["operation"].clone()).unwrap();
                    let result = match operation {
                        ExtensionClientOperation::ReadInitialization {} => {
                            ExtensionClientResult::Initialization {
                                initialization: ExtensionHostInitialization {
                                    language: Some(
                                        if name == "zh-CN" { "zh-CN" } else { "en" }.into(),
                                    ),
                                    localization: None,
                                    workspace_folders: Vec::new(),
                                    workspace_name: Some(name.clone()),
                                    workspace_file: None,
                                    configuration_values: json!({"test": {"value": name}}),
                                    configuration_data: json!({
                                        "defaults": {"contents": {"test": {"value": name}},
                                            "keys": ["test.value"], "overrides": []},
                                        "folders": []
                                    }),
                                },
                            }
                        }
                        ExtensionClientOperation::ExecuteCommand { command, arguments } => {
                            assert_eq!(command, "editor.echo");
                            assert_eq!(arguments, vec![json!(name)]);
                            ExtensionClientResult::Command {
                                value: json!(name),
                                has_value: true,
                            }
                        }
                        ExtensionClientOperation::ReadConfiguration { section, .. } => {
                            assert_eq!(section, "debug.lldb");
                            ExtensionClientResult::Configuration {
                                value: json!({"adapterPath":format!("/tools/{name}/lldb-dap"),"adapterArgs":[]}),
                            }
                        }
                        operation => panic!("unexpected editor operation: {operation:?}"),
                    };
                    assert!(
                        client
                            .handle_response(
                                owner,
                                json!({
                                    "jsonrpc": "2.0", "id": request["id"], "result": result
                                })
                            )
                            .unwrap()
                    );
                }
            }
        });
        Self {
            queue,
            worker: Some(worker),
        }
    }
}

impl Drop for EditorPeer {
    fn drop(&mut self) {
        self.queue.close();
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn install_node_fixture(root: &Path) -> (ProductNodeLauncher, EditorExtensionDeployment) {
    let electron = std::env::var_os("ASH_TEST_ELECTRON_PATH");
    let mut runtime =
        std::process::Command::new(electron.as_deref().unwrap_or(std::ffi::OsStr::new("node")));
    if electron.is_some() {
        runtime.env("ELECTRON_RUN_AS_NODE", "1");
    }
    let output = runtime
        .args(["--print", "process.execPath"])
        .output()
        .expect("Node is required for standard extension lifecycle tests");
    assert!(output.status.success());
    let node = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/extension-host");
    for (from, to) in [
        ("node.mjs", "node.mjs"),
        ("vscode.js", "vscode.mjs"),
        ("scm.js", "scm.js"),
    ] {
        std::fs::copy(source.join(from), root.join(to)).unwrap();
    }
    std::fs::copy(source.join("host.mjs"), root.join("host.mjs")).unwrap();
    let package = root.join("extension");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        json!({
            "publisher": "test", "name": "node", "contributes": {
                "commands": [{"command": "test.node", "title": "Node"}]
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        package.join("extension.cjs"),
        r#"
const v = require('vscode');
const name = v.workspace.name;
const value = v.workspace.getConfiguration('test').get('value');
exports.activate = context => {
    setInterval(() => {}, 1000);
    context.subscriptions.push(v.commands.registerCommand('test.node', async () => ({
        name, value, pid: process.pid, echoed: await v.commands.executeCommand('editor.echo', name)
    })));
};
"#,
    )
    .unwrap();
    let mut environment = std::env::var_os("SYSTEMROOT")
        .map(|value| BTreeMap::from([("SYSTEMROOT".into(), value)]))
        .unwrap_or_default();
    if electron.is_some() {
        environment.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    }
    let launcher = ProductNodeLauncher::new(node, root.join("node.mjs"), environment).unwrap();
    let command = ExtensionLaunchCommand::vscode(
        vec![
            "--extension-id".into(),
            "test.node".into(),
            "--package".into(),
            package.to_str().unwrap().to_owned(),
            "--entry".into(),
            "extension.cjs".into(),
            "--api".into(),
            "vscode".into(),
        ],
        &package,
    )
    .unwrap();
    (
        launcher,
        EditorExtensionDeployment {
            scope: EditorExtensionScope::Workspace,
            id: "test.node".into(),
            version: "1".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            command,
            credential_providers: Vec::new(),
            backend_channels: BTreeMap::new(),
            protocol_limits: None,
            workspace_read: WorkspaceReadAccess::Denied,
            params: ActivateParams {
                initialization: None,
                extension_id: "test.node".into(),
                package: PackageBinding {
                    package_id: "test/node".into(),
                    package_digest: format!("sha256:{}", "a".repeat(64)),
                    entrypoint: "extension.cjs".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onCommand:test.node".into()],
                capabilities: vec![ExtensionCapability::Command],
            },
            authority: Arc::new(AllowedActivation),
            activation: Some(ActivationPlan {
                events: vec!["onCommand:test.node".into()],
                commands: vec![("test.node".into(), "Node".into())],
            }),
            activation_failure: None,
        },
    )
}

fn invoke(runtime: &ExtensionHostRuntime, owner: u64) -> Value {
    invoke_registration(
        runtime,
        owner,
        "test.node",
        "execute",
        json!({"arguments": []}),
    )
}

fn invoke_registration(
    runtime: &ExtensionHostRuntime,
    owner: u64,
    registration: &str,
    operation: &str,
    payload: Value,
) -> Value {
    let snapshot = runtime.snapshot_for(owner);
    let extension = &snapshot.extensions[0];
    let request = ExtensionHostInvocationRequest {
        registration_generation: extension.registrations.iter().find_map(|entry| {
            match entry.kind {
                external_ext_protocol::RegistrationKind::SpeechProvider {
                    registration_generation,
                    ..
                } if entry.registration_id == registration => Some(registration_generation),
                _ => None,
            }
        }),
        extension_id: extension.id.clone(),
        registration_id: registration.into(),
        activation_generation: extension.activation_generation,
        incarnation: extension.incarnation.unwrap(),
        operation: operation.into(),
        payload,
        deadline_unix_millis: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 10_000,
    };
    let id = runtime
        .start_invocation(owner, request, Err(test_files_unavailable()))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match runtime.read_invocation(owner, &id).unwrap() {
            ExtensionHostInvocationRead::Succeeded(value) => return value,
            ExtensionHostInvocationRead::Pending => {
                assert!(Instant::now() < deadline, "invocation did not finish");
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => panic!("extension invocation failed"),
        }
    }
}

fn runtime_with_recipe(
    launcher: ProductNodeLauncher,
    deployment: EditorExtensionDeployment,
    grant: &Grant,
    client: Arc<crate::client_host::ClientHost>,
) -> ExtensionHostRuntime {
    let runtime = ExtensionHostRuntime::start(
        BuiltInEditorExtensions::Omitted,
        None,
        None,
        None,
        Arc::new(launcher),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(crate::server::update_broker::UpdateBroker::default()),
        client,
        None,
    )
    .unwrap();
    runtime
        .bind_dir(grant.authorize(Permission::DiscoverPlugins).unwrap())
        .unwrap();
    // Seed an admitted package recipe; the production activation path creates both instances.
    runtime.inner.state.lock().unwrap().entries.insert(
        deployment.id.clone(),
        RuntimeEntry {
            scope: deployment.scope,
            activation_gate: Arc::new(std::sync::Mutex::new(())),
            version: deployment.version.clone(),
            workspace_read: WorkspaceReadAccess::Denied,
            backend_channels: BTreeMap::new(),
            supervisor: None,
            failure: None,
            pending_activation: deployment.activation.clone(),
            client_scope: EditorClientScope::Pending,
            fallback: ExtensionHostExtensionSnapshot {
                id: deployment.id.clone(),
                version: deployment.version.clone(),
                package_digest: deployment.package_digest.clone(),
                runtime_api_version: 1,
                activation_generation: 7,
                incarnation: None,
                lifecycle: ExtensionHostLifecycle::Dormant,
                activation: None,
                failure: None,
                stderr: String::new(),
                output_events: Vec::new(),
                registrations: Vec::new(),
            },
            deployment: Some(deployment),
        },
    );
    runtime
}

#[test]
fn standard_extensions_keep_window_facts_callbacks_and_lifetimes_separate() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, deployment) = install_node_fixture(directory.path());
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _first = EditorPeer::start(client.clone(), 11, "first");
    let _second = EditorPeer::start(client.clone(), 22, "second");
    let runtime = runtime_with_recipe(launcher, deployment, &grant, client);
    let activate = |owner| {
        runtime
            .activate_by_event(
                owner,
                "test.node",
                7,
                ActivationEvent::Command("test.node".into()),
                None,
                Err(test_files_unavailable()),
            )
            .unwrap()
    };
    assert_eq!(
        activate(11).extensions[0].lifecycle,
        ExtensionHostLifecycle::Ready
    );
    assert_eq!(
        runtime.snapshot_for(22).extensions[0].lifecycle,
        ExtensionHostLifecycle::Dormant
    );
    assert_eq!(
        activate(22).extensions[0].lifecycle,
        ExtensionHostLifecycle::Ready
    );
    let first = invoke(&runtime, 11);
    let second = invoke(&runtime, 22);
    assert_eq!(first["name"], "first");
    assert_eq!(first["value"], "first");
    assert_eq!(first["echoed"], "first");
    assert_eq!(second["name"], "second");
    assert_eq!(second["value"], "second");
    assert_eq!(second["echoed"], "second");
    assert_ne!(first["pid"], second["pid"]);
    let first_supervisor = runtime
        .inner
        .state
        .lock()
        .unwrap()
        .entry(11, "test.node")
        .unwrap()
        .supervisor
        .clone()
        .unwrap();
    runtime.inner.client_host.unregister(11);
    runtime.close_owner(11);
    assert_eq!(
        first_supervisor.snapshot().status,
        ash_external_ext::ExtensionHostStatus::Stopped
    );
    assert_eq!(
        runtime.snapshot_for(11).extensions[0].lifecycle,
        ExtensionHostLifecycle::Dormant
    );
    assert_eq!(invoke(&runtime, 22), second);
    assert!(matches!(
        runtime.start_invocation(
            11,
            ExtensionHostInvocationRequest {
                registration_generation: None,
                extension_id: "test.node".into(),
                registration_id: "test.node".into(),
                activation_generation: 7,
                incarnation: 1,
                operation: "execute".into(),
                payload: json!({"arguments": []}),
                deadline_unix_millis: 1,
            },
            Err(test_files_unavailable())
        ),
        Err(ExtensionHostRuntimeError::Stale)
    ));
    assert!(matches!(
        runtime.activate_by_event(
            11,
            "test.node",
            7,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable())
        ),
        Err(ExtensionHostRuntimeError::Stale)
    ));
    grant.revoke();
    runtime
        .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
        .unwrap_err();
    runtime.close_owner(22);
}

#[test]
fn slow_window_shutdown_does_not_block_another_windows_reconciliation() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, deployment) = install_node_fixture(directory.path());
    let entry = directory.path().join("extension/extension.cjs");
    let source = std::fs::read_to_string(&entry).unwrap();
    std::fs::write(
        &entry,
        format!(
            r#"{source}
exports.deactivate = async () => {{
    require('node:fs').writeFileSync('deactivating', '');
    while (!require('node:fs').existsSync('release')) {{
        await new Promise(resolve => setTimeout(resolve, 5));
    }}
}};
"#
        ),
    )
    .unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _peer = EditorPeer::start(client.clone(), 11, "first");
    let runtime = runtime_with_recipe(launcher, deployment, &grant, client);
    runtime
        .activate_by_event(
            11,
            "test.node",
            7,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    runtime.inner.client_host.unregister(11);
    let closing = runtime.clone();
    let close = std::thread::spawn(move || closing.close_owner(11));
    let deadline = Instant::now() + Duration::from_secs(3);
    let flag = directory.path().join("extension/deactivating");
    while !flag.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let deactivating = flag.exists();
    let (tx, rx) = std::sync::mpsc::channel();
    let other = runtime.clone();
    let progress = std::thread::spawn(move || {
        let _ = tx.send(other.reconcile_for(22, super::super::ExtensionHostReconcileMode::Refresh));
    });
    let result = rx.recv_timeout(Duration::from_millis(500));
    let retired =
        runtime.snapshot_for(11).extensions[0].lifecycle == ExtensionHostLifecycle::Dormant;
    // Always release and join before asserting, including the negative control.
    std::fs::write(directory.path().join("extension/release"), b"").unwrap();
    close.join().unwrap();
    progress.join().unwrap();
    assert!(
        deactivating,
        "the real extension reached its delayed deactivate callback"
    );
    assert!(
        result.is_ok(),
        "another window was blocked by this window's process shutdown"
    );
    assert!(
        retired,
        "the old owner must lose its registrations before slow cleanup"
    );
    runtime.shutdown();
}

#[test]
fn lldb_rust_providers_keep_client_configuration_language_and_shutdown_separate() {
    let executable = PathBuf::from(
        std::env::var_os("ASH_DEBUG_LLDB_BIN")
            .expect("Cargo wrapper builds the Rust LLDB extension"),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _first = EditorPeer::start(client.clone(), 11, "en");
    let _second = EditorPeer::start(client.clone(), 22, "zh-CN");
    let runtime = ExtensionHostRuntime::start(
        BuiltInEditorExtensions::Omitted,
        None,
        None,
        None,
        Arc::new(ash_external_ext::ProductExecutableLauncher::new(executable.clone()).unwrap()),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(crate::server::update_broker::UpdateBroker::default()),
        client,
        None,
    )
    .unwrap();
    let deployment =
        super::super::source::product_lldb_deployment(executable.parent().unwrap()).unwrap();
    let entry = runtime
        .inner
        .build_entry(None, &deployment, std::num::NonZeroU64::new(7).unwrap());
    assert!(
        entry.is_window_template(),
        "the production recipe must bind Rust Debug to a window"
    );
    runtime
        .inner
        .state
        .lock()
        .unwrap()
        .entries
        .insert(deployment.id.clone(), entry);
    let activate = |owner| {
        runtime
            .activate_by_event(
                owner,
                "ash.debug-lldb",
                7,
                ActivationEvent::Debug {
                    phase: super::super::source::DebugActivationPhase::ResolveConfiguration,
                    debug_type: Some("lldb-dap".into()),
                },
                // Renderer supplies activation facts for Rust providers. The
                // standard JS host separately refreshes them through its facade.
                Some(ExtensionHostInitialization {
                    language: Some(if owner == 11 { "en" } else { "zh-CN" }.into()),
                    localization: None,
                    workspace_folders: Vec::new(),
                    workspace_name: None,
                    workspace_file: None,
                    configuration_values: json!({}),
                    configuration_data: json!({}),
                }),
                Err(test_files_unavailable()),
            )
            .unwrap()
    };
    assert_eq!(
        activate(11).extensions[0].lifecycle,
        ExtensionHostLifecycle::Ready
    );
    assert_eq!(
        runtime.snapshot_for(22).extensions[0].lifecycle,
        ExtensionHostLifecycle::Dormant
    );
    assert_eq!(
        activate(22).extensions[0].lifecycle,
        ExtensionHostLifecycle::Ready
    );
    for (owner, name) in [(11, "LLDB: Launch program"), (22, "LLDB：启动程序")] {
        assert_eq!(
            invoke_registration(
                &runtime,
                owner,
                "lldb.configuration",
                "provideDebugConfigurations",
                json!({"folder":null})
            )["configurations"][0]["name"],
            name
        );
    }
    let payload = json!({"configuration":{"type":"lldb-dap","request":"launch","name":"App","program":"app"},"session":{"id":"borrowed-session","workspaceFolder":null}});
    for (owner, path) in [(11, "/tools/en/lldb-dap"), (22, "/tools/zh-CN/lldb-dap")] {
        assert_eq!(
            invoke_registration(
                &runtime,
                owner,
                "lldb.adapter",
                "createDebugAdapterDescriptor",
                payload.clone()
            )["program"],
            path
        );
    }
    let first = runtime
        .inner
        .state
        .lock()
        .unwrap()
        .entry(11, "ash.debug-lldb")
        .unwrap()
        .supervisor
        .clone()
        .unwrap();
    let second = runtime
        .inner
        .state
        .lock()
        .unwrap()
        .entry(22, "ash.debug-lldb")
        .unwrap()
        .supervisor
        .clone()
        .unwrap();
    runtime.inner.client_host.unregister(11);
    runtime.close_owner(11);
    assert_eq!(
        first.snapshot().status,
        ash_external_ext::ExtensionHostStatus::Stopped
    );
    assert_eq!(
        invoke_registration(
            &runtime,
            22,
            "lldb.adapter",
            "createDebugAdapterDescriptor",
            payload
        )["program"],
        "/tools/zh-CN/lldb-dap"
    );
    runtime.close_owner(22);
    assert_eq!(
        second.snapshot().status,
        ash_external_ext::ExtensionHostStatus::Stopped
    );
}

struct DeniedActivation;

impl ash_external_ext::ActivationAuthority for DeniedActivation {
    fn authorizes(&self) -> bool {
        false
    }

    fn acquire(&self) -> Option<Box<dyn ash_external_ext::ActivationLease>> {
        None
    }
}

#[test]
fn first_window_activation_publishes_authority_failure_without_waiting_for_health() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, mut deployment) = install_node_fixture(directory.path());
    deployment.authority = Arc::new(DeniedActivation);
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _first = EditorPeer::start(client.clone(), 11, "first");
    let _second = EditorPeer::start(client.clone(), 22, "second");
    let runtime = runtime_with_recipe(launcher, deployment, &grant, client);
    let before = runtime.snapshot_for(11);
    let activated = runtime
        .activate_by_event(
            11,
            "test.node",
            7,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    let extension = &activated.extensions[0];
    assert_eq!(extension.lifecycle, ExtensionHostLifecycle::Failed);
    assert_eq!(
        extension.failure.as_ref().unwrap().code,
        super::super::projection::ExtensionHostFailureKind::AuthorityDenied
    );
    assert!(extension.incarnation.is_none());
    assert!(extension.registrations.is_empty());
    assert!(activated.generation > before.generation);
    assert_eq!(runtime.snapshot_for(11), activated);
    assert_eq!(
        runtime.snapshot_for(22).extensions[0].lifecycle,
        ExtensionHostLifecycle::Dormant
    );
    assert!(
        runtime
            .inner
            .state
            .lock()
            .unwrap()
            .entry(11, "test.node")
            .unwrap()
            .supervisor
            .is_none()
    );
}

#[test]
fn late_speech_host_events_publish_the_admitted_fleet_without_health_polling() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, mut deployment) = install_node_fixture(directory.path());
    deployment
        .params
        .capabilities
        .push(ExtensionCapability::SpeechProvider);
    std::fs::write(directory.path().join("extension/extension.cjs"), r#"
        const v = require('vscode'); let registration, cancelled = 0;
        const factory = token => { const events = new v.EventEmitter(); token.onCancellationRequested(() => { cancelled++; events.dispose(); }); return { onDidChange: events.event }; };
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', action => {
            if (action === 'register') setTimeout(() => { registration = v.speech.registerSpeechProvider('test.dynamic', { provideSpeechToTextSession: factory, provideTextToSpeechSession: factory, provideKeywordRecognitionSession: factory }); }, 20);
            if (action === 'unregister') setTimeout(() => registration.dispose(), 20);
            return cancelled;
        }));
    "#).unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _peer = EditorPeer::start(client.clone(), 11, "first");
    let runtime = runtime_with_recipe(launcher, deployment, &grant, client);
    // Only the registration event callback can publish after this point.
    runtime
        .inner
        .shutdown
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(())
        .unwrap();
    runtime
        .inner
        .worker
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .join()
        .unwrap();
    let queue = crate::server::notification_queue::NotificationQueue::default();
    runtime.inner.updates.register(11, false, &queue);
    runtime
        .activate_by_event(
            11,
            "test.node",
            7,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    queue.drain();
    let initial = runtime.snapshot_for(11).generation;
    invoke_registration(
        &runtime,
        11,
        "test.node",
        "execute",
        json!({"arguments":["register"]}),
    );
    let wait_changed = || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let notifications = queue.drain();
            if notifications
                .iter()
                .any(|value| value["method"] == "extensionHost/changed")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Speech event did not publish its fleet"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    wait_changed();
    let registered = runtime.snapshot_for(11);
    assert!(registered.generation > initial);
    let speech = registered.extensions[0]
        .registrations
        .iter()
        .find(|entry| {
            matches!(
                entry.kind,
                external_ext_protocol::RegistrationKind::SpeechProvider { .. }
            )
        })
        .unwrap();
    invoke_registration(
        &runtime,
        11,
        &speech.registration_id,
        "createSpeechSession",
        json!({"sessionId":"a1234567-1234-1234-1234-123456789abc","kind":"speechToText"}),
    );
    queue.drain();
    invoke_registration(
        &runtime,
        11,
        "test.node",
        "execute",
        json!({"arguments":["unregister"]}),
    );
    wait_changed();
    assert!(
        !runtime.snapshot_for(11).extensions[0]
            .registrations
            .iter()
            .any(|entry| matches!(
                entry.kind,
                external_ext_protocol::RegistrationKind::SpeechProvider { .. }
            ))
    );
    assert_eq!(invoke(&runtime, 11), json!(1));
    runtime.close_owner(11);
    assert_eq!(
        runtime.snapshot_for(11).extensions[0].lifecycle,
        ExtensionHostLifecycle::Dormant
    );
}
