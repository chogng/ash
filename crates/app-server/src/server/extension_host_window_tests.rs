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
        ("ash.js", "ash.mjs"),
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
const v = require('@ash/sdk');
const name = v.workspace.name;
const value = v.workspace.getConfiguration('test').get('value');
exports.activate = context => {
    setInterval(() => {}, 1000);
    context.subscriptions.push(v.commands.register('test.node', async () => ({
        name, value, pid: process.pid, echoed: await v.commands.execute('editor.echo', name)
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
    let command = ExtensionLaunchCommand::ash(
        vec![
            "--extension-id".into(),
            "test.node".into(),
            "--package".into(),
            package.to_str().unwrap().to_owned(),
            "--entry".into(),
            "extension.cjs".into(),
            "--api".into(),
            "ash".into(),
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

#[test]
fn ash_sdk_commands_use_rust_workspace_grants_and_retire_on_cancellation_and_disable() {
    use ash_core_plugins::PluginActivationAuthority;
    use ash_core_plugins::PluginAuthorityCommand;
    use ash_core_plugins::PluginAuthorityCommandId;
    use ash_core_plugins::PluginAuthorityCommandRequest;
    use ash_core_plugins::PluginPackageStore;
    use ash_file_system::FileSystem;
    use ash_file_system::LocalFileSystem;
    use ash_plugin::LocalPluginPackage;

    for package_read in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let (launcher, _) = install_node_fixture(directory.path());
        let package = directory.path().join("extension");
        std::fs::create_dir(package.join(".ash-plugin")).unwrap();
        std::fs::write(package.join(".ash-plugin/plugin.json"), json!({
            "schemaVersion": 1, "id": "acme/ash-sdk", "version": "1.0.0", "displayName": "Ash SDK",
            "compatibility": {"ash": ">=0.1.0"},
            "permissions": if package_read { json!([{"type": "directory", "access": "read"}]) } else { json!([]) },
            "contributions": {"editorExtensions": [{"id": "runtime", "runtime": "javascript", "api": "ash",
                "entrypoint": "extension.mjs", "runtimeApiVersion": 1,
                "activationEvents": [{"type": "onCommand", "id": "test.node"}], "capabilities": ["command"]}]}
        }).to_string()).unwrap();
        std::fs::write(package.join("package.json"), json!({
            "publisher": "acme", "name": "ash-sdk", "version": "1.0.0", "main": "./extension.mjs",
            "contributes": {"commands": [
                {"command": "test.node", "title": "Read with Ash SDK"},
                {"command": "ash.example.inspect", "title": "Run actual TypeScript example"}
            ]}
        }).to_string()).unwrap();
        std::fs::write(
            package.join("extension.ts"),
            r#"
import * as ash from '@ash/sdk';
import { activate as activateExample } from './inspect.mjs';
let release: (() => void) | undefined;
let resumed: unknown;
export function activate(context: ash.ExtensionContext): void {
 activateExample(context);
 context.subscriptions.push(ash.commands.register('test.node', async (path: unknown) => {
  if (path === ':status') return { waiting: !!release, resumed };
  if (path === ':release') { release!(); release = undefined; return {}; }
  if (typeof path !== 'string') throw new TypeError('Expected a file path');
  const waiting = path === ':wait';
  if (waiting) { await new Promise<void>(resolve => { release = resolve; }); path = 'data.txt'; }
  try {
   const text = await ash.files.readTextFile(path);
   if (waiting) resumed = 'unexpected-read';
   return { text, pid: process.pid };
  } catch (error: any) {
   if (waiting) { resumed = error.code; throw error; }
   return { code: error.code, message: error.message };
  }
 }));
};
"#,
        )
        .unwrap();
        std::fs::write(
            package.join("inspect.ts"),
            include_str!("../../../../examples/extensions/inspect/extension.ts"),
        )
        .unwrap();
        // Exercise the actual TS example without asking extension authors to install Rust.
        // Type stripping is the Node build step; the product host executes its ESM output.
        for entry in ["inspect", "extension"] {
            let output = std::process::Command::new("node")
                .args([
                    "--input-type=commonjs",
                    "-e",
                    r#"
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
fs.writeFileSync(process.argv[2], stripTypeScriptTypes(fs.readFileSync(process.argv[1], 'utf8')));
"#,
                ])
                .arg(package.join(format!("{entry}.ts")))
                .arg(package.join(format!("{entry}.mjs")))
                .output()
                .expect("Node with TypeScript stripping is required for the Ash SDK test");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let local = LocalPluginPackage::load(&package).unwrap();
        let store = tempfile::tempdir().unwrap();
        let authority =
            PluginActivationAuthority::in_memory(PluginPackageStore::open(store.path()).unwrap())
                .unwrap();
        let installed = authority
            .install_local(PluginAuthorityCommandId::new("install").unwrap(), 0, &local)
            .unwrap()
            .package;
        let apply = |revision, id: &str, command| {
            authority
                .apply(PluginAuthorityCommandRequest {
                    command_id: PluginAuthorityCommandId::new(id).unwrap(),
                    expected_revision: revision,
                    command,
                })
                .unwrap();
        };
        let activation_grant = Grant::for_environment(
            Dir::open_local(directory.path()).unwrap(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::DiscoverPlugins]),
        );
        // A separate workspace ensures this SDK result comes from the bound Rust service.
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("data.txt"),
            "Rust-owned workspace text",
        )
        .unwrap();
        let read_grant = Grant::for_environment(
            Dir::open_local(workspace.path()).unwrap(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::ReadFiles]),
        );
        let files: Arc<dyn FileSystem> = Arc::new(LocalFileSystem::new(read_grant.clone()));
        let client = Arc::new(crate::client_host::ClientHost::default());
        let _peer = EditorPeer::start(client.clone(), 11, "ash-sdk");
        let runtime = ExtensionHostRuntime::start(
            BuiltInEditorExtensions::Omitted,
            Some(authority.clone()),
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
            .bind_dir(
                activation_grant
                    .authorize(Permission::DiscoverPlugins)
                    .unwrap(),
            )
            .unwrap();
        assert!(runtime.snapshot_for(11).extensions.is_empty());
        apply(
            1,
            "enable",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        );
        runtime
            .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
            .unwrap();
        assert!(
            runtime.snapshot_for(11).extensions.is_empty(),
            "enablement must not grant execution"
        );
        apply(
            2,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        );
        runtime
            .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
            .unwrap();
        let dormant = runtime.snapshot_for(11).extensions[0].clone();
        let active = runtime
            .activate_by_event(
                11,
                &dormant.id,
                dormant.activation_generation,
                ActivationEvent::Command("test.node".into()),
                None,
                Ok(files.clone()),
            )
            .unwrap()
            .extensions[0]
            .clone();
        assert_eq!(
            active.lifecycle,
            ExtensionHostLifecycle::Ready,
            "{:?}",
            active.failure
        );
        let request = |path: &str| ExtensionHostInvocationRequest {
            extension_id: active.id.clone(),
            registration_id: "test.node".into(),
            registration_generation: None,
            activation_generation: active.activation_generation,
            incarnation: active.incarnation.unwrap(),
            operation: "execute".into(),
            payload: json!({"arguments": [path]}),
            deadline_unix_millis: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 10_000,
        };
        let wait = |id: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match runtime.read_invocation(11, id).unwrap() {
                    ExtensionHostInvocationRead::Succeeded(value) => break value,
                    ExtensionHostInvocationRead::Pending => {
                        assert!(Instant::now() < deadline, "Ash SDK command did not finish");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    ExtensionHostInvocationRead::Failed(failure) => {
                        panic!("Ash SDK command failed: {failure:?}")
                    }
                    ExtensionHostInvocationRead::Cancelled(reason) => {
                        panic!("Ash SDK command cancelled: {reason:?}")
                    }
                }
            }
        };
        let invoke = |path: &str| {
            let id = runtime
                .start_invocation(11, request(path), Ok(files.clone()))
                .unwrap();
            wait(&id)
        };
        let first = invoke("data.txt");
        if package_read {
            let mut example = request("data.txt");
            example.registration_id = "ash.example.inspect".into();
            let example_id = runtime
                .start_invocation(11, example, Ok(files.clone()))
                .unwrap();
            assert_eq!(wait(&example_id), "Rust-owned workspace text");
            assert_eq!(first["text"], "Rust-owned workspace text");
            assert_ne!(
                first["pid"].as_u64().unwrap(),
                u64::from(std::process::id())
            );
            assert_eq!(invoke("../data.txt")["code"], "invalidRequest");
            assert_eq!(
                invoke(workspace.path().join("data.txt").to_str().unwrap())["code"],
                "invalidRequest"
            );
            let absent = runtime
                .start_invocation(11, request("data.txt"), Err(test_files_unavailable()))
                .unwrap();
            assert_eq!(
                wait(&absent)["code"],
                "operationNotSupported",
                "installation cannot manufacture a filesystem service"
            );

            let pending = runtime
                .start_invocation(11, request(":wait"), Ok(files.clone()))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while invoke(":status")["waiting"] != true {
                assert!(Instant::now() < deadline, "delayed command did not start");
                std::thread::sleep(Duration::from_millis(5));
            }
            runtime
                .cancel_invocation(11, &pending, super::super::ResultRetention::Retain)
                .unwrap();
            invoke(":release");
            loop {
                let status = invoke(":status");
                if status["resumed"] == "cancelled" {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "cancelled command retained SDK access: {status}"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            loop {
                match runtime.read_invocation(11, &pending).unwrap() {
                    ExtensionHostInvocationRead::Cancelled(_) => break,
                    ExtensionHostInvocationRead::Pending => {
                        assert!(Instant::now() < deadline, "cancellation was not published");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    ExtensionHostInvocationRead::Failed(failure) => {
                        panic!("cancelled command failed instead: {failure:?}")
                    }
                    ExtensionHostInvocationRead::Succeeded(value) => {
                        panic!("cancelled command succeeded instead: {value}")
                    }
                }
            }
            assert_eq!(invoke("data.txt")["text"], "Rust-owned workspace text");
            read_grant.revoke();
            assert_eq!(invoke("data.txt")["code"], "permissionDenied");
        } else {
            assert_eq!(
                first["code"], "permissionDenied",
                "workspace permission cannot replace package permission"
            );
        }
        let supervisor = runtime
            .inner
            .state
            .lock()
            .unwrap()
            .entry(11, &active.id)
            .unwrap()
            .supervisor
            .clone()
            .unwrap();
        apply(
            3,
            "disable",
            PluginAuthorityCommand::Disable { package: installed },
        );
        runtime
            .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
            .unwrap();
        assert_eq!(
            supervisor.snapshot().status,
            ash_external_ext::ExtensionHostStatus::Stopped
        );
        assert!(runtime.snapshot_for(11).extensions.is_empty());
        assert!(matches!(
            runtime.start_invocation(11, request("data.txt"), Ok(files)),
            Err(ExtensionHostRuntimeError::Stale)
        ));
        runtime.shutdown();
    }
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
        const v = require('@ash/sdk'); let registration, cancelled = 0;
        const factory = token => { const events = new v.EventEmitter(); token.onCancellationRequested(() => { cancelled++; events.dispose(); }); return { onDidChange: events.event }; };
        exports.activate = context => context.subscriptions.push(v.commands.register('test.node', action => {
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

#[test]
fn admitted_plugin_terminal_resources_survive_factory_disposal_and_retire_on_revoke() {
    use ash_core_plugins::PluginActivationAuthority;
    use ash_core_plugins::PluginAuthorityCommand;
    use ash_core_plugins::PluginAuthorityCommandId;
    use ash_core_plugins::PluginAuthorityCommandRequest;
    use ash_core_plugins::PluginPackageStore;
    use ash_plugin::LocalPluginPackage;
    use external_ext_protocol::RegistrationKind;

    let directory = tempfile::tempdir().unwrap();
    let (launcher, _) = install_node_fixture(directory.path());
    let package = directory.path().join("extension");
    std::fs::create_dir(package.join(".ash-plugin")).unwrap();
    std::fs::write(package.join(".ash-plugin/plugin.json"), json!({
        "schemaVersion": 1, "id": "acme/terminal-followup", "version": "1.0.0",
        "displayName": "Terminal followup", "compatibility": {"ash": ">=0.1.0"}, "permissions": [],
        "contributions": {"editorExtensions": [{"id": "runtime", "runtime": "javascript", "api": "ash",
            "entrypoint": "extension.cjs", "runtimeApiVersion": 1,
            "activationEvents": [{"type": "onCommand", "id": "test.node"}],
            "capabilities": ["command", "terminalProfileProvider", "terminalLinkProvider", "speechProvider"]}]}
    }).to_string()).unwrap();
    std::fs::write(package.join("package.json"), json!({
        "publisher": "acme", "name": "terminal-followup", "version": "1.0.0", "main": "./extension.cjs",
        "engines": {"ash": "*"}, "contributes": {
            "commands": [{"command": "test.node", "title": "Control"}],
            "terminal": {"profiles": [{"id": "pty", "title": "PTY"}]}
        }
    }).to_string()).unwrap();
    std::fs::write(package.join("extension.cjs"), r#"
const v = require('@ash/sdk');
exports.activate = context => {
 let factory; let links; let closes = 0; let inputs = []; let delay = false; let pending; let cancelled = 0;
 const install = () => {
  factory = v.window.registerTerminalProfileProvider('pty', { provideTerminalProfile: () => {
   const write = new v.EventEmitter(); const end = new v.EventEmitter();
   return new v.TerminalProfile({ name: 'Owned PTY', pty: { onDidWrite: write.event, onDidClose: end.event,
    open: () => write.fire('READY'), handleInput: text => { inputs.push(text); write.fire('ACK:' + text); if (text === 'exit') end.fire(0); }, close: () => closes++ } });
  }});
  links = v.window.registerTerminalLinkProvider({ provideTerminalLinks: (_, token) => { token.onCancellationRequested(() => cancelled++); const value = [{ startIndex: 0, length: 4, original: 'owner' }]; return delay ? new Promise(resolve => { pending = () => { resolve(value); pending = undefined; }; }) : value; }, handleTerminalLink: link => inputs.push(link.original) });
  context.subscriptions.push(factory, links);
 };
 context.subscriptions.push(v.commands.register('test.node', action => {
  if (action === 'install') install();
  if (action === 'withdraw') { factory.dispose(); links.dispose(); }
  if (action === 'delay') delay = true;
  if (action === 'release') { delay = false; pending(); }
  return { closes, inputs, pid: process.pid, pending: !!pending, cancelled };
 }));
};
"#).unwrap();
    let local = LocalPluginPackage::load(&package).unwrap();
    let store = tempfile::tempdir().unwrap();
    let authority =
        PluginActivationAuthority::in_memory(PluginPackageStore::open(store.path()).unwrap())
            .unwrap();
    let installed = authority
        .install_local(PluginAuthorityCommandId::new("install").unwrap(), 0, &local)
        .unwrap()
        .package;
    let apply = |revision, id: &str, command| {
        authority
            .apply(PluginAuthorityCommandRequest {
                command_id: PluginAuthorityCommandId::new(id).unwrap(),
                expected_revision: revision,
                command,
            })
            .unwrap();
    };
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _peer = EditorPeer::start(client.clone(), 11, "normal-grant");
    let runtime = ExtensionHostRuntime::start(
        BuiltInEditorExtensions::Omitted,
        Some(authority.clone()),
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
    assert!(
        runtime.snapshot_for(11).extensions.is_empty(),
        "installation must not authorize execution"
    );
    apply(
        1,
        "enable",
        PluginAuthorityCommand::Enable {
            package: installed.clone(),
        },
    );
    runtime
        .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    assert!(
        runtime.snapshot_for(11).extensions.is_empty(),
        "enablement must not imply execution grant"
    );
    apply(
        2,
        "grant",
        PluginAuthorityCommand::Grant {
            package: installed.clone(),
        },
    );
    runtime
        .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    let snapshot = runtime.snapshot_for(11);
    let extension_id = snapshot.extensions[0].id.clone();
    assert_eq!(extension_id, "acme/terminal-followup:runtime");
    runtime
        .activate_by_event(
            11,
            &extension_id,
            snapshot.extensions[0].activation_generation,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    let control = |action: &str| {
        invoke_registration(
            &runtime,
            11,
            "test.node",
            "execute",
            json!({"arguments": [action]}),
        )
    };
    let first_pid = control("")["pid"].as_u64().unwrap();
    control("install");
    let wait_kind = |kind: fn(&RegistrationKind) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = runtime.snapshot_for(11);
            if let Some(registration) = snapshot.extensions[0]
                .registrations
                .iter()
                .find(|entry| kind(&entry.kind))
            {
                break registration.registration_id.clone();
            }
            assert!(
                Instant::now() < deadline,
                "registration event did not reach fleet"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let factory =
        wait_kind(|kind| matches!(kind, RegistrationKind::TerminalProfileProvider { .. }));
    let links = wait_kind(|kind| matches!(kind, RegistrationKind::TerminalLinkProvider {}));
    let provided = invoke_registration(
        &runtime,
        11,
        &links,
        "provideTerminalLinks",
        json!({"line": "LINK", "terminal": {"id": "one", "name": "Shell", "processId": 1}}),
    );
    invoke_registration(
        &runtime,
        11,
        &links,
        "handleTerminalLink",
        json!({"id": provided["links"][0]["id"]}),
    );
    let start_profile = || {
        let active = runtime.snapshot_for(11).extensions[0].clone();
        runtime
            .start_invocation(
                11,
                ExtensionHostInvocationRequest {
                    extension_id: extension_id.clone(),
                    registration_id: factory.clone(),
                    registration_generation: None,
                    activation_generation: active.activation_generation,
                    incarnation: active.incarnation.unwrap(),
                    operation: "createTerminalProfile".into(),
                    payload: json!({}),
                    deadline_unix_millis: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64
                        + 10_000,
                },
                Err(test_files_unavailable()),
            )
            .unwrap()
    };
    let abandoned = start_profile();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !runtime
        .inner
        .sessions
        .lock()
        .unwrap()
        .is_completed(&abandoned)
    {
        assert!(
            Instant::now() < deadline,
            "profile invocation did not complete"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        runtime
            .cancel_invocation(11, &abandoned, super::super::ResultRetention::Discard)
            .unwrap(),
        super::super::ExtensionHostInvocationCancelDisposition::AlreadyTerminal
    ));
    while control("")["closes"] != 1 {
        assert!(
            Instant::now() < deadline,
            "discarded completed profile leaked its PTY"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    while runtime.snapshot_for(11).extensions[0]
        .registrations
        .iter()
        .any(|entry| matches!(entry.kind, RegistrationKind::TerminalPty {}))
    {
        assert!(
            Instant::now() < deadline,
            "discarded PTY registration was not retired"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let delivered = start_profile();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !runtime
        .inner
        .sessions
        .lock()
        .unwrap()
        .is_completed(&delivered)
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        runtime.read_invocation(11, &delivered).unwrap(),
        ExtensionHostInvocationRead::Succeeded(_)
    ));
    assert!(
        matches!(
            runtime.read_invocation(11, &delivered),
            Err(ExtensionHostRuntimeError::InvocationNotFound)
        ),
        "a delivered result is never replayed"
    );
    assert!(matches!(
        runtime
            .cancel_invocation(11, &delivered, super::super::ResultRetention::Discard)
            .unwrap(),
        super::super::ExtensionHostInvocationCancelDisposition::AlreadyTerminal
    ));
    while control("")["closes"] != 2 {
        assert!(
            Instant::now() < deadline,
            "read-but-unadopted profile leaked after discard"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    for (index, expiry) in [true, false].into_iter().enumerate() {
        let unread = start_profile();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !runtime.inner.sessions.lock().unwrap().is_completed(&unread) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        {
            let mut sessions = runtime.inner.sessions.lock().unwrap();
            if expiry {
                sessions.sweep_expired(Instant::now() + Duration::from_secs(61));
            } else {
                assert!(
                    sessions
                        .detach_owner(11, ash_external_ext::CancelReason::Caller)
                        .is_empty()
                );
            }
        }
        while control("")["closes"] != index + 3 {
            assert!(
                Instant::now() < deadline,
                "unread profile resource survived expiry or owner detachment"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    control("delay");
    let active = runtime.snapshot_for(11).extensions[0].clone();
    let pending_id = runtime.start_invocation(11, ExtensionHostInvocationRequest {
        extension_id: extension_id.clone(), registration_id: links.clone(), registration_generation: None,
        activation_generation: active.activation_generation, incarnation: active.incarnation.unwrap(),
        operation: "provideTerminalLinks".into(), payload: json!({"line": "LINK", "terminal": {"id": "one", "name": "Shell", "processId": 1}}),
        deadline_unix_millis: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 10000,
    }, Err(test_files_unavailable())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while control("")["pending"] != true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    runtime
        .cancel_invocation(11, &pending_id, super::super::ResultRetention::Discard)
        .unwrap();
    while control("")["cancelled"] != 1 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    control("release");
    assert!(
        runtime.read_invocation(11, &pending_id).is_err(),
        "late result must not revive a discarded invocation"
    );
    let adopted = start_profile();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !runtime
        .inner
        .sessions
        .lock()
        .unwrap()
        .is_completed(&adopted)
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let ExtensionHostInvocationRead::Succeeded(created) =
        runtime.read_invocation(11, &adopted).unwrap()
    else {
        panic!("profile creation failed");
    };

    let pty = &created["pty"];
    let resource = pty["registrationId"].as_str().unwrap();
    assert_ne!(resource, factory);
    assert_eq!(
        wait_kind(|kind| matches!(kind, RegistrationKind::TerminalPty {})),
        resource
    );
    control("withdraw");
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.snapshot_for(11).extensions[0]
        .registrations
        .iter()
        .any(|entry| entry.registration_id == factory)
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(control("")["closes"], 4);
    let opened = invoke_registration(
        &runtime,
        11,
        resource,
        "openTaskTerminal",
        json!({"ptyId": pty["ptyId"], "dimensions": {"columns": 80, "rows": 24}}),
    );
    assert_eq!(
        opened,
        json!({"events": [{"type": "data", "data": "READY"}]})
    );
    assert!(
        matches!(
            runtime.cancel_invocation(11, &adopted, super::super::ResultRetention::Discard),
            Err(ExtensionHostRuntimeError::InvocationNotFound)
        ),
        "opening adopts the lease; old result cancellation must not close the live terminal"
    );
    assert_eq!(control("")["closes"], 4);
    let accepted = invoke_registration(
        &runtime,
        11,
        resource,
        "inputTaskTerminal",
        json!({"ptyId": pty["ptyId"], "data": "exit"}),
    );
    assert_eq!(
        accepted,
        json!({"events": [{"type": "data", "data": "ACK:exit"}, {"type": "close", "code": 0}]})
    );
    assert_eq!(control("")["inputs"], json!(["owner", "exit"]));
    assert_eq!(control("")["pid"], first_pid);
    let old = runtime.snapshot_for(11).extensions[0].clone();
    let stale = || ExtensionHostInvocationRequest {
        extension_id: extension_id.clone(),
        registration_id: resource.into(),
        registration_generation: None,
        activation_generation: old.activation_generation,
        incarnation: old.incarnation.unwrap(),
        operation: "readTaskTerminal".into(),
        payload: json!({"ptyId": pty["ptyId"]}),
        deadline_unix_millis: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 10_000,
    };
    apply(
        3,
        "revoke",
        PluginAuthorityCommand::RevokeGrant {
            package: installed.clone(),
        },
    );
    runtime
        .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    assert!(matches!(
        runtime.start_invocation(11, stale(), Err(test_files_unavailable())),
        Err(ExtensionHostRuntimeError::Stale)
    ));
    apply(
        4,
        "regrant",
        PluginAuthorityCommand::Grant { package: installed },
    );
    runtime
        .reconcile(super::super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    let fresh = runtime.snapshot_for(11);
    runtime
        .activate_by_event(
            11,
            &extension_id,
            fresh.extensions[0].activation_generation,
            ActivationEvent::Command("test.node".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    assert_ne!(control("")["pid"], first_pid);
    assert!(matches!(
        runtime.start_invocation(11, stale(), Err(test_files_unavailable())),
        Err(ExtensionHostRuntimeError::Stale)
    ));
    assert!(
        runtime.snapshot_for(11).extensions[0]
            .registrations
            .iter()
            .all(|entry| !matches!(entry.kind, RegistrationKind::TerminalPty {}))
    );
    runtime.close_owner(11);
}
