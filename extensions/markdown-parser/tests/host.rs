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
impl Drop for Running {
    fn drop(&mut self) {
        self.host.shutdown().unwrap();
    }
}
fn start() -> Running {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-markdown-parser"));
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
            extension_id: "ash.markdown-parser".into(),
            package: PackageBinding {
                package_id: "ash.markdown-parser@0.1.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "ash-markdown-parser".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onCommand:_markdown.parse".into()],
            capabilities: vec![ExtensionCapability::Command],
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
    assert_eq!(snapshot.registrations.len(), 1);
    Running {
        host,
        authority,
        launcher,
    }
}
fn invocation(snapshot: Value) -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: "_markdown.parse".into(),
        operation: "execute".into(),
        payload: json!({"arguments": [snapshot]}),
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(20))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}
fn snapshot(text: &str) -> Value {
    json!({"protocol_version": 1, "uri": "file:///synthetic.md", "version": 7, "text": text})
}

#[test]
fn real_product_process_preserves_utf16_source_and_rejects_invalid_contracts() {
    let running = start();
    let text =
        "\u{feff}# 中文😀\r\n\r\n**保真** [引用][id]  \r\n\r\n[id]: <https://example.com>\r\n";
    let result = running
        .host
        .invoke(invocation(snapshot(text)))
        .unwrap()
        .payload;
    assert_eq!(result["version"], 7);
    assert_eq!(result["uri"], "file:///synthetic.md");
    let blocks = result["blocks"].as_array().unwrap();
    let mut offset = 0;
    for block in blocks {
        assert_eq!(block["start"], offset);
        offset = block["end"].as_u64().unwrap();
    }
    assert_eq!(offset, text.encode_utf16().count() as u64);
    let mut invalid = snapshot(text);
    invalid["protocol_version"] = json!(2);
    assert!(matches!(
        running.host.invoke(invocation(invalid)),
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
            .host
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
        .host
        .invoke(invocation(snapshot(&source)))
        .unwrap()
        .payload;
    assert!(serde_json::to_vec(&result).unwrap().len() > 512 * 1024);
    let blocks = result["blocks"].as_array().unwrap();
    assert!(blocks.len() > 8192);
    let mut offset = 0;
    for block in blocks {
        assert_eq!(block["start"], offset);
        offset = block["end"].as_u64().unwrap();
    }
    assert_eq!(offset, source.encode_utf16().count() as u64);
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
    assert!(
        running
            .host
            .invoke(invocation(snapshot("# Recovered")))
            .is_ok()
    );
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        running.host.invoke(invocation(snapshot("# Denied"))),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}
