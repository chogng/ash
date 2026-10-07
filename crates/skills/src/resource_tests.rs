use super::SkillResourceKind;
use super::SkillResourcePath;
use crate::ContentDigest;
use crate::SkillCatalog;
use crate::SkillErrorKind;
use crate::SkillSourceRoot;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use std::fs;

#[test]
fn reads_resources_from_each_conventional_package_area() {
    let directory = tempfile::tempdir().unwrap();
    let skill = directory.path().join("review");
    fs::create_dir_all(skill.join("references/guides")).unwrap();
    fs::create_dir_all(skill.join("scripts")).unwrap();
    fs::create_dir_all(skill.join("assets")).unwrap();
    let instructions = "---\nname: review\ndescription: Reviews code when requested.\n---\nRead references/guides/checks.md\n";
    fs::write(skill.join("SKILL.md"), instructions).unwrap();
    fs::write(skill.join("references/guides/checks.md"), "Check races.\n").unwrap();
    fs::write(skill.join("scripts/check.py"), "print('checked')\n").unwrap();
    fs::write(skill.join("assets/template.bin"), [0, 1, 2, 255]).unwrap();
    let id = skill_id();
    let catalog = SkillCatalog::discover(vec![
        SkillSourceRoot::user(id.source.clone(), directory.path()).unwrap(),
    ])
    .unwrap();
    let selected = SkillRef::pinned(id, ContentDigest::sha256(instructions.as_bytes()));

    for (path, kind, expected) in [
        (
            "references/guides/checks.md",
            SkillResourceKind::Reference,
            b"Check races.\n".as_slice(),
        ),
        (
            "scripts/check.py",
            SkillResourceKind::Script,
            b"print('checked')\n".as_slice(),
        ),
        (
            "assets/template.bin",
            SkillResourceKind::Asset,
            [0, 1, 2, 255].as_slice(),
        ),
    ] {
        let resource = catalog
            .read_resource(&selected, &SkillResourcePath::new(path).unwrap())
            .unwrap();
        assert_eq!(resource.path().display(), path);
        assert_eq!(resource.kind(), kind);
        assert_eq!(resource.bytes(), expected);
        assert_eq!(resource.content_digest(), &ContentDigest::sha256(expected));
    }
}

#[test]
fn classifies_main_and_optional_package_resources_without_restricting_other_files() {
    for (path, expected) in [
        ("SKILL.md", SkillResourceKind::Instructions),
        ("references/api.md", SkillResourceKind::Reference),
        ("scripts/check.sh", SkillResourceKind::Script),
        ("assets/logo.png", SkillResourceKind::Asset),
        ("agents/openai.yaml", SkillResourceKind::AgentMetadata),
        ("LICENSE.txt", SkillResourceKind::Other),
    ] {
        assert_eq!(SkillResourcePath::new(path).unwrap().kind(), expected);
    }
}

#[test]
fn rejects_unpinned_traversal_symlinks_hard_links_and_oversized_resources() {
    assert_eq!(
        SkillResourcePath::new("../outside.md").unwrap_err().kind(),
        SkillErrorKind::InvalidContent
    );
    assert_eq!(
        SkillResourcePath::new("/outside.md").unwrap_err().kind(),
        SkillErrorKind::InvalidContent
    );

    let directory = tempfile::tempdir().unwrap();
    let skill = directory.path().join("review");
    fs::create_dir_all(skill.join("assets")).unwrap();
    let instructions =
        "---\nname: review\ndescription: Reviews code when requested.\n---\nInstructions\n";
    fs::write(skill.join("SKILL.md"), instructions).unwrap();
    fs::write(directory.path().join("outside.md"), "outside").unwrap();
    fs::write(skill.join("assets/large.bin"), vec![b'x'; 256 * 1024 + 1]).unwrap();
    fs::write(skill.join("assets/linked-source.bin"), "linked").unwrap();
    fs::hard_link(
        skill.join("assets/linked-source.bin"),
        skill.join("assets/linked.bin"),
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        directory.path().join("outside.md"),
        skill.join("assets/escape.bin"),
    )
    .unwrap();
    let id = skill_id();
    let catalog = SkillCatalog::discover(vec![
        SkillSourceRoot::user(id.source.clone(), directory.path()).unwrap(),
    ])
    .unwrap();

    assert_eq!(
        catalog
            .read_resource(
                &SkillRef::follow_latest(id.clone()),
                &SkillResourcePath::new("assets/linked.bin").unwrap(),
            )
            .unwrap_err()
            .kind(),
        SkillErrorKind::InvalidContent
    );
    let selected = SkillRef::pinned(id, ContentDigest::sha256(instructions.as_bytes()));
    for path in ["assets/large.bin", "assets/linked.bin"] {
        assert_eq!(
            catalog
                .read_resource(&selected, &SkillResourcePath::new(path).unwrap())
                .unwrap_err()
                .kind(),
            SkillErrorKind::SourceUnavailable
        );
    }
    #[cfg(unix)]
    assert_eq!(
        catalog
            .read_resource(
                &selected,
                &SkillResourcePath::new("assets/escape.bin").unwrap(),
            )
            .unwrap_err()
            .kind(),
        SkillErrorKind::SourceUnavailable
    );
}

#[test]
fn rejects_resource_read_when_skill_instructions_changed_without_a_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let skill = directory.path().join("review");
    fs::create_dir_all(skill.join("references")).unwrap();
    let instructions = "---\nname: review\ndescription: Reviews code when requested.\n---\nFirst\n";
    fs::write(skill.join("SKILL.md"), instructions).unwrap();
    fs::write(skill.join("references/checks.md"), "Checks\n").unwrap();
    let id = skill_id();
    let catalog = SkillCatalog::discover(vec![
        SkillSourceRoot::user(id.source.clone(), directory.path()).unwrap(),
    ])
    .unwrap();
    let selected = SkillRef::pinned(id, ContentDigest::sha256(instructions.as_bytes()));
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Reviews code when requested.\n---\nChanged\n",
    )
    .unwrap();

    let error = catalog
        .read_resource(
            &selected,
            &SkillResourcePath::new("references/checks.md").unwrap(),
        )
        .unwrap_err();

    assert_eq!(error.kind(), SkillErrorKind::ContentChanged);
}

fn skill_id() -> SkillId {
    SkillId::new(
        SkillSourceId::new("user:skill-source:test").unwrap(),
        SkillName::new("review").unwrap(),
    )
}
