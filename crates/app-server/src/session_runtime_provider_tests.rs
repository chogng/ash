use super::*;

fn no_runtime(
    _: Arc<SessionRuntimeProvider>,
    _: &SessionExecutionTarget,
    _: PathBuf,
    _: &CancellationToken,
) -> Result<(), String> {
    Err("runtime is unavailable".into())
}

#[test]
fn absent_runtime_is_optional_and_unadmitted_targets_cannot_launch() {
    let profile = tempfile::tempdir().unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap(),
    );
    let runtime = SessionRuntimeProvider::open(profile.path(), policy, None, no_runtime).unwrap();
    assert!(matches!(
        runtime
            .invoke(
                PROVIDER_ID,
                SessionRuntimeRequest::Probe {
                    workspace: profile.path().into()
                },
                &ash_async_utils::CancellationSource::new().token()
            )
            .unwrap(),
        SessionRuntimeResult::Availability { available: false }
    ));
    let target = SessionExecutionTarget::Provider {
        provider_id: PROVIDER_ID.into(),
        workspace: profile.path().into(),
        root: "/workspace".into(),
    };
    assert!(runtime.executable(&target).is_err());
    assert!(!runtime.is_admitted(&target));
    assert!(runtime.targets().is_empty());
}

#[test]
fn persisted_provider_targets_are_validated_and_disable_revokes_routes() {
    let profile = tempfile::tempdir().unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap(),
    );
    let target = SessionExecutionTarget::Provider {
        provider_id: PROVIDER_ID.into(),
        workspace: profile.path().into(),
        root: "/workspace".into(),
    };
    std::fs::write(
        profile.path().join("session-runtime-targets.json"),
        serde_json::to_vec(&vec![RuntimeTarget::Ready {
            target: target.clone(),
        }])
        .unwrap(),
    )
    .unwrap();
    let runtime =
        SessionRuntimeProvider::open(profile.path(), policy.clone(), None, no_runtime).unwrap();
    assert!(runtime.is_admitted(&target));
    policy
        .set_built_in_enablement(
            PROVIDER_ID,
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            1,
        )
        .unwrap();
    assert!(!runtime.is_admitted(&target));
    assert!(runtime.targets().is_empty());
    std::fs::write(profile.path().join("session-runtime-targets.json"), b"[{\"type\":\"provider\",\"providerId\":\"other\",\"workspace\":\"relative\",\"root\":\"/\"}]").unwrap();
    assert!(SessionRuntimeProvider::open(profile.path(), policy, None, no_runtime).is_err());
}
