use super::ExtensionHostInvocationRead;
use super::ExtensionHostRuntimeError;
use super::projection::ExtensionHostFailureKind;
use super::projection::runtime_failure;
use super::registration_allows_operation;
use super::sessions::InvocationSessionStore;
use super::source::stable_extension_id;
use ash_external_ext::ExtensionHostError;
use ash_external_ext::InvokeResult;
use ash_external_ext::LanguageProviderOperation;
use ash_external_ext::RegistrationKind;
use serde_json::json;
use std::time::Duration;
use std::time::Instant;

#[test]
fn terminal_link_provider_cannot_invoke_terminal_input_or_other_provider_operations() {
    let links = RegistrationKind::TerminalLinkProvider {};
    assert!(registration_allows_operation(
        &links,
        "provideTerminalLinks"
    ));
    assert!(registration_allows_operation(&links, "handleTerminalLink"));
    for operation in [
        "inputTaskTerminal",
        "createTerminalProfile",
        "execute",
        "getTerminalEnvironment",
    ] {
        assert!(!registration_allows_operation(&links, operation));
    }
}

#[test]
fn lldb_product_provider_is_dormant_until_its_exact_debugger_is_requested() {
    let executable = std::env::current_exe().unwrap();
    let deployment = super::source::product_lldb_deployment(executable.parent().unwrap()).unwrap();
    assert_eq!(deployment.id, "ash.debug-lldb");
    assert_eq!(
        deployment.params.capabilities,
        [
            ash_external_ext::ExtensionCapability::DebugAdapter,
            ash_external_ext::ExtensionCapability::Command,
            ash_external_ext::ExtensionCapability::StatusBar
        ]
    );
    assert!(matches!(
        deployment.workspace_read,
        super::source::WorkspaceReadAccess::Denied
    ));
    assert!(deployment.backend_channels.is_empty());
    assert!(deployment.credential_providers.is_empty());
    let activation = deployment.activation.unwrap();
    for phase in [
        super::source::DebugActivationPhase::Start,
        super::source::DebugActivationPhase::ResolveConfiguration,
    ] {
        assert!(activation.matches(&super::source::ActivationEvent::Debug {
            phase,
            debug_type: Some("lldb-dap".into())
        }));
        assert!(activation.matches(&super::source::ActivationEvent::Debug {
            phase,
            debug_type: Some("lldb".into())
        }));
        assert!(!activation.matches(&super::source::ActivationEvent::Debug {
            phase,
            debug_type: Some("other".into())
        }));
    }
    assert!(!activation.matches(&super::source::ActivationEvent::StartupFinished));
    assert!(!activation.matches(&super::source::ActivationEvent::Language("rust".into())));
    // Select and Start asks every initial provider for templates before it has
    // a debugger type. Resolving or launching remains type-specific.
    assert!(activation.matches(&super::source::ActivationEvent::Debug {
        phase: super::source::DebugActivationPhase::InitialConfigurations,
        debug_type: None,
    }));
    assert_eq!(activation.events, deployment.params.activation_events);
}

#[test]
fn declared_capability_calls_activate_the_exact_real_provider_and_obey_cancellation_and_revocation()
{
    use ash_external_ext::ActivationAuthority;
    use ash_external_ext::ActivationLease;
    use ash_external_ext::ExtensionHostLimits;
    use ash_external_ext::HostErrorCode;
    use ash_external_ext::HostEventContext;
    use ash_external_ext::RestartPolicy;
    use external_ext_protocol::ExtensionClientOperation;
    use external_ext_protocol::ExtensionClientResult;
    use std::collections::BTreeMap;
    use std::num::NonZeroU64;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    struct Switch(Arc<AtomicBool>);
    impl ActivationAuthority for Switch {
        fn authorizes(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }
        fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
            self.authorizes()
                .then(|| Box::new(AllowedLease) as Box<dyn ActivationLease>)
        }
    }
    let executable = std::path::PathBuf::from(
        std::env::var_os("ASH_MARKDOWN_MATH_BIN")
            .expect("Cargo test wrapper prepares the real math extension"),
    );
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Omitted,
        None,
        None,
        None,
        Arc::new(ash_external_ext::ProductExecutableLauncher::new(executable.clone()).unwrap()),
        ExtensionHostLimits::default(),
        RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        None,
    )
    .unwrap();
    let enabled = Arc::new(AtomicBool::new(true));
    let mut deployment =
        super::source::product_markdown_math_deployment(executable.parent().unwrap()).unwrap();
    deployment.authority = Arc::new(Switch(enabled.clone()));
    let entry = runtime
        .inner
        .build_entry(None, &deployment, NonZeroU64::new(1).unwrap());
    runtime
        .inner
        .state
        .lock()
        .unwrap()
        .entries
        .insert(deployment.id.clone(), entry);
    assert_eq!(
        runtime.product_extension_states(),
        [("ash.markdown-math".into(), false)]
    );
    let mut binding = super::EditorClientBinding {
        runtime: Arc::downgrade(&runtime.inner),
        activation: std::sync::Weak::new(),
        backend_channels: BTreeMap::new(),
        credential_providers: Vec::new(),
        credential_services: Arc::new(Mutex::new(BTreeMap::new())),
        client_host: Arc::new(crate::client_host::ClientHost::default()),
        owner: 7,
        extension_id: "ash.markdown-language-features".into(),
        workspace_read: super::source::WorkspaceReadAccess::Denied,
        files: Err(test_files_unavailable()),
    };
    let operation = || ExtensionClientOperation::BackendRequest {
        capability: "math.render.v2".into(),
        method: "receiveData".into(),
        params: json!({"formulas":[{"source":"\\frac{a}{b}","display":"block"}]}),
        progress: None,
    };
    let source = ash_async_utils::CancellationSource::new();
    let invoke = |binding: &super::EditorClientBinding| {
        binding.request(
            HostEventContext::new(1, 1),
            operation(),
            &source.token(),
            Duration::from_secs(10),
        )
    };
    assert_eq!(
        invoke(&binding).unwrap_err().code,
        HostErrorCode::PermissionDenied
    );
    assert!(
        runtime.inner.state.lock().unwrap().entries[&deployment.id]
            .pending_activation
            .is_some()
    );
    binding
        .backend_channels
        .insert("math.render.v2".into(), deployment.id.clone());
    let result = invoke(&binding).unwrap();
    assert!(
        matches!(result, ExtensionClientResult::Value { value } if value["results"][0]["html"].as_str().unwrap().contains("katex-display"))
    );
    assert!(
        runtime.inner.state.lock().unwrap().entries[&deployment.id]
            .pending_activation
            .is_none()
    );
    assert_eq!(
        runtime.product_extension_states(),
        [("ash.markdown-math".into(), true)]
    );
    enabled.store(false, Ordering::Release);
    assert!(matches!(
        invoke(&binding).unwrap_err().code,
        HostErrorCode::PermissionDenied | HostErrorCode::RegistrationNotFound
    ));
    enabled.store(true, Ordering::Release);
    source.cancel();
    assert_eq!(invoke(&binding).unwrap_err().code, HostErrorCode::Cancelled);
    runtime.shutdown();
}

#[path = "extension_host_window_tests.rs"]
mod windows;

#[test]
fn markdown_product_registration_owns_views_and_obeys_profile_policy() {
    struct Disabled;
    impl crate::ExtensionsEditorExtensionAdmission for Disabled {
        fn generation(&self) -> u64 {
            1
        }
        fn is_product_extension_enabled(&self, _id: &str) -> bool {
            false
        }
        fn authorizes(&self, _binding: &crate::ExtensionsEditorExtensionBinding) -> bool {
            false
        }
        fn acquire(
            &self,
            _binding: &crate::ExtensionsEditorExtensionBinding,
        ) -> Option<Box<dyn crate::ExtensionsEditorExtensionAdmissionLease>> {
            None
        }
    }
    let deployments = super::source::built_in_deployments(
        super::source::BuiltInEditorExtensions::Product,
        Some(std::sync::Arc::new(Disabled)),
    )
    .unwrap();
    let markdown = deployments
        .iter()
        .find(|entry| entry.id == "ash.markdown-language-features")
        .unwrap();
    assert_eq!(
        markdown.params.capabilities,
        vec![
            ash_external_ext::ExtensionCapability::Command,
            ash_external_ext::ExtensionCapability::CustomTextEditor,
            ash_external_ext::ExtensionCapability::LanguageProvider
        ]
    );
    assert!(matches!(
        markdown.workspace_read,
        super::source::WorkspaceReadAccess::Read
    ));
    assert!(markdown.credential_providers.is_empty());
    let activation = markdown.activation.as_ref().unwrap();
    assert!(activation.matches(&super::source::ActivationEvent::Language("markdown".into())));
    assert!(!activation.matches(&super::source::ActivationEvent::StartupFinished));
    for (command, _) in &activation.commands {
        assert!(activation.matches(&super::source::ActivationEvent::Command(command.clone())));
    }
    assert_eq!(activation.events, markdown.params.activation_events);
    assert_eq!(markdown.activation.as_ref().unwrap().commands.len(), 7);
    assert!(!markdown.authority.authorizes());
    assert!(markdown.authority.acquire().is_none());
    assert_eq!(
        markdown
            .backend_channels
            .get("math.render.v2")
            .map(String::as_str),
        Some("ash.markdown-math")
    );
    assert!(deployments.iter().all(|entry| entry.id != "ash.academy"));
    assert!(deployments.iter().all(|entry| entry.id != "ash.code"));
    let math = deployments
        .iter()
        .find(|entry| entry.id == "ash.markdown-math")
        .unwrap();
    assert_eq!(
        math.params.capabilities,
        [ash_external_ext::ExtensionCapability::DataChannel]
    );
    assert!(math.activation.as_ref().unwrap().matches(
        &super::source::ActivationEvent::Capability("math.render.v2".into())
    ));
    assert!(math.backend_channels.is_empty());
    assert!(!math.authority.authorizes());
    for (deployment, manifest) in [
        (
            markdown,
            include_str!("../../../../extensions/markdown-language-features/package.json"),
        ),
        (
            math,
            include_str!("../../../../extensions/markdown-math/package.json"),
        ),
    ] {
        let manifest: serde_json::Value = serde_json::from_str(manifest).unwrap();
        assert_eq!(manifest["publisher"], "ash");
        assert_eq!(
            deployment.id,
            format!("ash.{}", manifest["name"].as_str().unwrap())
        );
        assert_eq!(deployment.params.extension_id, deployment.id);
        assert_eq!(
            deployment.params.package.package_id,
            format!(
                "{}@{}",
                deployment.id,
                manifest["version"].as_str().unwrap()
            )
        );
        assert_eq!(
            deployment.params.package.entrypoint,
            manifest["ashRuntime"]["entrypoint"].as_str().unwrap()
        );
    }
}

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

    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    assert!(matches!(
        sessions.reserve("same-owner".into(), 7, 1, "test.extension".into()),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
    sessions
        .reserve("two".into(), 8, 1, "test.extension".into())
        .unwrap();
    assert!(matches!(
        sessions.reserve("global".into(), 9, 1, "test.extension".into()),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
}

#[test]
fn pending_invocation_identity_is_connection_owned() {
    let mut sessions = InvocationSessionStore::new(2, 2);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();

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
fn retiring_git_preserves_another_extensions_pending_invocation_in_the_same_window() {
    let mut sessions = InvocationSessionStore::new(2, 2);
    sessions
        .reserve("git".into(), 7, 1, "ash.git".into())
        .unwrap();
    sessions
        .reserve("independent".into(), 7, 1, "test.scm".into())
        .unwrap();
    assert!(
        sessions
            .detach_except(
                &std::collections::BTreeSet::from(["test.scm".into()]),
                ash_external_ext::CancelReason::AuthorityRevoked,
            )
            .is_empty()
    );
    assert!(matches!(
        sessions.read(7, "git"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
    assert!(matches!(
        sessions.read(7, "independent"),
        Ok(ExtensionHostInvocationRead::Pending)
    ));
}

#[test]
fn detaching_an_owner_releases_terminal_sessions_immediately() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!({ "ok": true }),
        }),
    );

    assert!(
        sessions
            .detach_owner(7, ash_external_ext::CancelReason::Shutdown)
            .is_empty()
    );
    sessions
        .reserve("replacement".into(), 8, 1, "test.extension".into())
        .unwrap();
}

#[test]
fn abandoned_terminal_sessions_are_reaped_before_reusing_quota() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!(null),
        }),
    );
    sessions.sweep_expired(Instant::now() + Duration::from_secs(61));

    sessions
        .reserve("replacement".into(), 8, 1, "test.extension".into())
        .unwrap();
}

#[test]
fn discarding_a_completed_invocation_is_owner_fenced_and_releases_quota_without_a_read() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!("completed before cancellation"),
        }),
    );
    assert!(matches!(
        sessions.cancel(
            8,
            "one",
            ash_external_ext::CancelReason::Caller,
            super::ResultRetention::Discard
        ),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
    assert!(matches!(
        sessions.reserve("blocked".into(), 8, 1, "test.extension".into()),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
    sessions
        .cancel(
            7,
            "one",
            ash_external_ext::CancelReason::Caller,
            super::ResultRetention::Discard,
        )
        .unwrap();
    assert!(matches!(
        sessions.read(7, "one"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
    sessions
        .reserve("replacement".into(), 7, 1, "test.extension".into())
        .unwrap();
}

#[test]
fn cancellation_with_retained_results_keeps_the_existing_polling_contract() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!("result"),
        }),
    );
    sessions
        .cancel(
            7,
            "one",
            ash_external_ext::CancelReason::Caller,
            super::ResultRetention::Retain,
        )
        .unwrap();
    assert!(
        matches!(sessions.read(7, "one"), Ok(ExtensionHostInvocationRead::Succeeded(value)) if value == json!("result"))
    );
    sessions
        .reserve("replacement".into(), 7, 1, "test.extension".into())
        .unwrap();
}

#[test]
fn discarded_pending_invocations_release_quota_when_the_real_host_completes() {
    use ash_external_ext::ExtensionActivationSpec;
    use ash_external_ext::ExtensionHostSupervisor;
    use ash_external_ext::ExtensionInvocation;
    use ash_external_ext::ExtensionLaunchCommand;
    use std::sync::Arc;
    let node = std::process::Command::new("node")
        .args(["--print", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let executable = std::path::PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let source = r#"
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const r = JSON.parse(line);
 const body = r.method === 'initialize' ? { result: 'initialized', body: { protocolVersion: 1, runtimeApiVersion: 1 } }
  : r.method === 'activate' ? { result: 'activated', body: { registrations: [{ registrationId: 'fixture', kind: 'command', command: 'fixture', title: 'Fixture' }] } }
  : r.method === 'invoke' ? { result: 'invoked', body: { payload: 'completed' } }
  : { result: ({ cancel: 'cancelled', deactivate: 'deactivated', shutdown: 'shutdown', ping: 'pong' })[r.method] };
 process.stdout.write(JSON.stringify({ protocolVersion: r.protocolVersion, requestId: r.requestId, incarnation: r.incarnation, activationGeneration: r.activationGeneration, status: 'success', body }) + '\n');
});
"#;
    // The fixture uses an explicit environment; Windows Node needs this to
    // initialize its cryptographic provider before it can answer the handshake.
    let environment = std::env::var_os("SystemRoot")
        .map(|root| std::collections::BTreeMap::from([("SystemRoot".into(), root)]))
        .unwrap_or_default();
    let supervisor = ExtensionHostSupervisor::new(
        Arc::new(ash_external_ext::TrustedDevelopmentLauncher),
        ExtensionLaunchCommand::new(
            executable,
            ["-e", source],
            std::env::temp_dir(),
            environment,
        )
        .unwrap(),
        ExtensionActivationSpec::new(
            ash_external_ext::ActivateParams {
                initialization: None,
                extension_id: "fixture".into(),
                package: ash_external_ext::PackageBinding {
                    package_id: "fixture@1".into(),
                    package_digest: format!("sha256:{}", "a".repeat(64)),
                    entrypoint: "fixture.js".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onCommand:fixture".into()],
                capabilities: vec![ash_external_ext::ExtensionCapability::Command],
            },
            std::num::NonZeroU64::new(1).unwrap(),
            Arc::new(AllowedActivation),
        ),
        ash_external_ext::ExtensionHostLimits {
            isolation: ash_external_ext::ProcessIsolationPolicy::TrustedDevelopment,
            ..Default::default()
        },
        ash_external_ext::RestartPolicy::default(),
    )
    .unwrap();
    supervisor.start().unwrap();
    let handle = Arc::new(
        supervisor
            .begin_invoke(ExtensionInvocation {
                registration_id: "fixture".into(),
                operation: "execute".into(),
                payload: json!({}),
                deadline_unix_millis: std::num::NonZeroU64::new(1_900_000_000_000).unwrap(),
            })
            .unwrap(),
    );
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions
        .reserve("one".into(), 7, 1, "test.extension".into())
        .unwrap();
    sessions.install("one", handle.clone(), None).unwrap();
    sessions
        .cancel(
            7,
            "one",
            ash_external_ext::CancelReason::Caller,
            super::ResultRetention::Discard,
        )
        .unwrap();
    assert!(matches!(
        sessions.read(7, "one"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
    assert!(matches!(
        sessions.reserve("blocked".into(), 7, 1, "test.extension".into()),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
    sessions.complete("one", handle.wait());
    sessions
        .reserve("replacement".into(), 7, 1, "test.extension".into())
        .unwrap();
    assert_eq!(supervisor.snapshot().incarnation, 1);
    let handle = Arc::new(
        supervisor
            .begin_invoke(ExtensionInvocation {
                registration_id: "fixture".into(),
                operation: "execute".into(),
                payload: json!({}),
                deadline_unix_millis: std::num::NonZeroU64::new(1_900_000_000_000).unwrap(),
            })
            .unwrap(),
    );
    sessions
        .install("replacement", handle.clone(), None)
        .unwrap();
    supervisor.shutdown().unwrap();
    assert!(
        sessions
            .cancel(
                7,
                "replacement",
                ash_external_ext::CancelReason::Caller,
                super::ResultRetention::Discard
            )
            .is_err()
    );
    assert!(matches!(
        sessions.read(7, "replacement"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
    sessions.complete("replacement", handle.wait());
    sessions
        .reserve("after-exit".into(), 7, 1, "test.extension".into())
        .unwrap();
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
        schemes: vec![ash_external_ext::ExternalUriScheme::Https],
        label: "Acme browser".into(),
    };
    assert!(registration_allows_operation(&opener, "canOpenExternalUri"));
    assert!(registration_allows_operation(&opener, "openExternalUri"));
    assert!(!registration_allows_operation(&opener, "execute"));
    let command = RegistrationKind::Command {
        command: "acme.run".into(),
        title: "Run".into(),
        category: None,
        enablement: None,
        icon: None,
        menus: Vec::new(),
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
    let output = RegistrationKind::OutputEvents {};
    assert!(registration_allows_operation(&output, "outputEvent"));
    assert!(!registration_allows_operation(&output, "execute"));
    assert!(!registration_allows_operation(&output, "workspaceEvent"));
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
impl ash_external_ext::ExtensionHostLauncher for CountingLauncher {
    fn spawn(
        &self,
        _: &ash_external_ext::ExtensionLaunchCommand,
        _: &ash_external_ext::ExtensionHostLimits,
    ) -> Result<std::sync::Arc<dyn ash_external_ext::ExtensionHostProcess>, ExtensionHostError>
    {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(ExtensionHostError::SpawnFailed)
    }
}

#[test]
fn changing_git_enablement_preserves_unrelated_runtime_and_window_instances() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    struct Policy(AtomicU64);
    impl crate::ExtensionsEditorExtensionAdmission for Policy {
        fn generation(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }
        fn is_product_extension_enabled(&self, id: &str) -> bool {
            id != "ash.git" || self.generation() != 2
        }
        fn authorizes(&self, _: &crate::ExtensionsEditorExtensionBinding) -> bool {
            false
        }
        fn acquire(
            &self,
            _: &crate::ExtensionsEditorExtensionBinding,
        ) -> Option<Box<dyn crate::ExtensionsEditorExtensionAdmissionLease>> {
            None
        }
    }
    let policy = Arc::new(Policy(AtomicU64::new(1)));
    let mut limits = ash_external_ext::ExtensionHostLimits::default();
    limits.isolation = ash_external_ext::ProcessIsolationPolicy::TrustedDevelopment;
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Product,
        None,
        None,
        Some(policy.clone()),
        Arc::new(CountingLauncher(std::sync::atomic::AtomicUsize::new(0))),
        limits,
        ash_external_ext::RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        Default::default(),
    )
    .unwrap();
    let (mut git_generation, shared_gate, window_gate) = {
        let mut state = runtime.inner.state.lock().unwrap();
        let git_generation = state.entries["ash.git"].fallback.activation_generation;
        let shared_gate = state.entries["ash.markdown-math"].activation_gate.clone();
        let base = &state.entries["ash.markdown-language-features"];
        let mut window = runtime.inner.build_entry(
            None,
            base.deployment.as_ref().unwrap(),
            std::num::NonZeroU64::new(base.fallback.activation_generation).unwrap(),
        );
        window.deployment = None;
        let window_gate = window.activation_gate.clone();
        state
            .windows
            .entry(42)
            .or_default()
            .insert(window.fallback.id.clone(), window);
        (git_generation, shared_gate, window_gate)
    };
    for revision in [2, 3] {
        policy.0.store(revision, Ordering::Release);
        runtime
            .reconcile(super::ExtensionHostReconcileMode::Refresh)
            .unwrap();
        let state = runtime.inner.state.lock().unwrap();
        assert!(Arc::ptr_eq(
            &shared_gate,
            &state.entries["ash.markdown-math"].activation_gate
        ));
        assert!(Arc::ptr_eq(
            &window_gate,
            &state.windows[&42]["ash.markdown-language-features"].activation_gate
        ));
        let git = &state.entries["ash.git"];
        assert!(git.fallback.activation_generation > git_generation);
        git_generation = git.fallback.activation_generation;
        if revision == 2 {
            // The product catalog must retain the disabled provider so the UI can re-enable it.
            assert!(git.supervisor.is_none());
        } else {
            assert!(git.supervisor.is_some());
            assert!(git.pending_activation.is_some());
        }
    }
    runtime.shutdown();
}

#[test]
fn product_ssh_is_available_without_a_directory_and_is_rebound_after_unbind() {
    use ash_external_ext::ExtensionHostLimits;
    use ash_external_ext::RestartPolicy;
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    struct SshLauncher(CountingLauncher);
    impl ash_external_ext::ExtensionHostLauncher for SshLauncher {
        fn spawn(
            &self,
            command: &ash_external_ext::ExtensionLaunchCommand,
            limits: &ExtensionHostLimits,
        ) -> Result<Arc<dyn ash_external_ext::ExtensionHostProcess>, ExtensionHostError> {
            // Other product extensions may also activate; count only this test's SSH host.
            if command
                .executable()
                .and_then(|path| path.file_name())
                .is_some_and(|name| {
                    name == format!("ash-remote-ssh-extension{}", std::env::consts::EXE_SUFFIX)
                        .as_str()
                })
            {
                self.0.spawn(command, limits)
            } else {
                Err(ExtensionHostError::SpawnFailed)
            }
        }
    }
    let launcher = Arc::new(SshLauncher(CountingLauncher(
        std::sync::atomic::AtomicUsize::new(0),
    )));
    let mut limits = ExtensionHostLimits::default();
    limits.isolation = ash_external_ext::ProcessIsolationPolicy::TrustedDevelopment;
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Product,
        None,
        None,
        None,
        launcher.clone(),
        limits,
        RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        Default::default(),
    )
    .unwrap();
    let product_states = runtime.product_extension_states();
    for id in ["ash.markdown-language-features", "ash.markdown-math"] {
        assert!(
            product_states
                .iter()
                .any(|(extension_id, _)| extension_id == id)
        );
    }
    let initial = runtime.inner.snapshot();
    let initial_ssh = initial
        .extensions
        .iter()
        .find(|extension| extension.id == "ash.remote-ssh")
        .unwrap();
    assert_eq!(
        initial_ssh.lifecycle,
        super::projection::ExtensionHostLifecycle::Dormant
    );
    assert!(initial_ssh.incarnation.is_none());
    assert_eq!(launcher.0.0.load(Ordering::SeqCst), 0);
    runtime
        .activate_by_event(
            1,
            "ash.remote-ssh",
            initial_ssh.activation_generation,
            super::source::ActivationEvent::ResolveAuthority("ssh".into()),
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    let attempts = RestartPolicy::default().maximum_restarts + 1;
    assert_eq!(launcher.0.0.load(Ordering::SeqCst), attempts);
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
    let after_ssh = after
        .extensions
        .iter()
        .find(|extension| extension.id == "ash.remote-ssh")
        .unwrap();
    assert!(after_ssh.activation_generation > initial_ssh.activation_generation);
    assert_eq!(
        after_ssh.lifecycle,
        super::projection::ExtensionHostLifecycle::Dormant
    );
    assert_eq!(launcher.0.0.load(Ordering::SeqCst), attempts);
}

#[test]
fn lazy_activation_checks_generation_and_event_and_health_never_launches_dormant_entries() {
    use super::source::ActivationEvent;
    use super::source::DebugActivationPhase;
    for event in [
        ActivationEvent::Capability("math.render.v2".into()),
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
    use ash_external_ext::{
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
    let params = ash_external_ext::ActivateParams {
        initialization: None,
        extension_id: "lazy".into(),
        package: ash_external_ext::PackageBinding {
            package_id: "lazy@1".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "main.js".into(),
        },
        runtime_api_version: 1,
        activation_events: vec![
            "onCapability:math.render.v2".into(),
            "onCommand:lazy.run".into(),
            "onTaskType:build".into(),
            "onDebugResolve:node".into(),
            "onDebugInitialConfigurations".into(),
            "onDebugDynamicConfigurations:node".into(),
        ],
        capabilities: vec![ash_external_ext::ExtensionCapability::Command],
    };
    let supervisor = ExtensionHostSupervisor::new(
        launcher.clone(),
        command,
        ash_external_ext::ExtensionActivationSpec::new(
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
                scope: super::source::EditorExtensionScope::Workspace,
                backend_channels: std::collections::BTreeMap::new(),
                activation_gate: Arc::new(std::sync::Mutex::new(())),
                client_scope: super::EditorClientScope::Unsupported,
                deployment: None,
                version: "1".into(),
                workspace_read: super::source::WorkspaceReadAccess::Denied,
                supervisor: Some(supervisor),
                failure: None,
                pending_activation: Some(super::source::ActivationPlan {
                    events: vec![
                        "onCapability:math.render.v2".into(),
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
impl ash_external_ext::ActivationLease for AllowedLease {}
impl ash_external_ext::ActivationAuthority for AllowedActivation {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ash_external_ext::ActivationLease>> {
        Some(Box::new(AllowedLease))
    }
}

#[test]
fn directory_changes_do_not_reuse_extension_activation_generations() {
    use ash_external_ext::{ExtensionHostLimits, RestartPolicy};
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
        (
            server.open_connection(ConnectionAuthority::RemoteHost),
            "ExtensionHostUnavailable",
        ),
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
            matches!(
                connection.authority,
                ConnectionAuthority::ProductHost | ConnectionAuthority::RemoteHost
            )
        );
    }
}

fn test_files_unavailable() -> ash_external_ext::HostFailure {
    ash_external_ext::HostFailure {
        code: ash_external_ext::HostErrorCode::OperationNotSupported,
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
            ash_external_ext::ExtensionHostLimits::default(),
            ash_external_ext::RestartPolicy::default(),
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
            .extension_host_processor()
            .extension_host_start(&untrusted, &json!({"environment":{"SET":"one"}}))
            .is_err()
    );
    assert!(
        server
            .extension_host_processor()
            .extension_host_start(&first, &json!({"environment":{"bad-name":"one"}}))
            .is_err()
    );
    assert!(
        super::super::connection_state(&first)
            .extension_hosts
            .is_none()
    );
    server
        .extension_host_processor()
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
        .extension_host_processor()
        .extension_host_start(&second, &json!({"environment":{"SET":"two"}}))
        .unwrap();
    assert!(
        server
            .extension_host_processor()
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

#[test]
fn credentials_are_private_to_admitted_consumers_and_never_relayed_to_the_renderer() {
    use external_ext_protocol::ExtensionClientOperation;
    use external_ext_protocol::ExtensionClientResult;
    use external_ext_protocol::HostErrorCode;
    use external_ext_protocol::HostEventContext;
    use external_ext_protocol::services::CoreServiceRequest;
    use external_ext_protocol::services::CoreServiceResponse;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    let client = Arc::new(crate::client_host::ClientHost::default());
    let queue = crate::server::notification_queue::NotificationQueue::default();
    client.register(7, false, queue.clone());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let handler: Arc<super::CredentialHandler> = Arc::new(move |host, account, _| {
        count.fetch_add(1, Ordering::Relaxed);
        if host != "github.com" || account.is_some_and(|id| id != "approved") {
            return Err(ash_external_ext::HostFailure {
                code: HostErrorCode::PermissionDenied,
                message: "account not authorized".into(),
            });
        }
        Ok(CoreServiceResponse::Credential {
            username: "test-user".into(),
            password: b"test-secret".to_vec(),
        })
    });
    let mut binding = super::EditorClientBinding {
        runtime: std::sync::Weak::new(),
        activation: std::sync::Weak::new(),
        backend_channels: BTreeMap::new(),
        credential_providers: Vec::new(),
        credential_services: Arc::new(Mutex::new(BTreeMap::from([("github".into(), handler)]))),
        client_host: client,
        owner: 7,
        extension_id: "ash.git".into(),
        workspace_read: super::source::WorkspaceReadAccess::Denied,
        files: Err(ash_external_ext::HostFailure {
            code: HostErrorCode::PermissionDenied,
            message: "no files".into(),
        }),
    };
    let source = ash_async_utils::CancellationSource::new();
    let request = |host: &str, account: Option<&str>| ExtensionClientOperation::CoreService {
        request: CoreServiceRequest::CredentialGet {
            provider_id: "github".into(),
            host: host.into(),
            account_id: account.map(str::to_owned),
        },
    };
    let invoke = |binding: &super::EditorClientBinding, operation| {
        binding.request(
            HostEventContext::new(1, 1),
            operation,
            &source.token(),
            Duration::from_millis(10),
        )
    };
    assert_eq!(
        invoke(&binding, request("github.com", None))
            .unwrap_err()
            .code,
        HostErrorCode::PermissionDenied
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    binding.credential_providers.push("github".into());
    for host in [
        "github.com/path",
        "user@github.com",
        "github.com:443",
        "GITHUB.COM",
        "",
    ] {
        assert!(invoke(&binding, request(host, None)).is_err());
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert!(invoke(&binding, request("example.com", None)).is_err());
    assert!(invoke(&binding, request("github.com", Some("revoked"))).is_err());
    let result = invoke(&binding, request("github.com", Some("approved"))).unwrap();
    assert!(
        matches!(&result,ExtensionClientResult::CoreService{response:CoreServiceResponse::Credential{username,password}} if username=="test-user" && password==b"test-secret")
    );
    assert!(!format!("{result:?}").contains("test-secret"));
    assert!(queue.drain().is_empty());
    source.cancel();
    let calls_before = calls.load(Ordering::Relaxed);
    assert!(invoke(&binding, request("github.com", None)).is_err());
    assert_eq!(calls.load(Ordering::Relaxed), calls_before);
    binding.credential_providers.clear();
    assert!(invoke(&binding, request("github.com", None)).is_err());
    assert!(queue.drain().is_empty());
}

#[test]
#[ignore = "requires ASH_ACADEMY_DISTRIBUTION and ASH_ACADEMY_TRUSTED_ROOT signed package fixture"]
fn signed_installed_academy_uses_product_launcher_and_exact_revocable_consent() {
    signed_installed_editor_uses_product_launcher_and_exact_revocable_consent(
        "ASH_ACADEMY_DISTRIBUTION",
        "ASH_ACADEMY_TRUSTED_ROOT",
        "academy",
        "editor.client.v1",
        [("en", "Academy Document"), ("zh-CN", "Academy 文档")],
    );
}

#[test]
#[ignore = "requires ASH_PDF_VIEWER_DISTRIBUTION and ASH_PDF_VIEWER_TRUSTED_ROOT signed package fixture"]
fn signed_installed_pdf_viewer_uses_product_launcher_and_exact_revocable_consent() {
    signed_installed_editor_uses_product_launcher_and_exact_revocable_consent(
        "ASH_PDF_VIEWER_DISTRIBUTION",
        "ASH_PDF_VIEWER_TRUSTED_ROOT",
        "pdf-viewer",
        "editor.resource.v1",
        [("en", "PDF Reader"), ("zh-CN", "PDF 阅读器")],
    );
}

#[test]
#[ignore = "requires ASH_REFERENCE_MANAGER_DISTRIBUTION and ASH_REFERENCE_MANAGER_TRUSTED_ROOT signed package fixture"]
fn signed_installed_reference_manager_uses_product_launcher_and_exact_revocable_consent() {
    signed_installed_editor_uses_product_launcher_and_exact_revocable_consent(
        "ASH_REFERENCE_MANAGER_DISTRIBUTION",
        "ASH_REFERENCE_MANAGER_TRUSTED_ROOT",
        "reference-manager",
        "editor.resource.v1",
        [("en", "Reference Library"), ("zh-CN", "文献库")],
    );
}

fn signed_installed_editor_uses_product_launcher_and_exact_revocable_consent(
    distribution_env: &str,
    trusted_root_env: &str,
    name: &str,
    channel: &str,
    localized_names: [(&str, &str); 2],
) {
    use ash_core_plugins::CapabilityKind;
    use ash_core_plugins::EditorExtensionPolicy;
    use ash_core_plugins::EditorExtensionPolicyAction;
    use ash_core_plugins::ExtensionPackageManager;
    use ash_core_plugins::ExtensionPackageService;
    use ash_core_plugins::ExtensionSource;
    use ash_core_plugins::ExtensionSources;
    use ash_core_plugins::ExtensionsRemoteClient;
    use ash_core_plugins::InstallPackageRequest;
    use ash_core_plugins::RemoteExtensionsConfig;
    use std::sync::Arc;

    let runtime_id = format!("ash.{name}");
    let package_id = format!("{runtime_id}@editor-smoke");
    let root = tempfile::tempdir().unwrap();
    let config = RemoteExtensionsConfig::from_directory(
        std::env::var_os(distribution_env).expect("signed distribution path"),
        std::fs::read(std::env::var_os(trusted_root_env).expect("pinned root path")).unwrap(),
        root.path().join("cache"),
    )
    .unwrap()
    .with_product_runtime_publishers(["ash".into()])
    .unwrap();
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            ExtensionSources::new([(
                ash_utils_plugins::ExtensionSourceId::new("editor-smoke").unwrap(),
                Arc::new(ExtensionsRemoteClient::new(config)) as Arc<dyn ExtensionSource>,
            )])
            .unwrap(),
        )
        .unwrap(),
    );
    let found = manager
        .search(ash_core_plugins::SearchPackagesRequest {
            query: name.into(),
            capability_kind: Some(CapabilityKind::EditorExtension),
            ..Default::default()
        })
        .unwrap();
    assert!(
        found
            .packages
            .iter()
            .any(|package| package.id == package_id && package.package_type == "editor")
    );
    let details = manager
        .get(ash_core_plugins::GetPackageRequest {
            package_id: package_id.clone(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    assert_eq!(details.package_type, "editor");
    assert!(
        details
            .capabilities
            .iter()
            .any(|capability| capability.kind == CapabilityKind::EditorExtension)
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: package_id.clone(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let executable = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap()
        .into_iter()
        .find(|source| {
            crate::extension_packages_editor_extensions::product_runtime_extension_id(source)
                .is_ok_and(|id| id.as_deref() == Some(runtime_id.as_str()))
        })
        .unwrap();
    assert!(executable.is_product_runtime());
    assert!(
        executable
            .editor_extension_root()
            .unwrap()
            .ends_with("editor")
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            executable
                .editor_extension_root()
                .unwrap()
                .join("package.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let expected_source = manifest
        .pointer("/ashRuntime/client/sourceDigest")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    let runtime = super::ExtensionHostRuntime::start(
        super::source::BuiltInEditorExtensions::Omitted,
        None,
        Some(manager.clone()),
        Some(Arc::new(
            crate::extension_packages_editor_extensions::ProfileEditorExtensionAdmission(
                policy.clone(),
            ),
        )),
        Arc::new(
            ash_external_ext::ProductExecutableLauncher::new(std::env::current_exe().unwrap())
                .unwrap(),
        ),
        ash_external_ext::ExtensionHostLimits::default(),
        ash_external_ext::RestartPolicy::default(),
        Arc::new(super::super::update_broker::UpdateBroker::default()),
        Arc::new(crate::client_host::ClientHost::default()),
        None,
    )
    .unwrap();
    let rejected = runtime.snapshot_for(1);
    assert_eq!(rejected.extensions.len(), 1);
    assert_eq!(
        rejected.extensions[0].failure.as_ref().unwrap().code,
        ExtensionHostFailureKind::AuthorityDenied
    );
    policy
        .set(
            &installed.package,
            executable.capability(),
            EditorExtensionPolicyAction::Grant,
            policy.generation(),
        )
        .unwrap();
    let granted = runtime
        .reconcile(super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    let generation = granted.extensions[0].activation_generation;
    let activated = runtime
        .activate_by_event(
            1,
            &runtime_id,
            generation,
            super::source::ActivationEvent::StartupFinished,
            None,
            Err(test_files_unavailable()),
        )
        .unwrap();
    assert_eq!(
        activated.extensions[0].lifecycle,
        super::projection::ExtensionHostLifecycle::Ready
    );
    assert_eq!(activated.extensions[0].registrations.len(), 1);
    let supervisor = runtime.inner.state.lock().unwrap().entries[&runtime_id]
        .supervisor
        .clone()
        .unwrap();
    for (language, expected) in localized_names {
        let result = supervisor
            .begin_data_channel(
                channel,
                json!({"operation":"describe", "language":language}),
                Duration::from_secs(10),
            )
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(result.payload["editors"][0]["displayName"], expected);
        assert_eq!(result.payload["clientModule"], "dist/editor.js");
        assert_eq!(result.payload["clientDigest"], expected_source);
    }
    policy
        .set(
            &installed.package,
            executable.capability(),
            EditorExtensionPolicyAction::Revoke,
            policy.generation(),
        )
        .unwrap();
    runtime
        .reconcile(super::ExtensionHostReconcileMode::Refresh)
        .unwrap();
    assert!(!supervisor.is_running());
    assert_eq!(
        runtime.snapshot_for(1).extensions[0]
            .failure
            .as_ref()
            .unwrap()
            .code,
        ExtensionHostFailureKind::AuthorityDenied
    );
    manager
        .uninstall(ash_core_plugins::UninstallPackageRequest {
            installation_id: installed.installation_id,
            mode: ash_core_plugins::UninstallMode::IfUnused,
        })
        .unwrap();
    assert!(
        runtime
            .reconcile(super::ExtensionHostReconcileMode::Refresh)
            .unwrap()
            .extensions
            .is_empty()
    );
}

#[test]
fn terminal_completion_and_quick_fix_operations_are_capability_scoped() {
    let completion = RegistrationKind::TerminalCompletionProvider {
        trigger_characters: vec!["-".into()],
    };
    let fix = RegistrationKind::TerminalQuickFixProvider {
        provider_id: "acme.fix".into(),
    };
    assert!(registration_allows_operation(
        &completion,
        "provideTerminalCompletions"
    ));
    assert!(registration_allows_operation(
        &fix,
        "provideTerminalQuickFixes"
    ));
    assert!(registration_allows_operation(
        &fix,
        "handleTerminalQuickFix"
    ));
    for operation in [
        "inputTaskTerminal",
        "execute",
        "createTerminalProfile",
        "provideTerminalLinks",
    ] {
        assert!(!registration_allows_operation(&completion, operation));
        assert!(!registration_allows_operation(&fix, operation));
    }
    assert!(!registration_allows_operation(
        &completion,
        "provideTerminalQuickFixes"
    ));
    assert!(!registration_allows_operation(
        &fix,
        "provideTerminalCompletions"
    ));
}
