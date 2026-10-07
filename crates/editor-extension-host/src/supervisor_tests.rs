use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde_json::json;

use super::ExtensionHostStatus;
use super::ExtensionHostSupervisor;
use super::ExtensionInvocation;
use super::ExtensionInvocationTarget;
use crate::ActivateParams;
use crate::ActivateResult;
use crate::ActivationAuthority;
use crate::ActivationLease;
use crate::CancelReason;
use crate::ExtensionActivationSpec;
use crate::ExtensionCapability;
use crate::ExtensionHostError;
use crate::ExtensionHostLauncher;
use crate::ExtensionHostLimits;
use crate::ExtensionHostOutputEvent;
use crate::ExtensionHostProcess;
use crate::ExtensionHostRequest;
use crate::ExtensionHostResponse;
use crate::ExtensionLaunchCommand;
use crate::HostEventContext;
use crate::HostOutputOperation;
use crate::HostOutputSeverity;
use crate::HostRequestKind;
use crate::HostResponseKind;
use crate::HostSuccess;
use crate::InitializeResult;
use crate::InvokeResult;
use crate::PROTOCOL_VERSION;
use crate::PackageBinding;
use crate::PendingHostRequest;
use crate::ProcessIsolationPolicy;
use crate::RegistrationDescriptor;
use crate::RegistrationKind;
use crate::RestartPolicy;

#[derive(Default)]
struct TestAuthority {
    authorized: AtomicBool,
    active_leases: Arc<AtomicUsize>,
}

impl TestAuthority {
    fn authorized() -> Self {
        Self {
            authorized: AtomicBool::new(true),
            active_leases: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl ActivationAuthority for TestAuthority {
    fn authorizes(&self) -> bool {
        self.authorized.load(Ordering::Acquire)
    }

    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes().then(|| {
            self.active_leases.fetch_add(1, Ordering::AcqRel);
            Box::new(TestLease(Arc::clone(&self.active_leases))) as Box<dyn ActivationLease>
        })
    }
}

struct TestLease(Arc<AtomicUsize>);

impl ActivationLease for TestLease {}

impl Drop for TestLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
struct TestLauncher {
    spawns: AtomicUsize,
    processes: Mutex<Vec<Arc<TestProcess>>>,
}

impl ExtensionHostLauncher for TestLauncher {
    fn spawn(
        &self,
        _command: &ExtensionLaunchCommand,
        _limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        self.spawns.fetch_add(1, Ordering::AcqRel);
        let process = Arc::new(TestProcess::default());
        self.processes.lock().unwrap().push(Arc::clone(&process));
        Ok(process)
    }
}

#[derive(Default)]
struct TestProcess {
    exited: AtomicBool,
    hang_invocations: AtomicBool,
    cancels: AtomicUsize,
    output_events: Mutex<Vec<ExtensionHostOutputEvent>>,
}

impl ExtensionHostProcess for TestProcess {
    fn respond_client(
        &self,
        _: extension_protocol::ExtensionClientResponse,
    ) -> Result<(), ExtensionHostError> {
        panic!("fixture does not issue client calls")
    }
    fn dispatch(
        &self,
        request: ExtensionHostRequest,
    ) -> Result<PendingHostRequest, ExtensionHostError> {
        if self.exited.load(Ordering::Acquire) {
            return Err(ExtensionHostError::HostExited);
        }
        let (pending, sender) = PendingHostRequest::channel(request.context.request_id);
        let response = match &request.request {
            HostRequestKind::Initialize(params) => {
                Some(HostSuccess::Initialized(InitializeResult {
                    protocol_version: PROTOCOL_VERSION,
                    runtime_api_version: params.runtime_api_version,
                }))
            }
            HostRequestKind::Activate(_) => Some(HostSuccess::Activated(ActivateResult {
                registrations: vec![RegistrationDescriptor {
                    registration_id: "review.command".into(),
                    kind: RegistrationKind::Command {
                        command: "acme.review".into(),
                        title: "Review".into(),
                    },
                }],
            })),
            HostRequestKind::Invoke(_) if self.hang_invocations.load(Ordering::Acquire) => None,
            HostRequestKind::Invoke(_) => Some(HostSuccess::Invoked(InvokeResult {
                payload: json!({"ok": true}),
            })),
            HostRequestKind::Cancel(_) => {
                self.cancels.fetch_add(1, Ordering::AcqRel);
                Some(HostSuccess::Cancelled)
            }
            HostRequestKind::Deactivate => Some(HostSuccess::Deactivated),
            HostRequestKind::Ping => Some(HostSuccess::Pong),
            HostRequestKind::Shutdown => Some(HostSuccess::Shutdown),
        };
        if let Some(response) = response {
            sender
                .send(Ok(crate::process::PendingMessage::Response(
                    ExtensionHostResponse {
                        context: request.context,
                        response: HostResponseKind::Success(response),
                    },
                )))
                .unwrap();
        } else {
            std::mem::forget(sender);
        }
        Ok(pending)
    }

    fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn terminate(&self) -> Result<(), ExtensionHostError> {
        self.exited.store(true, Ordering::Release);
        Ok(())
    }

    fn stderr(&self) -> String {
        String::new()
    }

    fn drain_output_events(&self) -> Vec<ExtensionHostOutputEvent> {
        self.output_events
            .lock()
            .map(|mut events| std::mem::take(&mut *events))
            .unwrap_or_default()
    }
}

fn supervisor(
    launcher: Arc<TestLauncher>,
    authority: Arc<TestAuthority>,
) -> ExtensionHostSupervisor {
    let params = ActivateParams {
        extension_id: "acme.review".into(),
        package: PackageBinding {
            package_id: "acme/review@1.0.0".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "bin/review-host".into(),
        },
        runtime_api_version: 1,
        activation_events: vec!["onCommand:acme.review".into()],
        capabilities: vec![ExtensionCapability::Command],
    };
    let activation = ExtensionActivationSpec::new(params, NonZeroU64::new(9).unwrap(), authority);
    let limits = ExtensionHostLimits {
        isolation: ProcessIsolationPolicy::TrustedDevelopment,
        request_timeout: Duration::from_millis(30),
        cancellation_grace: Duration::from_millis(10),
        ..ExtensionHostLimits::default()
    };
    let restart = RestartPolicy {
        maximum_restarts: 3,
        window: Duration::from_secs(10),
        initial_delay: Duration::from_millis(1),
        maximum_delay: Duration::from_millis(2),
    };
    ExtensionHostSupervisor::new(
        launcher,
        ExtensionLaunchCommand::new(
            std::env::temp_dir().join("immutable/review-host"),
            Vec::<String>::new(),
            std::env::temp_dir().join("immutable"),
            BTreeMap::new(),
        )
        .unwrap(),
        activation,
        limits,
        restart,
    )
    .unwrap()
}

fn invocation() -> ExtensionInvocation {
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 5_000;
    ExtensionInvocation {
        registration_id: "review.command".into(),
        operation: "execute".into(),
        payload: json!({}),
        deadline_unix_millis: NonZeroU64::new(deadline).unwrap(),
    }
}

#[test]
fn handshake_activation_and_invoke_hold_exact_authority_leases() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), Arc::clone(&authority));
    let snapshot = supervisor.start().unwrap();
    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_eq!(snapshot.extension_id, "acme.review");
    assert_eq!(snapshot.runtime_api_version, 1);
    assert!(snapshot.package.package_digest.starts_with("sha256:"));
    assert_eq!(snapshot.incarnation, 1);
    assert_eq!(snapshot.activation_generation, 9);
    assert_eq!(authority.active_leases.load(Ordering::Acquire), 1);

    let handle = Arc::new(supervisor.begin_invoke(invocation()).unwrap());
    assert_eq!(authority.active_leases.load(Ordering::Acquire), 2);
    assert_eq!(handle.wait().unwrap().payload, json!({"ok": true}));
    assert_eq!(authority.active_leases.load(Ordering::Acquire), 1);
}

#[test]
fn snapshot_retains_ordered_process_fenced_output_events() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), authority);
    supervisor.start().unwrap();
    let process = launcher.processes.lock().unwrap()[0].clone();
    process
        .output_events
        .lock()
        .unwrap()
        .push(ExtensionHostOutputEvent {
            context: HostEventContext::new(1, 9),
            operation: HostOutputOperation::Append {
                channel_id: "review".into(),
                text: "ready\n".into(),
                severity: HostOutputSeverity::Information,
                category: None,
            },
        });

    let first = supervisor.snapshot();
    let second = supervisor.snapshot();

    assert_eq!(first.output_events.len(), 1);
    assert_eq!(first.output_events[0].sequence, 1);
    assert_eq!(second.output_events, first.output_events);
}

#[test]
fn timeout_dispatches_cancel_then_restarts_and_replays_activation() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), Arc::clone(&authority));
    supervisor.start().unwrap();
    let first = Arc::clone(&launcher.processes.lock().unwrap()[0]);
    first.hang_invocations.store(true, Ordering::Release);

    let error = supervisor.invoke(invocation()).unwrap_err();

    assert!(matches!(error, ExtensionHostError::OutcomeIndeterminate));
    assert_eq!(first.cancels.load(Ordering::Acquire), 1);
    assert!(first.has_exited());
    assert_eq!(launcher.spawns.load(Ordering::Acquire), 2);
    assert_eq!(supervisor.snapshot().incarnation, 2);
    assert_eq!(supervisor.snapshot().status, ExtensionHostStatus::Ready);
    assert_eq!(authority.active_leases.load(Ordering::Acquire), 1);
}

#[test]
fn caller_cancel_is_dispatched_while_invoke_is_pending() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), authority);
    supervisor.start().unwrap();
    let process = Arc::clone(&launcher.processes.lock().unwrap()[0]);
    process.hang_invocations.store(true, Ordering::Release);
    let handle = Arc::new(supervisor.begin_invoke(invocation()).unwrap());
    let waiting = Arc::clone(&handle);
    let waiter = thread::spawn(move || waiting.wait());
    thread::sleep(Duration::from_millis(2));

    handle.cancel(CancelReason::Caller).unwrap();

    assert!(waiter.join().unwrap().is_err());
    assert!(process.cancels.load(Ordering::Acquire) >= 1);
}

#[test]
fn revoked_authority_blocks_new_invocations() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(launcher, Arc::clone(&authority));
    supervisor.start().unwrap();
    authority.authorized.store(false, Ordering::Release);
    assert!(matches!(
        supervisor.begin_invoke(invocation()),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}

#[test]
fn shutdown_releases_in_flight_authority_leases_even_if_handle_is_retained() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), Arc::clone(&authority));
    supervisor.start().unwrap();
    launcher.processes.lock().unwrap()[0]
        .hang_invocations
        .store(true, Ordering::Release);
    let handle = supervisor.begin_invoke(invocation()).unwrap();
    assert_eq!(authority.active_leases.load(Ordering::Acquire), 2);

    supervisor.shutdown().unwrap();

    assert_eq!(authority.active_leases.load(Ordering::Acquire), 0);
    drop(handle);
}

#[test]
fn process_authority_drain_waits_until_the_child_is_confirmed_terminated() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), Arc::clone(&authority));
    supervisor.start().unwrap();
    let process = Arc::clone(&launcher.processes.lock().unwrap()[0]);
    authority.authorized.store(false, Ordering::Release);
    let leases = Arc::clone(&authority.active_leases);
    let (drained, receiver) = std::sync::mpsc::channel();
    let waiter = thread::spawn(move || {
        while leases.load(Ordering::Acquire) != 0 {
            thread::yield_now();
        }
        drained.send(()).unwrap();
    });

    assert!(receiver.recv_timeout(Duration::from_millis(10)).is_err());
    assert!(!process.has_exited());

    supervisor.shutdown().unwrap();

    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(process.has_exited());
    waiter.join().unwrap();
}

#[test]
fn request_identity_exhaustion_fails_closed_without_reuse() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(launcher, authority);
    supervisor
        .inner
        .next_request_id
        .store(u64::MAX, Ordering::Release);

    assert!(matches!(
        supervisor.start(),
        Err(ExtensionHostError::RequestIdentityExhausted)
    ));
}

#[test]
fn reconcile_recovers_an_idle_crash_and_replays_activation() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), authority);
    supervisor.start().unwrap();
    launcher.processes.lock().unwrap()[0]
        .exited
        .store(true, Ordering::Release);

    let snapshot = supervisor.reconcile().unwrap();

    assert_eq!(snapshot.status, ExtensionHostStatus::Ready);
    assert_eq!(snapshot.incarnation, 2);
    assert_eq!(launcher.spawns.load(Ordering::Acquire), 2);
    assert_eq!(snapshot.registrations.len(), 1);
}

#[test]
fn fenced_invoke_never_replays_on_a_new_incarnation() {
    let launcher = Arc::new(TestLauncher::default());
    let authority = Arc::new(TestAuthority::authorized());
    let supervisor = supervisor(Arc::clone(&launcher), authority);
    let advertised = supervisor.start().unwrap();
    launcher.processes.lock().unwrap()[0]
        .exited
        .store(true, Ordering::Release);

    let error = match supervisor.begin_fenced_invoke(
        ExtensionInvocationTarget {
            incarnation: NonZeroU64::new(advertised.incarnation).unwrap(),
            activation_generation: NonZeroU64::new(advertised.activation_generation).unwrap(),
        },
        invocation(),
    ) {
        Ok(_) => panic!("stale incarnation was accepted"),
        Err(error) => error,
    };

    assert!(matches!(error, ExtensionHostError::RegistrationNotFound));
    assert_eq!(
        supervisor.snapshot().incarnation,
        advertised.incarnation + 1
    );
}
