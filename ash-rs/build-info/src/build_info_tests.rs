#[test]
fn reports_supplied_identity_consistently() {
    let commit = "0123456789012345678901234567890123456789";
    let info = super::BuildInfo::new(Some(commit), None);
    assert_eq!(info, super::BuildInfo::new(Some(commit), None));
    assert_eq!(info.version, super::VERSION);
    assert!(!info.target.is_empty());
    assert_eq!(info.commit.as_deref(), Some(commit));
    assert!(info.build_id.as_deref().unwrap().starts_with("sha256:"));
    assert_eq!(info.target, super::TARGET);
    let json = serde_json::to_value(info).unwrap();
    assert!(json.get("buildId").is_some());
}

#[test]
fn explicit_build_id_takes_precedence_over_git_identity() {
    let info = super::BuildInfo::new(
        Some("0123456789012345678901234567890123456789"),
        Some("release"),
    );
    assert_eq!(info.build_id.as_deref(), Some("release"));
    assert_eq!(super::BuildInfo::new(None, None).build_id, None);
}
