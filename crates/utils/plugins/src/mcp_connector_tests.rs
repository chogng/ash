use super::plugin_mcp_server_id;
use crate::PluginPackageId;

#[test]
fn routing_identity_preserves_publisher_and_contribution_without_lossy_sanitization() {
    assert_eq!(
        plugin_mcp_server_id(&PluginPackageId::new("acme/code-review").unwrap(), "review"),
        "plugin:acme/code-review:mcp:review"
    );
    assert_ne!(
        plugin_mcp_server_id(
            &PluginPackageId::new("other/code-review").unwrap(),
            "review"
        ),
        plugin_mcp_server_id(&PluginPackageId::new("acme/code-review").unwrap(), "review")
    );
}
