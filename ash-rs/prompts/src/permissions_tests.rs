use super::*;

#[test]
fn approval_modes_select_distinct_versioned_assets_without_changing_the_action_rules() {
    let modes = [
        (ApprovalMode::Manual, "manual", "permissions/approval/ask"),
        (
            ApprovalMode::Auto,
            "auto",
            "permissions/approval/auto-review",
        ),
        (
            ApprovalMode::BypassPermissions,
            "bypassPermissions",
            "permissions/approval/bypass",
        ),
    ];
    for (mode, label, identity) in modes {
        let [actions, approval] = permissions_instructions(mode);
        assert_eq!(actions, ACTION_PERMISSIONS);
        assert_eq!(approval.id(), identity);
        assert!(approval.body().contains(&format!("`{label}`")));
        for asset in [actions, approval] {
            asset.freeze().validate().unwrap();
            assert!(!asset.body().contains("sandbox_permissions"));
            assert!(!asset.body().contains("prefix_rule"));
        }
    }
}
