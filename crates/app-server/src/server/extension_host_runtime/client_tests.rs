use super::MAX_FILE_BYTES;
use super::WorkspaceReadAccess;
use super::read_workspace_file;
use ash_async_utils::CancellationSource;
use ash_external_ext::HostErrorCode;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::FileSystem;
use ash_file_system::LocalFileSystem;
use external_ext_protocol::ExtensionClientResult;
use std::sync::Arc;

#[test]
fn reads_only_when_package_and_current_directory_both_allow_it() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("data.txt"), "authorized text").unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );
    let files: Arc<dyn FileSystem> = Arc::new(LocalFileSystem::new(grant.clone()));
    let files = Ok(files);
    let cancellation = CancellationSource::new();
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "data.txt",
            &cancellation.token()
        )
        .unwrap(),
        ExtensionClientResult::File {
            text: "authorized text".into()
        }
    );
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Denied,
            &files,
            "data.txt",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::PermissionDenied
    );
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "../data.txt",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::InvalidRequest
    );
    grant.revoke();
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "data.txt",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::PermissionDenied
    );
}

#[test]
fn rejects_oversized_binary_and_cancelled_reads() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("binary"), [255]).unwrap();
    std::fs::write(directory.path().join("escaped"), vec![0; MAX_FILE_BYTES]).unwrap();
    let large = std::fs::File::create(directory.path().join("large")).unwrap();
    large.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );
    let files: Arc<dyn FileSystem> = Arc::new(LocalFileSystem::new(grant));
    let files = Ok(files);
    let cancellation = CancellationSource::new();
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "binary",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::InvalidRequest
    );
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "large",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::QuotaExceeded
    );
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "escaped",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::QuotaExceeded
    );
    cancellation.cancel();
    assert_eq!(
        read_workspace_file(
            WorkspaceReadAccess::Read,
            &files,
            "binary",
            &cancellation.token()
        )
        .unwrap_err()
        .code,
        HostErrorCode::Cancelled
    );
}
