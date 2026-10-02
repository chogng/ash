use super::*;

fn write_connection(home: &std::path::Path, token: &str, expires_at: u64) {
    fs::create_dir_all(home.join("credentials")).unwrap();
    fs::write(home.join("device_id"), "test-device").unwrap();
    fs::write(
        home.join("config.toml"),
        r#"[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0123456789abcdef"
"#,
    )
    .unwrap();
    fs::write(home.join("credentials/kimi-code-env-0123456789abcdef.json"),
        serde_json::json!({"access_token":token,"refresh_token":"rotating-secret","expires_at":expires_at,"token_type":"Bearer"}).to_string()).unwrap();
}

#[test]
fn cli_connection_reads_the_configured_slot_and_observes_rotation_and_expiry() {
    let directory = tempfile::tempdir().unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    write_connection(directory.path(), "first-token", now + 3600);
    let cli = KimiCli::at(directory.path().into());
    let credential_path = directory
        .path()
        .join("credentials/kimi-code-env-0123456789abcdef.json");
    let original = fs::read_to_string(&credential_path).unwrap();
    assert!(cli.is_ready());
    let first = cli.api_target().unwrap();
    assert_eq!(first.base_url(), "https://api.kimi.ai/coding/v1");
    assert!(
        first
            .headers()
            .iter()
            .any(|header| header.name() == "X-Msh-Device-Id" && header.value() == "test-device")
    );
    assert!(
        first.headers().iter().any(
            |header| header.name() == "Authorization" && header.value() == "Bearer first-token"
        )
    );
    let identity = cli.catalog_identity().unwrap();
    assert!(!identity.contains("first-token"));
    assert_eq!(fs::read_to_string(&credential_path).unwrap(), original);

    write_connection(directory.path(), "second-token", now + 3600);
    assert_ne!(identity, cli.catalog_identity().unwrap());
    assert!(
        cli.api_target()
            .unwrap()
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization"
                && header.value() == "Bearer second-token")
    );

    write_connection(directory.path(), "expired-token", now - 1);
    assert!(!cli.is_ready());
    assert!(cli.api_target().is_err());
}

#[test]
fn cli_connection_rejects_invalid_credential_path() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("config.toml"),
        r#"[providers."managed:kimi-code"]
type = "kimi"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/../other"
"#,
    )
    .unwrap();
    assert!(!KimiCli::at(directory.path().into()).is_ready());
}
