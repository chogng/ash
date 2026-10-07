use super::MarketplaceName;
use super::PluginId;

#[test]
fn plugin_identity_keeps_name_and_source_without_requiring_a_publisher() {
    for value in ["review@team", "acme.review@official", "My_Plugin@team-2"] {
        let id = PluginId::parse(value).unwrap();
        assert_eq!(id.to_string(), value);
        assert_eq!(
            serde_json::from_str::<PluginId>(&serde_json::to_string(&id).unwrap()).unwrap(),
            id
        );
    }
    assert_ne!(
        PluginId::parse("review@team").unwrap(),
        PluginId::parse("review@third-party").unwrap()
    );
    let id = PluginId::new("review", MarketplaceName::new("team").unwrap()).unwrap();
    assert_eq!(id.plugin_name(), "review");
    assert_eq!(id.marketplace().as_str(), "team");
}

#[test]
fn plugin_identity_rejects_ambiguous_or_unsafe_segments_at_every_boundary() {
    for value in [
        "review",
        "@team",
        "review@",
        "review@a@b",
        "a/b@team",
        "..@team",
        ".hidden@team",
        "review.@team",
        "a..b@team",
        "a\\b@team",
        "a b@team",
        "a@../team",
        "a@team.name",
        "插件@team",
        "a@team\n",
    ] {
        assert!(PluginId::parse(value).is_err(), "{value:?}");
        assert!(serde_json::from_str::<PluginId>(&serde_json::to_string(value).unwrap()).is_err());
    }
    assert!(PluginId::new("a".repeat(129), MarketplaceName::new("team").unwrap()).is_err());
    assert!(MarketplaceName::new("a".repeat(129)).is_err());
}

#[test]
fn complete_identity_fits_contribution_runtime_limits() {
    let name = "p".repeat(128);
    let id = PluginId::new(&name, MarketplaceName::new("m".repeat(31)).unwrap()).unwrap();
    assert_eq!(id.to_string().len(), 160);
    let oversized = format!("{id}m");
    assert!(PluginId::parse(&oversized).is_err());
    assert!(serde_json::from_str::<PluginId>(&serde_json::to_string(&oversized).unwrap()).is_err());
    assert!(PluginId::new(name, MarketplaceName::new("m".repeat(32)).unwrap()).is_err());
}
