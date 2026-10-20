use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_external_ext as host;
use serde_json::json;

struct Authority(AtomicBool);
struct Lease;
impl host::ActivationLease for Lease {}
impl host::ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn acquire(&self) -> Option<Box<dyn host::ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Lease) as Box<dyn host::ActivationLease>)
    }
}

fn invocation() -> host::ExtensionInvocation {
    host::ExtensionInvocation {
        registration_id: "remote:ssh".into(),
        operation: "resolveConnection".into(),
        payload: json!({"authority":"ssh+build"}),
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(5))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}

#[test]
fn rust_provider_uses_shared_registration_invocation_and_retirement_fences() {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-remote-ssh-extension"));
    let directory = tempfile::tempdir().unwrap();
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let supervisor = host::ExtensionHostSupervisor::new(
        Arc::new(host::ProductExecutableLauncher::new(executable.clone()).unwrap()),
        host::ExtensionLaunchCommand::new(
            executable,
            Vec::<String>::new(),
            directory.path(),
            BTreeMap::new(),
        )
        .unwrap(),
        host::ExtensionActivationSpec::new(
            host::ActivateParams {
                initialization: None,
                extension_id: "ash.remote-ssh".into(),
                package: host::PackageBinding {
                    package_id: "ash.remote-ssh@1.0.0".into(),
                    package_digest: format!("sha256:{}", "a".repeat(64)),
                    entrypoint: "ash-remote-ssh-extension".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["startup".into()],
                capabilities: vec![
                    host::ExtensionCapability::RemoteAuthorityResolver,
                    host::ExtensionCapability::ProductRemoteAuthorityResolver,
                ],
            },
            NonZeroU64::new(1).unwrap(),
            authority.clone(),
        ),
        host::ExtensionHostLimits {
            isolation: host::ProcessIsolationPolicy::AuthorizedProduct,
            ..host::ExtensionHostLimits::default()
        },
        host::RestartPolicy::default(),
    )
    .unwrap();
    let started = supervisor.start().unwrap();
    assert_eq!(started.registrations.len(), 1);
    assert_eq!(
        supervisor.invoke(invocation()).unwrap().payload,
        json!({"connectionName":"build"})
    );
    let mut invalid = invocation();
    invalid.payload = json!({"authority":"other+build"});
    assert!(supervisor.invoke(invalid).is_err());
    supervisor.shutdown().unwrap();
    assert!(supervisor.snapshot().registrations.is_empty());
    let restarted = supervisor.start().unwrap();
    assert!(restarted.incarnation > started.incarnation);
    assert!(matches!(
        supervisor.begin_fenced_invoke(
            host::ExtensionInvocationTarget {
                registration_generation: None,
                incarnation: NonZeroU64::new(started.incarnation).unwrap(),
                activation_generation: NonZeroU64::new(1).unwrap()
            },
            invocation()
        ),
        Err(host::ExtensionHostError::RegistrationNotFound)
    ));
    authority.0.store(false, Ordering::Release);
    assert!(matches!(
        supervisor.invoke(invocation()),
        Err(host::ExtensionHostError::AuthorityDenied)
    ));
    supervisor.shutdown().unwrap();
}
