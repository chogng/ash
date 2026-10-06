use super::restrict_javascript_process as finish_startup;
use ash_sandboxing::SandboxCommand;
use std::fs::File;
use std::io;
use std::os::windows::io::AsRawHandle;
use windows_sandbox::spawn_locked_process as spawn;
use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys_061 as windows_sys;
fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;
use std::time::Instant;

#[test]
fn locked_process_blocks_host_io_on_initial_existing_and_new_threads() {
    let root = tempfile::tempdir().unwrap();
    let secret = root.path().join("secret.txt");
    std::fs::write(&secret, "host-only").unwrap();
    let root_dacl = dacl(root.path());
    let secret_dacl = dacl(&secret);
    let file = File::open(&secret).unwrap();
    // A deliberately inheritable handle must still be excluded by HANDLE_LIST.
    unsafe {
        checked(SetHandleInformation(
            file.as_raw_handle(),
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        ))
        .unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let executable = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/windows_isolation_probe.exe");
    assert!(
        executable.is_file(),
        "build the windows_isolation_probe example before this test"
    );
    let command = SandboxCommand::new(&executable, std::iter::empty::<String>(), root.path());
    let mut child = spawn(&command).unwrap();
    let config = serde_json::json!({
        "secret":secret, "directory":root.path(), "executable":executable,
        "endpoint":listener.local_addr().unwrap().to_string(),
        "parentPid":std::process::id(),
    });
    writeln!(child.take_stdin().unwrap(), "{config}").unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= until {
            child.close().unwrap();
            break child.try_wait().unwrap().unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .take_stdout()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    child
        .take_stderr()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(
        status,
        ash_sandboxing::SandboxProcessExitStatus::Code(0),
        "stdout={stdout} stderr={stderr}"
    );
    assert!(stdout.contains("confinement verified"), "{stdout}");
    assert!(!root.path().join("escape.txt").exists());
    let sid = stdout
        .lines()
        .find_map(|line| line.strip_prefix("app-sid="))
        .unwrap();
    let profile = profile_folder(sid);
    drop(child);
    assert_eq!(dacl(root.path()), root_dacl, "package ACL was not restored");
    assert_eq!(
        dacl(&secret),
        secret_dacl,
        "package file ACL was not restored"
    );
    assert!(!profile.exists(), "AppContainer profile was not removed");
}

fn dacl(path: &std::path::Path) -> String {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
    use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
        let mut descriptor = null_mut();
        assert_eq!(
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor
            ),
            0
        );
        let mut text = null_mut();
        let mut length = 0;
        let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        );
        LocalFree(descriptor.cast());
        checked(converted).unwrap();
        let result =
            String::from_utf16(std::slice::from_raw_parts(text, length as usize - 1)).unwrap();
        LocalFree(text.cast());
        result
    }
}

fn profile_folder(sid: &str) -> std::path::PathBuf {
    use windows_sys::Win32::Security::Isolation::GetAppContainerFolderPath;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    let sid: Vec<u16> = sid.encode_utf16().chain([0]).collect();
    unsafe {
        let mut folder = std::ptr::null_mut();
        let result = GetAppContainerFolderPath(sid.as_ptr(), &mut folder);
        assert!(result >= 0, "profile lookup failed: {result:#x}");
        let mut length = 0;
        while *folder.add(length) != 0 {
            length += 1;
        }
        let path = std::path::PathBuf::from(
            String::from_utf16(std::slice::from_raw_parts(folder, length)).unwrap(),
        );
        CoTaskMemFree(folder.cast());
        path
    }
}

#[test]
fn unconfined_process_cannot_claim_to_have_completed_locked_startup() {
    assert!(finish_startup().is_err());
}
