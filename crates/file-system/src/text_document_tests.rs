use super::*;
use ash_async_utils::CancellationSource;
use std::fs;

#[test]
fn document_updates_preserve_bom_eol_and_reject_changed_disk_revisions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let path = dir.canonical_path().join("file.txt");
    fs::write(&path, "\u{feff}old\r\n").unwrap();
    let files = FileTextDocuments::new(dir);
    let token = CancellationSource::new().token();
    let snapshot = files.read(&path, &token).unwrap().unwrap();
    assert_eq!(snapshot.text, "old\r\n");
    files
        .apply(
            vec![TextDocumentChange::Update {
                snapshot: snapshot.id,
                text: "new\r\n".into(),
            }],
            &token,
        )
        .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}new\r\n");
    let snapshot = files.read(&path, &token).unwrap().unwrap();
    fs::write(&path, "external").unwrap();
    assert_eq!(
        files.apply(
            vec![TextDocumentChange::Update {
                snapshot: snapshot.id,
                text: "stale".into()
            }],
            &token
        ),
        Err(TextDocumentError::Conflict)
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
}

#[test]
fn document_batch_checks_every_source_before_creating_or_moving_files() {
    for operation in ["update", "delete", "move"] {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let path = dir.canonical_path().join("old.txt");
        let created = dir.canonical_path().join("created.txt");
        let moved = dir.canonical_path().join("moved.txt");
        fs::write(&path, "old").unwrap();
        let files = FileTextDocuments::new(dir);
        let token = CancellationSource::new().token();
        let snapshot = files.read(&path, &token).unwrap().unwrap();
        let change = match operation {
            "update" => TextDocumentChange::Update {
                snapshot: snapshot.id,
                text: "new".into(),
            },
            "delete" => TextDocumentChange::Delete {
                snapshot: snapshot.id,
            },
            "move" => TextDocumentChange::Move {
                snapshot: snapshot.id,
                target: moved.clone(),
                text: "new".into(),
            },
            _ => unreachable!(),
        };
        fs::write(&path, "external").unwrap();
        assert_eq!(
            files.apply(
                vec![
                    TextDocumentChange::Create {
                        path: created.clone(),
                        text: "first".into()
                    },
                    change
                ],
                &token
            ),
            Err(TextDocumentError::Conflict)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert!(!created.exists());
        assert!(!moved.exists());
    }
}

#[test]
fn document_creation_cannot_replace_an_intervening_writer() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let path = dir.canonical_path().join("new.txt");
    let files = FileTextDocuments::new(dir);
    fs::write(&path, "external").unwrap();
    assert!(
        files
            .apply(
                vec![TextDocumentChange::Create {
                    path: path.clone(),
                    text: "agent".into()
                }],
                &CancellationSource::new().token()
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
}

#[test]
fn authorized_documents_enforce_paths_and_revocation_at_commit() {
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessPolicy;
    use ash_file_access::PathAccessRule;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let visible = dir.canonical_path().join("visible");
    let secret = dir.canonical_path().join("secret");
    fs::write(&visible, "old").unwrap();
    fs::write(&secret, "private").unwrap();
    let grant = Grant::for_environment(
        dir.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::WriteFiles]),
    )
    .with_path_policy(
        PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![PathAccessRule {
                pattern: "secret".into(),
                access: PathAccess::Denied,
            }],
        )
        .unwrap(),
    );
    let editor = AuthorizedTextDocuments::new(
        grant.authorize(Permission::WriteFiles).unwrap(),
        std::sync::Arc::new(FileTextDocuments::new(dir.clone())),
        [],
    );
    let token = CancellationSource::new().token();
    assert!(editor.read(&secret, &token).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("secret", dir.canonical_path().join("alias")).unwrap();
        assert!(
            editor
                .read(&dir.canonical_path().join("alias"), &token)
                .is_err()
        );
        fs::create_dir(dir.canonical_path().join("denied-directory")).unwrap();
        std::os::unix::fs::symlink(
            "denied-directory",
            dir.canonical_path().join("directory-alias"),
        )
        .unwrap();
        let policy = ash_file_access::PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![PathAccessRule {
                pattern: "denied-directory".into(),
                access: PathAccess::Denied,
            }],
        )
        .unwrap();
        let restricted = AuthorizedTextDocuments::new(
            grant
                .authorize(Permission::WriteFiles)
                .unwrap()
                .constrained_by(&policy),
            std::sync::Arc::new(FileTextDocuments::new(dir.clone())),
            [],
        );
        assert!(
            restricted
                .apply(
                    vec![TextDocumentChange::Create {
                        path: dir.canonical_path().join("directory-alias/new"),
                        text: "denied".into()
                    }],
                    &token
                )
                .is_err()
        );
        assert!(!dir.canonical_path().join("denied-directory/new").exists());
    }
    let snapshot = editor.read(&visible, &token).unwrap().unwrap();
    grant.revoke();
    assert!(
        editor
            .apply(
                vec![TextDocumentChange::Update {
                    snapshot: snapshot.id,
                    text: "unauthorized".into()
                }],
                &token
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(visible).unwrap(), "old");
}
