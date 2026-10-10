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
use ash_external_ext::ProductJavaScriptLauncher;
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

use super::super::ExtensionHostInvocationRead;
use super::super::ExtensionHostInvocationRequest;
use super::super::ExtensionHostRuntime;
use super::super::ExtensionHostRuntimeError;
use super::super::NodeClientScope;
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
                                    language: Some("en".into()),
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

fn install_node_fixture(root: &Path) -> (ProductJavaScriptLauncher, EditorExtensionDeployment) {
    let output = std::process::Command::new("node")
        .args(["--print", "process.execPath"])
        .output()
        .expect("Node is required for standard extension lifecycle tests");
    assert!(output.status.success());
    let node = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../external-js-ext/src");
    for (from, to) in [("node.mjs", "node.mjs"), ("vscode.js", "vscode.mjs")] {
        std::fs::copy(source.join(from), root.join(to)).unwrap();
    }
    std::fs::copy(
        source.join("../../../sdk/typescript/index.js"),
        root.join("sdk.mjs"),
    )
    .unwrap();
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
    let product = root.join("ash-external-js-ext");
    let launcher = ProductJavaScriptLauncher::new(product.clone())
        .with_node_runtime(node, root.join("node.mjs"), BTreeMap::new())
        .unwrap();
    let command = ExtensionLaunchCommand::vscode(
        product,
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
    let snapshot = runtime.snapshot_for(owner);
    let extension = &snapshot.extensions[0];
    let request = ExtensionHostInvocationRequest {
        extension_id: extension.id.clone(),
        registration_id: "test.node".into(),
        activation_generation: extension.activation_generation,
        incarnation: extension.incarnation.unwrap(),
        operation: "execute".into(),
        payload: json!({"arguments": []}),
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
    launcher: ProductJavaScriptLauncher,
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
            activation_gate: Arc::new(std::sync::Mutex::new(())),
            version: deployment.version.clone(),
            workspace_read: WorkspaceReadAccess::Denied,
            supervisor: None,
            failure: None,
            pending_activation: deployment.activation.clone(),
            node_client: NodeClientScope::Pending,
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
            node_deployment: Some(deployment),
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
