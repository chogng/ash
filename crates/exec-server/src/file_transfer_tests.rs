use super::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;
use std::cell::Cell;

struct Fixture {
    root: tempfile::TempDir,
    files: LocalFileSystem,
    dir: Dir,
    transfers: FileTransfers,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(root.path()).unwrap();
        let files = LocalFileSystem::new(Grant::for_environment(
            dir.clone(),
            GrantSource::HostConfiguration,
            Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
        ));
        Self {
            root,
            files,
            dir,
            transfers: Default::default(),
        }
    }
    fn request(&self, request: Request) -> Result<Response, Error> {
        match request {
            Request::FileRead {
                path,
                offset,
                expected_revision,
            } => self
                .transfers
                .read(&self.files, &path, offset, expected_revision.as_deref())
                .map(Response::File)
                .map_err(Error::Remote),
            request => self
                .transfers
                .write(&self.files, request)
                .map(Response::FileWrite)
                .map_err(Error::Remote),
        }
    }
    fn begin(&self, id: &str, bytes: &[u8], condition: WriteCondition) {
        assert!(matches!(
            self.request(Request::FileWriteBegin {
                operation_id: id.into(),
                path: "file".into(),
                total_bytes: bytes.len() as u64,
                content_revision: ash_file_system::file_revision(bytes),
                condition,
            })
            .unwrap(),
            Response::FileWrite(FileWriteState::Uploading { next_offset: 0 })
        ));
    }
}
fn payload(size: usize) -> Vec<u8> {
    (0..size).map(|index| (index % 256) as u8).collect()
}

#[test]
fn full_size_binary_file_uses_bounded_frames_and_one_revision() {
    let fixture = Fixture::new();
    let original = payload(MAX_FILE_BYTES);
    std::fs::write(fixture.root.path().join("file"), &original).unwrap();
    let count = Cell::new(0);
    let content = read_file(
        |request| {
            let response = fixture.request(request)?;
            let mut wire = Vec::new();
            crate::transport::write_frame(&mut wire, &response).unwrap();
            assert!(wire.len() <= exec_server_protocol::MAX_FRAME_BYTES);
            count.set(count.get() + 1);
            Ok(response)
        },
        "file",
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert_eq!(count.get(), MAX_FILE_BYTES / MAX_FILE_CHUNK_BYTES);
    assert_eq!(content.bytes, original);
    assert_eq!(content.revision, ash_file_system::file_revision(&original));
}

#[test]
fn changing_a_file_between_ranges_fails_the_whole_read() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.root.path().join("file"),
        payload(MAX_FILE_CHUNK_BYTES + 1),
    )
    .unwrap();
    let calls = Cell::new(0);
    let result = read_file(
        |request| {
            let response = fixture.request(request)?;
            if calls.get() == 0 {
                std::fs::write(
                    fixture.root.path().join("file"),
                    payload(MAX_FILE_CHUNK_BYTES + 2),
                )
                .unwrap();
            }
            calls.set(calls.get() + 1);
            Ok(response)
        },
        "file",
        &CancellationSource::new().token(),
    );
    assert!(matches!(result, Err(Error::Remote(ExecError::Conflict))));
    assert_eq!(
        calls.get(),
        1,
        "a conflicting range does not return partial contents"
    );
}

#[test]
fn chunks_do_not_publish_and_two_writers_cannot_commit_the_same_revision() {
    let fixture = Fixture::new();
    std::fs::write(fixture.root.path().join("file"), b"old").unwrap();
    let revision = ash_file_system::file_revision(b"old");
    for id in ["first", "second"] {
        fixture.begin(
            id,
            b"new",
            WriteCondition::ExpectedRevision(revision.clone()),
        );
        fixture
            .request(Request::FileWriteChunk {
                operation_id: id.into(),
                offset: 0,
                bytes: b"new".to_vec(),
            })
            .unwrap();
        assert_eq!(
            std::fs::read(fixture.root.path().join("file")).unwrap(),
            b"old"
        );
    }
    let first = fixture
        .request(Request::FileWriteCommit {
            operation_id: "first".into(),
        })
        .unwrap();
    assert!(matches!(
        first,
        Response::FileWrite(FileWriteState::Committed { .. })
    ));
    assert!(matches!(
        fixture
            .request(Request::FileWriteCommit {
                operation_id: "second".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Rejected {
            error: ExecError::Conflict
        })
    ));
    std::fs::write(fixture.root.path().join("file"), b"later edit").unwrap();
    assert_eq!(
        serde_json::to_value(
            fixture
                .request(Request::FileWriteCommit {
                    operation_id: "first".into()
                })
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(first).unwrap()
    );
    assert_eq!(
        std::fs::read(fixture.root.path().join("file")).unwrap(),
        b"later edit",
        "a repeated commit returns its receipt without writing again"
    );
}

#[test]
fn incomplete_out_of_order_duplicate_and_aborted_uploads_never_publish() {
    let fixture = Fixture::new();
    fixture.begin("upload", &[1, 2, 3], WriteCondition::MissingOrEmpty);
    for request in [
        Request::FileWriteCommit {
            operation_id: "upload".into(),
        },
        Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 1,
            bytes: vec![1],
        },
        Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 0,
            bytes: vec![1; 4],
        },
    ] {
        assert!(matches!(
            fixture.request(request),
            Err(Error::Remote(ExecError::Conflict))
        ));
    }
    fixture
        .request(Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 0,
            bytes: vec![1],
        })
        .unwrap();
    assert!(matches!(
        fixture.request(Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 0,
            bytes: vec![1]
        }),
        Err(Error::Remote(ExecError::Conflict))
    ));
    assert!(matches!(
        fixture
            .request(Request::FileWriteAbort {
                operation_id: "upload".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Aborted)
    ));
    assert!(matches!(
        fixture
            .request(Request::FileWriteCommit {
                operation_id: "upload".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Aborted)
    ));
    assert!(!fixture.root.path().join("file").exists());
}

#[test]
fn lost_commit_response_queries_the_receipt_without_repeating_a_mutation() {
    let fixture = Fixture::new();
    let commits = Cell::new(0);
    let statuses = Cell::new(0);
    write_file(
        |request| {
            let commit = matches!(request, Request::FileWriteCommit { .. });
            if matches!(request, Request::FileWriteStatus { .. }) {
                statuses.set(statuses.get() + 1);
            }
            let response = fixture.request(request)?;
            if commit {
                commits.set(commits.get() + 1);
                std::fs::write(fixture.root.path().join("file"), b"later edit").unwrap();
                return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
            }
            Ok(response)
        },
        "upload",
        "file",
        b"committed",
        WriteCondition::MissingOrEmpty,
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert_eq!((commits.get(), statuses.get()), (1, 1));
    assert_eq!(
        std::fs::read(fixture.root.path().join("file")).unwrap(),
        b"later edit"
    );
}

#[test]
fn a_lost_chunk_response_does_not_repeat_or_commit() {
    let fixture = Fixture::new();
    let chunks = Cell::new(0);
    let commits = Cell::new(0);
    let result = write_file(
        |request| {
            let chunk = matches!(request, Request::FileWriteChunk { .. });
            if matches!(request, Request::FileWriteCommit { .. }) {
                commits.set(commits.get() + 1);
            }
            let response = fixture.request(request)?;
            if chunk {
                chunks.set(chunks.get() + 1);
                return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
            }
            Ok(response)
        },
        "upload",
        "file",
        &payload(MAX_FILE_CHUNK_BYTES + 1),
        WriteCondition::MissingOrEmpty,
        &CancellationSource::new().token(),
    );
    assert!(matches!(result, Err(Error::FileNotPublished(_))));
    assert_eq!((chunks.get(), commits.get()), (1, 0));
    assert!(!fixture.root.path().join("file").exists());
}

#[test]
fn cancellation_aborts_an_upload_before_publication() {
    let fixture = Fixture::new();
    let cancellation = CancellationSource::new();
    let result = write_file(
        |request| {
            let chunk = matches!(request, Request::FileWriteChunk { .. });
            let response = fixture.request(request)?;
            if chunk {
                cancellation.cancel();
            }
            Ok(response)
        },
        "upload",
        "file",
        &payload(MAX_FILE_CHUNK_BYTES + 1),
        WriteCondition::MissingOrEmpty,
        &cancellation.token(),
    );
    assert!(matches!(result, Err(Error::Cancelled(_))));
    assert!(!fixture.root.path().join("file").exists());
    assert!(matches!(
        fixture
            .request(Request::FileWriteStatus {
                operation_id: "upload".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Aborted)
    ));
}

#[test]
fn capacity_is_reserved_before_upload_and_expiry_releases_it() {
    let fixture = Fixture::new();
    for index in 0..6 {
        fixture.begin(
            &format!("upload-{index}"),
            &payload(MAX_FILE_BYTES),
            WriteCondition::MissingOrEmpty,
        );
    }
    assert!(matches!(
        fixture.request(Request::FileWriteBegin {
            operation_id: "seventh".into(),
            path: "file".into(),
            total_bytes: MAX_FILE_BYTES as u64,
            content_revision: ash_file_system::file_revision(&payload(MAX_FILE_BYTES)),
            condition: WriteCondition::MissingOrEmpty
        }),
        Err(Error::Remote(ExecError::Busy))
    ));
    {
        let mut uploads = fixture.transfers.uploads.lock().unwrap();
        expire(&mut uploads, Instant::now() + UPLOAD_LIFETIME);
        assert!(
            uploads
                .values()
                .all(|upload| upload.bytes.is_empty() && upload.state == FileWriteState::Aborted)
        );
    }
    fixture.begin(
        "seventh",
        &payload(MAX_FILE_BYTES),
        WriteCondition::MissingOrEmpty,
    );
}

#[test]
fn empty_files_and_the_size_boundary_follow_the_same_contract() {
    let fixture = Fixture::new();
    let cancellation = CancellationSource::new().token();
    write_file(
        |request| fixture.request(request),
        "empty",
        "file",
        b"",
        WriteCondition::MissingOrEmpty,
        &cancellation,
    )
    .unwrap();
    let empty = read_file(|request| fixture.request(request), "file", &cancellation).unwrap();
    assert!(empty.bytes.is_empty());
    assert_eq!(empty.revision, ash_file_system::file_revision(b""));
    assert!(matches!(
        write_file(
            |request| fixture.request(request),
            "oversized",
            "file",
            &payload(MAX_FILE_BYTES + 1),
            WriteCondition::MissingOrEmpty,
            &cancellation
        ),
        Err(Error::Remote(ExecError::InvalidInput))
    ));
}

#[test]
fn upload_content_and_identity_are_fixed_before_any_publication() {
    let fixture = Fixture::new();
    fixture.begin("upload", b"expected", WriteCondition::MissingOrEmpty);
    assert!(matches!(
        fixture.request(Request::FileWriteBegin {
            operation_id: "upload".into(),
            path: "file".into(),
            total_bytes: 8,
            content_revision: ash_file_system::file_revision(b"changed!"),
            condition: WriteCondition::MissingOrEmpty,
        }),
        Err(Error::Remote(ExecError::Conflict))
    ));
    fixture
        .request(Request::FileWriteChunk {
            operation_id: "upload".into(),
            offset: 0,
            bytes: b"changed!".to_vec(),
        })
        .unwrap();
    assert!(matches!(
        fixture
            .request(Request::FileWriteCommit {
                operation_id: "upload".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Rejected {
            error: ExecError::Conflict
        })
    ));
    assert!(!fixture.root.path().join("file").exists());
}

#[test]
fn read_only_authority_denies_uploads_before_allocating_resources() {
    let fixture = Fixture::new();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(fixture.root.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ReadFiles]),
    ));
    assert_eq!(
        fixture.transfers.write(
            &files,
            Request::FileWriteBegin {
                operation_id: "denied".into(),
                path: "file".into(),
                total_bytes: MAX_FILE_BYTES as u64,
                content_revision: ash_file_system::file_revision(&payload(MAX_FILE_BYTES)),
                condition: WriteCondition::MissingOrEmpty,
            }
        ),
        Err(ExecError::PermissionDenied)
    );
    assert!(fixture.transfers.uploads.lock().unwrap().is_empty());
}

#[test]
fn malformed_revisions_and_oversized_chunks_do_not_consume_upload_capacity() {
    let fixture = Fixture::new();
    for (content_revision, condition) in [
        ("invalid".into(), WriteCondition::MissingOrEmpty),
        (
            ash_file_system::file_revision(b"x"),
            WriteCondition::ExpectedRevision("invalid".into()),
        ),
    ] {
        assert_eq!(
            fixture.transfers.write(
                &fixture.files,
                Request::FileWriteBegin {
                    operation_id: "invalid".into(),
                    path: "file".into(),
                    total_bytes: 1,
                    content_revision,
                    condition,
                }
            ),
            Err(ExecError::InvalidInput)
        );
        assert!(fixture.transfers.uploads.lock().unwrap().is_empty());
    }
    fixture.begin(
        "chunk",
        &payload(MAX_FILE_CHUNK_BYTES + 1),
        WriteCondition::MissingOrEmpty,
    );
    assert!(matches!(
        fixture.request(Request::FileWriteChunk {
            operation_id: "chunk".into(),
            offset: 0,
            bytes: payload(MAX_FILE_CHUNK_BYTES + 1),
        }),
        Err(Error::Remote(ExecError::InvalidInput))
    ));
    assert!(matches!(
        fixture
            .request(Request::FileWriteStatus {
                operation_id: "chunk".into()
            })
            .unwrap(),
        Response::FileWrite(FileWriteState::Uploading { next_offset: 0 })
    ));
}

#[test]
fn filesystem_io_failure_keeps_an_unknown_terminal_result_instead_of_claiming_rejection() {
    let fixture = Fixture::new();
    fixture.begin("io", b"x", WriteCondition::MissingOrEmpty);
    fixture
        .request(Request::FileWriteChunk {
            operation_id: "io".into(),
            offset: 0,
            bytes: b"x".to_vec(),
        })
        .unwrap();
    let dir = fixture.dir.clone();
    assert!(
        std::thread::spawn(move || {
            let _lock = dir.directory().lock_writes().unwrap();
            panic!("simulate an interrupted filesystem writer");
        })
        .join()
        .is_err()
    );
    for request in [
        Request::FileWriteCommit {
            operation_id: "io".into(),
        },
        Request::FileWriteStatus {
            operation_id: "io".into(),
        },
        Request::FileWriteCommit {
            operation_id: "io".into(),
        },
    ] {
        assert!(matches!(
            fixture.request(request).unwrap(),
            Response::FileWrite(FileWriteState::OutcomeUnknown)
        ));
    }
    assert!(matches!(
        committed(FileWriteState::OutcomeUnknown, b"x"),
        Err(Error::OutcomeUnknown)
    ));
}
