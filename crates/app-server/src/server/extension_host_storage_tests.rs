use super::*;
use ash_async_utils::CancellationSource;
use ash_external_ext::ActivationAuthority;
use ash_external_ext::ActivationLease;
use ash_external_ext::HostEventContext;
use external_ext_protocol::services::CoreServiceRequest;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[path = "extension_host_secrets_tests.rs"]
mod secrets_tests;

struct Source {
    enabled: AtomicBool,
    checks: AtomicUsize,
}
impl ActivationAuthority for Source {
    fn authorizes(&self) -> bool {
        self.checks.fetch_add(1, Ordering::SeqCst);
        self.enabled.load(Ordering::SeqCst)
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Lease) as Box<dyn ActivationLease>)
    }
}
struct Lease;
impl ActivationLease for Lease {}

#[test]
fn ordinary_state_is_shared_by_real_hosts_recovers_and_rejects_retired_instances() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, mut deployment) = install_node_fixture(directory.path());
    std::fs::write(
        directory.path().join("extension/extension.cjs"),
        r#"
const ash = require('@ash/sdk');
exports.activate = async context => {
 const restored = await context.storage.get('first');
 context.subscriptions.push(ash.commands.register('test.node', async action => {
  if (action === 'first') await context.storage.update('first', '你好');
  if (action === 'second') await context.storage.update('second', null);
  if (action === 'activated') return restored;
  return { first:await context.storage.get('first'), second:await context.storage.get('second') };
 }));
};
"#,
    )
    .unwrap();
    let source = Arc::new(Source {
        enabled: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    });
    deployment.authority = source.clone();
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite3");
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _first = EditorPeer::start(client.clone(), 11, "first");
    let _second = EditorPeer::start(client.clone(), 22, "second");
    let open = |launcher| {
        let runtime = runtime_with_recipe(launcher, deployment.clone(), &grant, client.clone());
        runtime.bind_storage(Arc::new(
            ash_state::SqliteExtensionStateStore::open(&database).unwrap(),
        ));
        runtime
    };
    let activate = |runtime: &ExtensionHostRuntime, owner| {
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
    let invoke = |runtime: &ExtensionHostRuntime, owner, action: &str| {
        invoke_registration(
            runtime,
            owner,
            "test.node",
            "execute",
            json!({"arguments":[action]}),
        )
    };
    let runtime = open(launcher);
    activate(&runtime, 11);
    activate(&runtime, 22);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| invoke(&runtime, 11, "first"));
        let second = scope.spawn(|| invoke(&runtime, 22, "second"));
        first.join().unwrap();
        second.join().unwrap();
    });
    let saved = json!({"first":"你好","second":null});
    assert_eq!(invoke(&runtime, 11, "read"), saved);
    assert_eq!(invoke(&runtime, 22, "read"), saved);
    let active = runtime.snapshot_for(11).extensions[0].clone();
    let context = HostEventContext::new(active.incarnation.unwrap(), active.activation_generation);
    let binding = super::super::super::EditorClientBinding {
        runtime: Arc::downgrade(&runtime.inner),
        activation: Arc::downgrade(
            &runtime
                .inner
                .state
                .lock()
                .unwrap()
                .entry(11, "test.node")
                .unwrap()
                .activation_gate,
        ),
        backend_channels: BTreeMap::new(),
        credential_providers: Vec::new(),
        credential_services: runtime.inner.credential_services.clone(),
        client_host: client.clone(),
        owner: 11,
        extension_id: "test.node".into(),
        workspace_read: WorkspaceReadAccess::Denied,
        files: Err(test_files_unavailable()),
    };
    let cancellation = CancellationSource::new();
    assert_eq!(
        binding
            .storage(
                context,
                &CoreServiceRequest::StorageSet {
                    key: "expired".into(),
                    value: json!(true)
                },
                &cancellation.token(),
                Duration::ZERO
            )
            .unwrap_err()
            .code,
        ash_external_ext::HostErrorCode::DeadlineExceeded
    );
    source.enabled.store(false, Ordering::SeqCst);
    for request in [
        CoreServiceRequest::StorageGet {
            key: "first".into(),
        },
        CoreServiceRequest::StorageSet {
            key: "first".into(),
            value: json!("lost"),
        },
        CoreServiceRequest::StorageDelete {
            key: "first".into(),
        },
    ] {
        assert_eq!(
            binding
                .storage(
                    context,
                    &request,
                    &cancellation.token(),
                    Duration::from_secs(1)
                )
                .unwrap_err()
                .code,
            ash_external_ext::HostErrorCode::PermissionDenied
        );
    }
    runtime.close_owner(11);
    runtime.close_owner(22);
    source.enabled.store(true, Ordering::SeqCst);
    activate(&runtime, 11);
    assert_eq!(invoke(&runtime, 11, "read"), saved);
    assert_eq!(
        binding
            .storage(
                context,
                &CoreServiceRequest::StorageSet {
                    key: "first".into(),
                    value: json!("lost")
                },
                &cancellation.token(),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .code,
        ash_external_ext::HostErrorCode::PermissionDenied
    );
    runtime.close_owner(11);
    drop(runtime);
    let replacement = tempfile::tempdir().unwrap();
    let (launcher, _) = install_node_fixture(replacement.path());
    let recovered = open(launcher);
    activate(&recovered, 22);
    assert_eq!(invoke(&recovered, 22, "activated"), json!("你好"));
    assert_eq!(invoke(&recovered, 22, "read"), saved);
    assert!(
        binding
            .storage(
                context,
                &CoreServiceRequest::StorageGet {
                    key: "first".into()
                },
                &cancellation.token(),
                Duration::from_secs(1)
            )
            .is_err()
    );
    recovered.close_owner(22);
}
