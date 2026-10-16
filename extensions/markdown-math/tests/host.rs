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
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-markdown-math"));
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
            extension_id: "vscode.markdown-math".into(),
            package: PackageBinding {
                package_id: "vscode.markdown-math@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "ash-markdown-math".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onStartupFinished".into()],
            capabilities: vec![ExtensionCapability::DataChannel],
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

fn invocation(payload: Value) -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: "math.render.v1".into(),
        operation: "receiveData".into(),
        payload,
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(20))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}
fn formulas(values: &[&str]) -> Value {
    json!({"formulas":values.iter().map(|source| json!({"source":source,"display":"inline"})).collect::<Vec<_>>()})
}

#[test]
fn real_process_shares_document_macros_and_resets_them_between_requests() {
    let running = start();
    let result = running
        .host
        .invoke(invocation(json!({
            "macros":{"\\RR":"\\mathbb{R}"},
            "formulas":[
                {"source":"\\newcommand{\\ashfoo}{x^2}\\ashfoo","display":"inline"},
                {"source":"\\ashfoo+\\RR","display":"block"},
                {"source":"\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}","display":"block"}
            ]
        })))
        .unwrap()
        .payload;
    let html = result["html"].as_array().unwrap();
    assert_eq!(html.len(), 3);
    assert!(html[0].as_str().unwrap().contains("<math"));
    assert!(html[1].as_str().unwrap().contains("katex-display"));
    assert!(
        !html
            .iter()
            .any(|html| html.as_str().unwrap().contains("katex-error"))
    );
    for _ in 0..2 {
        let isolated = running
            .host
            .invoke(invocation(formulas(&[r"\ashfoo", r"\RR"])))
            .unwrap()
            .payload;
        assert!(
            isolated["html"]
                .as_array()
                .unwrap()
                .iter()
                .all(|html| html.as_str().unwrap().contains("#cc0000"))
        );
    }
}

#[test]
fn invalid_untrusted_and_expanding_input_stays_inert_and_leaves_process_usable() {
    let running = start();
    let output = running
        .host
        .invoke(invocation(formulas(&[
            r"\href{javascript:alert(1)}{x}",
            r"\includegraphics{https://example.invalid/pixel}",
            r"\text{<script>alert(1)</script>}",
            r"\frac{1}{",
            r"\def\loop{\loop}\loop",
        ])))
        .unwrap()
        .payload;
    let html = output["html"].as_array().unwrap();
    assert_eq!(html.len(), 5);
    for rendered in html {
        let text = rendered.as_str().unwrap();
        assert!(!text.contains("<script"));
        assert!(!text.contains("<img"));
        assert!(!text.contains("<a "));
    }
    assert!(html[3].as_str().unwrap().contains("katex-error"));
    assert!(html[4].as_str().unwrap().contains("katex-error"));
    let malformed = json!({"formulas":[],"trust":true});
    assert!(matches!(
        running.host.invoke(invocation(malformed)),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::InvalidRequest,
            ..
        })
    ));
    let oversized = formulas(&[&"x".repeat(256 * 1024 + 1)]);
    assert!(matches!(
        running.host.invoke(invocation(oversized)),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::QuotaExceeded,
            ..
        })
    ));
    assert!(
        running
            .host
            .invoke(invocation(formulas(&["E=mc^2"])))
            .unwrap()
            .payload["html"][0]
            .as_str()
            .unwrap()
            .contains("<math")
    );
}

#[test]
fn process_cancellation_crash_recovery_and_revocation_preserve_authority() {
    let running = start();
    let pending = running
        .host
        .begin_invoke(invocation(formulas(&vec![r"\frac{x+1}{y+2}"; 4096])))
        .unwrap();
    pending.cancel(CancelReason::Caller).unwrap();
    assert!(matches!(
        pending.wait(),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
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
    let recovered = running.host.reconcile().unwrap();
    assert_eq!(recovered.status, ExtensionHostStatus::Ready);
    assert_ne!(previous, recovered.incarnation);
    assert!(running.host.invoke(invocation(formulas(&["x+1"]))).is_ok());
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        running.host.invoke(invocation(formulas(&["x+1"]))),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}
