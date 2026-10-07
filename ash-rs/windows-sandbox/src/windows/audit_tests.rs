use super::*;

fn sddl(path: &Path) -> String {
    use windows_sys::Win32::Security::Authorization::*;
    let mut descriptor = std::ptr::null_mut();
    assert_eq!(
        unsafe {
            GetNamedSecurityInfoW(
                win::wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        },
        0
    );
    let _descriptor = win::Local(descriptor);
    let mut text = std::ptr::null_mut();
    let mut length = 0;
    assert_ne!(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                &mut length,
            )
        },
        0
    );
    let _text = win::Local(text.cast());
    let text = unsafe { std::slice::from_raw_parts(text, length as usize) };
    String::from_utf16(text.split(|unit| *unit == 0).next().unwrap()).unwrap()
}

#[test]
fn ancestor_traversal_does_not_grant_listing_or_inherit_to_children() {
    let temp = tempfile::tempdir().unwrap();
    let child = temp.path().join("private-child");
    std::fs::write(&child, "private").unwrap();
    // Preserve a historical inherited ACE that differs from today's parent.
    // SetNamedSecurityInfoW would silently replace it during an ancestor edit.
    let owner = win::current_user().unwrap();
    let child_acl = win::descriptor(&format!(
        "D:AIAR(A;;GA;;;{owner})(A;ID;GR;;;S-1-5-21-541-542-543-544)"
    ))
    .unwrap();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                win::wide(&child).as_ptr(),
                DACL_SECURITY_INFORMATION,
                child_acl.0,
            )
        },
        0
    );
    let sid = "S-1-5-21-531-532-533-534";
    let before = sddl(temp.path());
    let child_before = sddl(&child);
    let mut acl =
        mxc_sdk::mxc_common::filesystem_dacl::DaclManager::in_directory(&temp.path().join("journal"))
            .unwrap();
    assert!(!mask_allowed(temp.path(), &[sid], FILE_READ_ATTRIBUTES).unwrap());
    acl.grant_directory_traversal(sid, temp.path()).unwrap();
    assert!(mask_allowed(temp.path(), &[sid], FILE_READ_ATTRIBUTES).unwrap());
    assert!(!mask_allowed(temp.path(), &[sid], FILE_LIST_DIRECTORY | MUTATION).unwrap());
    assert!(!mask_allowed(&child, &[sid], FILE_READ_ATTRIBUTES | FILE_READ_DATA).unwrap());
    assert_eq!(
        sddl(&child),
        child_before,
        "ancestor writes must not recalculate child ACLs"
    );
    acl.restore_strict().unwrap();
    assert!(!mask_allowed(temp.path(), &[sid], FILE_READ_ATTRIBUTES).unwrap());
    assert_eq!(
        sddl(temp.path()),
        before,
        "restoration must preserve inheritance control flags"
    );
    assert_eq!(sddl(&child), child_before);
}

#[test]
fn audit_checks_world_writable_files_as_well_as_directories() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("world-writable");
    std::fs::write(&path, "unchanged").unwrap();
    let owner = win::current_user().unwrap();
    let sd = win::descriptor(&format!("D:P(A;;GA;;;{owner})(A;;GW;;;WD)")).unwrap();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                win::wide(&path).as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                sd.0,
            )
        },
        0
    );
    assert!(world_writable(&path).unwrap());
    let report = scan([temp.path().to_owned()]);
    assert!(
        report
            .flagged
            .contains(&std::fs::canonicalize(&path).unwrap())
    );
    assert!(!report.truncated);
}

#[test]
fn object_acl_edits_preserve_legacy_inheritance_control() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("legacy");
    std::fs::create_dir(&target).unwrap();
    let owner = win::current_user().unwrap();
    let descriptor = win::descriptor(&format!("D:(A;OICIID;FA;;;{owner})")).unwrap();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                win::wide(&target).as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.0,
            )
        },
        0
    );
    let before = sddl(&target);
    assert!(before.starts_with("D:("), "legacy fixture: {before}");
    let mut acl =
        mxc_sdk::mxc_common::filesystem_dacl::DaclManager::in_directory(&temp.path().join("journal"))
            .unwrap();
    acl.grant_directory_traversal("S-1-5-21-531-532-533-534", &target)
        .unwrap();
    acl.restore_strict().unwrap();
    assert_eq!(sddl(&target), before);
}

#[test]
fn inheritable_acl_edits_restore_legacy_directory_and_file_control() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("legacy");
    std::fs::create_dir(&target).unwrap();
    let child = target.join("child");
    std::fs::write(&child, "unchanged").unwrap();
    for path in [&target, &child] {
        // CI creates descriptors with the correct inherited ACEs but no AI
        // control bit. Preserve those ACEs when creating the same baseline.
        let descriptor = win::descriptor(&sddl(path).replacen("D:AI", "D:", 1)).unwrap();
        assert_ne!(
            unsafe {
                SetFileSecurityW(
                    win::wide(path).as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    descriptor.0,
                )
            },
            0
        );
    }
    let before = [&target, &child].map(|path| sddl(path));
    assert!(
        before.iter().all(|acl| acl.starts_with("D:(")),
        "{before:?}"
    );
    let mut acl =
        mxc_sdk::mxc_common::filesystem_dacl::DaclManager::in_directory(&temp.path().join("journal"))
            .unwrap();
    acl.grant_appcontainer_access(
        "S-1-5-21-531-532-533-534",
        std::slice::from_ref(&target),
        &[],
    )
    .unwrap();
    acl.restore_strict().unwrap();
    assert_eq!([&target, &child].map(|path| sddl(path)), before);
}

#[test]
fn audit_does_not_authorize_mutations_outside_the_approved_scope() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let work = std::fs::canonicalize(work).unwrap();
    let outside = std::fs::canonicalize(outside).unwrap();
    let request = Execution {
        runner_hash: String::new(),
        files: Default::default(),
        host_acl_scope: Some(crate::windows::filesystem::HostAclScope::new([work.clone()]).unwrap()),
        acl_changes: ash_sandboxing::HostAclChanges::Scoped,
        command: String::new(),
        working_directory: work.to_string_lossy().into_owned(),
        env: Vec::new(),
        mode: super::super::account::NetworkMode::Denied,
        proxy_port: None,
        io: ash_sandboxing::ProcessIo::Pipes,
    };
    assert!(check_findings(&request, &BTreeSet::from([work])).is_ok());
    let error = check_findings(&request, &BTreeSet::from([outside.clone()])).unwrap_err();
    assert!(error.contains(outside.to_str().unwrap()));
    assert!(error.contains("explicit host remediation"));
}
