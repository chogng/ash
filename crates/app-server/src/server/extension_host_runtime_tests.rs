use super::ExtensionHostInvocationRead;
use super::ExtensionHostRuntimeError;
use super::projection::ExtensionHostFailureKind;
use super::projection::runtime_failure;
use super::registration_allows_operation;
use super::sessions::InvocationSessionStore;
use super::source::stable_extension_id;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::InvokeResult;
use ash_editor_extension_host::LanguageProviderOperation;
use ash_editor_extension_host::RegistrationKind;
use serde_json::json;
use std::time::Duration;
use std::time::Instant;

#[path = "extension_host_window_tests.rs"]
mod windows;

#[test]
fn stable_id_combines_plugin_and_manifest_local_identity() {
    assert_eq!(
        stable_extension_id("acme/review", "editor-runtime"),
        "acme/review:editor-runtime"
    );
}

#[test]
fn normalized_extension_source_does_not_require_legacy_plugin_authority() {
    let snapshot = super::source::combined_deployments(None, None, None).unwrap();

    assert_eq!(snapshot.revision, Default::default());
    assert!(snapshot.deployments.is_empty());
}

#[test]
fn session_reservations_enforce_global_and_connection_quotas() {
    let mut sessions = InvocationSessionStore::new(2, 1);

    sessions.reserve("one".into(), 7, 1).unwrap();
    assert!(matches!(
        sessions.reserve("same-owner".into(), 7, 1),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
    sessions.reserve("two".into(), 8, 1).unwrap();
    assert!(matches!(
        sessions.reserve("global".into(), 9, 1),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
}

#[test]
fn pending_invocation_identity_is_connection_owned() {
    let mut sessions = InvocationSessionStore::new(2, 2);
    sessions.reserve("one".into(), 7, 1).unwrap();

    assert!(matches!(
        sessions.read(7, "one"),
        Ok(ExtensionHostInvocationRead::Pending)
    ));
    assert!(matches!(
        sessions.read(8, "one"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
}

#[test]
fn detaching_an_owner_releases_terminal_sessions_immediately() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions.reserve("one".into(), 7, 1).unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!({ "ok": true }),
        }),
    );

    assert!(
        sessions
            .detach_owner(7, ash_editor_extension_host::CancelReason::Shutdown)
            .is_empty()
    );
    sessions.reserve("replacement".into(), 8, 1).unwrap();
}

#[test]
fn abandoned_terminal_sessions_are_reaped_before_reusing_quota() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions.reserve("one".into(), 7, 1).unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!(null),
        }),
    );
    sessions.sweep_expired(Instant::now() + Duration::from_secs(61));

    sessions.reserve("replacement".into(), 8, 1).unwrap();
}

#[test]
fn invocation_operations_are_brokered_by_registration_kind() {
    let remote = RegistrationKind::RemoteConnectionResolver {
        authority_prefix: "team".into(),
    };
    assert!(registration_allows_operation(&remote, "resolveConnection"));
    assert!(!registration_allows_operation(&remote, "execute"));
    let endpoint = RegistrationKind::RemoteAuthorityResolver {
        authority_prefix: "team".into(),
    };
    assert!(registration_allows_operation(&endpoint, "resolveAuthority"));
    assert!(registration_allows_operation(&endpoint, "getCanonicalURI"));
    assert!(!registration_allows_operation(&remote, "getCanonicalURI"));
    assert!(registration_allows_operation(&endpoint, "remoteConnect"));
    assert!(!registration_allows_operation(
        &endpoint,
        "resolveConnection"
    ));
    assert!(!registration_allows_operation(&remote, "remoteWrite"));
    let opener = RegistrationKind::ExternalUriOpener {
        schemes: vec![ash_editor_extension_host::ExternalUriScheme::Https],
        label: "Acme browser".into(),
    };
    assert!(registration_allows_operation(&opener, "canOpenExternalUri"));
    assert!(registration_allows_operation(&opener, "openExternalUri"));
    assert!(!registration_allows_operation(&opener, "execute"));
    let command = RegistrationKind::Command {
        command: "acme.run".into(),
        title: "Run".into(),
    };
    let language = RegistrationKind::LanguageProvider {
        completion_trigger_characters: Vec::new(),
        language_ids: vec!["rust".into()],
        operations: vec![LanguageProviderOperation::Hover],
    };
    let debug = RegistrationKind::DebugAdapter {
        debugger_type: "acme".into(),
    };

    assert!(registration_allows_operation(&command, "execute"));
    assert!(!registration_allows_operation(&command, "provideTasks"));
    assert!(registration_allows_operation(&language, "hover"));
    assert!(!registration_allows_operation(&language, "rename"));
    assert!(!registration_allows_operation(&debug, "execute"));
    assert!(registration_allows_operation(
        &debug,
        "createDebugAdapterDescriptor"
    ));
    for operation in [
        "sendInlineDebugAdapter",
        "readInlineDebugAdapter",
        "closeInlineDebugAdapter",
    ] {
        assert!(registration_allows_operation(&debug, operation));
        assert!(!registration_allows_operation(&command, operation));
        assert!(!registration_allows_operation(&language, operation));
    }
    let tracker = RegistrationKind::DebugAdapterTracker {
        debugger_type: "*".into(),
    };
    for operation in ["createDebugAdapterTracker", "debugAdapterTrackerEvent"] {
        assert!(registration_allows_operation(&tracker, operation));
    }
    for operation in ["createDebugAdapterDescriptor", "debugEvent", "execute"] {
        assert!(!registration_allows_operation(&tracker, operation));
    }
    let configurations = RegistrationKind::DebugConfigurationProvider {
        debugger_type: "acme".into(),
        trigger_kind: 1,
    };
    for operation in [
        "provideDebugConfigurations",
        "resolveDebugConfiguration",
        "resolveDebugConfigurationWithSubstitutedVariables",
    ] {
        assert!(registration_allows_operation(&configurations, operation));
    }
    assert!(!registration_allows_operation(
        &configurations,
        "createDebugAdapterDescriptor"
    ));
    assert!(!registration_allows_operation(&configurations, "execute"));
    let tasks = RegistrationKind::TaskProvider {
        task_type: "builder".into(),
    };
    assert!(registration_allows_operation(&tasks, "provideTasks"));
    assert!(registration_allows_operation(&tasks, "resolveTask"));
    assert!(!registration_allows_operation(&tasks, "execute"));
    let task_events = RegistrationKind::TaskEvents {};
    assert!(registration_allows_operation(&task_events, "taskEvent"));
    assert!(registration_allows_operation(
        &task_events,
        "createTaskTerminal"
    ));
    assert!(registration_allows_operation(
        &task_events,
        "closeTaskTerminal"
    ));
    assert!(!registration_allows_operation(&task_events, "provideTasks"));
    assert!(!registration_allows_operation(&task_events, "execute"));
    let debug_events = RegistrationKind::DebugEvents {};
    assert!(registration_allows_operation(&debug_events, "debugEvent"));
    assert!(!registration_allows_operation(
        &debug_events,
        "createDebugAdapterDescriptor"
    ));
    assert!(!registration_allows_operation(&debug_events, "execute"));
    let documents = RegistrationKind::TextDocumentEvents {};
    let window = RegistrationKind::WorkspaceEvents {};
    assert!(registration_allows_operation(&window, "workspaceEvent"));
    assert!(!registration_allows_operation(&window, "execute"));
    assert!(!registration_allows_operation(&window, "documentEvent"));
    assert!(registration_allows_operation(&documents, "documentEvent"));
    assert!(!registration_allows_operation(&documents, "execute"));
    let channel = RegistrationKind::DataChannel {
        channel_id: "editTelemetry".into(),
    };
    let link = RegistrationKind::LinkPresentationProvider {
        uri_pattern: "^https://example.com/issues/".into(),
        presentation_kind: "issue".into(),
    };
    assert!(registration_allows_operation(&channel, "receiveData"));
    assert!(!registration_allows_operation(
        &channel,
        "provideLinkPresentation"
    ));
    assert!(registration_allows_operation(
        &link,
        "provideLinkPresentation"
    ));
    assert!(!registration_allows_operation(&link, "receiveData"));
}

#[test]
fn host_failures_are_sanitized_before_projection() {
    let failure = runtime_failure(
        &ExtensionHostError::InvalidProtocol("host leaked /secret/path".into()),
        Some(3),
    );

    assert_eq!(failure.code, ExtensionHostFailureKind::InvalidProtocol);
    assert!(!failure.message.contains("/secret/path"));
    assert_eq!(failure.incarnation, Some(3));
}

struct CountingLauncher(std::sync::atomic::AtomicUsize);
impl ash_editor_extension_host::ExtensionHostLauncher for CountingLauncher {
    fn spawn(
        &self,
        _: &ash_editor_extension_host::ExtensionLaunchCommand,
        _: &ash_editor_extension_host::ExtensionHostLimits,
    ) -> Result<
        std::sync::Arc<dyn ash_editor_extension_host::ExtensionHostProcess>,
        ExtensionHostError,
    > {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(ExtensionHostError::SpawnFailed)
    }
}

#[test]
fn product_ssh_is_available_without_a_directory_and_is_rebound_after_unbind() {
    use ash_editor_extension_host::ExtensionHostLimits;
    use ash_editor_extension_host::RestartPolicy;
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    let launcher = Arc::new(CountingLauncher(std::sync::atomic::AtomicUsize::new(0)));
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Product,
        None,
        None,
        None,
        launcher.clone(),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        Default::default(),
    )
    .unwrap();
    let initial = runtime.inner.snapshot();
    assert_eq!(initial.extensions[0].id, "ash.remote-ssh");
    assert_eq!(
        initial.extensions[0].failure.as_ref().unwrap().code,
        ExtensionHostFailureKind::CrashLoop
    );
    let attempts = RestartPolicy::default().maximum_restarts + 1;
    assert_eq!(launcher.0.load(Ordering::SeqCst), attempts);
    let directory = tempfile::tempdir().unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    runtime
        .bind_dir(grant.authorize(Permission::DiscoverPlugins).unwrap())
        .unwrap();
    runtime.unbind_dir();
    let after = runtime.inner.snapshot();
    assert_eq!(after.extensions.len(), 1);
    assert_eq!(after.extensions[0].id, "ash.remote-ssh");
    assert!(
        after.extensions[0].activation_generation > initial.extensions[0].activation_generation
    );
    assert_eq!(launcher.0.load(Ordering::SeqCst), 3 * attempts);
}

#[test]
fn lazy_activation_checks_generation_and_event_and_health_never_launches_dormant_entries() {
    use super::source::ActivationEvent;
    use super::source::DebugActivationPhase;
    for event in [
        ActivationEvent::Command("lazy.run".into()),
        ActivationEvent::TaskType(Some("build".into())),
        ActivationEvent::Debug {
            phase: DebugActivationPhase::ResolveConfiguration,
            debug_type: Some("node".into()),
        },
        ActivationEvent::Debug {
            phase: DebugActivationPhase::InitialConfigurations,
            debug_type: None,
        },
        ActivationEvent::Debug {
            phase: DebugActivationPhase::DynamicConfigurations,
            debug_type: Some("node".into()),
        },
    ] {
        assert_lazy_activation_fence(event);
    }
}

fn assert_lazy_activation_fence(event: super::source::ActivationEvent) {
    use ash_editor_extension_host::{
        ExtensionHostLimits, ExtensionHostSupervisor, ExtensionLaunchCommand, RestartPolicy,
    };
    use ash_file_access::{Dir, Grant, GrantSource, Permission, Permissions};
    use std::sync::{Arc, atomic::Ordering};
    let directory = tempfile::tempdir().unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::DiscoverPlugins]),
    );
    let authorization = grant.authorize(Permission::DiscoverPlugins).unwrap();
    let launcher = Arc::new(CountingLauncher(std::sync::atomic::AtomicUsize::new(0)));
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Omitted,
        None,
        None,
        None,
        launcher.clone(),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        Default::default(),
    )
    .unwrap();
    runtime.bind_dir(authorization).unwrap();
    let command = ExtensionLaunchCommand::javascript(
        std::env::current_exe().unwrap(),
        Vec::<String>::new(),
        directory.path(),
    )
    .unwrap();
    let params = ash_editor_extension_host::ActivateParams {
        initialization: None,
        extension_id: "lazy".into(),
        package: ash_editor_extension_host::PackageBinding {
            package_id: "lazy@1".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "main.js".into(),
        },
        runtime_api_version: 1,
        activation_events: vec![
            "onCommand:lazy.run".into(),
            "onTaskType:build".into(),
            "onDebugResolve:node".into(),
            "onDebugInitialConfigurations".into(),
            "onDebugDynamicConfigurations:node".into(),
        ],
        capabilities: vec![ash_editor_extension_host::ExtensionCapability::Command],
    };
    let supervisor = ExtensionHostSupervisor::new(
        launcher.clone(),
        command,
        ash_editor_extension_host::ExtensionActivationSpec::new(
            params,
            std::num::NonZeroU64::new(7).unwrap(),
            Arc::new(AllowedActivation),
        ),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
    )
    .unwrap();
    {
        let mut state = runtime.inner.state.lock().unwrap();
        state.entries.insert(
            "lazy".into(),
            super::RuntimeEntry {
                activation_gate: Arc::new(std::sync::Mutex::new(())),
                node_client: super::NodeClientScope::Unsupported,
                node_deployment: None,
                version: "1".into(),
                workspace_read: super::source::WorkspaceReadAccess::Denied,
                supervisor: Some(supervisor),
                failure: None,
                pending_activation: Some(super::source::ActivationPlan {
                    events: vec![
                        "onCommand:lazy.run".into(),
                        "onTaskType:build".into(),
                        "onDebugResolve:node".into(),
                        "onDebugInitialConfigurations".into(),
                        "onDebugDynamicConfigurations:node".into(),
                    ],
                    commands: vec![("lazy.run".into(), "Run".into())],
                }),
                fallback: super::projection::ExtensionHostExtensionSnapshot {
                    id: "lazy".into(),
                    version: "1".into(),
                    package_digest: format!("sha256:{}", "a".repeat(64)),
                    runtime_api_version: 1,
                    activation_generation: 7,
                    incarnation: None,
                    lifecycle: super::projection::ExtensionHostLifecycle::Failed,
                    activation: None,
                    failure: None,
                    stderr: String::new(),
                    output_events: Vec::new(),
                    registrations: Vec::new(),
                },
            },
        );
    }
    for mode in [
        super::ExtensionHostReconcileMode::Refresh,
        super::ExtensionHostReconcileMode::RestartFailed,
    ] {
        let snapshot = runtime.reconcile(mode).unwrap();
        assert_eq!(
            snapshot.extensions[0].lifecycle,
            super::projection::ExtensionHostLifecycle::Dormant
        );
        assert_eq!(snapshot.extensions[0].incarnation, None);
        assert!(snapshot.extensions[0].registrations.is_empty());
    }
    assert_eq!(launcher.0.load(Ordering::SeqCst), 0);
    for (generation, event) in [
        (6, event.clone()),
        (7, super::source::ActivationEvent::Language("rust".into())),
    ] {
        assert!(matches!(
            runtime.activate_by_event(
                1,
                "lazy",
                generation,
                event,
                None,
                Err(test_files_unavailable())
            ),
            Err(ExtensionHostRuntimeError::Stale)
        ));
    }
    assert_eq!(launcher.0.load(Ordering::SeqCst), 0);
    let activated = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            runtime
                .activate_by_event(
                    1,
                    "lazy",
                    7,
                    event.clone(),
                    None,
                    Err(test_files_unavailable()),
                )
                .unwrap()
        });
        let second = runtime
            .activate_by_event(
                1,
                "lazy",
                7,
                event.clone(),
                None,
                Err(test_files_unavailable()),
            )
            .unwrap();
        assert_eq!(first.join().unwrap(), second);
        second
    });
    assert_eq!(
        launcher.0.load(Ordering::SeqCst),
        RestartPolicy::default().maximum_restarts + 1
    );
    assert_eq!(
        activated.extensions[0].failure.as_ref().unwrap().code,
        ExtensionHostFailureKind::CrashLoop
    );
    // A failed first attempt is observable; duplicate first-use requests do not replay startup.
    runtime
        .activate_by_event(
            1,
            "lazy",
            7,
            event.clone(),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    assert_eq!(
        launcher.0.load(Ordering::SeqCst),
        RestartPolicy::default().maximum_restarts + 1
    );
    grant.revoke();
    assert!(
        runtime
            .activate_by_event(
                1,
                "lazy",
                7,
                event.clone(),
                None,
                Err(test_files_unavailable())
            )
            .is_err()
    );
}

struct AllowedActivation;
struct AllowedLease;
impl ash_editor_extension_host::ActivationLease for AllowedLease {}
impl ash_editor_extension_host::ActivationAuthority for AllowedActivation {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ash_editor_extension_host::ActivationLease>> {
        Some(Box::new(AllowedLease))
    }
}

#[test]
fn directory_changes_do_not_reuse_extension_activation_generations() {
    use ash_editor_extension_host::{ExtensionHostLimits, RestartPolicy};
    use ash_file_access::{Dir, Grant, GrantSource, Permission, Permissions};
    use std::sync::Arc;
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Omitted,
        None,
        None,
        None,
        Arc::new(CountingLauncher(std::sync::atomic::AtomicUsize::new(0))),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        Default::default(),
    )
    .unwrap();
    let bind = |path| {
        let grant = Grant::for_environment(
            Dir::open_local(path).unwrap(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::DiscoverPlugins]),
        );
        runtime
            .bind_dir(grant.authorize(Permission::DiscoverPlugins).unwrap())
            .unwrap();
        grant
    };
    let first_grant = bind(first.path());
    let first_generation = runtime.inner.state.lock().unwrap().authority_generation;
    runtime.unbind_dir();
    let second_grant = bind(second.path());
    assert!(runtime.inner.state.lock().unwrap().authority_generation > first_generation);
    assert!(matches!(
        runtime.activate_by_event(
            1,
            "lazy",
            first_generation,
            super::source::ActivationEvent::Command("lazy.run".into()),
            None,
            Err(test_files_unavailable()),
        ),
        Err(ExtensionHostRuntimeError::Stale)
    ));
    first_grant.revoke();
    second_grant.revoke();
}

#[test]
fn extension_activation_accepts_authenticated_editor_transports_without_promoting_rpc_clients() {
    use crate::server::ConnectionAuthority;
    use crate::tests::{call, initialize, server};
    let server = server();
    for (mut connection, expected) in [
        (server.connection(), "ResourceNotOwner"),
        (server.browser_connection(), "ExtensionHostUnavailable"),
        (server.product_host_connection(), "ExtensionHostUnavailable"),
    ] {
        initialize(&server, &mut connection);
        let response = call(
            &server,
            &mut connection,
            serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "extensionHost/activate",
                "params": { "extensionId": "acme/test:tasks", "activationGeneration": 1,
                    "event": { "type": "taskType", "taskType": "build" } }
            }),
        );
        assert_eq!(response["error"]["message"], expected);
        assert_eq!(
            connection.allows_product_host_capabilities(),
            connection.authority == ConnectionAuthority::ProductHost
        );
    }
}

fn test_files_unavailable() -> ash_editor_extension_host::HostFailure {
    ash_editor_extension_host::HostFailure {
        code: ash_editor_extension_host::HostErrorCode::OperationNotSupported,
        message: "test has no filesystem".into(),
    }
}

#[test]
fn remote_extension_start_is_connection_owned_and_close_retires_only_its_fleet() {
    use std::sync::Arc;
    let mut server = crate::tests::server();
    server.extension_hosts = Some(
        super::ExtensionHostRuntime::start(
            super::source::BuiltInEditorExtensions::Product,
            None,
            None,
            None,
            Arc::new(CountingLauncher(std::sync::atomic::AtomicUsize::new(0))),
            ash_editor_extension_host::ExtensionHostLimits::default(),
            ash_editor_extension_host::RestartPolicy::default(),
            Arc::clone(&server.updates),
            Arc::clone(&server.client_host),
            Default::default(),
        )
        .unwrap(),
    );
    let first = server.browser_connection();
    let second = server.browser_connection();
    let untrusted = server.connection();
    assert!(
        server
            .extension_host_start(&untrusted, &json!({"environment":{"SET":"one"}}))
            .is_err()
    );
    assert!(
        server
            .extension_host_start(&first, &json!({"environment":{"bad-name":"one"}}))
            .is_err()
    );
    assert!(
        super::super::connection_state(&first)
            .extension_hosts
            .is_none()
    );
    server
        .extension_host_start(
            &first,
            &json!({"environment":{
                "SET":"one", "REMOVE":null,
                "node_repl_auth_token":"synthetic-host-control",
                "OPENAI_IDENTITY_TOKEN_FILE":null
            }}),
        )
        .unwrap();
    server
        .extension_host_start(&second, &json!({"environment":{"SET":"two"}}))
        .unwrap();
    assert!(
        server
            .extension_host_start(&first, &json!({"environment":{}}))
            .is_err()
    );
    let one = super::super::connection_state(&first)
        .extension_hosts
        .clone()
        .unwrap();
    let two = super::super::connection_state(&second)
        .extension_hosts
        .clone()
        .unwrap();
    assert_eq!(
        one.inner.environment.as_ref().unwrap(),
        &std::collections::BTreeMap::from([
            ("SET".into(), Some("one".into())),
            ("REMOVE".into(), None)
        ])
    );
    assert_eq!(
        two.inner.environment.as_ref().unwrap(),
        &std::collections::BTreeMap::from([("SET".into(), Some("two".into()))])
    );
    assert!(
        server
            .extension_hosts
            .as_ref()
            .unwrap()
            .inner
            .environment
            .is_none()
    );
    server.close_connection(first);
    assert!(one.snapshot_for(0).extensions.is_empty());
    assert!(!two.snapshot_for(0).extensions.is_empty());
    server.close_connection(second);
    assert!(two.snapshot_for(0).extensions.is_empty());
    assert!(
        !server
            .extension_hosts
            .as_ref()
            .unwrap()
            .snapshot_for(0)
            .extensions
            .is_empty()
    );
}
