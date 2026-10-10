use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use host::ActivateParams;
use host::ActivationAuthority;
use host::ActivationLease;
use host::CancelReason;
use host::ExtensionActivationSpec;
use host::ExtensionCapability;
use host::ExtensionHostError;
use host::ExtensionHostLimits;
use host::ExtensionHostStatus;
use host::ExtensionHostSupervisor;
use host::ExtensionInvocation;
use host::ExtensionLaunchCommand;
use host::HostErrorCode;
use host::HostOutputOperation;
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

struct RunningExtension {
    host: ExtensionHostSupervisor,
    authority: Arc<Authority>,
}

impl Drop for RunningExtension {
    fn drop(&mut self) {
        self.host
            .shutdown()
            .expect("SDK example shuts down cleanly");
    }
}

fn start() -> RunningExtension {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_review"));
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let command =
        ExtensionLaunchCommand::new(executable, Vec::<String>::new(), directory, BTreeMap::new())
            .unwrap();
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let activation = ExtensionActivationSpec::new(
        ActivateParams {
            initialization: None,
            extension_id: "example.review".into(),
            package: PackageBinding {
                package_id: "example/review@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "bin/review".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onCommand:review.echo".into()],
            capabilities: vec![
                ExtensionCapability::Command,
                ExtensionCapability::LanguageProvider,
            ],
        },
        NonZeroU64::new(1).unwrap(),
        authority.clone(),
    );
    let host = ExtensionHostSupervisor::new(
        Arc::new(TrustedDevelopmentLauncher),
        command,
        activation,
        ExtensionHostLimits {
            isolation: ProcessIsolationPolicy::TrustedDevelopment,
            ..ExtensionHostLimits::default()
        },
        RestartPolicy::default(),
    )
    .unwrap();
    let snapshot = host.start().unwrap();
    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_eq!(snapshot.registrations.len(), 4);
    RunningExtension { host, authority }
}

fn invocation(id: &str, operation: &str, payload: Value) -> ExtensionInvocation {
    let deadline = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(10))
        .as_millis() as u64;
    ExtensionInvocation {
        registration_id: id.into(),
        operation: operation.into(),
        payload,
        deadline_unix_millis: NonZeroU64::new(deadline).unwrap(),
    }
}

fn wait_until_waiting(host: &ExtensionHostSupervisor) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if host.snapshot().output_events.iter().any(|entry| matches!(&entry.event.operation, HostOutputOperation::Append { text, .. } if text == "waiting\n")) { return; }
        assert!(
            Instant::now() < deadline,
            "SDK example did not start its waiting callback"
        );
        thread::yield_now();
    }
}

#[test]
fn independent_sdk_program_registers_invokes_and_emits_output_through_the_real_host() {
    let running = start();
    let result = running
        .host
        .invoke(invocation(
            "review.echo",
            "execute",
            json!({"arguments": ["hello", 7]}),
        ))
        .unwrap();
    assert_eq!(result.payload, json!(["hello", 7]));
    assert!(running.host.snapshot().output_events.iter().any(|entry| matches!(&entry.event.operation, HostOutputOperation::Append { text, .. } if text == "echo\n")));
}

#[test]
fn hover_receives_the_frontend_snapshot_and_zero_based_utf16_position() {
    let running = start();
    let result = running.host.invoke(invocation("review.hover", "hover", json!({
        "languageId": "rust", "version": 7, "resource": "file:///workspace/main.rs", "text": "😀 x\r\n", "position": {"lineIndex": 0, "columnIndex": 2}
    }))).unwrap();
    assert_eq!(
        result.payload,
        json!({"contents": ["version 7 at 0:2"], "range": {"start": {"lineIndex": 0, "columnIndex": 0}, "end": {"lineIndex": 0, "columnIndex": 2}}})
    );
    let error = running.host.invoke(invocation("review.hover", "hover", json!({
        "languageId": "rust", "version": 7, "text": "😀", "position": {"lineIndex": 0, "columnIndex": 3}
    }))).unwrap_err();
    assert!(matches!(
        error,
        ExtensionHostError::HostRejected {
            code: HostErrorCode::InvalidRequest,
            ..
        }
    ));
}

#[test]
fn a_waiting_callback_does_not_block_other_commands_or_cancellation() {
    let running = start();
    let pending = running
        .host
        .begin_invoke(invocation(
            "review.wait",
            "execute",
            json!({"arguments": []}),
        ))
        .unwrap();
    wait_until_waiting(&running.host);
    assert_eq!(
        running
            .host
            .invoke(invocation(
                "review.echo",
                "execute",
                json!({"arguments": ["parallel"]})
            ))
            .unwrap()
            .payload,
        json!(["parallel"])
    );
    pending.cancel(CancelReason::Caller).unwrap();
    assert!(matches!(
        pending.wait(),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
    assert_eq!(running.host.snapshot().status, ExtensionHostStatus::Ready);
}

#[test]
fn the_host_deadline_reaches_a_waiting_callback_as_a_typed_error() {
    let running = start();
    let mut request = invocation("review.wait", "execute", json!({"arguments": []}));
    let deadline = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap()
        + Duration::from_millis(500))
    .as_millis() as u64;
    request.deadline_unix_millis = NonZeroU64::new(deadline).unwrap();
    assert!(matches!(
        running.host.invoke(request),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::DeadlineExceeded,
            ..
        })
    ));
}

#[test]
fn callback_failures_and_wrong_operations_do_not_crash_the_process() {
    let running = start();
    for (id, operation) in [("review.fail", "execute"), ("review.echo", "hover")] {
        let error = running
            .host
            .invoke(invocation(id, operation, json!({"arguments": []})))
            .unwrap_err();
        assert!(matches!(
            error,
            ExtensionHostError::HostRejected {
                code: HostErrorCode::OperationNotSupported,
                ..
            }
        ));
    }
    assert_eq!(
        running
            .host
            .invoke(invocation(
                "review.echo",
                "execute",
                json!({"arguments": []})
            ))
            .unwrap()
            .payload,
        json!([])
    );
}

#[test]
fn revoking_authority_prevents_further_sdk_callbacks() {
    let running = start();
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        running.host.invoke(invocation(
            "review.echo",
            "execute",
            json!({"arguments": []})
        )),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}
