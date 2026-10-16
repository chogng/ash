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
}
impl Running {
    fn invoke(
        &self,
        request: ExtensionInvocation,
    ) -> Result<ash_external_ext::InvokeResult, ExtensionHostError> {
        self.host
            .begin_invoke(request)?
            .wait_with_client(|operation, _, _| {
                if let external_ext_protocol::ExtensionClientOperation::ReadConfiguration {
                    ..
                } = operation
                {
                    Ok(
                        external_ext_protocol::ExtensionClientResult::Configuration {
                            value: json!({}),
                        },
                    )
                } else {
                    Err(ash_external_ext::HostFailure {
                        code: HostErrorCode::RegistrationNotFound,
                        message: "optional capability unavailable".into(),
                    })
                }
            })
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.host.shutdown().unwrap();
    }
}
fn start() -> Running {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-markdown-language-features"));
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let launcher = Arc::new(Launcher {
        inner: ProductExecutableLauncher::new(executable.clone()).unwrap(),
        process: Mutex::new(None),
    });
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let command =
        ExtensionLaunchCommand::new(executable, Vec::<String>::new(), directory, BTreeMap::new())
            .unwrap();
    let activation = ExtensionActivationSpec::new(
        ActivateParams {
            initialization: None,
            extension_id: "vscode.markdown-language-features".into(),
            package: PackageBinding {
                package_id: "vscode.markdown-language-features@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "ash-markdown-language-features".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onStartupFinished".into()],
            capabilities: vec![
                ExtensionCapability::Command,
                ExtensionCapability::LanguageProvider,
                ExtensionCapability::CustomTextEditor,
            ],
        },
        NonZeroU64::new(1).unwrap(),
        authority.clone(),
    );
    let host = ExtensionHostSupervisor::new(
        launcher.clone(),
        command,
        activation,
        ExtensionHostLimits {
            isolation: ProcessIsolationPolicy::AuthorizedProduct,
            maximum_frame_bytes: 32 * 1024 * 1024,
            maximum_payload_bytes: 24 * 1024 * 1024,
            ..Default::default()
        },
        RestartPolicy::default(),
    )
    .unwrap();
    let snapshot = host.start().unwrap();
    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_eq!(snapshot.registrations.len(), 21);
    Running {
        host,
        authority,
        launcher,
    }
}
fn invocation(snapshot: Value) -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: "vscode.markdown.editor".into(),
        operation: "resolveCustomTextEditor".into(),
        payload: json!({"document": snapshot}),
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(20))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}
fn snapshot(text: &str) -> Value {
    json!({"uri": "file:///synthetic.md", "version": 7, "text": text,"languageId":"markdown","readOnly":false})
}

#[test]
fn real_product_process_preserves_utf16_source_and_rejects_invalid_contracts() {
    let running = start();
    let text =
        "\u{feff}# 中文😀\r\n\r\n**保真** [引用][id]  \r\n\r\n[id]: <https://example.com>\r\n";
    let result = running.invoke(invocation(snapshot(text))).unwrap().payload["update"].clone();
    assert_eq!(result["version"], 7);
    assert_eq!(result["uri"], "file:///synthetic.md");
    let blocks = result["blocks"].as_array().unwrap();
    let mut offset = 0;
    for block in blocks {
        assert_eq!(block[0], offset);
        offset = block[1].as_u64().unwrap();
    }
    assert_eq!(offset, text.encode_utf16().count() as u64);
    let deep = format!("{}deep\n", "> ".repeat(256));
    let nested = running.invoke(invocation(snapshot(&deep))).unwrap().payload;
    assert_eq!(
        nested["update"]["blocks"][0][1].as_u64().unwrap(),
        deep.len() as u64
    );
    let mut invalid = snapshot(text);
    invalid["version"] = json!(0);
    assert!(matches!(
        running.invoke(invocation(invalid)),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::InvalidRequest,
            ..
        })
    ));
}

#[test]
fn real_parser_is_cancellable_and_remains_usable() {
    let running = start();
    let pending = running
        .host
        .begin_invoke(invocation(snapshot(&"# x\n\n".repeat(1_000_000))))
        .unwrap();
    pending.cancel(CancelReason::Caller).unwrap();
    assert!(matches!(
        pending.wait(),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
    assert!(
        running
            .invoke(invocation(snapshot("# After cancellation")))
            .is_ok()
    );
}

#[test]
fn product_process_transports_large_wide_and_nested_render_trees() {
    let source = format!(
        "\u{feff}# 大文件\r\n\r\n{}{}深层中文😀\r\n",
        "中文😀 **加粗** [引用](https://example.com)  \r\n原始转义\\*。\r\n\r\n".repeat(16000),
        "> ".repeat(40)
    );
    assert!(source.len() > 1024 * 1024);
    let running = start();
    let result = running
        .invoke(invocation(snapshot(&source)))
        .unwrap()
        .payload["update"]
        .clone();
    assert!(serde_json::to_vec(&result).unwrap().len() > 512 * 1024);
    let blocks = result["blocks"].as_array().unwrap();
    assert!(blocks.len() > 8192);
    let mut offset = 0;
    for block in blocks {
        assert_eq!(block[0], offset);
        offset = block[1].as_u64().unwrap();
    }
    assert_eq!(offset, source.encode_utf16().count() as u64);
}

#[test]
fn four_megabytes_of_prose_fit_the_response_contract_and_leave_the_process_usable() {
    let source = "A paragraph with **bold** text, [link](https://example.com) and 中文😀.\n\n"
        .repeat(55_000);
    assert!(source.len() >= 4 * 1024 * 1024);
    let running = start();
    let result = running
        .invoke(invocation(snapshot(&source)))
        .unwrap()
        .payload;
    let blocks = result["update"]["blocks"].as_array().unwrap();
    assert_eq!(
        blocks.last().unwrap()[1].as_u64().unwrap(),
        source.encode_utf16().count() as u64
    );
    assert!(serde_json::to_vec(&result).unwrap().len() < 24 * 1024 * 1024);
    let incarnation = running.host.snapshot().incarnation;
    // The larger source still fits the input contract, but its render tree does
    // not fit the output quota. That must not retire this extension incarnation.
    assert!(matches!(
        running.invoke(invocation(snapshot(&source.repeat(2)))),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::QuotaExceeded,
            ..
        })
    ));
    assert!(
        running
            .invoke(invocation(snapshot("# Still alive")))
            .is_ok()
    );
    assert_eq!(running.host.snapshot().incarnation, incarnation);
}

#[test]
fn revocation_blocks_calls_and_process_crash_recovers_a_new_incarnation() {
    let running = start();
    let old = running.host.snapshot().incarnation;
    running
        .launcher
        .process
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .terminate()
        .unwrap();
    let restored = running.host.reconcile().unwrap();
    assert_eq!(restored.status, ExtensionHostStatus::Ready);
    assert_ne!(old, restored.incarnation);
    assert!(running.invoke(invocation(snapshot("# Recovered"))).is_ok());
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        running.invoke(invocation(snapshot("# Denied"))),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}
