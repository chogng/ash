use super::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn package_descriptors_preserve_source_identity_and_only_scan_the_declared_skill() {
    let root = tempdir().unwrap();
    fs::create_dir_all(root.path().join("nested")).unwrap();
    for (path, name) in [
        (root.path().to_path_buf(), "review"),
        (root.path().join("nested"), "hidden"),
    ] {
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Review code.\n---\nInstructions"),
        )
        .unwrap();
    }
    for (source, package, expected_id, expected_kind) in [
        (
            PluginSkillSource::LocalPlugin,
            "acme/review",
            "plugin-acme/review:skill-source:review",
            SkillSourceKind::Plugin,
        ),
        (
            PluginSkillSource::Extensions,
            "review@team",
            "extension_packages-review@team:skill-source:review",
            SkillSourceKind::Registry,
        ),
    ] {
        let source = SkillSourceRoot::from_plugin(PluginSkillRoot {
            path: root.path().to_path_buf(),
            source,
            plugin_id: package.into(),
            skill_name: "review".into(),
        })
        .unwrap();
        assert_eq!(source.view().id().as_str(), expected_id);
        assert_eq!(source.view().kind(), expected_kind);
        assert!(!source.view().allows_automatic_activation());
        let catalog = crate::SkillCatalog::discover(vec![source]).unwrap();
        assert_eq!(catalog.snapshot().list().len(), 1);
        assert_eq!(catalog.snapshot().list()[0].id().name.as_str(), "review");
    }
}

#[test]
fn package_descriptors_still_require_a_valid_skill_name_and_existing_directory() {
    let root = tempdir().unwrap();
    for (name, path) in [
        ("Invalid_Name", root.path().to_path_buf()),
        ("review", root.path().join("missing")),
    ] {
        assert!(
            SkillSourceRoot::from_plugin(PluginSkillRoot {
                path,
                source: PluginSkillSource::LocalPlugin,
                plugin_id: "acme/review".into(),
                skill_name: name.into(),
            })
            .is_err()
        );
    }
}

#[test]
fn source_root_debug_output_does_not_expose_the_host_path() {
    let root = std::env::temp_dir().join(format!("ash-skill-source-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let source =
        SkillSourceRoot::user(SkillSourceId::new("user:skill-source:test").unwrap(), &root)
            .unwrap();

    let rendered = format!("{source:?}");

    assert!(!rendered.contains(root.to_str().unwrap()));
    assert!(rendered.contains("<private>"));
    let _ = fs::remove_dir(&root);
}

#[test]
fn dir_source_preserves_dir_provenance() {
    let root = std::env::temp_dir().join(format!("ash-dir-skill-source-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let source =
        SkillSourceRoot::directory(SkillSourceId::new("dir:skill-source:.ash").unwrap(), &root)
            .unwrap();

    assert_eq!(source.view().kind(), SkillSourceKind::Directory);
    assert!(!source.view().allows_automatic_activation());
    let _ = fs::remove_dir(&root);
}

#[cfg(unix)]
#[test]
fn source_root_rejects_symbolic_links() {
    use std::os::unix::fs::symlink;

    let base = std::env::temp_dir().join(format!("ash-skill-link-{}", std::process::id()));
    let target = base.join("target");
    let link = base.join("link");
    fs::create_dir_all(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = SkillSourceRoot::user(SkillSourceId::new("user:skill-source:test").unwrap(), &link)
        .unwrap_err();

    assert_eq!(error.kind(), SkillErrorKind::SourceUnavailable);
    let _ = fs::remove_dir_all(&base);
}
