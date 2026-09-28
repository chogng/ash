use super::*;

fn config(key: &str, base_url: &str) -> String {
    format!(
        r#"[providers.daimon-kimi-code]
type = "kimi"
base_url = "{base_url}"
api_key = "{key}"
"#
    )
}

#[test]
fn desktop_connection_reads_current_key_without_copying_or_rewriting_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    let initial = config("first-key", DESKTOP_GATEWAY);
    fs::write(&path, &initial).unwrap();
    let desktop = KimiDesktop::at(path.clone());

    assert!(desktop.is_ready());
    let first = desktop.api_target().unwrap();
    assert_eq!(first.base_url, DESKTOP_GATEWAY);
    assert!(first.headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer first-key"
    }));
    let first_identity = desktop.catalog_identity().unwrap();
    assert!(!first_identity.contains("first-key"));
    assert_eq!(fs::read_to_string(&path).unwrap(), initial);

    let rotated = config("second-key", DESKTOP_GATEWAY);
    fs::write(&path, &rotated).unwrap();
    let second = desktop.api_target().unwrap();
    assert!(second.headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer second-key"
    }));
    assert_ne!(first_identity, desktop.catalog_identity().unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), rotated);
}

#[test]
fn desktop_connection_rejects_other_endpoints_and_missing_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    let desktop = KimiDesktop::at(path.clone());
    assert!(!desktop.is_ready());

    fs::write(&path, config("key", "https://example.test/coding/v1")).unwrap();
    assert!(!desktop.is_ready());
    assert!(desktop.api_target().is_err());

    fs::write(&path, config("", DESKTOP_GATEWAY)).unwrap();
    assert!(!desktop.is_ready());
}
