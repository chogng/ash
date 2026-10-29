use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_external_ext::ActivateParams;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::CancelReason;
use ash_external_ext::ExtensionActivationSpec;
use ash_external_ext::ExtensionCapability;
use ash_external_ext::ExtensionHostError;
use ash_external_ext::ExtensionHostLauncher;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostProcess;
use ash_external_ext::ExtensionHostStatus;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::HostErrorCode;
use ash_external_ext::PackageBinding;
use ash_external_ext::ProcessIsolationPolicy;
use ash_external_ext::ProductExecutableLauncher;
use ash_external_ext::RestartPolicy;
use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientResult;
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

struct Launcher {
    inner: ProductExecutableLauncher,
    process: Mutex<Option<Arc<dyn ExtensionHostProcess>>>,
}
impl ExtensionHostLauncher for Launcher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        let process = self.inner.spawn(command, limits)?;
        *self.process.lock().unwrap() = Some(Arc::clone(&process));
        Ok(process)
    }
}

struct Running {
    host: ExtensionHostSupervisor,
    authority: Arc<Authority>,
    launcher: Arc<Launcher>,
    status: Arc<Mutex<Vec<Value>>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.host.shutdown().unwrap();
    }
}

fn start(language: &str, capabilities: Vec<ExtensionCapability>) -> Running {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-debug-lldb"));
    let launcher = Arc::new(Launcher {
        inner: ProductExecutableLauncher::new(executable.clone()).unwrap(),
        process: Mutex::new(None),
    });
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let params = ActivateParams {
        initialization: Some(
            serde_json::from_value(json!({
                "language": language, "workspaceFolders": [], "workspaceName": null,
                "workspaceFile": null, "configurationValues": {}, "configurationData": {}
            }))
            .unwrap(),
        ),
        extension_id: "ash.debug-lldb".into(),
        package: PackageBinding {
            package_id: "ash.debug-lldb@1.0.0".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "ash-debug-lldb".into(),
        },
        runtime_api_version: 1,
        activation_events: vec!["onDebug:lldb-dap".into()],
        capabilities,
    };
    let host = ExtensionHostSupervisor::new(
        launcher.clone(),
        ExtensionLaunchCommand::new(
            executable,
            Vec::<String>::new(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            BTreeMap::new(),
        )
        .unwrap(),
        ExtensionActivationSpec::new(params, NonZeroU64::new(1).unwrap(), authority.clone()),
        ExtensionHostLimits {
            isolation: ProcessIsolationPolicy::AuthorizedProduct,
            ..Default::default()
        },
        RestartPolicy::default(),
    )
    .unwrap();
    Running {
        host,
        authority,
        launcher,
        status: Arc::new(Mutex::new(Vec::new())),
    }
}

fn running(language: &str) -> Running {
    let running = start(
        language,
        vec![
            ExtensionCapability::DebugAdapter,
            ExtensionCapability::Command,
            ExtensionCapability::StatusBar,
        ],
    );
    let status = Arc::clone(&running.status);
    let snapshot = running
        .host
        .start_with_client(
            None,
            Some(Arc::new(move |_, operation, _, _| match operation {
                ExtensionClientOperation::SetStatusBarEntries { entries, .. } => {
                    status
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(entries).unwrap());
                    Ok(ExtensionClientResult::Done)
                }
                _ => panic!("unexpected background client operation"),
            })),
        )
        .unwrap();
    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_eq!(snapshot.registrations.len(), 7);
    running
}

fn invocation(id: &str, operation: &str, payload: Value) -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: id.into(),
        operation: operation.into(),
        payload,
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(10))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}

fn adapter_request() -> ExtensionInvocation {
    invocation(
        "lldb.adapter",
        "createDebugAdapterDescriptor",
        json!({
            "configuration": {"name":"App","type":"lldb-dap","request":"launch","program":"/workspace/app"},
            "session": {"id":"client-owned-session","workspaceFolder":{"uri":"file:///workspace","name":"workspace","index":0}}
        }),
    )
}

fn descriptor(running: &Running, settings: Value) -> Result<Value, ExtensionHostError> {
    running
        .host
        .begin_invoke(adapter_request())?
        .wait_with_client(|operation, _, _| match operation {
            ExtensionClientOperation::ReadConfiguration { section, resource } => {
                assert_eq!(section, "debug.lldb");
                assert_eq!(resource.as_deref(), Some("file:///workspace"));
                Ok(ExtensionClientResult::Configuration {
                    value: settings.clone(),
                })
            }
            _ => panic!("unexpected client service request"),
        })
        .map(|result| result.payload)
}

#[test]
fn real_rust_provider_handles_all_resolution_phases_and_localizes_templates() {
    for (language, name) in [("en", "LLDB: Launch program"), ("zh-CN", "LLDB：启动程序")] {
        let running = running(language);
        let templates = running
            .host
            .invoke(invocation(
                "lldb.configuration",
                "provideDebugConfigurations",
                json!({"folder":null}),
            ))
            .unwrap()
            .payload;
        assert_eq!(templates["configurations"][0]["name"], name);
        let configuration = json!({"type":"lldb-dap","name":"Custom","request":"launch","program":"/workspace/app","args":["", "two words"],"env":{"CUSTOM":"value"}});
        for operation in [
            "resolveDebugConfiguration",
            "resolveDebugConfigurationWithSubstitutedVariables",
        ] {
            let resolved = running
                .host
                .invoke(invocation(
                    "lldb.configuration",
                    operation,
                    json!({"folder":null,"configuration":configuration}),
                ))
                .unwrap()
                .payload;
            assert_eq!(resolved["configuration"], configuration);
        }
    }
}

#[test]
fn descriptors_use_the_initiating_clients_settings_and_preserve_argument_boundaries() {
    let running = running("en");
    assert_eq!(
        descriptor(
            &running,
            json!({"adapterPath":"/tools/lldb-dap","adapterArgs":["", "two words"]})
        )
        .unwrap(),
        json!({"program":"/tools/lldb-dap","arguments":["", "two words"]})
    );
    assert_eq!(
        descriptor(&running, json!({})).unwrap()["program"],
        format!("lldb-dap{}", std::env::consts::EXE_SUFFIX)
    );
    assert_eq!(
        descriptor(&running, json!({"adapterPath":"/other/lldb-dap"})).unwrap()["program"],
        "/other/lldb-dap"
    );
}

#[test]
fn malformed_input_returns_localized_errors_and_does_not_retire_the_provider() {
    let running = running("zh-CN");
    let error = descriptor(&running, json!({"adapterPath":""})).unwrap_err();
    assert!(
        matches!(error, ExtensionHostError::HostRejected {code:HostErrorCode::InvalidRequest, ref message} if message.contains("请将"))
    );
    for payload in [
        json!({"folder":null}),
        json!({"folder":null,"configuration":{"name":"App","type":"lldb-dap","request":"launch"}}),
    ] {
        assert!(matches!(
            running.host.invoke(invocation(
                "lldb.configuration",
                "resolveDebugConfiguration",
                payload
            )),
            Err(ExtensionHostError::HostRejected {
                code: HostErrorCode::InvalidRequest,
                ..
            })
        ));
    }
    assert!(descriptor(&running, json!({})).is_ok());
}

#[test]
fn a_waiting_descriptor_does_not_block_configuration_or_cancellation() {
    let running = running("en");
    let pending = running.host.begin_invoke(adapter_request()).unwrap();
    assert!(
        running
            .host
            .invoke(invocation(
                "lldb.configuration",
                "provideDebugConfigurations",
                json!({"folder":null})
            ))
            .is_ok()
    );
    pending.cancel(CancelReason::Caller).unwrap();
    assert!(matches!(
        pending.wait(),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
    assert!(descriptor(&running, json!({})).is_ok());
}

#[test]
fn capability_denial_crash_recovery_and_disable_release_registration_ownership() {
    let denied = start("en", vec![ExtensionCapability::Command]);
    assert!(denied.host.start().is_err());
    assert!(!denied.host.is_running());
    let running = running("en");
    let previous = running.host.snapshot().incarnation;
    running
        .launcher
        .process
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .terminate()
        .unwrap();
    let snapshot = running.host.reconcile().unwrap();
    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_ne!(snapshot.incarnation, previous);
    assert!(descriptor(&running, json!({})).is_ok());
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        running.host.invoke(adapter_request()),
        Err(ExtensionHostError::AuthorityDenied)
    ));
    running.host.shutdown().unwrap();
    assert!(!running.host.is_running());
    assert!(running.host.snapshot().registrations.is_empty());
}

fn managed_request() -> ExtensionInvocation {
    let mut request = adapter_request();
    request.registration_id = "codelldb.adapter".into();
    request.payload["configuration"]["type"] = json!("lldb");
    request.payload["configuration"]["sourceLanguages"] = json!(["rust"]);
    request
}

#[test]
fn windows_rust_formatter_guard_preserves_commands_across_both_resolution_phases() {
    let running = running("en");
    let mut configuration = json!({"type":"lldb","name":"Rust","request":"launch","program":"/workspace/app","sourceLanguages":["rust"],"initCommands":["version"],"preRunCommands":["settings set target.max-children-count 50"]});
    for operation in [
        "resolveDebugConfiguration",
        "resolveDebugConfigurationWithSubstitutedVariables",
    ] {
        configuration = running
            .host
            .invoke(invocation(
                "codelldb.configuration",
                operation,
                json!({"folder":null,"configuration":configuration}),
            ))
            .unwrap()
            .payload["configuration"]
            .clone();
        assert_eq!(configuration["initCommands"], json!(["version"]));
        let commands = configuration["preRunCommands"].as_array().unwrap();
        assert_eq!(commands.len(), if cfg!(windows) { 2 } else { 1 });
        assert_eq!(
            commands.last().unwrap(),
            "settings set target.max-children-count 50"
        );
        if cfg!(windows) {
            assert!(commands[0].as_str().unwrap().contains("_ash_bounded"));
        }
    }
}

#[test]
fn codelldb_override_preserves_arguments_and_keeps_its_configuration_type() {
    let running = running("zh-CN");
    let template = running
        .host
        .invoke(invocation(
            "codelldb.configuration",
            "provideDebugConfigurations",
            json!({"folder":null}),
        ))
        .unwrap()
        .payload;
    assert_eq!(template["configurations"][0]["type"], "lldb");
    assert_eq!(template["configurations"][0]["name"], "CodeLLDB：启动程序");
    let descriptor = running.host.begin_invoke(managed_request()).unwrap().wait_with_client(|operation, _, _| match operation {
        ExtensionClientOperation::ReadConfiguration { .. } => Ok(ExtensionClientResult::Configuration { value: json!({"codeLldbPath":"/tools/codelldb","codeLldbArgs":["", "literal value"],"runtimeDirectory":"unused-relative-directory"}) }),
        _ => panic!("unexpected foreground request"),
    }).unwrap().payload;
    let arguments = if cfg!(windows) {
        assert!(
            descriptor["program"]
                .as_str()
                .unwrap()
                .ends_with("ash-debug-lldb.exe")
        );
        let values = descriptor["arguments"].as_array().unwrap();
        assert_eq!(values[0], "--stdio-adapter");
        assert_eq!(values[1], "无法连接 CodeLLDB 调试适配器");
        assert_eq!(values[2], "/tools/codelldb");
        json!(&values[3..])
    } else {
        assert_eq!(descriptor["program"], "/tools/codelldb");
        descriptor["arguments"].clone()
    };
    assert_eq!(
        arguments,
        json!([
            "",
            "literal value",
            "--settings",
            "{\"sourceLanguages\":[\"rust\"]}"
        ])
    );
    assert!(
        running.status.lock().unwrap().is_empty(),
        "explicit adapters never prepare a managed runtime"
    );
}

#[test]
fn managed_installation_reports_localized_progress_and_can_be_cancelled_and_retried() {
    let running = running("zh-CN");
    let root = tempfile::tempdir().unwrap();
    let version: Value = serde_json::from_str(include_str!("../runtime.json")).unwrap();
    let directory = root.path().join(version["version"].as_str().unwrap());
    std::fs::create_dir(&directory).unwrap();
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        value => value,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    let lock = std::fs::File::create(directory.join(format!("{os}-{arch}.lock"))).unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    for _ in 0..2 {
        running.status.lock().unwrap().clear();
        let pending = Arc::new(running.host.begin_invoke(managed_request()).unwrap());
        let settings = json!({"runtimeDirectory":root.path()});
        std::thread::scope(|scope| {
            let handle = Arc::clone(&pending);
            let wait = scope.spawn(move || {
                handle.wait_with_client(|operation, _, _| match operation {
                    ExtensionClientOperation::ReadConfiguration { .. } => {
                        Ok(ExtensionClientResult::Configuration {
                            value: settings.clone(),
                        })
                    }
                    _ => panic!("unexpected foreground request"),
                })
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while running.status.lock().unwrap().is_empty() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "installation did not publish waiting progress"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            let status = running.status.lock().unwrap()[0].clone();
            assert!(status[0]["text"].as_str().unwrap().contains("等待"));
            assert!(status[0]["ariaLabel"].as_str().unwrap().contains("取消"));
            assert_eq!(
                status[0]["command"]["command"],
                "ash.debug-lldb.cancelInstall"
            );
            running
                .host
                .invoke(invocation(
                    "ash.debug-lldb.cancelInstall",
                    "execute",
                    json!({"arguments":[],"activeEditor":null}),
                ))
                .unwrap();
            assert!(matches!(
                wait.join().unwrap(),
                Err(ExtensionHostError::HostRejected {
                    code: HostErrorCode::Cancelled,
                    ..
                })
            ));
        });
        assert!(
            running
                .status
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            !directory.join(format!("{os}-{arch}")).exists(),
            "cancellation must not publish a runtime"
        );
    }
}
