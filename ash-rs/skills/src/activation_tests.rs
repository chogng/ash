use super::*;
use crate::SkillSourceRoot;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillSourceId;
use std::fs;

#[test]
fn activation_loads_exact_body_and_freezes_catalog_provenance() {
    let directory = tempfile::tempdir().unwrap();
    let body = "---\nname: review\ndescription: Reviews code when requested.\n---\n# Workflow\n";
    fs::create_dir(directory.path().join("review")).unwrap();
    fs::write(directory.path().join("review/SKILL.md"), body).unwrap();
    let id = SkillId::new(
        SkillSourceId::new("user:skill-source:test").unwrap(),
        SkillName::new("review").unwrap(),
    );
    let catalog = SkillCatalog::discover(vec![
        SkillSourceRoot::user(id.source.clone(), directory.path()).unwrap(),
    ])
    .unwrap();

    let activated = catalog
        .activate(
            &SkillRef::follow_latest(id.clone()),
            SkillActivationReason::Explicit,
        )
        .unwrap();

    assert_eq!(activated.body(), body);
    assert_eq!(activated.activation().id, id);
    assert_eq!(activated.activation().catalog_generation, 1);
    assert_eq!(
        activated.activation().content_digest,
        ContentDigest::sha256(body.as_bytes())
    );
}

#[test]
fn pinned_activation_rejects_changed_content_without_following_it() {
    let directory = tempfile::tempdir().unwrap();
    let skill_directory = directory.path().join("review");
    fs::create_dir(&skill_directory).unwrap();
    let first = "---\nname: review\ndescription: Reviews code when requested.\n---\nfirst\n";
    fs::write(skill_directory.join("SKILL.md"), first).unwrap();
    let id = SkillId::new(
        SkillSourceId::new("user:skill-source:test").unwrap(),
        SkillName::new("review").unwrap(),
    );
    let mut catalog = SkillCatalog::discover(vec![
        SkillSourceRoot::user(id.source.clone(), directory.path()).unwrap(),
    ])
    .unwrap();
    let pinned = SkillRef::pinned(id, ContentDigest::sha256(first.as_bytes()));
    fs::write(
        skill_directory.join("SKILL.md"),
        "---\nname: review\ndescription: Reviews code when requested.\n---\nsecond\n",
    )
    .unwrap();
    catalog.refresh();

    let error = catalog
        .activate(&pinned, SkillActivationReason::Explicit)
        .unwrap_err();
    assert_eq!(error.kind(), SkillErrorKind::ContentChanged);
}
