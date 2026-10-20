use super::*;
use crate::server::extension_host_runtime::EditorClientBinding;
use ash_secrets::SecretStore;
use external_ext_protocol::services::CoreServiceResponse;
use std::sync::Mutex;

struct GateStore {
    store: Arc<dyn SecretStore>,
    block: AtomicBool,
    fail: AtomicBool,
    entered: std::sync::mpsc::Sender<()>,
    resume: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl SecretStore for GateStore {
    fn load(
        &self,
        key: &ash_secrets::SecretKey,
    ) -> Result<Option<ash_secrets::SecretValue>, ash_secrets::SecretStoreError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(ash_secrets::SecretStoreError::new(
                ash_secrets::SecretStoreErrorKind::BackendFailure,
                "synthetic-secret",
            ));
        }
        let value = self.store.load(key)?;
        if self.block.load(Ordering::SeqCst) {
            self.entered.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
        }
        Ok(value)
    }
    fn store(
        &self,
        key: &ash_secrets::SecretKey,
        value: &ash_secrets::SecretValue,
    ) -> Result<(), ash_secrets::SecretStoreError> {
        self.store.store(key, value)
    }
    fn delete(
        &self,
        key: &ash_secrets::SecretKey,
    ) -> Result<ash_secrets::DeleteSecretOutcome, ash_secrets::SecretStoreError> {
        self.store.delete(key)
    }
}

fn binding(runtime: &ExtensionHostRuntime, owner: u64) -> (EditorClientBinding, HostEventContext) {
    let fleet = runtime.inner.state.lock().unwrap();
    let entry = fleet.entry(owner, "test.node").unwrap();
    let snapshot = entry.supervisor.as_ref().unwrap().snapshot();
    (
        EditorClientBinding {
            runtime: Arc::downgrade(&runtime.inner),
            activation: Arc::downgrade(&entry.activation_gate),
            backend_channels: BTreeMap::new(),
            credential_providers: Vec::new(),
            credential_services: runtime.inner.credential_services.clone(),
            client_host: runtime.inner.client_host.clone(),
            owner,
            extension_id: "test.node".into(),
            workspace_read: WorkspaceReadAccess::Denied,
            files: Err(test_files_unavailable()),
        },
        HostEventContext::new(snapshot.incarnation, snapshot.activation_generation),
    )
}

#[test]
fn private_secrets_share_real_hosts_restore_encrypted_data_and_fence_old_bindings() {
    let directory = tempfile::tempdir().unwrap();
    let (launcher, mut deployment) = install_node_fixture(directory.path());
    std::fs::write(
        directory.path().join("extension/extension.cjs"),
        r#"
const ash = require('@ash/sdk');
exports.activate = async context => {
 const restored = (await context.secrets.get('token')) === 'synthetic-secret';
 context.subscriptions.push(ash.commands.register('test.node', async action => {
  if (action === 'store') { await context.secrets.store('token', 'synthetic-secret'); return true; }
  if (action === 'delete') return context.secrets.delete('token');
  if (action === 'activated') return restored;
  return (await context.secrets.get('token')) === 'synthetic-secret';
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
    let keyring = Arc::new(ash_secrets::MemorySecretStore::default());
    let open_store = || {
        Arc::new(
            ash_secrets::ProfileSecretStore::open(profile.path().join("secrets"), keyring.clone())
                .unwrap(),
        ) as Arc<dyn SecretStore>
    };
    let store = open_store();
    // Product keys and other extensions cannot be selected through the author key.
    store
        .store(
            &ash_secrets::SecretKey::new("product-token").unwrap(),
            &ash_secrets::SecretValue::new(b"synthetic-secret".to_vec()),
        )
        .unwrap();
    let (entered, waiting) = std::sync::mpsc::channel();
    let (resume, resumed) = std::sync::mpsc::channel();
    let gate = Arc::new(GateStore {
        store,
        block: AtomicBool::new(false),
        fail: AtomicBool::new(false),
        entered,
        resume: Mutex::new(resumed),
    });
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let client = Arc::new(crate::client_host::ClientHost::default());
    let _first = EditorPeer::start(client.clone(), 11, "first");
    let _second = EditorPeer::start(client.clone(), 22, "second");
    let runtime = runtime_with_recipe(launcher, deployment.clone(), &grant, client.clone());
    runtime.bind_secrets(gate.clone());
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
    activate(&runtime, 11);
    activate(&runtime, 22);
    assert_eq!(invoke(&runtime, 11, "activated"), false);
    let (old, context) = binding(&runtime, 11);
    let cancel = CancellationSource::new();
    let call = |request: &CoreServiceRequest| {
        old.secrets(context, request, &cancel.token(), Duration::from_secs(3))
    };
    assert!(matches!(
        call(&CoreServiceRequest::SecretLoad {
            key: "product-token".into()
        })
        .unwrap(),
        ExtensionClientResult::CoreService {
            response: CoreServiceResponse::SecretLoaded { value: None }
        }
    ));
    assert_eq!(invoke(&runtime, 11, "store"), true);
    assert_eq!(invoke(&runtime, 22, "get"), true);
    {
        let other_root = tempfile::tempdir().unwrap();
        let (launcher, other_fixture) = install_node_fixture(other_root.path());
        std::fs::copy(
            directory.path().join("extension/extension.cjs"),
            other_root.path().join("extension/extension.cjs"),
        )
        .unwrap();
        std::fs::write(other_root.path().join("extension/package.json"), json!({"publisher":"test","name":"other","contributes":{"commands":[{"command":"test.node","title":"Node"}]}}).to_string()).unwrap();
        let mut other = deployment.clone();
        other.id = "test.other".into();
        other.params.extension_id = other.id.clone();
        other.params.package.package_id = "test/other".into();
        let args: Vec<String> = other_fixture
            .command
            .arguments()
            .iter()
            .map(|arg| {
                if arg == "test.node" {
                    "test.other".into()
                } else {
                    arg.to_string_lossy().into_owned()
                }
            })
            .collect();
        other.command =
            ExtensionLaunchCommand::ash(args, &other_root.path().join("extension")).unwrap();
        let isolated = runtime_with_recipe(launcher, other, &grant, client.clone());
        isolated.bind_secrets(gate.clone());
        isolated
            .activate_by_event(
                22,
                "test.other",
                7,
                ActivationEvent::Command("test.node".into()),
                None,
                Err(test_files_unavailable()),
            )
            .unwrap();
        assert_eq!(
            invoke_registration(
                &isolated,
                22,
                "test.node",
                "execute",
                json!({"arguments":["get"]})
            ),
            false,
            "another package cannot read the first package's key"
        );
        isolated.close_owner(22);
    }
    assert_eq!(invoke(&runtime, 22, "delete"), true);
    assert_eq!(invoke(&runtime, 22, "delete"), false);
    assert_eq!(invoke(&runtime, 11, "get"), false);
    assert_eq!(invoke(&runtime, 11, "store"), true);
    runtime.bind_secrets(Arc::new(ash_secrets::UnavailableSecretStore));
    assert!(
        call(&CoreServiceRequest::SecretLoad {
            key: "token".into()
        })
        .is_err()
    );
    runtime.bind_secrets(gate.clone());
    for request in [
        CoreServiceRequest::SecretLoad { key: "".into() },
        CoreServiceRequest::SecretStore {
            key: "token".into(),
            value: vec![0; 65537],
        },
    ] {
        assert!(call(&request).is_err());
    }
    gate.fail.store(true, Ordering::SeqCst);
    let error = call(&CoreServiceRequest::SecretLoad {
        key: "token".into(),
    })
    .unwrap_err();
    assert!(!format!("{error:?}").contains("synthetic-secret"));
    gate.fail.store(false, Ordering::SeqCst);
    // A value already read by the backing facility cannot be delivered after revocation.
    source.enabled.store(true, Ordering::SeqCst);
    gate.block.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
        let reading = scope.spawn(|| {
            call(&CoreServiceRequest::SecretLoad {
                key: "token".into(),
            })
        });
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        source.enabled.store(false, Ordering::SeqCst);
        gate.block.store(false, Ordering::SeqCst);
        resume.send(()).unwrap();
        assert_eq!(
            reading.join().unwrap().unwrap_err().code,
            ash_external_ext::HostErrorCode::PermissionDenied
        );
    });
    for request in [
        CoreServiceRequest::SecretLoad {
            key: "token".into(),
        },
        CoreServiceRequest::SecretStore {
            key: "token".into(),
            value: b"lost".to_vec(),
        },
        CoreServiceRequest::SecretDelete {
            key: "token".into(),
        },
    ] {
        assert_eq!(
            call(&request).unwrap_err().code,
            ash_external_ext::HostErrorCode::PermissionDenied
        );
    }
    runtime.close_owner(11);
    runtime.close_owner(22);
    source.enabled.store(true, Ordering::SeqCst);
    activate(&runtime, 11);
    assert_eq!(invoke(&runtime, 11, "activated"), true);
    assert_eq!(
        call(&CoreServiceRequest::SecretLoad {
            key: "token".into()
        })
        .unwrap_err()
        .code,
        ash_external_ext::HostErrorCode::PermissionDenied
    );
    runtime.close_owner(11);
    drop(runtime);
    drop(gate);
    // Reopen the encrypted owner and start a new actual child process.
    let replacement = tempfile::tempdir().unwrap();
    let (launcher, _) = install_node_fixture(replacement.path());
    let restored = runtime_with_recipe(launcher, deployment, &grant, client);
    restored.bind_secrets(open_store());
    activate(&restored, 22);
    assert_eq!(invoke(&restored, 22, "activated"), true);
    assert!(
        call(&CoreServiceRequest::SecretLoad {
            key: "token".into()
        })
        .is_err()
    );
    restored.close_owner(22);
    let other_profile = tempfile::tempdir().unwrap();
    let other = ash_secrets::ProfileSecretStore::open(other_profile.path(), keyring).unwrap();
    assert!(
        other
            .load(&ash_secrets::SecretKey::new("product-token").unwrap())
            .unwrap()
            .is_none()
    );
    // Encrypted files contain no plaintext synthetic secret, even after reopening.
    for entry in std::fs::read_dir(profile.path().join("secrets/encrypted/values")).unwrap() {
        assert!(
            !std::fs::read(entry.unwrap().path())
                .unwrap()
                .windows(b"synthetic-secret".len())
                .any(|bytes| bytes == b"synthetic-secret")
        );
    }
}
