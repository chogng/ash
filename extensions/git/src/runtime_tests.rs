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

#[test]
fn restarted_repository_stream_rejects_late_retired_and_older_snapshots() {
    let mut repository = Repository {
        descriptor: RepositoryDescriptor {
            id: "repo".into(),
            label: "Test".into(),
            path: String::new(),
            dir_id: None,
            parent_path: None,
        },
        root_uri: "file:///workspace".into(),
        configuration: Configuration::default(),
        status: Some(status("first", 20)),
        draft: "Retained draft".into(),
        input_revision: 7,
        operation: None,
        error: String::new(),
        commit_editor_head: None,
        blame: None,
        pending_paths: None,
        retired_streams: BTreeSet::new(),
    };
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
