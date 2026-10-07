use super::*;
use std::fs;

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
