use super::*;
use base64::Engine;

fn tokens() -> TokenResponse {
    let jwt = |value: serde_json::Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    TokenResponse {
        id_token: jwt(
            serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1","chatgpt_plan_type":"pro"}}),
        ),
        access_token: jwt(serde_json::json!({"exp":4_000_000_000_u64})),
        refresh_token: "refresh-token-must-not-be-used".into(),
    }
}

#[test]
fn configured_codex_home_requires_a_directory_and_resolves_its_identity() {
    let root = tempfile::tempdir().unwrap();
    assert!(configured_home(&root.path().join("missing")).is_err());
    let file = root.path().join("file");
    fs::write(&file, b"not a directory").unwrap();
    assert!(configured_home(&file).is_err());
    assert_eq!(
        configured_home(root.path()).unwrap(),
        root.path().canonicalize().unwrap()
    );
}

#[test]
fn creates_codex_schema_with_private_permissions_and_refuses_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".codex");
    let store = CodexAuthStore::new(home.clone());
    store.create(&tokens()).unwrap();
    let original = fs::read(home.join("auth.json")).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        json.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from(["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"])
    );
    assert!(json["OPENAI_API_KEY"].is_null());
    assert_eq!(
        json["tokens"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([
            "access_token",
            "account_id",
            "id_token",
            "refresh_token"
        ])
    );
    assert!(chrono::DateTime::parse_from_rfc3339(json["last_refresh"].as_str().unwrap()).is_ok());
    assert!(store.create(&tokens()).is_err());
    assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    assert!(!home.join("config.toml").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn malformed_other_auth_modes_and_api_keys_are_never_treated_as_absent() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    for contents in [
        "broken-secret-json",
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"private-api-key"}"#,
        r#"{"auth_mode":"chatgpt","tokens":null}"#,
    ] {
        fs::write(home.path().join("auth.json"), contents).unwrap();
        let error = store.load().err().unwrap().to_string();
        assert!(!error.contains("private-api-key"));
        assert!(!error.contains("broken-secret-json"));
        assert!(store.ensure_creatable().is_err());
        assert!(store.create(&tokens()).is_err());
        assert_eq!(
            fs::read_to_string(home.path().join("auth.json")).unwrap(),
            contents
        );
    }
}

#[test]
fn login_without_user_identity_cannot_create_or_replace_credentials() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    let mut incomplete = tokens();
    let claims =
        serde_json::json!({"https://api.openai.com/auth":{"chatgpt_account_id":"account-1"}});
    incomplete.id_token = format!(
        "e30.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap())
    );
    assert!(store.write_login(&incomplete, LoginWrite::Create).is_err());
    let path = home.path().join("auth.json");
    assert!(!path.exists());
    let credential = store.create(&tokens()).unwrap();
    let original = fs::read(&path).unwrap();
    assert!(
        store
            .write_login(
                &incomplete,
                LoginWrite::Replace {
                    revision: credential.storage_revision,
                }
            )
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn a_concurrent_login_wins_without_being_overwritten() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    store.ensure_creatable().unwrap();
    fs::write(home.path().join("auth.json"), b"created-by-codex").unwrap();
    assert!(store.create(&tokens()).is_err());
    assert_eq!(
        fs::read(home.path().join("auth.json")).unwrap(),
        b"created-by-codex"
    );
}

#[test]
fn read_observes_external_changes_and_respects_workspace_restrictions() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    assert!(store.load().unwrap().is_none());
    store.create(&tokens()).unwrap();
    assert_eq!(
        store.load().unwrap().unwrap().account_id.as_deref(),
        Some("account-1")
    );
    fs::write(
        home.path().join("config.toml"),
        "forced_chatgpt_workspace_id = 'different'\n",
    )
    .unwrap();
    assert!(store.load().is_err());
    fs::write(
        home.path().join("config.toml"),
        "forced_login_method = 'api'\n",
    )
    .unwrap();
    assert!(store.load().is_err());
    fs::write(home.path().join("config.toml"), "").unwrap();
    fs::remove_file(home.path().join("auth.json")).unwrap();
    assert!(store.load().unwrap().is_none());
}

#[test]
fn legacy_auth_mode_precedence_matches_codex_without_reading_other_secrets() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    store.create(&tokens()).unwrap();
    let path = home.path().join("auth.json");
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    json.as_object_mut().unwrap().remove("auth_mode");
    json["tokens"]
        .as_object_mut()
        .unwrap()
        .remove("refresh_token");
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    assert!(store.load().unwrap().unwrap().is_usable());
    for field in [
        "OPENAI_API_KEY",
        "personal_access_token",
        "bedrock_api_key",
        "bedrock_access_keys",
    ] {
        let mut other = json.clone();
        other[field] = serde_json::json!("another-credential");
        let original = serde_json::to_vec(&other).unwrap();
        fs::write(&path, &original).unwrap();
        assert!(store.load().is_err());
        assert!(fs::read(&path).unwrap() == original);
    }
}

#[test]
fn unsupported_storage_is_explicit_and_does_not_create_a_different_store() {
    let home = tempfile::tempdir().unwrap();
    let store = CodexAuthStore::new(home.path().into());
    for config in [
        "cli_auth_credentials_store = 'ephemeral'",
        "cli_auth_credentials_store = 'keyring'\n[features]\nsecret_auth_storage = true",
    ] {
        fs::write(home.path().join("config.toml"), config).unwrap();
        assert!(store.load().is_err());
        assert!(store.create(&tokens()).is_err());
        assert!(!home.path().join("auth.json").exists());
    }
}

#[test]
#[ignore = "Requires an installed official Codex CLI; uses only synthetic credentials, no model"]
fn codex_cli_accepts_the_generated_auth_file() {
    let home = tempfile::tempdir().unwrap();
    CodexAuthStore::new(home.path().into())
        .create(&tokens())
        .unwrap();
    let path = home.path().join("auth.json");
    let before = fs::read(&path).unwrap();
    let result = std::process::Command::new("codex")
        .args(["login", "status"])
        .env("CODEX_HOME", home.path())
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .current_dir(home.path())
        .output()
        .expect("Codex CLI must be installed for this compatibility test");
    assert!(
        result.status.success(),
        "Codex must accept the generated credential structure"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("Logged in using ChatGPT"));
    assert!(
        before == fs::read(path).unwrap(),
        "Codex login status must not rewrite the generated credentials"
    );
}
