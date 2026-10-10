use super::WorkspaceReadAccess;
use super::plugin_deployments;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_plugin::LocalPluginPackage;

#[test]
fn local_vscode_package_waits_for_manifest_activation_and_revocation_retires_authority() {
    for valid_activation in [true, false] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
        std::fs::write(root.path().join(".ash-plugin/plugin.json"), serde_json::json!({
            "schemaVersion": 1, "id": "acme/standard", "version": "1.0.0", "displayName": "Standard",
            "compatibility": {"ash": ">=0.1.0"}, "permissions": [],
            "contributions": {"editorExtensions": [{"id": "tasks", "runtime": "javascript", "api": "vscode",
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
                "vscode"
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
    std::fs::write(
        root.path().join(".ash-plugin/plugin.json"),
        include_bytes!("../../../../../sdk/typescript/example/.ash-plugin/plugin.json"),
    )
    .unwrap();
    std::fs::write(
        root.path().join("example/extension.js"),
        "export function activate() {}",
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
    assert_eq!(deployment.id, "ash/sdk-example:inspect");
    assert!(deployment.command.executable().ends_with(format!(
        "ash-external-js-ext{}",
        std::env::consts::EXE_SUFFIX
    )));
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
            "ash/sdk-example:inspect",
            "--package",
            deployment.command.working_directory().to_str().unwrap(),
            "--entry",
            "example/extension.js"
        ]
    );
    assert!(deployment.workspace_read == WorkspaceReadAccess::Read);
    assert!(deployment.authority.authorizes());
    assert!(deployment.scope == super::EditorExtensionScope::Profile);
    // Remote JS activation is package-granted; workspace reads still use each invocation's filesystem.
    assert!(
        super::super::authority::prepare_extension(
            None,
            deployment,
            std::num::NonZeroU64::new(1).unwrap()
        )
        .is_ok()
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
fn sdk_task_and_debug_packages_wait_for_their_declared_activation_event() {
    for (event, capability, expected) in [
        (
            serde_json::json!({"type": "onTaskType", "taskType": "build"}),
            "taskProvider",
            "onTaskType:build",
        ),
        (
            serde_json::json!({"type": "onDemand", "capability": "debugAdapter"}),
            "debugAdapter",
            "onDemand:debugAdapter",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../../../sdk/typescript/example/.ash-plugin/plugin.json"
        ))
        .unwrap();
        let contribution = &mut manifest["contributions"]["editorExtensions"][0];
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
            "export function activate() {}",
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
