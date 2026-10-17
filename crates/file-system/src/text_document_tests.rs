use super::*;
use ash_async_utils::CancellationSource;
use std::fs;

thread_local! {
    static AUTHORIZED_PATH_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn after_authorized_path() {
    let hook = AUTHORIZED_PATH_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

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

#[cfg(unix)]
fn restricted_documents(dir: &Dir, access: ash_file_access::PathAccess) -> AuthorizedTextDocuments {
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessRule;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let grant = Grant::for_environment(
        dir.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
    )
    .with_path_policy(
        PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![PathAccessRule {
                pattern: "restricted".into(),
                access,
            }],
        )
        .unwrap(),
    );
    AuthorizedTextDocuments::new(
        grant.authorize(Permission::WriteFiles).unwrap(),
        std::sync::Arc::new(FileTextDocuments::new(dir.clone())),
        [],
    )
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug)]
enum PathRace {
    Authorization,
    Resolution,
}

#[cfg(unix)]
#[test]
fn document_reads_reject_replacements_before_and_after_backend_policy_checks() {
    for race in [PathRace::Authorization, PathRace::Resolution] {
        for (replaced, target) in [
            ("visible", "restricted"),
            ("visible/nested", "../restricted/nested"),
            ("visible/nested/file", "../../restricted/nested/file"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let dir = Dir::open_local(temp.path()).unwrap();
            let root = dir.canonical_path().to_path_buf();
            fs::create_dir_all(root.join("visible/nested")).unwrap();
            fs::create_dir_all(root.join("restricted/nested")).unwrap();
            fs::write(root.join("visible/nested/file"), "public").unwrap();
            fs::write(root.join("restricted/nested/file"), "secret").unwrap();
            let documents = restricted_documents(&dir, ash_file_access::PathAccess::Denied);
            let hook_root = root.clone();
            let hook = move || {
                fs::rename(hook_root.join(replaced), hook_root.join("old")).unwrap();
                std::os::unix::fs::symlink(target, hook_root.join(replaced)).unwrap();
            };
            match race {
                PathRace::Authorization => AUTHORIZED_PATH_HOOK.with(|slot| {
                    *slot.borrow_mut() = Some(Box::new(hook));
                }),
                PathRace::Resolution => crate::local::tests::on_read_resolution(hook),
            }
            // These deterministic hooks model an external writer at each IO boundary;
            // no timing loop is needed to hit the formerly vulnerable interleaving.
            let result = documents.read(
                &root.join("visible/nested/file"),
                &CancellationSource::new().token(),
            );
            assert!(
                result.is_err(),
                "{race:?} followed replaced {replaced}: {result:?}"
            );
            assert!(root.join("old").exists(), "race hook did not run");
            assert_eq!(
                fs::read_to_string(root.join("restricted/nested/file")).unwrap(),
                "secret"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn document_creates_reject_replacements_before_and_after_backend_policy_checks() {
    for access in [
        ash_file_access::PathAccess::Denied,
        ash_file_access::PathAccess::ReadOnly,
    ] {
        for race in [PathRace::Authorization, PathRace::Resolution] {
            for missing_parent in [false, true] {
                let temp = tempfile::tempdir().unwrap();
                let dir = Dir::open_local(temp.path()).unwrap();
                let root = dir.canonical_path().to_path_buf();
                fs::create_dir(root.join("visible")).unwrap();
                fs::create_dir(root.join("restricted")).unwrap();
                fs::write(root.join("restricted/sentinel"), "protected").unwrap();
                let documents = restricted_documents(&dir, access);
                let hook_root = root.clone();
                let hook = move || {
                    fs::rename(hook_root.join("visible"), hook_root.join("old")).unwrap();
                    std::os::unix::fs::symlink("restricted", hook_root.join("visible")).unwrap();
                };
                match race {
                    PathRace::Authorization => AUTHORIZED_PATH_HOOK.with(|slot| {
                        *slot.borrow_mut() = Some(Box::new(hook));
                    }),
                    PathRace::Resolution => crate::local::tests::on_write_resolution(hook),
                }
                let path = if missing_parent {
                    "visible/new/deep/file"
                } else {
                    "visible/file"
                };
                let result = documents.apply(
                    vec![TextDocumentChange::Create {
                        path: root.join(path),
                        text: "agent".into(),
                    }],
                    &CancellationSource::new().token(),
                );
                assert!(
                    result.is_err(),
                    "{race:?}, {access:?}, missing_parent={missing_parent}: {result:?}"
                );
                assert!(root.join("old").exists(), "race hook did not run");
                // Even creating parents or staging files in the restricted tree is forbidden.
                assert_eq!(fs::read_dir(root.join("restricted")).unwrap().count(), 1);
                assert_eq!(
                    fs::read_to_string(root.join("restricted/sentinel")).unwrap(),
                    "protected"
                );
                assert_eq!(fs::read_dir(root.join("old")).unwrap().count(), 0);
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn document_mutations_validate_and_publish_through_the_same_pinned_parents() {
    #[derive(Clone, Copy)]
    enum Operation {
        Create,
        Update,
        Delete,
        Move,
    }
    for operation in [
        Operation::Create,
        Operation::Update,
        Operation::Delete,
        Operation::Move,
    ] {
        for access in [
            ash_file_access::PathAccess::Denied,
            ash_file_access::PathAccess::ReadOnly,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let dir = Dir::open_local(temp.path()).unwrap();
            let root = dir.canonical_path().to_path_buf();
            fs::create_dir(root.join("visible")).unwrap();
            fs::create_dir(root.join("restricted")).unwrap();
            fs::write(root.join("visible/file"), "old").unwrap();
            fs::write(root.join("restricted/file"), "secret").unwrap();
            let documents = restricted_documents(&dir, access);
            let token = CancellationSource::new().token();
            let snapshot = documents
                .read(&root.join("visible/file"), &token)
                .unwrap()
                .unwrap();
            let change = match operation {
                Operation::Create => TextDocumentChange::Create {
                    path: root.join("visible/new"),
                    text: "new".into(),
                },
                Operation::Update => TextDocumentChange::Update {
                    snapshot: snapshot.id,
                    text: "new".into(),
                },
                Operation::Delete => TextDocumentChange::Delete {
                    snapshot: snapshot.id,
                },
                Operation::Move => TextDocumentChange::Move {
                    snapshot: snapshot.id,
                    target: root.join("visible/new"),
                    text: "new".into(),
                },
            };
            let hook_root = root.clone();
            crate::local::tests::on_mutation_staging(move || {
                fs::rename(hook_root.join("visible"), hook_root.join("old")).unwrap();
                std::os::unix::fs::symlink("restricted", hook_root.join("visible")).unwrap();
            });
            documents.apply(vec![change], &token).unwrap();
            assert_eq!(
                fs::read_to_string(root.join("restricted/file")).unwrap(),
                "secret"
            );
            assert_eq!(fs::read_dir(root.join("restricted")).unwrap().count(), 1);
            match operation {
                Operation::Create | Operation::Move => {
                    assert_eq!(fs::read_to_string(root.join("old/new")).unwrap(), "new")
                }
                Operation::Update => {
                    assert_eq!(fs::read_to_string(root.join("old/file")).unwrap(), "new")
                }
                Operation::Delete => assert!(!root.join("old/file").exists()),
            }
            if matches!(operation, Operation::Move) {
                assert!(!root.join("old/file").exists());
            }
            assert_eq!(
                fs::read_dir(root.join("old")).unwrap().count(),
                if matches!(operation, Operation::Create) {
                    2
                } else if matches!(operation, Operation::Delete) {
                    0
                } else {
                    1
                }
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn document_edits_use_the_current_policy_for_cached_snapshots() {
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessRule;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    for access in [PathAccess::Denied, PathAccess::ReadOnly] {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let root = dir.canonical_path().to_path_buf();
        fs::create_dir(root.join("visible")).unwrap();
        fs::create_dir(root.join("restricted")).unwrap();
        fs::write(root.join("visible/file"), "same").unwrap();
        fs::write(root.join("restricted/file"), "same").unwrap();
        let grant = Grant::for_environment(
            dir.clone(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
        );
        let owner = std::sync::Arc::new(FileTextDocuments::new(dir));
        let reader = AuthorizedTextDocuments::new(
            grant.authorize(Permission::ReadFiles).unwrap(),
            owner.clone(),
            [],
        );
        let token = CancellationSource::new().token();
        let snapshot = reader
            .read(&root.join("visible/file"), &token)
            .unwrap()
            .unwrap();
        let policy = PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![PathAccessRule {
                pattern: "restricted".into(),
                access,
            }],
        )
        .unwrap();
        let writer = AuthorizedTextDocuments::new(
            grant
                .authorize(Permission::WriteFiles)
                .unwrap()
                .constrained_by(&policy),
            owner,
            [(snapshot.id.clone(), root.join("visible/file"))],
        );
        let hook_root = root.clone();
        AUTHORIZED_PATH_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                fs::rename(hook_root.join("visible"), hook_root.join("old")).unwrap();
                std::os::unix::fs::symlink("restricted", hook_root.join("visible")).unwrap();
            }))
        });
        assert!(
            writer
                .apply(
                    vec![TextDocumentChange::Update {
                        snapshot: snapshot.id,
                        text: "new".into()
                    }],
                    &token
                )
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(root.join("restricted/file")).unwrap(),
            "same"
        );
        assert_eq!(fs::read_to_string(root.join("old/file")).unwrap(), "same");
    }
}

#[cfg(unix)]
#[test]
fn document_operations_preserve_allowed_symlinks_and_create_missing_parents() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let root = dir.canonical_path();
    fs::create_dir(root.join("visible")).unwrap();
    fs::write(root.join("visible/file"), "old").unwrap();
    std::os::unix::fs::symlink("visible", root.join("alias")).unwrap();
    std::os::unix::fs::symlink("visible/file", root.join("leaf")).unwrap();
    let documents = restricted_documents(&dir, ash_file_access::PathAccess::Denied);
    let token = CancellationSource::new().token();
    let snapshot = documents.read(&root.join("leaf"), &token).unwrap().unwrap();
    documents
        .apply(
            vec![
                TextDocumentChange::Update {
                    snapshot: snapshot.id,
                    text: "updated".into(),
                },
                TextDocumentChange::Create {
                    path: root.join("alias/new/deep/file"),
                    text: "created".into(),
                },
            ],
            &token,
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("visible/file")).unwrap(),
        "updated"
    );
    assert_eq!(
        fs::read_to_string(root.join("visible/new/deep/file")).unwrap(),
        "created"
    );
    assert!(
        fs::symlink_metadata(root.join("leaf"))
            .unwrap()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn document_reads_still_allow_readonly_subtrees() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    fs::create_dir(dir.canonical_path().join("restricted")).unwrap();
    let path = dir.canonical_path().join("restricted/file");
    fs::write(&path, "readable").unwrap();
    let documents = restricted_documents(&dir, ash_file_access::PathAccess::ReadOnly);
    let token = CancellationSource::new().token();
    let snapshot = documents.read(&path, &token).unwrap().unwrap();
    assert_eq!(snapshot.text, "readable");
    assert!(
        documents
            .apply(
                vec![TextDocumentChange::Update {
                    snapshot: snapshot.id,
                    text: "changed".into(),
                }],
                &token
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "readable");
}

#[cfg(unix)]
#[test]
fn document_creation_cannot_read_a_replaced_editorconfig() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let root = dir.canonical_path().to_path_buf();
    fs::create_dir(root.join("visible")).unwrap();
    fs::create_dir(root.join("restricted")).unwrap();
    fs::write(
        root.join("visible/.editorconfig"),
        "[*]\nend_of_line = lf\n",
    )
    .unwrap();
    fs::write(
        root.join("restricted/.editorconfig"),
        "[*]\nend_of_line = crlf\n",
    )
    .unwrap();
    let documents = restricted_documents(&dir, ash_file_access::PathAccess::Denied);
    let hook_root = root.clone();
    crate::local::tests::on_read_resolution(move || {
        fs::rename(
            hook_root.join("visible/.editorconfig"),
            hook_root.join("original-config"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            "../restricted/.editorconfig",
            hook_root.join("visible/.editorconfig"),
        )
        .unwrap();
    });
    assert!(
        documents
            .apply(
                vec![TextDocumentChange::Create {
                    path: root.join("visible/new"),
                    text: "new\n".into(),
                }],
                &CancellationSource::new().token()
            )
            .is_err()
    );
    assert!(root.join("original-config").exists());
    assert!(!root.join("visible/new").exists());
    assert_eq!(fs::read_dir(root.join("restricted")).unwrap().count(), 1);
}

#[test]
fn cached_document_owners_cannot_rebind_a_policy_to_a_different_root() {
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    fs::create_dir(dir.canonical_path().join("nested")).unwrap();
    let path = dir.canonical_path().join("nested/file");
    fs::write(&path, "old").unwrap();
    let owner = std::sync::Arc::new(FileTextDocuments::new(dir.clone()));
    let token = CancellationSource::new().token();
    let snapshot = owner.read(&path, &token).unwrap().unwrap();
    let nested = Dir::open_local(dir.canonical_path().join("nested")).unwrap();
    let grant = Grant::for_environment(
        nested,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::WriteFiles]),
    );
    let documents = AuthorizedTextDocuments::new(
        grant.authorize(Permission::WriteFiles).unwrap(),
        owner,
        [(snapshot.id.clone(), path.clone())],
    );
    assert_eq!(
        documents.apply(
            vec![TextDocumentChange::Update {
                snapshot: snapshot.id,
                text: "new".into(),
            }],
            &token
        ),
        Err(TextDocumentError::Conflict)
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "old");
}
