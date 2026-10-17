use super::RepoPath;
use super::repository_root;
use ash_utils_path_uri::PathUri;

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
        let root = PathUri::parse(root).unwrap();
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
        let root = PathUri::parse(root).unwrap();
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
    let windows = PathUri::parse("file:///C:/work").unwrap();
    let posix = PathUri::parse("file:///work").unwrap();
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
            RepoPath::from_resource(&windows, &PathUri::parse(resource).unwrap()),
            None
        );
    }
}
