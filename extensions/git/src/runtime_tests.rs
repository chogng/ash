use super::accept_repository_status;
use crate::model::Configuration;
use crate::model::Head;
use crate::model::Repository;
use crate::model::RepositoryDescriptor;
use crate::model::Status;
use std::collections::BTreeSet;

fn status(stream: &str, revision: u64) -> Status {
    Status {
        repository_id: "repo".into(),
        stream_instance_id: stream.into(),
        revision,
        history_revision: 1,
        path: String::new(),
        head: Head::Unborn {
            name: "main".into(),
        },
        changes: Vec::new(),
    }
}

fn repository(initial_status: Option<Status>) -> Repository {
    Repository {
        descriptor: RepositoryDescriptor {
            id: "repo".into(),
            label: "Test".into(),
            path: String::new(),
            dir_id: None,
            parent_path: None,
        },
        root_uri: crate::paths::ResourceUri::parse("file:///workspace").unwrap(),
        configuration: Configuration::default(),
        status: initial_status,
        catalog: None,
        draft: "Retained draft".into(),
        input_revision: 7,
        operation: None,
        error: String::new(),
        notice: String::new(),
        commit_editor_head: None,
        blame: None,
        pending_paths: None,
        retired_streams: BTreeSet::new(),
    }
}

#[test]
fn resource_paths_decode_without_host_filesystem_path_rules() {
    let mut repository = repository(None);
    for root in [
        "file:///workspace",
        "file:///C:/workspace",
        "file://server/share/workspace",
    ] {
        repository.root_uri = crate::paths::ResourceUri::parse(root).unwrap();
        for (encoded, expected) in [
            ("image.bin", "image.bin"),
            ("src/nested/file.txt", "src/nested/file.txt"),
            ("space%20and+plus%2520.txt", "space and+plus%20.txt"),
            ("%E4%B8%AD%E6%96%87.txt", "中文.txt"),
        ] {
            assert_eq!(
                crate::changes::relative_resource(&repository, &format!("{root}/{encoded}")),
                Some(crate::paths::RepoPath::parse(expected).unwrap()),
                "{root}/{encoded}"
            );
        }
        for resource in [
            format!("{root}-other/file.txt"),
            format!("{root}/%FF.txt"),
            root.into(),
        ] {
            assert_eq!(
                crate::changes::relative_resource(&repository, &resource),
                None
            );
        }
        assert_eq!(
            crate::changes::relative_resource(&repository, "file://other/share/workspace/file.txt"),
            None
        );
    }
}

#[test]
fn restarted_repository_stream_rejects_late_retired_and_older_snapshots() {
    let mut repository = repository(Some(status("first", 20)));
    accept_repository_status(&mut repository, status("second", 1));
    accept_repository_status(&mut repository, status("first", 21));
    assert_eq!(
        repository.status.as_ref().unwrap().stream_instance_id,
        "second"
    );
    assert_eq!(repository.status.as_ref().unwrap().revision, 1);
    accept_repository_status(&mut repository, status("second", 0));
    assert_eq!(repository.status.as_ref().unwrap().revision, 1);
    accept_repository_status(&mut repository, status("second", 2));
    assert_eq!(repository.status.as_ref().unwrap().revision, 2);
    assert_eq!(repository.draft, "Retained draft");
    assert_eq!(repository.input_revision, 7);
}

#[test]
fn initial_watched_status_respects_client_policy_and_never_overwrites_a_live_view() {
    let mut initial = repository(None);
    assert!(super::accept_initial_repository_status(
        &mut initial,
        Some(status("new", 1))
    ));
    assert!(!super::accept_initial_repository_status(
        &mut initial,
        Some(status("new", 9))
    ));
    assert_eq!(initial.status.as_ref().unwrap().revision, 1);
    for configuration in [
        serde_json::json!({"path": "/custom/git"}),
        serde_json::json!({"path": ["/custom/git"]}),
        serde_json::json!({"similarityThreshold": 75}),
    ] {
        let mut customized = repository(None);
        customized.configuration = Configuration(configuration);
        assert!(!super::accept_initial_repository_status(
            &mut customized,
            Some(status("new", 1))
        ));
        assert!(customized.status.is_none());
    }
    let mut missing = repository(None);
    assert!(!super::accept_initial_repository_status(&mut missing, None));
    let mut foreign = status("foreign", 1);
    foreign.repository_id = "another-repository".into();
    assert!(!super::accept_initial_repository_status(
        &mut missing,
        Some(foreign)
    ));
}

#[test]
fn editor_discovery_skips_known_repositories_but_detects_unknown_workspace_paths() {
    for workspace in ["file:///workspace", "ash-remote://ssh+host/workspace"] {
        let mut state = super::State::default();
        state.folders.push(crate::model::WorkspaceFolder {
            id: "workspace".into(),
            name: "Workspace".into(),
            uri: crate::paths::ResourceUri::parse(workspace).unwrap(),
        });
        let mut known = repository(None);
        known.root_uri = crate::paths::ResourceUri::parse(&format!("{workspace}/repo")).unwrap();
        state.repositories.insert("repo".into(), known);
        for resources in [
            serde_json::json!([]),
            serde_json::json!([
                format!("{workspace}/repo/src/first.ts"),
                format!("{workspace}/repo/tests/second.ts")
            ]),
            serde_json::json!([
                "git-index:/file.ts?revision=1",
                "untitled:/new",
                "file:///outside/file.ts"
            ]),
            serde_json::json!(["ash-remote://ssh+other/workspace/new/file.ts"]),
        ] {
            assert!(
                !super::editor_resources_need_discovery(&state, resources.as_array().unwrap()),
                "{resources}"
            );
        }
        for path in ["new-repo/file.ts", "repo-other/file.ts"] {
            let resources = serde_json::json!([format!("{workspace}/{path}")]);
            assert!(
                super::editor_resources_need_discovery(&state, resources.as_array().unwrap()),
                "{resources}"
            );
        }
    }
}
