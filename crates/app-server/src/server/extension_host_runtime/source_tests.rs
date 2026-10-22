use super::WorkspaceReadAccess;
use super::plugin_deployments;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_plugin::LocalPluginPackage;

#[test]
fn product_git_activation_does_not_wait_for_workbench_restoration() {
    let root = tempfile::tempdir().unwrap();
    let deployment = super::product_git_deployment(root.path()).unwrap();
    let activation = deployment.activation.as_ref().unwrap();
    assert!(activation.events.iter().any(|event| event == "*"));
    assert_eq!(deployment.params.activation_events, activation.events);
    assert!(activation.matches(&super::ActivationEvent::Command("git.refresh".into())));
}

#[test]
fn local_ash_package_waits_for_manifest_activation_and_revocation_retires_authority() {
    for valid_activation in [true, false] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
        std::fs::write(root.path().join(".ash-plugin/plugin.json"), serde_json::json!({
            "schemaVersion": 1, "id": "acme/standard", "version": "1.0.0", "displayName": "Standard",
            "compatibility": {"ash": ">=0.1.0"}, "permissions": [],
            "contributions": {"editorExtensions": [{"id": "tasks", "runtime": "javascript", "api": "ash",
                "entrypoint": "extension.cjs", "runtimeApiVersion": 1,
                "activationEvents": [{"type": "onCommand", "id": "acme.run"}], "capabilities": ["command", "taskProvider"]}]}
        }).to_string()).unwrap();
        std::fs::write(
            root.path().join("extension.cjs"),
            "exports.activate = () => {};",
        )
        .unwrap();
        std::fs::write(root.path().join("package.json"), serde_json::json!({
            "name": "standard", "publisher": "acme", "version": "1.0.0", "main": "./extension.cjs",
            "activationEvents": if valid_activation { serde_json::json!([]) } else { serde_json::json!(7) },
            "contributes": {"commands": [{"command": "acme.run", "title": "Run standard task"}],
                "taskDefinitions": [{"type": "builder", "required": [], "properties": {}}]}
        }).to_string()).unwrap();
        let package = LocalPluginPackage::load(root.path()).unwrap();
        let store_root = tempfile::tempdir().unwrap();
        let authority = PluginActivationAuthority::in_memory(
            PluginPackageStore::open(store_root.path()).unwrap(),
        )
        .unwrap();
        let installed = authority
            .install_local(
                PluginAuthorityCommandId::new("install").unwrap(),
                0,
                &package,
            )
            .unwrap()
            .package;
        assert!(
            plugin_deployments(&authority)
                .unwrap()
                .deployments
                .is_empty()
        );
        for (revision, id, command) in [
            (
                1,
                "enable",
                PluginAuthorityCommand::Enable {
                    package: installed.clone(),
                },
            ),
            (
                2,
                "grant",
                PluginAuthorityCommand::Grant {
                    package: installed.clone(),
                },
            ),
        ] {
            authority
                .apply(PluginAuthorityCommandRequest {
                    command_id: PluginAuthorityCommandId::new(id).unwrap(),
                    expected_revision: revision,
                    command,
                })
                .unwrap();
            if id == "enable" {
                assert!(
                    plugin_deployments(&authority)
                        .unwrap()
                        .deployments
                        .is_empty()
                );
            }
        }
        let snapshot = plugin_deployments(&authority).unwrap();
        let deployment = &snapshot.deployments[0];
        assert_eq!(deployment.id, "acme/standard:tasks");
        let arguments: Vec<_> = deployment
            .command
            .arguments()
            .iter()
            .map(|argument| argument.to_str().unwrap())
            .collect();
        assert_eq!(
            arguments,
            [
                "--extension-id",
                "acme/standard:tasks",
                "--package",
                deployment.command.working_directory().to_str().unwrap(),
                "--entry",
                "extension.cjs",
                "--api",
                "ash"
            ]
        );
        assert!(deployment.workspace_read == WorkspaceReadAccess::Denied);
        assert!(deployment.authority.authorizes());
        if valid_activation {
            let activation = deployment.activation.as_ref().unwrap();
            assert_eq!(
                activation.commands,
                [("acme.run".into(), "Run standard task".into())]
            );
            assert_eq!(
                activation.events,
                ["onCommand:acme.run", "onTaskType:builder"]
            );
            assert_eq!(deployment.params.activation_events, activation.events);
            assert!(deployment.activation_failure.is_none());
        } else {
            assert!(deployment.activation.is_none());
            assert_eq!(
                deployment.activation_failure.as_deref(),
                Some("invalid activation events")
            );
        }
        authority
            .apply(PluginAuthorityCommandRequest {
                command_id: PluginAuthorityCommandId::new("revoke").unwrap(),
                expected_revision: 3,
                command: PluginAuthorityCommand::RevokeGrant { package: installed },
            })
            .unwrap();
        assert!(!deployment.authority.authorizes());
        assert!(
            plugin_deployments(&authority)
                .unwrap()
                .deployments
                .is_empty()
        );
    }
}

#[test]
fn effective_javascript_package_launches_product_host_with_exact_identity_and_read_ceiling() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
    std::fs::create_dir_all(root.path().join("example")).unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(
        root.path().join(".ash-plugin/plugin.json"),
        include_bytes!("../../../../../examples/extensions/inspect/.ash-plugin/plugin.json"),
    )
    .unwrap();
    std::fs::write(
        root.path().join("dist/extension.js"),
        "exports.activate = () => {};",
    )
    .unwrap();
    std::fs::write(
        root.path().join("package.json"),
        include_bytes!("../../../../../examples/extensions/inspect/package.json"),
    )
    .unwrap();
    let package = LocalPluginPackage::load(root.path()).unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let store = PluginPackageStore::open(store_root.path()).unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    let installed = authority
        .install_local(
            PluginAuthorityCommandId::new("install").unwrap(),
            0,
            &package,
        )
        .unwrap()
        .package;
    assert!(
        plugin_deployments(&authority)
            .unwrap()
            .deployments
            .is_empty()
    );
    for (revision, id, command) in [
        (
            1,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ),
        (
            2,
            "enable",
            PluginAuthorityCommand::Enable { package: installed },
        ),
    ] {
        authority
            .apply(PluginAuthorityCommandRequest {
                command_id: PluginAuthorityCommandId::new(id).unwrap(),
                expected_revision: revision,
                command,
            })
            .unwrap();
    }
    let snapshot = plugin_deployments(&authority).unwrap();
    assert_eq!(snapshot.deployments.len(), 1);
    let deployment = &snapshot.deployments[0];
    assert_eq!(deployment.id, "ash/inspect-example:inspect");
    assert!(deployment.command.is_node_host());
    assert_eq!(deployment.command.executable(), None);
    let arguments: Vec<_> = deployment
        .command
        .arguments()
        .iter()
        .map(|argument| argument.to_str().unwrap())
        .collect();
    assert_eq!(
        arguments,
        [
            "--extension-id",
            "ash/inspect-example:inspect",
            "--package",
            deployment.command.working_directory().to_str().unwrap(),
            "--entry",
            "dist/extension.js",
            "--api",
            "ash"
        ]
    );
    assert!(deployment.workspace_read == WorkspaceReadAccess::Read);
    assert!(deployment.authority.authorizes());
    assert!(deployment.scope == super::EditorExtensionScope::Workspace);
    // A document provider cannot activate without the requesting workspace's grant.
    assert!(
        super::super::authority::prepare_extension(
            None,
            deployment,
            std::num::NonZeroU64::new(1).unwrap()
        )
        .is_err()
    );
}

#[test]
fn task_and_debug_activation_match_only_the_requested_type_and_phase() {
    use super::ActivationEvent;
    use super::ActivationPlan;
    use super::DebugActivationPhase;

    let tasks = ActivationPlan {
        events: vec!["onTaskType:build".into()],
        commands: vec![],
    };
    assert!(tasks.matches(&ActivationEvent::TaskType(Some("build".into()))));
    assert!(!tasks.matches(&ActivationEvent::TaskType(Some("test".into()))));
    assert!(!tasks.matches(&ActivationEvent::TaskType(None)));
    let generic = ActivationPlan {
        events: vec!["onTaskType".into()],
        commands: vec![],
    };
    assert!(generic.matches(&ActivationEvent::TaskType(None)));
    let debug = ActivationPlan {
        events: vec!["onDebugResolve:node".into()],
        commands: vec![],
    };
    assert!(debug.matches(&ActivationEvent::Debug {
        phase: DebugActivationPhase::ResolveConfiguration,
        debug_type: Some("node".into())
    }));
    assert!(!debug.matches(&ActivationEvent::Debug {
        phase: DebugActivationPhase::DynamicConfigurations,
        debug_type: Some("node".into())
    }));
    assert!(!debug.matches(&ActivationEvent::Debug {
        phase: DebugActivationPhase::ResolveConfiguration,
        debug_type: Some("python".into())
    }));
    let generic = ActivationPlan {
        events: vec!["onDebugInitialConfigurations".into()],
        commands: vec![],
    };
    assert!(generic.matches(&ActivationEvent::Debug {
        phase: DebugActivationPhase::InitialConfigurations,
        debug_type: None
    }));
    let legacy = ActivationPlan {
        events: vec!["onDebugType:node".into()],
        commands: vec![],
    };
    assert!(legacy.matches(&ActivationEvent::Debug {
        phase: DebugActivationPhase::Start,
        debug_type: Some("node".into())
    }));
}

#[test]
fn standard_task_and_debug_packages_wait_for_their_declared_activation_event() {
    for (event, capability, expected) in [
        (
            serde_json::json!({"type": "onTaskType", "taskType": "build"}),
            "taskProvider",
            "onTaskType:build",
        ),
        (
            serde_json::json!({"type": "onDemand", "capability": "debugAdapter"}),
            "debugAdapter",
            "onDebug",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../../../examples/extensions/inspect/.ash-plugin/plugin.json"
        ))
        .unwrap();
        let contribution = &mut manifest["contributions"]["editorExtensions"][0];
        // Keep coverage for installed providers while these capabilities await Ash SDK migration.
        contribution["api"] = "ash".into();
        contribution["entrypoint"] = "extension.js".into();
        contribution["activationEvents"] = serde_json::json!([event]);
        contribution["capabilities"] = serde_json::json!([capability]);
        std::fs::write(
            root.path().join(".ash-plugin/plugin.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.path().join("extension.js"),
            "exports.activate = () => {};",
        )
        .unwrap();
        std::fs::write(
            root.path().join("package.json"),
            serde_json::json!({
                "name": "fixture", "publisher": "ash", "version": "1.0.0", "main": "extension.js",
                "activationEvents": [expected], "contributes": {}
            })
            .to_string(),
        )
        .unwrap();
        let package = LocalPluginPackage::load(root.path()).unwrap();
        let store_root = tempfile::tempdir().unwrap();
        let authority = PluginActivationAuthority::in_memory(
            PluginPackageStore::open(store_root.path()).unwrap(),
        )
        .unwrap();
        let installed = authority
            .install_local(
                PluginAuthorityCommandId::new("install").unwrap(),
                0,
                &package,
            )
            .unwrap()
            .package;
        for (revision, id, command) in [
            (
                1,
                "grant",
                PluginAuthorityCommand::Grant {
                    package: installed.clone(),
                },
            ),
            (
                2,
                "enable",
                PluginAuthorityCommand::Enable { package: installed },
            ),
        ] {
            authority
                .apply(PluginAuthorityCommandRequest {
                    command_id: PluginAuthorityCommandId::new(id).unwrap(),
                    expected_revision: revision,
                    command,
                })
                .unwrap();
        }
        let snapshot = plugin_deployments(&authority).unwrap();
        assert_eq!(snapshot.deployments.len(), 1);
        let activation = snapshot.deployments[0]
            .activation
            .as_ref()
            .expect("domain packages must remain dormant until first use");
        assert_eq!(activation.events, [expected]);
        assert!(activation.commands.is_empty());
    }
}

#[test]
fn wildcard_activation_matches_the_first_window_bound_startup_event() {
    let plan = super::ActivationPlan {
        events: vec!["*".into()],
        commands: Vec::new(),
    };
    assert!(plan.matches(&super::ActivationEvent::StartupFinished));
    assert!(plan.matches(&super::ActivationEvent::Command("early.command".into())));
}

#[test]
fn terminal_link_demand_activation_cannot_activate_an_unrelated_capability() {
    let plan = super::ActivationPlan {
        events: vec!["onDemand:terminalLinkProvider".into()],
        commands: Vec::new(),
    };
    assert!(plan.matches(&super::ActivationEvent::Capability(
        "terminalLinkProvider".into()
    )));
    assert!(!plan.matches(&super::ActivationEvent::Capability(
        "terminalProfileProvider".into()
    )));
    assert!(!plan.matches(&super::ActivationEvent::Command(
        "terminalLinkProvider".into()
    )));
}

#[test]
fn terminal_profile_activation_matches_declared_identity_and_demand_capability() {
    use super::ActivationEvent;
    use super::ActivationPlan;

    let declared = ActivationPlan {
        events: vec!["onTerminalProfile:acme.shell".into()],
        commands: vec![],
    };
    assert!(declared.matches(&ActivationEvent::TerminalProfile("acme.shell".into())));
    assert!(!declared.matches(&ActivationEvent::TerminalProfile("other.shell".into())));
    assert!(!declared.matches(&ActivationEvent::TaskType(None)));
    let demand = ActivationPlan {
        events: vec!["onDemand:terminalProfileProvider".into()],
        commands: vec![],
    };
    assert!(demand.matches(&ActivationEvent::TerminalProfile("acme.shell".into())));
    assert!(!demand.matches(&ActivationEvent::Command("acme.shell".into())));
}

#[test]
fn speech_activation_uses_only_its_declared_provider_owner() {
    use super::ActivationEvent;
    use super::ActivationPlan;
    for declaration in ["onSpeech", "onDemand:speechProvider"] {
        let plan = ActivationPlan {
            events: vec![declaration.into()],
            commands: vec![],
        };
        assert!(plan.matches(&ActivationEvent::Speech));
        assert!(!plan.matches(&ActivationEvent::Command("speech".into())));
        assert!(!plan.matches(&ActivationEvent::TaskType(None)));
    }
    let plan = ActivationPlan {
        events: vec!["onLanguage:typescript".into()],
        commands: vec![],
    };
    assert!(!plan.matches(&ActivationEvent::Speech));
}

#[test]
fn debug_workflow_deployments_use_public_capabilities_and_separate_authority() {
    let directory = tempfile::tempdir().unwrap();
    let javascript = super::product_debug_workflow_deployment(
        directory.path(),
        "debug-javascript",
        include_str!("../../../../../extensions/debug-javascript/package.json"),
        "javascript-sources",
    )
    .unwrap();
    let server_ready = super::product_debug_workflow_deployment(
        directory.path(),
        "debug-server-ready",
        include_str!("../../../../../extensions/debug-server-ready/package.json"),
        "server-ready-sources",
    )
    .unwrap();
    assert_eq!(javascript.id, "ash.debug-javascript");
    // Startup must stay within the external process quota even when the host has
    // a large developer environment; only OS helper lookup facts are transferred.
    assert!(javascript.command.environment().len() <= 12);
    assert!(
        !javascript
            .command
            .environment()
            .contains_key(std::ffi::OsStr::new("OPENAI_API_KEY"))
    );
    assert_eq!(server_ready.id, "ash.debug-server-ready");
    assert_ne!(javascript.package_digest, server_ready.package_digest);
    assert_eq!(
        javascript.params.capabilities,
        [
            ash_external_ext::ExtensionCapability::DebugAdapter,
            ash_external_ext::ExtensionCapability::TerminalProfileProvider,
            ash_external_ext::ExtensionCapability::Command,
            ash_external_ext::ExtensionCapability::StatusBar
        ]
    );
    assert_eq!(
        server_ready.params.capabilities,
        [ash_external_ext::ExtensionCapability::DebugAdapter]
    );
    for deployment in [&javascript, &server_ready] {
        assert!(matches!(
            deployment.workspace_read,
            WorkspaceReadAccess::Denied
        ));
        assert!(deployment.backend_channels.is_empty());
        assert!(deployment.credential_providers.is_empty());
    }
    assert!(
        javascript
            .activation
            .as_ref()
            .unwrap()
            .events
            .contains(&"onStartupFinished".into())
    );
    assert_eq!(
        javascript.activation.as_ref().unwrap().commands,
        [(
            "ash.debug-javascript.toggleAutoAttach".into(),
            "%command.toggleAutoAttach%".into()
        )]
    );
    assert_eq!(
        server_ready.activation.as_ref().unwrap().events,
        ["onDebug"]
    );
}
