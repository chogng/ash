use super::decode;
use super::decode_worktrees;
use crate::model::RepositoryCommand;
use crate::model::Status;
use crate::paths::ResourceUri;
use serde_json::json;

#[test]
fn settings_update_decodes_only_the_fields_granted_to_the_extension() {
    let result: crate::model::SettingsUpdated = decode(json!({"revision":7})).unwrap();
    assert_eq!(result.revision, 7);
    assert!(decode::<crate::model::SettingsUpdated>(json!({})).is_err());
}

#[test]
fn checkout_paths_use_the_repository_convention_not_the_presenter_host() {
    for (root, checkout) in [
        ("file:///C:/source", "C:\\worktrees\\中文 space"),
        (
            "file://server/share/source",
            "\\\\server\\share\\worktrees\\中文 space",
        ),
        ("file:///source", "/worktrees/中文 space"),
    ] {
        let root = ResourceUri::parse(root).unwrap();
        let worktrees = decode_worktrees(&root, json!({"worktrees":[{
            "checkoutRoot":checkout,"path":checkout,"branch":null,"head":"abc","current":false,"state":"ready"
        }]})).unwrap();
        assert_eq!(worktrees[0].checkout_root.execution_path(), checkout);
        assert!(decode_worktrees(&root, json!({"worktrees":[{
            "checkoutRoot":"relative/path","path":checkout,"branch":null,"head":"abc","current":false,"state":"ready"
        }]})).is_err());
    }
}

#[test]
fn backend_paths_are_validated_before_a_status_can_enter_the_model() {
    let mut status = json!({
        "repositoryId":"repo","streamInstanceId":"stream","revision":1,"historyRevision":1,"path":"",
        "head":{"type":"unborn","name":"main"},
        "changes":[{"path":"../outside","indexStatus":"modified","worktreeStatus":"unmodified","conflicted":false,"submodule":{}}]
    });
    // Supply actual submodule facts so rejection is specifically about the path.
    status["changes"][0]["submodule"] = json!({"isSubmodule":false,"commitChanged":false,"trackedChanges":false,"untrackedChanges":false});
    assert!(decode::<Status>(status.clone()).is_err());
    status["changes"][0]["path"] = json!("src/中文 %20.txt");
    assert_eq!(
        &*decode::<Status>(status).unwrap().changes[0].path,
        "src/中文 %20.txt"
    );
}

#[test]
fn external_command_intents_cannot_inject_another_operation_or_transport_fields() {
    assert!(decode::<RepositoryCommand>(json!({"kind":"execute","args":["--version"]})).is_err());
    assert!(
        decode::<RepositoryCommand>(json!({"kind":"deleteTag","name":"v1","repositoryId":"other"}))
            .is_err()
    );
    assert!(
        decode::<RepositoryCommand>(
            json!({"kind":"pushBranch","remote":"origin","name":"main","branch":"main"})
        )
        .is_err()
    );
    assert!(matches!(
        decode::<RepositoryCommand>(json!({"kind":"deleteTag","name":"v1"})).unwrap(),
        RepositoryCommand::DeleteTag { .. }
    ));
}
