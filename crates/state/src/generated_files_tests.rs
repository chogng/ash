use super::*;

fn registration() -> GeneratedFileRegistration {
    GeneratedFileRegistration {
        id: "a".repeat(64),
        resource: "ash-profile:/generated/review.md".into(),
        title: "Review 评审".into(),
        content_type: "text/markdown".into(),
        source: GeneratedFileSource {
            provider_id: "provider".into(),
            account_id: None,
            session_id: "session".into(),
            thread_id: "thread".into(),
            item_id: "item".into(),
            part_id: "part".into(),
        },
    }
}

fn created(outcome: GeneratedFileRegistrationOutcome) -> GeneratedFileRecord {
    match outcome {
        GeneratedFileRegistrationOutcome::Created(record) => record,
        GeneratedFileRegistrationOutcome::Existing(_) => panic!("expected a new reference"),
    }
}

#[test]
fn generated_files_retry_preserves_original_metadata_and_rejects_identity_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap();
    let file = registration();
    let original = created(store.register("ui", &file).unwrap());
    assert!(original.created_at > 0);
    let mut retry = file.clone();
    retry.title = "Revised title".into();
    retry.content_type = "text/plain".into();
    match store.register("ui", &retry).unwrap() {
        GeneratedFileRegistrationOutcome::Existing(record) => assert_eq!(record, original),
        GeneratedFileRegistrationOutcome::Created(_) => panic!("retry inserted another record"),
    }
    for changed in [
        GeneratedFileRegistration {
            resource: "file:///other.md".into(),
            ..file.clone()
        },
        GeneratedFileRegistration {
            source: GeneratedFileSource {
                part_id: "other".into(),
                ..file.source.clone()
            },
            ..file.clone()
        },
    ] {
        assert!(matches!(
            store.register("ui", &changed),
            Err(GeneratedFileError::Conflict)
        ));
    }
    assert_eq!(store.list("ui", &[]).unwrap(), vec![original]);
}

#[test]
fn generated_files_source_identity_includes_every_field_and_client_namespace() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap();
    let file = registration();
    created(store.register("ui", &file).unwrap());
    let mut duplicate = file.clone();
    duplicate.id = "b".repeat(64);
    assert!(matches!(
        store.register("ui", &duplicate),
        Err(GeneratedFileError::Conflict)
    ));
    created(store.register("other-ui", &duplicate).unwrap());
    let mut sources = Vec::new();
    for field in 0..6 {
        let mut source = file.source.clone();
        match field {
            0 => source.provider_id = "other".into(),
            1 => source.account_id = Some("account".into()),
            2 => source.session_id = "other".into(),
            3 => source.thread_id = "other".into(),
            4 => source.item_id = "other".into(),
            5 => source.part_id = "other".into(),
            _ => unreachable!(),
        }
        sources.push(source);
    }
    for (index, source) in sources.into_iter().enumerate() {
        let changed = GeneratedFileRegistration {
            id: format!("{index:064x}"),
            source,
            ..file.clone()
        };
        created(store.register("ui", &changed).unwrap());
        let duplicate = GeneratedFileRegistration {
            id: "f".repeat(64),
            ..changed
        };
        assert!(matches!(
            store.register("ui", &duplicate),
            Err(GeneratedFileError::Conflict)
        ));
    }
    assert_eq!(store.list("ui", &["account".into()]).unwrap().len(), 7);
    assert_eq!(store.list("other-ui", &[]).unwrap().len(), 1);
}

#[test]
fn generated_files_unique_index_deduplicates_null_and_named_accounts() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap();
    for account_id in [None, Some("account".into())] {
        let file = GeneratedFileRegistration {
            source: GeneratedFileSource {
                account_id,
                ..registration().source
            },
            ..registration()
        };
        // Each namespace tests the SQL constraint independently of the store's preflight.
        let client_id = file.source.account_id.as_deref().unwrap_or("anonymous");
        created(store.register(client_id, &file).unwrap());
        let connection = store.connection.lock().unwrap();
        let error = connection
            .execute(
                "INSERT INTO generated_files SELECT client_id, ?1, resource, title, content_type,
             provider_id, account_id, session_id, thread_id, item_id, part_id, created_at
             FROM generated_files WHERE client_id = ?2",
                params!["b".repeat(64), client_id],
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );
    }
}

#[test]
fn generated_files_survive_reopen_and_remain_isolated_between_profiles() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite");
    let original = {
        let store = SqliteGeneratedFileStore::open(&path).unwrap();
        created(store.register("ui", &registration()).unwrap())
    };
    let reopened = SqliteGeneratedFileStore::open(&path).unwrap();
    assert_eq!(reopened.list("ui", &[]).unwrap(), vec![original.clone()]);
    assert!(reopened.list("other-ui", &[]).unwrap().is_empty());
    let other = SqliteGeneratedFileStore::open(&directory.path().join("other.sqlite")).unwrap();
    assert!(other.list("ui", &[]).unwrap().is_empty());
    assert_eq!(reopened.list("ui", &[]).unwrap(), vec![original]);
}

#[test]
fn generated_files_separate_connections_register_one_source_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite");
    let first = SqliteGeneratedFileStore::open(&path).unwrap();
    let second = SqliteGeneratedFileStore::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let attempts = [first, second]
        .into_iter()
        .enumerate()
        .map(|(index, store)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let file = GeneratedFileRegistration {
                    id: format!("{index:064x}"),
                    ..registration()
                };
                barrier.wait();
                store.register("ui", &file)
            })
        })
        .collect::<Vec<_>>();
    let outcomes = attempts
        .into_iter()
        .map(|attempt| attempt.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Ok(GeneratedFileRegistrationOutcome::Created(_))))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(GeneratedFileError::Conflict)))
            .count(),
        1
    );
    assert_eq!(
        SqliteGeneratedFileStore::open(&path)
            .unwrap()
            .list("ui", &[])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn generated_files_validate_metadata_at_the_store_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap();
    for client_id in ["".into(), " ".into(), "a".repeat(1025), "ui\0other".into()] {
        assert!(matches!(
            store.register(&client_id, &registration()),
            Err(GeneratedFileError::Invalid)
        ));
        assert!(matches!(
            store.list(&client_id, &[]),
            Err(GeneratedFileError::Invalid)
        ));
    }
    for field in 0..11 {
        for value in ["".to_owned(), "\0".to_owned(), "x".repeat(16385)] {
            let mut file = registration();
            match field {
                0 => file.id = value,
                1 => file.resource = value,
                2 => file.title = value,
                3 => file.content_type = value,
                4 => file.source.provider_id = value,
                5 => file.source.account_id = Some(value),
                6 => file.source.session_id = value,
                7 => file.source.thread_id = value,
                8 => file.source.item_id = value,
                9 => file.source.part_id = value,
                10 => file.id = "g".repeat(64),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    store.register("ui", &file),
                    Err(GeneratedFileError::Invalid)
                ),
                "field {field}"
            );
        }
    }
    assert!(store.list("ui", &[]).unwrap().is_empty());
}

#[test]
fn native_publication_is_acknowledged_once_across_store_instances() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("state.sqlite");
    let id = "f".repeat(64);
    let store = SqliteGeneratedFileStore::open(&database).unwrap();
    store.connection.lock().unwrap().execute(
        "INSERT INTO generated_file_publications VALUES (?1, 'session', 'thread', 'item', 'Title', '# Original')",
        [&id],
    ).unwrap();

    let reopened = SqliteGeneratedFileStore::open(&database).unwrap();
    for reader in [&store, &reopened] {
        assert_eq!(reader.pending_native_ids().unwrap(), [id.as_str()]);
        assert_eq!(
            reader.pending_native_markdown(&id).unwrap().as_deref(),
            Some("# Original")
        );
        assert!(!reader.has_native_file(&id).unwrap());
    }
    assert!(
        reopened
            .finish_native_publication(&id, "file:///first.md")
            .unwrap()
    );
    assert!(
        !store
            .finish_native_publication(&id, "file:///retry.md")
            .unwrap()
    );
    assert!(store.pending_native_ids().unwrap().is_empty());
    assert!(store.has_native_file(&id).unwrap());
    let records = store.list(NATIVE_GENERATED_FILE_CLIENT, &[]).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].file.id, id);
    assert_eq!(records[0].file.resource, "file:///first.md");
}

#[test]
fn native_reference_wins_over_a_visible_import_with_the_same_id() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteGeneratedFileStore::open(&temp.path().join("state.sqlite")).unwrap();
    let file = registration();
    created(store.register("ui", &file).unwrap());
    store.connection.lock().unwrap().execute(
        "INSERT INTO generated_file_publications VALUES (?1, 'session', 'thread', 'item', 'Title', '# Original')",
        [&file.id],
    ).unwrap();
    assert!(
        store
            .finish_native_publication(&file.id, "file:///native.md")
            .unwrap()
    );
    let records = store.list("ui", &[]).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].file.resource, "file:///native.md");
}
