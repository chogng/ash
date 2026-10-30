//! Exercises the product adapter with the actual Cargo-built Provider and the SDK transport.
#[path = "../../../crates/app-server/src/session_runtime_provider.rs"]
mod host;

#[path = "support/bootstrap.rs"]
mod bootstrap;

use ash_async_utils::CancellationSource;
use ash_core_plugins::EditorExtensionPolicy;
use ash_core_plugins::EditorExtensionPolicyAction;
use ash_protocol::SessionRuntimeRequest;
use ash_protocol::SessionRuntimeResult;
use std::collections::BTreeMap;
use std::sync::Arc;

#[test]
fn real_provider_registration_roundtrip_authorization_and_release() {
    let profile = tempfile::tempdir().unwrap();
    let policy = Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
    let installation = host::SessionRuntimeInstallation {
        executable: env!("CARGO_BIN_EXE_ash-dev-container-provider").into(),
        environment: BTreeMap::new(),
    };
    let runtime = host::SessionRuntimeProvider::open(
        profile.path(),
        policy.clone(),
        Some(installation),
        readiness,
    )
    .unwrap();
    let source = CancellationSource::new();
    let token = source.token();
    for _ in 0..2 {
        assert!(matches!(
            runtime
                .invoke(
                    "ash.dev-containers",
                    SessionRuntimeRequest::Probe {
                        workspace: profile.path().into()
                    },
                    &token
                )
                .unwrap(),
            SessionRuntimeResult::Availability { available: false }
        ));
    }
    assert!(
        runtime
            .invoke(
                "other.provider",
                SessionRuntimeRequest::Probe {
                    workspace: profile.path().into()
                },
                &token
            )
            .is_err()
    );
    assert!(
        runtime
            .invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Prepare {
                    workspace: profile.path().into()
                },
                &token
            )
            .is_err()
    );
    let cancelled = CancellationSource::new();
    cancelled.cancel();
    assert!(
        runtime
            .invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Probe {
                    workspace: profile.path().into()
                },
                &cancelled.token()
            )
            .is_err()
    );
    assert!(runtime.environment().is_empty());
    let _installation = host::product_installation();
    policy
        .set_built_in_enablement(
            "ash.dev-containers",
            EditorExtensionPolicyAction::Disable,
            1,
        )
        .unwrap();
    assert!(matches!(
        runtime
            .invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Probe {
                    workspace: profile.path().into()
                },
                &token
            )
            .unwrap(),
        SessionRuntimeResult::Availability { available: false }
    ));
    assert!(runtime.targets().is_empty());
    drop(runtime); // Supervisor closes/reaps the real child even when activation was disabled.
}

#[test]
fn actual_provider_prepares_and_retires_a_target_using_owned_tool_processes() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = profile.path().join("project");
    std::fs::create_dir_all(workspace.join(".devcontainer")).unwrap();
    std::fs::write(workspace.join(".devcontainer/devcontainer.json"), "{}").unwrap();
    let log = profile.path().join("docker.log");
    let cli = tool(
        profile.path(),
        "devcontainer",
        if cfg!(windows) {
            "@echo off\r\nif \"%1\"==\"up\" (echo {\"outcome\":\"success\",\"containerId\":\"0123456789012345678901234567890123456789012345678901234567890123\",\"remoteWorkspaceFolder\":\"/workspace\"}) else (echo {\"version\":\"test\"})\r\n"
        } else {
            "#!/bin/sh\nif [ \"$1\" = up ]; then printf '%s\\n' '{\"outcome\":\"success\",\"containerId\":\"0123456789012345678901234567890123456789012345678901234567890123\",\"remoteWorkspaceFolder\":\"/workspace\"}'; else printf '%s\\n' '{\"version\":\"test\"}'; fi\n"
        },
    );
    let docker_source = if cfg!(windows) {
        format!(
            "@echo off\r\necho %* >> \"{}\"\r\nif \"%1\"==\"ps\" echo 0123456789012345678901234567890123456789012345678901234567890123\r\nexit /b 0\r\n",
            log.display()
        )
    } else {
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = ps ]; then printf '%s\\n' 0123456789012345678901234567890123456789012345678901234567890123; fi\n",
            log.display()
        )
    };
    let docker = tool(profile.path(), "docker", &docker_source);
    let policy = Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
    let mut environment = BTreeMap::new();
    for key in ["PATH", "SystemRoot", "COMSPEC", "TEMP"] {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    environment.insert("ASH_DEVCONTAINER_CLI".into(), cli.into_os_string());
    environment.insert("ASH_DOCKER_PATH".into(), docker.clone().into_os_string());
    let runtime = host::SessionRuntimeProvider::open(
        profile.path(),
        policy,
        Some(host::SessionRuntimeInstallation {
            executable: env!("CARGO_BIN_EXE_ash-dev-container-provider").into(),
            environment,
        }),
        readiness,
    )
    .unwrap();
    let source = CancellationSource::new();
    let target = match runtime
        .invoke(
            "ash.dev-containers",
            SessionRuntimeRequest::Prepare {
                workspace: workspace.clone(),
            },
            &source.token(),
        )
        .unwrap()
    {
        SessionRuntimeResult::Target { target } => target,
        other => panic!("unexpected preparation: {other:?}"),
    };
    assert!(runtime.is_admitted(&target));
    let canonical = dunce::canonicalize(&workspace).unwrap();
    assert_eq!(runtime.targets(), vec![target.clone()]);
    std::fs::remove_file(workspace.join(".devcontainer/devcontainer.json")).unwrap();
    assert!(matches!(
        runtime
            .invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Stop {
                    workspace: canonical.clone()
                },
                &source.token()
            )
            .unwrap(),
        SessionRuntimeResult::Released
    ));
    assert!(runtime.targets().is_empty());
    assert!(!runtime.is_admitted(&target));
    assert!(runtime.executable(&target).is_err());
    // A profile restart must preserve removal authorization without reviving stopped routes.
    drop(runtime);
    let policy = Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
    let mut environment = BTreeMap::new();
    for key in ["PATH", "SystemRoot", "COMSPEC", "TEMP"] {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    environment.insert("ASH_DOCKER_PATH".into(), docker.into_os_string());
    let runtime = host::SessionRuntimeProvider::open(
        profile.path(),
        policy,
        Some(host::SessionRuntimeInstallation {
            executable: env!("CARGO_BIN_EXE_ash-dev-container-provider").into(),
            environment,
        }),
        readiness,
    )
    .unwrap();
    assert!(!runtime.is_admitted(&target));
    assert!(
        matches!(runtime.invoke("ash.dev-containers", SessionRuntimeRequest::List, &source.token()).unwrap(), SessionRuntimeResult::Targets { targets } if targets == vec![target.clone()])
    );
    assert!(matches!(
        runtime
            .invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Remove {
                    workspace: canonical
                },
                &source.token()
            )
            .unwrap(),
        SessionRuntimeResult::Released
    ));
    assert!(runtime.targets().is_empty());
    let commands = std::fs::read_to_string(log).unwrap();
    assert!(commands.contains("ps --all --quiet --no-trunc --filter"));
    assert!(commands.contains("stop --time 10 012345678901"));
    assert!(commands.contains("rm 012345678901"));
}

fn tool(directory: &std::path::Path, name: &str, source: &str) -> std::path::PathBuf {
    let path = directory.join(format!(
        "{name}.{}",
        if cfg!(windows) { "cmd" } else { "sh" }
    ));
    std::fs::write(&path, source).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

#[test]
fn cancelling_a_running_build_releases_its_tool_process_tree() {
    let profile = tempfile::tempdir().unwrap();
    let workspace = profile.path().join("project");
    std::fs::create_dir_all(workspace.join(".devcontainer")).unwrap();
    std::fs::write(workspace.join(".devcontainer/devcontainer.json"), "{}").unwrap();
    let started = profile.path().join("started");
    let script = if cfg!(windows) {
        format!(
            "@echo off\r\necho started > \"{}\"\r\nping -n 120 127.0.0.1 > nul\r\n",
            started.display()
        )
    } else {
        format!(
            "#!/bin/sh\nprintf started > '{}'\nsleep 120\n",
            started.display()
        )
    };
    let cli = tool(profile.path(), "slow-devcontainer", &script);
    let policy = Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
    let mut environment = BTreeMap::new();
    for key in ["PATH", "SystemRoot", "COMSPEC", "TEMP"] {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    environment.insert("ASH_DEVCONTAINER_CLI".into(), cli.into_os_string());
    let runtime = host::SessionRuntimeProvider::open(
        profile.path(),
        policy,
        Some(host::SessionRuntimeInstallation {
            executable: env!("CARGO_BIN_EXE_ash-dev-container-provider").into(),
            environment,
        }),
        readiness,
    )
    .unwrap();
    let source = CancellationSource::new();
    let token = source.token();
    std::thread::scope(|scope| {
        let request = scope.spawn(|| {
            runtime.invoke(
                "ash.dev-containers",
                SessionRuntimeRequest::Prepare { workspace },
                &token,
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !started.is_file() {
            assert!(
                std::time::Instant::now() < deadline,
                "the real Provider never launched its tool"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        source.cancel();
        assert!(request.join().unwrap().is_err());
        assert!(
            std::time::Instant::now() < deadline,
            "cancellation waited for the build to finish"
        );
    });
    assert!(runtime.targets().is_empty());
}

fn readiness(
    runtime: Arc<host::SessionRuntimeProvider>,
    target: &ash_protocol::SessionExecutionTarget,
    executable: std::path::PathBuf,
    token: &ash_async_utils::CancellationToken,
) -> Result<(), String> {
    // These SDK process tests isolate provisioning. The owning gateway tests exercise the
    // real protocol probe; this seam verifies admission cannot precede readiness completion.
    assert!(!runtime.is_admitted(target));
    assert!(executable.is_file());
    token.check().map_err(|error| error.to_string())
}
