use super::*;
use github::ShareLineRange;
fn link() -> ShareLink {
    ShareLink {
        path_kind: SharePathKind::File,
        repository: Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap(),
        reference: ShareReference::Commit("a".repeat(40)),
        target: ShareTarget::GitHub,
        path: Some("src/a #%.rs".into()),
        lines: Some(ShareLineRange { start: 4, end: 7 }),
        notebook_cell: None,
    }
}
#[test]
fn file_permalink_encodes_paths_without_turning_fragments_into_file_names() {
    assert_eq!(
        share_link(link()).unwrap(),
        format!(
            "https://github.com/team/repo/blob/{}/src/a%20%23%25.rs#L4-L7",
            "a".repeat(40)
        )
    );
}
#[test]
fn mutable_refs_and_notebook_cells_keep_their_coordinates() {
    let mut value = link();
    value.reference = ShareReference::Branch("feature/链接".into());
    value.target = ShareTarget::VscodeDev;
    value.notebook_cell = Some(3);
    assert_eq!(
        share_link(value).unwrap(),
        "https://vscode.dev/github/team/repo/blob/feature/%E9%93%BE%E6%8E%A5/src/a%20%23%25.rs#C3:L4-L7"
    );
}
#[test]
fn repository_links_use_trees_and_enterprise_stays_on_its_host() {
    let mut value = link();
    value.path = None;
    value.lines = None;
    value.repository.host = "github.example.com".into();
    assert_eq!(
        share_link(value.clone()).unwrap(),
        format!(
            "https://github.example.com/team/repo/tree/{}",
            "a".repeat(40)
        )
    );
    value.target = ShareTarget::VscodeDev;
    assert!(share_link(value).is_err());
}
#[test]
fn malformed_paths_refs_and_line_coordinates_are_rejected() {
    for path in ["../secret", "/absolute", "a//b", "a/./b", "a\\b", "a\n"] {
        let mut value = link();
        value.path = Some(path.into());
        assert!(share_link(value).is_err(), "{path}");
    }
    for branch in [
        "",
        "../main",
        "main:evil",
        "foo@{1}",
        "feature branch",
        ".",
        "a/.hidden",
        "a.lock",
    ] {
        let mut value = link();
        value.reference = ShareReference::Branch(branch.into());
        assert!(share_link(value).is_err(), "{branch}");
    }
    let mut value = link();
    value.lines = Some(ShareLineRange { start: 0, end: 1 });
    assert!(share_link(value).is_err());
    let mut value = link();
    value.lines = Some(ShareLineRange { start: 5, end: 4 });
    assert!(share_link(value).is_err());
    let mut value = link();
    value.path = None;
    assert!(share_link(value).is_err());
}
#[test]
fn directory_links_use_tree_and_cannot_carry_line_coordinates() {
    let mut value = link();
    value.path = Some("src/sub dir".into());
    value.path_kind = SharePathKind::Directory;
    value.lines = None;
    assert!(share_link(value.clone()).unwrap().contains("/tree/"));
    value.lines = Some(ShareLineRange { start: 1, end: 1 });
    assert!(share_link(value).is_err());
}
