#[cfg(windows)]
mod probe {
    use windows_sandbox::finish_locked_process_startup as finish_startup;

    use std::io;

    use std::ptr::null_mut;

    use windows_sys::Win32::Security::RevertToSelf;
    use windows_sys::Win32::System::Threading::CreateProcessW;
    use windows_sys::Win32::System::Threading::DETACHED_PROCESS;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_DUP_HANDLE;
    use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
    use windows_sys::Win32::System::Threading::PROCESS_VM_READ;
    use windows_sys::Win32::System::Threading::PROCESS_VM_WRITE;
    use windows_sys::Win32::System::Threading::STARTUPINFOW;

    use windows_sys_061 as windows_sys;
    fn checked(success: i32) -> io::Result<()> {
        if success == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn run() {
        unsafe {
            use windows_sys::Win32::System::Diagnostics::Debug::SEM_FAILCRITICALERRORS;
            use windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX;
            use windows_sys::Win32::System::Diagnostics::Debug::SEM_NOOPENFILEERRORBOX;
            use windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode;
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
        }
        assert!(std::env::var_os("PATH").is_none());
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        let config: serde_json::Value = serde_json::from_str(&line).unwrap();
        print_profile_sid();
        assert_only_stdio_inherits();
        assert_child_creation_denied(&config);
        match config["sources"].as_str().unwrap() {
            "package" => assert_eq!(
                std::fs::read(config["secret"].as_str().unwrap()).unwrap(),
                b"host-only"
            ),
            "embedded" => assert!(
                std::fs::read(config["secret"].as_str().unwrap()).is_err(),
                "embedded startup read an unrelated working-directory file"
            ),
            _ => panic!("unknown source policy"),
        }
        // std's first Winsock initialization panics if registry/provider loading is
        // denied. Initialize it while trusted, so later attempts test socket access.
        let _ = std::net::TcpListener::bind("127.0.0.1:0");
        // Worker threads must already be locked, even while the trusted initial thread prepares.
        let worker_config = config.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            assert!(std::fs::read(worker_config["secret"].as_str().unwrap()).is_err());
            receive.recv().unwrap();
            assert_denied(&worker_config);
        });
        finish_startup().unwrap();
        println!("startup restricted");
        assert_denied(&config);
        unsafe {
            // Reverting again cannot recover the released startup token.
            checked(RevertToSelf()).unwrap();
            let process = OpenProcess(
                PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_DUP_HANDLE,
                0,
                config["parentPid"].as_u64().unwrap() as u32,
            );
            assert!(
                process.is_null(),
                "parent process access escaped confinement"
            );
            println!("parent process denied");
        }
        assert_denied(&config);
        send.send(()).unwrap();
        worker.join().unwrap();
        std::thread::spawn(move || assert_denied(&config))
            .join()
            .unwrap();
        println!("confinement verified");
    }

    fn assert_denied(config: &serde_json::Value) {
        assert!(
            std::fs::read(config["secret"].as_str().unwrap()).is_err(),
            "host file read escaped confinement"
        );
        println!("file read denied");
        let write_path =
            std::path::Path::new(config["directory"].as_str().unwrap()).join("escape.txt");
        assert!(
            std::fs::write(write_path, "escape").is_err(),
            "host file write escaped confinement"
        );
        println!("file write denied");
        assert!(
            std::net::TcpStream::connect_timeout(
                &config["endpoint"].as_str().unwrap().parse().unwrap(),
                std::time::Duration::from_millis(300)
            )
            .is_err(),
            "TCP access escaped confinement"
        );
        println!("TCP denied");
        assert!(
            std::net::UdpSocket::bind("127.0.0.1:0").is_err(),
            "UDP access escaped confinement"
        );
        println!("UDP denied");
    }

    fn assert_child_creation_denied(config: &serde_json::Value) {
        use std::os::windows::ffi::OsStrExt;
        let executable: Vec<u16> = std::ffi::OsStr::new(config["executable"].as_str().unwrap())
            .encode_wide()
            .chain([0])
            .collect();
        unsafe {
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = size_of_val(&startup) as u32;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            // This runs with the broader trusted startup token. The creation policy
            // and job apply process-wide and cannot be relaxed by dropping this token.
            assert_eq!(
                CreateProcessW(
                    executable.as_ptr(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    0,
                    DETACHED_PROCESS,
                    null_mut(),
                    null_mut(),
                    &startup,
                    &mut process
                ),
                0,
                "child process escaped confinement"
            );
        }
    }

    fn print_profile_sid() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        use windows_sys::Win32::Security::GetTokenInformation;
        use windows_sys::Win32::Security::TOKEN_APPCONTAINER_INFORMATION;
        use windows_sys::Win32::Security::TOKEN_QUERY;
        use windows_sys::Win32::Security::TokenAppContainerSid;
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        use windows_sys::Win32::System::Threading::OpenProcessToken;
        unsafe {
            let mut token = null_mut();
            checked(OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY,
                &mut token,
            ))
            .unwrap();
            let mut data = [0usize; 32];
            let mut bytes = 0;
            let result = GetTokenInformation(
                token,
                TokenAppContainerSid,
                data.as_mut_ptr().cast(),
                size_of_val(&data) as u32,
                &mut bytes,
            );
            CloseHandle(token);
            checked(result).unwrap();
            let information = &*data.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>();
            let mut sid = null_mut();
            checked(ConvertSidToStringSidW(
                information.TokenAppContainer,
                &mut sid,
            ))
            .unwrap();
            let mut length = 0;
            while *sid.add(length) != 0 {
                length += 1;
            }
            println!(
                "app-sid={}",
                String::from_utf16(std::slice::from_raw_parts(sid, length)).unwrap()
            );
            LocalFree(sid.cast());
        }
    }

    fn assert_only_stdio_inherits() {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::Console::GetStdHandle;
        use windows_sys::Win32::System::Console::STD_ERROR_HANDLE;
        use windows_sys::Win32::System::Console::STD_INPUT_HANDLE;
        use windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE;
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        #[repr(C)]
        struct Entry {
            handle: HANDLE,
            handle_count: usize,
            pointer_count: usize,
            granted_access: u32,
            object_type: u32,
            attributes: u32,
            reserved: u32,
        }
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtQueryInformationProcess(
                process: HANDLE,
                class: u32,
                data: *mut std::ffi::c_void,
                length: u32,
                returned: *mut u32,
            ) -> i32;
        }
        // Inspect valid entries instead of querying a parent's numeric handle, which
        // can name another child object or trigger Windows strict-handle exceptions.
        unsafe {
            let allowed = [
                GetStdHandle(STD_INPUT_HANDLE),
                GetStdHandle(STD_OUTPUT_HANDLE),
                GetStdHandle(STD_ERROR_HANDLE),
            ];
            let bytes = 2 * size_of::<usize>() + 4096 * size_of::<Entry>();
            let mut data = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let mut returned = 0;
            let status = NtQueryInformationProcess(
                GetCurrentProcess(),
                51,
                data.as_mut_ptr().cast(),
                bytes as u32,
                &mut returned,
            );
            assert!(status >= 0, "handle snapshot failed: {status:#x}");
            assert!(data[0] <= 4096);
            assert!(2 * size_of::<usize>() + data[0] * size_of::<Entry>() <= returned as usize);
            let entries = std::slice::from_raw_parts(data.as_ptr().add(2).cast::<Entry>(), data[0]);
            for entry in entries {
                assert!(
                    entry.attributes & 2 == 0 || allowed.contains(&entry.handle),
                    "an unrelated handle was inherited"
                );
            }
        }
    }
}
fn main() {
    #[cfg(windows)]
    probe::run();
}
