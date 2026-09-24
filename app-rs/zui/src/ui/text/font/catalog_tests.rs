use super::FontCatalog;

#[test]
fn catalog_removes_empty_and_duplicate_family_names() {
    let catalog = FontCatalog::from_family_names(vec![
        "Ash Sans".to_string(),
        String::new(),
        "Ash Mono".to_string(),
        "Ash Sans".to_string(),
    ]);

    assert_eq!(
        catalog.family_names(),
        &["Ash Mono".to_string(), "Ash Sans".to_string()]
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_system_catalog_loads_system_families() {
    let catalog = FontCatalog::system().expect("system font catalog should load");

    assert!(!catalog.family_names().is_empty());
}
