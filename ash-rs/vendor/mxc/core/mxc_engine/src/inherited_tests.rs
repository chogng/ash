use super::*;

#[test]
fn helper_handoff_retains_embedding_authority_and_object_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let policy = crate::SandboxPolicy {
        version: "0.8.0-alpha".into(),
        filesystem: None,
        network: None,
        ui: None,
        timeout_ms: None,
    };
    let mut request = crate::build_request(&policy, None).unwrap();
    request
        .permit_host_acl_changes(std::slice::from_ref(&root))
        .unwrap();
    request.inner.host_filesystem = Some(wxc_common::host_changes::HostFilesystemAccess::ReadOnly);
    request.inner.host_filesystem_roots = vec![root.to_string_lossy().into_owned()];
    request.inner.require_process_security_environment = true;
    request.inner.prepared_files =
        Some(wxc_common::filesystem_object::FilesystemSnapshot::capture([root.clone()]).unwrap());
    request.inner.bubblewrap_executable = Some(root.join("bwrap"));
    let value: Launch = serde_json::from_str(&encode_inherited_launch(&request).unwrap()).unwrap();
    assert_eq!(value.host_acl_scope, request.inner.host_acl_scope);
    assert_eq!(value.host_filesystem, request.inner.host_filesystem);
    assert_eq!(
        value.host_filesystem_roots,
        request.inner.host_filesystem_roots
    );
    assert!(value.require_process_security_environment);
    assert_eq!(value.prepared_files, request.inner.prepared_files);
    assert_eq!(
        value.bubblewrap_executable,
        request.inner.bubblewrap_executable
    );
    value.prepared_files.as_ref().unwrap().validate().unwrap();
    std::fs::rename(&root, root.with_extension("moved")).unwrap();
    std::fs::create_dir(&root).unwrap();
    assert!(value.prepared_files.unwrap().validate().is_err());
    std::fs::remove_dir(root.with_extension("moved")).unwrap();
    // Ordinary public configuration still cannot populate embedding-only fields.
    assert!(value.request.host_acl_scope.is_none());
    assert!(value.request.host_filesystem.is_none());
    assert!(!value.request.require_process_security_environment);
}
