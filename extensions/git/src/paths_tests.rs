use super::RepoPath;
use super::repository_root;
use crate::paths::ResourceUri;

#[test]
fn configured_roots_accept_paths_and_uris_in_the_target_convention() {
    for (root, configured) in [
        ("file:///C:/work%20tree", "C:\\work tree\\"),
        (
            "file://server/share/work%20tree",
            "\\\\server\\share\\work tree",
        ),
        ("file:///work%20tree", "/work tree/"),
    ] {
        let root = ResourceUri::parse(root).unwrap();
        assert!(super::matches_configured_root(&root, configured));
        assert!(super::matches_configured_root(&root, &root.to_string()));
        assert!(!super::matches_configured_root(&root, "relative/path"));
        assert!(!super::matches_configured_root(
            &root,
            "file:///another/repository"
        ));
    }
}

#[test]
fn git_names_round_trip_independently_of_host_platform() {
    for root in [
        "file:///work",
        "file:///C:/work",
        "file://server/share/work",
    ] {
        let root = ResourceUri::parse(root).unwrap();
        for name in ["src/file.txt", "中文/space +%20#?.txt"] {
            let path = RepoPath::parse(name).unwrap();
            let resource = path.resolve(&root).unwrap();
            assert_eq!(RepoPath::from_resource(&root, &resource), Some(path));
        }
        assert_eq!(repository_root(&root, "").unwrap(), root);
        assert_eq!(RepoPath::from_resource(&root, &root), None);
    }
}

#[test]
fn invalid_repository_paths_are_rejected_at_deserialization() {
    for path in [
        "", "/a", "a/", "a//b", ".", "../a", "a/../b", "a/./b", "a\0b",
    ] {
        assert!(
            serde_json::from_value::<RepoPath>(serde_json::json!(path)).is_err(),
            "{path:?}"
        );
    }
}

#[test]
fn windows_names_never_change_meaning_during_resolution() {
    let windows = ResourceUri::parse("file:///C:/work").unwrap();
    let posix = ResourceUri::parse("file:///work").unwrap();
    for name in ["a\\b", "a:stream", "C:relative"] {
        let path = RepoPath::parse(name).unwrap();
        assert!(path.resolve(&windows).is_err());
        let resource = path.resolve(&posix).unwrap();
        assert_eq!(RepoPath::from_resource(&posix, &resource), Some(path));
    }
    for resource in [
        "file:///C:/work-other/a",
        "file:///D:/work/a",
        "file://server/share/work/a",
        "file:///C:/work/a%2fb",
        "file:///C:/work/a%5cb",
    ] {
        assert_eq!(
            RepoPath::from_resource(&windows, &ResourceUri::parse(resource).unwrap()),
            None
        );
    }
}

#[test]
fn remote_workspace_facts_keep_their_editor_authority() {
    for uri in [
        "ash-remote://ssh+windows/C%3A/work%20%E4%B8%AD/O'Brien",
        "ash-remote://ssh+linux/srv/work",
        "ash-remote://ssh+windows//server/share/work",
        "ash-remote://team+build/C:/work",
    ] {
        let folder: crate::model::WorkspaceFolder = serde_json::from_value(serde_json::json!({
            "id": "workspace", "name": "workspace", "uri": uri
        }))
        .expect("Git must accept the remote editor's workspace identity");
        assert_eq!(folder.uri.to_string(), uri);
    }
}

#[test]
fn remote_git_resources_preserve_paths_and_reject_foreign_owners() {
    for (uri, execution) in [
        ("ash-remote://ssh+windows/C%3A/work", "C:\\work"),
        (
            "ash-remote://ssh+windows//server/share/work",
            "\\\\server\\share\\work",
        ),
        (
            "ash-remote://ssh+linux/srv/work%5Carchive",
            "/srv/work\\archive",
        ),
    ] {
        let root = ResourceUri::parse(uri).unwrap();
        assert_eq!(root.execution_path(), execution);
        let name = RepoPath::parse("中文/space +%20#?.txt").unwrap();
        let resource = name.resolve(&root).unwrap();
        assert!(resource.to_string().starts_with("ash-remote://"));
        assert_eq!(RepoPath::from_resource(&root, &resource), Some(name));
        assert_eq!(ResourceUri::parse(&resource.to_string()).unwrap(), resource);
        let foreign =
            ResourceUri::parse(&resource.to_string().replace("ssh+", "ssh+other-")).unwrap();
        assert_eq!(RepoPath::from_resource(&root, &foreign), None);
        assert_eq!(super::target_path(&root, execution).unwrap(), root);
        assert!(super::matches_configured_root(&root, execution));
    }
    let remote = ResourceUri::parse("ash-remote://ssh+windows/C%3A/work").unwrap();
    assert_eq!(
        RepoPath::from_resource(&remote, &ResourceUri::parse("file:///C:/work/a").unwrap()),
        None
    );
    for invalid in [
        "https://host/work",
        "ash-remote:///work",
        "ash-remote://user:password@host/work",
        "ash-remote://host/work?secret=1",
        "ash-remote://host/work#part",
        "ash-remote://host/work/a%2Fb",
    ] {
        assert!(ResourceUri::parse(invalid).is_err(), "{invalid}");
    }
}
