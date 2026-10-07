use super::*;

fn plugin(id: &str, action: DiscoveryAction) -> DiscoverableCapability {
    DiscoverableCapability::Plugin(DiscoverablePluginInfo {
        id: CapabilityDiscoveryId::new(id).unwrap(),
        display_name: id.into(),
        description: "catalog-only Plugin candidate".into(),
        contributions: DiscoverableContributionKinds {
            tools: true,
            ..DiscoverableContributionKinds::default()
        },
        action,
    })
}

#[test]
fn snapshot_sorts_filters_and_freezes_typed_requests() {
    let snapshot = CapabilityDiscoverySnapshot::new(
        7,
        vec![
            plugin("publisher/ash", DiscoveryAction::Enable),
            plugin("publisher/alpha", DiscoveryAction::Install),
        ],
    )
    .unwrap();
    let visible = snapshot
        .visible_to(DiscoveryClientCapabilities {
            install_plugins: true,
            enable_plugins: false,
            connect_accounts: false,
        })
        .map(|candidate| candidate.id().as_str())
        .collect::<Vec<_>>();

    assert_eq!(visible, vec!["publisher/alpha"]);
    assert_eq!(
        snapshot
            .request(&CapabilityDiscoveryId::new("publisher/alpha").unwrap())
            .unwrap(),
        CapabilityDiscoveryRequest {
            snapshot_generation: 7,
            candidate_id: CapabilityDiscoveryId::new("publisher/alpha").unwrap(),
            action: DiscoveryAction::Install,
        }
    );
}

#[test]
fn snapshot_rejects_duplicate_candidate_identity() {
    let error = CapabilityDiscoverySnapshot::new(
        1,
        vec![
            plugin("publisher/ash", DiscoveryAction::Install),
            plugin("publisher/ash", DiscoveryAction::Enable),
        ],
    )
    .unwrap_err();

    assert!(error.to_string().contains("duplicate"));
}
