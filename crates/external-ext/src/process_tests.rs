use std::collections::BTreeMap;
use std::io::BufReader;
use std::io::Cursor;
use std::time::Duration;

use super::PendingEntry;
use super::reserve_pending;
use crate::ExtensionHostRequest;
use crate::ExtensionHostResponse;
use crate::HostRequestKind;
use crate::HostResponseKind;
use crate::HostSuccess;
use crate::PendingHostRequest;
use crate::RequestContext;
use external_ext_protocol::read_frame as read_bounded_line;

#[test]
fn product_js_policy_cannot_authorize_an_independent_executable_or_another_host() {
    use crate::ExtensionHostLauncher;
    let root = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let executable = root.join("ash-external-js-ext");
    let launcher = crate::ProductJavaScriptLauncher::new(executable.clone());
    let limits = crate::ExtensionHostLimits {
        isolation: crate::ProcessIsolationPolicy::RequireJavaScriptEnforcement(
            crate::JavaScriptMemoryLimits::default(),
        ),
        ..Default::default()
    };
    let independent = super::ExtensionLaunchCommand::new(
        &executable,
        std::iter::empty::<String>(),
        &root,
        BTreeMap::new(),
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&independent, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let other_host = super::ExtensionLaunchCommand::javascript(
        root.join("other-host"),
        std::iter::empty::<String>(),
        &root,
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&other_host, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let javascript =
        super::ExtensionLaunchCommand::javascript(executable, std::iter::empty::<String>(), root)
            .unwrap();
    assert!(matches!(
        launcher.spawn(&javascript, &crate::ExtensionHostLimits::default()),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
}

#[test]
fn bounded_reader_never_accepts_an_oversized_line() {
    let input = Cursor::new(b"123456\nnext\n".to_vec());
    let mut reader = BufReader::with_capacity(2, input);
    assert!(read_bounded_line(&mut reader, 5).is_err());
}

#[test]
fn bounded_reader_handles_chunked_crlf_and_clean_eof() {
    let input = Cursor::new(b"one\r\ntwo\n".to_vec());
    let mut reader = BufReader::with_capacity(2, input);
    assert_eq!(
        read_bounded_line(&mut reader, 8).unwrap(),
        Some(b"one".to_vec())
    );
    assert_eq!(
        read_bounded_line(&mut reader, 8).unwrap(),
        Some(b"two".to_vec())
    );
    assert_eq!(read_bounded_line(&mut reader, 8).unwrap(), None);
}

#[test]
fn duplicate_request_id_never_replaces_the_original_waiter() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(1, 1, 1),
        request: HostRequestKind::Ping,
    };
    let (original, original_sender) = PendingHostRequest::channel(1);
    let mut pending = BTreeMap::new();
    reserve_pending(
        &mut pending,
        PendingEntry {
            client_ids: std::collections::BTreeSet::new(),
            last_client_id: 0,
            request: request.clone(),
            sender: original_sender,
            control: false,
        },
        2,
        1,
    )
    .unwrap();
    let (_duplicate, duplicate_sender) = PendingHostRequest::channel(1);
    assert!(
        reserve_pending(
            &mut pending,
            PendingEntry {
                client_ids: std::collections::BTreeSet::new(),
                last_client_id: 0,
                request: request.clone(),
                sender: duplicate_sender,
                control: false,
            },
            2,
            1,
        )
        .is_err()
    );
    pending
        .remove(&1)
        .unwrap()
        .sender
        .send(Ok(super::PendingMessage::Response(ExtensionHostResponse {
            context: request.context,
            response: HostResponseKind::Success(HostSuccess::Pong),
        })))
        .unwrap();
    assert!(
        original
            .recv_timeout(Duration::from_millis(10))
            .unwrap()
            .is_some()
    );
}

#[test]
fn control_request_capacity_is_reserved_when_normal_requests_are_full() {
    let mut pending = BTreeMap::new();
    let normal = ExtensionHostRequest {
        context: RequestContext::new(1, 1, 1),
        request: HostRequestKind::Ping,
    };
    let (_, normal_sender) = PendingHostRequest::channel(1);
    reserve_pending(
        &mut pending,
        PendingEntry {
            client_ids: std::collections::BTreeSet::new(),
            last_client_id: 0,
            request: normal,
            sender: normal_sender,
            control: false,
        },
        1,
        1,
    )
    .unwrap();
    let cancel = ExtensionHostRequest {
        context: RequestContext::new(2, 1, 1),
        request: HostRequestKind::Cancel(crate::CancelParams {
            target_request_id: 1,
            reason: crate::CancelReason::Deadline,
        }),
    };
    let (_, cancel_sender) = PendingHostRequest::channel(2);
    assert!(
        reserve_pending(
            &mut pending,
            PendingEntry {
                client_ids: std::collections::BTreeSet::new(),
                last_client_id: 0,
                request: cancel,
                sender: cancel_sender,
                control: true,
            },
            1,
            1,
        )
        .is_ok()
    );
}

#[test]
fn node_runtime_requires_its_policy_exact_product_host_and_runtime_binding() {
    use crate::ExtensionHostLauncher;
    let executable = std::env::current_exe().unwrap();
    let root = executable.parent().unwrap().to_path_buf();
    let product = root.join("ash-external-js-ext");
    let launcher = crate::ProductJavaScriptLauncher::new(product.clone())
        .with_node_runtime(executable.clone(), executable, BTreeMap::new())
        .unwrap();
    let node = super::ExtensionLaunchCommand::vscode(product, std::iter::empty::<String>(), &root)
        .unwrap();
    let confined = crate::ExtensionHostLimits {
        isolation: crate::ProcessIsolationPolicy::RequireJavaScriptEnforcement(
            crate::JavaScriptMemoryLimits::default(),
        ),
        ..Default::default()
    };
    assert!(matches!(
        launcher.spawn(&node, &confined),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let limits = crate::ExtensionHostLimits {
        isolation: crate::ProcessIsolationPolicy::AuthorizedNode,
        ..Default::default()
    };
    let unbound = crate::ProductJavaScriptLauncher::new(node.executable().to_path_buf());
    assert!(matches!(
        unbound.spawn(&node, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let independent = super::ExtensionLaunchCommand::new(
        node.executable(),
        std::iter::empty::<String>(),
        &root,
        BTreeMap::new(),
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&independent, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let other = super::ExtensionLaunchCommand::vscode(
        root.join("package-program"),
        std::iter::empty::<String>(),
        &root,
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&other, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
}

#[test]
fn product_node_process_speaks_the_shared_protocol_and_uses_real_node() {
    use crate::ExtensionHostLauncher;
    use serde_json::json;
    let node = std::process::Command::new("node")
        .args(["--print", "process.execPath"])
        .output()
        .expect("Node is required for the standard extension host process test");
    assert!(node.status.success());
    let node = std::path::PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let root = std::env::temp_dir().join(format!(
        "ash-node-wire-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    // Embed declared test resources so Cargo and Bazel exercise the same entry
    // without depending on the runner's source checkout path.
    for (name, source) in [
        (
            "node.mjs",
            include_str!("../../external-js-ext/src/node.mjs"),
        ),
        (
            "vscode.mjs",
            include_str!("../../external-js-ext/src/vscode.js"),
        ),
        ("sdk.mjs", include_str!("../../../sdk/typescript/index.js")),
    ] {
        std::fs::write(root.join(name), source).unwrap();
    }
    let package = root.join("extension");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(package.join("package.json"), json!({
        "publisher": "test", "name": "node", "contributes": { "commands": [{"command": "test.node", "title": "Node"}] }
    }).to_string()).unwrap();
    std::fs::write(package.join("extension.cjs"), r#"
const v = require('vscode');
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', () => {
  require('node:fs').writeFileSync(__dirname + '/proof.txt', 'real Node');
  require('node:fs').writeSync(1, 'raw extension stdout\n');
  require('node:child_process').execFileSync(process.execPath, ['-e', 'process.stdout.write("inherited debug stdout")'], {stdio: 'inherit'});
  return Buffer.from('Node wire').toString();
}));
"#).unwrap();
    let product = root.join("ash-external-js-ext");
    let launcher = crate::ProductJavaScriptLauncher::new(product.clone())
        .with_node_runtime(node, root.join("node.mjs"), BTreeMap::new())
        .unwrap();
    let command = crate::ExtensionLaunchCommand::vscode(
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
    let limits = crate::ExtensionHostLimits {
        isolation: crate::ProcessIsolationPolicy::AuthorizedNode,
        ..Default::default()
    };
    let process = launcher.spawn(&command, &limits).unwrap();
    let mut id = 0;
    let mut request = |kind| {
        id += 1;
        let request = crate::ExtensionHostRequest {
            context: crate::RequestContext::new(id, 1, 2),
            request: kind,
        };
        let response = process
            .dispatch(request.clone())
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|error| panic!("{error}: {}", process.stderr()))
            .unwrap();
        response
            .validate_for(&request, &limits.protocol_limits())
            .unwrap();
        response.response
    };
    assert_eq!(
        request(crate::HostRequestKind::Initialize(
            crate::InitializeParams {
                environment: None,
                extension_id: "test.node".into(),
                runtime_api_version: 1
            }
        )),
        crate::HostResponseKind::Success(crate::HostSuccess::Initialized(
            crate::InitializeResult {
                protocol_version: 1,
                runtime_api_version: 1
            }
        ))
    );
    let activated = request(crate::HostRequestKind::Activate(crate::ActivateParams {
        extension_id: "test.node".into(),
        package: crate::PackageBinding {
            package_id: "test/node".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "extension.cjs".into(),
        },
        initialization: Some(external_ext_protocol::ExtensionHostInitialization {
            language: None,
            workspace_folders: Vec::new(),
            workspace_name: None,
            workspace_file: None,
            configuration_values: json!({}),
            configuration_data: json!({}),
        }),
        runtime_api_version: 1,
        activation_events: vec!["*".into()],
        capabilities: vec![crate::ExtensionCapability::Command],
    }));
    assert!(
        matches!(
            activated,
            crate::HostResponseKind::Success(crate::HostSuccess::Activated(_))
        ),
        "{}",
        process.stderr()
    );
    let invoked = request(crate::HostRequestKind::Invoke(crate::InvokeParams {
        extension_id: "test.node".into(),
        registration_id: "test.node".into(),
        operation: "execute".into(),
        payload: json!({"arguments":[]}),
        deadline_unix_millis: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 5000,
    }));
    assert_eq!(
        invoked,
        crate::HostResponseKind::Success(crate::HostSuccess::Invoked(crate::InvokeResult {
            payload: json!("Node wire")
        }))
    );
    assert_eq!(
        std::fs::read_to_string(package.join("proof.txt")).unwrap(),
        "real Node"
    );
    assert_eq!(
        request(crate::HostRequestKind::Shutdown),
        crate::HostResponseKind::Success(crate::HostSuccess::Shutdown)
    );
    process.terminate().unwrap();
    assert!(process.stderr().contains("raw extension stdout"));
    assert!(process.stderr().contains("inherited debug stdout"));

    // Exercise the actual supervisor, not a JS-only peer agreeing with its own frame format.
    std::fs::write(
        package.join("extension.cjs"),
        r#"
const v = require('vscode');
require('node:fs').writeFileSync(__dirname + '/initialization.txt', String(v.workspace.getConfiguration().get('nodeIncarnation')));
exports.activate = async context => {
  await Promise.all(Array.from({ length: 64 }, () => v.window.showInformationMessage('startup')));
  context.subscriptions.push(v.commands.registerCommand('test.node', async () => {
    await Promise.all(Array.from({ length: 64 }, () => v.window.showInformationMessage('foreground')));
    setTimeout(() => { void v.commands.executeCommand('background.wait'); }, 20);
    return 'scheduled';
  }));
};
"#,
    )
    .unwrap();
    struct Authority(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    struct Lease(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl crate::ActivationLease for Lease {}
    impl Drop for Lease {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    impl crate::ActivationAuthority for Authority {
        fn authorizes(&self) -> bool {
            true
        }
        fn acquire(&self) -> Option<Box<dyn crate::ActivationLease>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(Box::new(Lease(std::sync::Arc::clone(&self.0))))
        }
    }
    let leases = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let params = crate::ActivateParams {
        extension_id: "test.node".into(),
        package: crate::PackageBinding {
            package_id: "test/node".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "extension.cjs".into(),
        },
        initialization: Some(external_ext_protocol::ExtensionHostInitialization {
            language: None,
            workspace_folders: Vec::new(),
            workspace_name: None,
            workspace_file: None,
            configuration_values: json!({}),
            configuration_data: json!({}),
        }),
        runtime_api_version: 1,
        activation_events: vec!["*".into()],
        capabilities: vec![crate::ExtensionCapability::Command],
    };
    let launcher: std::sync::Arc<dyn crate::ExtensionHostLauncher> = std::sync::Arc::new(launcher);
    let supervisor = crate::ExtensionHostSupervisor::new(
        std::sync::Arc::clone(&launcher),
        command.clone(),
        crate::ExtensionActivationSpec::new(
            params.clone(),
            std::num::NonZeroU64::new(3).unwrap(),
            std::sync::Arc::new(Authority(std::sync::Arc::clone(&leases))),
        ),
        limits.clone(),
        crate::RestartPolicy::default(),
    )
    .unwrap();
    let (sent, received) = std::sync::mpsc::channel();
    fn window_facts(value: u64) -> external_ext_protocol::ExtensionHostInitialization {
        external_ext_protocol::ExtensionHostInitialization {
            language: None,
            workspace_folders: vec![],
            workspace_name: None,
            workspace_file: None,
            configuration_values: json!({"nodeIncarnation": value}),
            configuration_data: json!({}),
        }
    }
    let handler: std::sync::Arc<crate::ExtensionBackgroundClientHandler> =
        std::sync::Arc::new(move |context, operation, token, _timeout| {
            assert_eq!(context, crate::HostEventContext::new(1, 3));
            match operation {
                external_ext_protocol::ExtensionClientOperation::ReadInitialization {} => Ok(
                    external_ext_protocol::ExtensionClientResult::Initialization {
                        initialization: window_facts(1),
                    })
                }
                external_ext_protocol::ExtensionClientOperation::ExecuteCommand {
                    command, ..
                } => {
                    assert_eq!(command, "background.wait");
                    sent.send("background").unwrap();
                    while !token.is_cancelled() {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    sent.send("cancelled").unwrap();
                    Err(crate::HostFailure {
                        code: crate::HostErrorCode::Cancelled,
                        message: "window closed".into(),
                    })
                }
                operation => panic!("unexpected service call: {operation:?}"),
            }
        });
    let snapshot = supervisor
        .start_with_client(None, Some(std::sync::Arc::clone(&handler)))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(package.join("initialization.txt")).unwrap(),
        "1"
    );
    assert_eq!(snapshot.status, crate::ExtensionHostStatus::Ready);
    for _ in 0..64 {
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            "startup"
        );
    }
    let result = supervisor
        .begin_invoke(crate::ExtensionInvocation {
            registration_id: "test.node".into(),
            operation: "execute".into(),
            payload: json!({"arguments": []}),
            deadline_unix_millis: std::num::NonZeroU64::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 5000,
            )
            .unwrap(),
        })
        .unwrap()
        .wait_with_client(|operation, token, timeout| {
            handler(
                crate::HostEventContext::new(1, 3),
                operation,
                token,
                timeout,
            )
        })
        .unwrap();
    assert_eq!(result.payload, json!("scheduled"));
    for _ in 0..64 {
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            "startup"
        );
    }
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "background"
    );
    assert_eq!(leases.load(std::sync::atomic::Ordering::SeqCst), 2);
    supervisor
        .shutdown()
        .unwrap_or_else(|error| panic!("shutdown {error}: {}", supervisor.snapshot().stderr));
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "cancelled"
    );
    assert_eq!(leases.load(std::sync::atomic::Ordering::SeqCst), 0);
    let (sent, received) = std::sync::mpsc::channel();
    let handler: std::sync::Arc<crate::ExtensionBackgroundClientHandler> =
        std::sync::Arc::new(move |_, operation, token, _| {
            if matches!(
                operation,
                external_ext_protocol::ExtensionClientOperation::ReadInitialization {}
            ) {
                return Ok(
                    external_ext_protocol::ExtensionClientResult::Initialization {
                        initialization: window_facts(2),
                    },
                );
            }
            if matches!(
                operation,
                external_ext_protocol::ExtensionClientOperation::ShowMessage { .. }
            ) {
                return Ok(external_ext_protocol::ExtensionClientResult::Done);
            }
            sent.send("background").unwrap();
            while !token.is_cancelled() {
                std::thread::sleep(Duration::from_millis(2));
            }
            sent.send("cancelled").unwrap();
            Err(crate::HostFailure {
                code: crate::HostErrorCode::Cancelled,
                message: "owner dropped".into(),
            })
        });
    supervisor
        .start_with_client(None, Some(std::sync::Arc::clone(&handler)))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(package.join("initialization.txt")).unwrap(),
        "2"
    );
    supervisor
        .begin_invoke(crate::ExtensionInvocation {
            registration_id: "test.node".into(),
            operation: "execute".into(),
            payload: json!({"arguments": []}),
            deadline_unix_millis: std::num::NonZeroU64::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 5000,
            )
            .unwrap(),
        })
        .unwrap()
        .wait_with_client(|operation, token, timeout| {
            handler(
                crate::HostEventContext::new(2, 3),
                operation,
                token,
                timeout,
            )
        })
        .unwrap();
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "background"
    );
    drop(supervisor);
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "cancelled"
    );
    assert_eq!(leases.load(std::sync::atomic::Ordering::SeqCst), 0);

    // A real crash queries current editor facts before loading the replacement package.
    std::fs::write(package.join("extension.cjs"), r#"
const v = require('vscode'); const fact = v.workspace.getConfiguration().get('nodeIncarnation');
require('node:fs').writeFileSync(__dirname + '/initialization.txt', String(fact));
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', crash => { if (crash) process.exit(1); return fact; }));
"#).unwrap();
    let recovering = crate::ExtensionHostSupervisor::new(
        launcher,
        command,
        crate::ExtensionActivationSpec::new(
            params,
            std::num::NonZeroU64::new(3).unwrap(),
            std::sync::Arc::new(Authority(std::sync::Arc::clone(&leases))),
        ),
        limits,
        crate::RestartPolicy::default(),
    )
    .unwrap();
    let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let queried = std::sync::Arc::clone(&reads);
    let handler: std::sync::Arc<crate::ExtensionBackgroundClientHandler> =
        std::sync::Arc::new(move |_, operation, _, _| {
            assert!(matches!(
                operation,
                external_ext_protocol::ExtensionClientOperation::ReadInitialization {}
            ));
            Ok(
                external_ext_protocol::ExtensionClientResult::Initialization {
                    initialization: window_facts(
                        queried.fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u64 + 1,
                    ),
                },
            )
        });
    recovering.start_with_client(None, Some(handler)).unwrap();
    let invoke = |crash: bool| {
        recovering
            .begin_invoke(crate::ExtensionInvocation {
                registration_id: "test.node".into(),
                operation: "execute".into(),
                payload: json!({"arguments":[crash]}),
                deadline_unix_millis: std::num::NonZeroU64::new(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64
                        + 5000,
                )
                .unwrap(),
            })
            .unwrap()
            .wait()
    };
    assert!(invoke(true).is_err(), "a crashed command is not replayed");
    assert_eq!(recovering.snapshot().incarnation, 2);
    assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(invoke(false).unwrap().payload, json!(2));
    recovering.shutdown().unwrap();
    let wrong: std::sync::Arc<crate::ExtensionBackgroundClientHandler> =
        std::sync::Arc::new(|_, _, _, _| Ok(external_ext_protocol::ExtensionClientResult::Done));
    assert!(matches!(
        recovering.start_with_client(None, Some(wrong)),
        Err(crate::ExtensionHostError::InvalidProtocol(_))
    ));
    assert_eq!(
        recovering.snapshot().status,
        crate::ExtensionHostStatus::Stopped
    );
    assert_eq!(leases.load(std::sync::atomic::Ordering::SeqCst), 0);
}
