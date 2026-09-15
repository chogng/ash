use super::*;
use crate::{FileSystemAccess, NetworkAccess};
use crate::{SandboxDirAccess, SandboxDirGrant, SandboxScope};
use ash_file_access::Dir;
use std::fs;
use std::path::Path;

struct RecordingBackend;

impl SandboxBackend for RecordingBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        _policy: SandboxPolicy,
        _dir: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        assert!(command.working_directory().is_absolute());
        Ok(PreparedCommand::unrestricted(command))
    }
}

#[test]
fn backend_without_scoped_support_fails_closed() {
    let fixture = tempfile::tempdir().unwrap();
    let first = fixture.path().join("first");
    let second = fixture.path().join("second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let first = Dir::open_local(first).unwrap();
    let second = Dir::open_local(second).unwrap();
    let scope = SandboxScope::new(
        first.clone(),
        vec![
            SandboxDirGrant::new(first.clone(), SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(second, SandboxDirAccess::ReadWrite),
        ],
        Vec::new(),
    )
    .unwrap();
    let manager = SandboxManager::new(first, RecordingBackend);
    let command = SandboxCommand::new("echo", ["hello"], ".");

    let error = manager
        .prepare_scoped(
            &command,
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            &scope,
        )
        .unwrap_err();

    assert!(matches!(error, SandboxError::BackendUnavailable { .. }));
}

#[test]
fn manager_resolves_the_working_directory_before_backend_dispatch() {
    let dir = Dir::open_local(".").unwrap();
    let manager = SandboxManager::new(dir.clone(), RecordingBackend);
    let command = SandboxCommand::new("echo", ["hello"], ".");

    let prepared = manager
        .prepare(
            &command,
            SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied),
        )
        .unwrap();

    assert_eq!(prepared.working_directory(), dir.canonical_path());
    assert_eq!(prepared.program(), "echo");
    assert_eq!(prepared.arguments(), ["hello"]);
    assert_eq!(prepared.kind(), SandboxKind::Unrestricted);
    assert!(Path::new(prepared.working_directory()).is_absolute());
}
