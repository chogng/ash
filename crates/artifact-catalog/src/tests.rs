use super::*;

#[test]
fn catalog_registers_non_document_resources_without_installing_document_storage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite");
    let store = SqliteArtifactCatalog::open(&path).unwrap();
    let file = ArtifactRegistration {
        resource: "file:///images/chart.svg".into(),
        content_type: "image/svg+xml".into(),
        ..registration()
    };
    let record = created(store.register("ui", &file).unwrap());
    assert_eq!(store.list("ui", &[]).unwrap(), [record]);
    assert!(!directory.path().join("images").exists());
    assert_eq!(store.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name LIKE '%publication%'", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
}

fn registration() -> ArtifactRegistration {
    ArtifactRegistration {
        id: "a".repeat(64),
        resource: "ash-profile:/generated/review.md".into(),
        title: "Review 评审".into(),
        content_type: "text/markdown".into(),
        source: ArtifactSource {
            provider_id: "provider".into(),
            account_id: None,
            session_id: "session".into(),
            thread_id: "thread".into(),
            item_id: "item".into(),
            part_id: "part".into(),
        },
    }
}

fn created(outcome: ArtifactRegistrationOutcome) -> ArtifactRecord {
    match outcome {
        ArtifactRegistrationOutcome::Created(record) => record,
        ArtifactRegistrationOutcome::Existing(_) => panic!("expected a new reference"),
    }
}

#[test]
fn artifact_catalog_retry_preserves_original_metadata_and_rejects_identity_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap();
    let file = registration();
    let original = created(store.register("ui", &file).unwrap());
    assert!(original.created_at > 0);
    let mut retry = file.clone();
    retry.title = "Revised title".into();
    retry.content_type = "text/plain".into();
    match store.register("ui", &retry).unwrap() {
        ArtifactRegistrationOutcome::Existing(record) => assert_eq!(record, original),
        ArtifactRegistrationOutcome::Created(_) => panic!("retry inserted another record"),
    }
    for changed in [
        ArtifactRegistration {
            resource: "file:///other.md".into(),
            ..file.clone()
        },
        ArtifactRegistration {
            source: ArtifactSource {
                part_id: "other".into(),
                ..file.source.clone()
            },
            ..file.clone()
        },
    ] {
        assert!(matches!(
            store.register("ui", &changed),
            Err(ArtifactCatalogError::Conflict)
        ));
    }
    assert_eq!(store.list("ui", &[]).unwrap(), vec![original]);
}

#[test]
fn artifact_catalog_source_identity_includes_every_field_and_client_namespace() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap();
    let file = registration();
    created(store.register("ui", &file).unwrap());
    let mut duplicate = file.clone();
    duplicate.id = "b".repeat(64);
    assert!(matches!(
        store.register("ui", &duplicate),
        Err(ArtifactCatalogError::Conflict)
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
        let changed = ArtifactRegistration {
            id: format!("{index:064x}"),
            source,
            ..file.clone()
        };
        created(store.register("ui", &changed).unwrap());
        let duplicate = ArtifactRegistration {
            id: "f".repeat(64),
            ..changed
        };
        assert!(matches!(
            store.register("ui", &duplicate),
            Err(ArtifactCatalogError::Conflict)
        ));
    }
    assert_eq!(store.list("ui", &["account".into()]).unwrap().len(), 7);
    assert_eq!(store.list("other-ui", &[]).unwrap().len(), 1);
}

#[test]
fn artifact_catalog_unique_index_deduplicates_null_and_named_accounts() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap();
    for account_id in [None, Some("account".into())] {
        let file = ArtifactRegistration {
            source: ArtifactSource {
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
                "INSERT INTO artifact_catalog SELECT client_id, ?1, resource, title, content_type,
             provider_id, account_id, session_id, thread_id, item_id, part_id, created_at
             FROM artifact_catalog WHERE client_id = ?2",
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
fn artifact_catalog_survive_reopen_and_remain_isolated_between_profiles() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite");
    let original = {
        let store = SqliteArtifactCatalog::open(&path).unwrap();
        created(store.register("ui", &registration()).unwrap())
    };
    let reopened = SqliteArtifactCatalog::open(&path).unwrap();
    assert_eq!(reopened.list("ui", &[]).unwrap(), vec![original.clone()]);
    assert!(reopened.list("other-ui", &[]).unwrap().is_empty());
    let other = SqliteArtifactCatalog::open(&directory.path().join("other.sqlite")).unwrap();
    assert!(other.list("ui", &[]).unwrap().is_empty());
    assert_eq!(reopened.list("ui", &[]).unwrap(), vec![original]);
}

#[test]
fn artifact_catalog_separate_connections_register_one_source_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite");
    let first = SqliteArtifactCatalog::open(&path).unwrap();
    let second = SqliteArtifactCatalog::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let attempts = [first, second]
        .into_iter()
        .enumerate()
        .map(|(index, store)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let file = ArtifactRegistration {
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
            .filter(|result| matches!(result, Ok(ArtifactRegistrationOutcome::Created(_))))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(ArtifactCatalogError::Conflict)))
            .count(),
        1
    );
    assert_eq!(
        SqliteArtifactCatalog::open(&path)
            .unwrap()
            .list("ui", &[])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn artifact_catalog_validate_metadata_at_the_store_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap();
    for client_id in ["".into(), " ".into(), "a".repeat(1025), "ui\0other".into()] {
        assert!(matches!(
            store.register(&client_id, &registration()),
            Err(ArtifactCatalogError::Invalid)
        ));
        assert!(matches!(
            store.list(&client_id, &[]),
            Err(ArtifactCatalogError::Invalid)
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
                    Err(ArtifactCatalogError::Invalid)
                ),
                "field {field}"
            );
        }
    }
    assert!(store.list("ui", &[]).unwrap().is_empty());
}

#[test]
fn native_registration_is_create_only_and_cannot_use_an_imported_account_identity() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteArtifactCatalog::open(&temp.path().join("state.sqlite")).unwrap();
    let file = ArtifactRegistration {
        source: ArtifactSource {
            provider_id: "local-agent-host".into(),
            part_id: "markdown".into(),
            ..registration().source
        },
        ..registration()
    };
    assert!(matches!(
        store.register(NATIVE_ARTIFACT_CLIENT, &file),
        Err(ArtifactCatalogError::Invalid)
    ));
    let first = created(store.register_native(&file).unwrap());
    let retry = ArtifactRegistration {
        title: "Later title".into(),
        ..file.clone()
    };
    match store.register_native(&retry).unwrap() {
        ArtifactRegistrationOutcome::Existing(record) => assert_eq!(record, first),
        ArtifactRegistrationOutcome::Created(_) => {
            panic!("native replay created a second record")
        }
    }
    let imported = ArtifactRegistration {
        source: ArtifactSource {
            account_id: Some("account".into()),
            ..file.source
        },
        ..file
    };
    assert!(matches!(
        store.register_native(&imported),
        Err(ArtifactCatalogError::Invalid)
    ));
}
