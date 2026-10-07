//! Real-process acceptance probe for the terminal worker's object permissions.

#[cfg(windows)]
fn main() {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use windows_sys_061::Win32::Foundation::*;
    use windows_sys_061::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys_061::Win32::System::Threading::*;

    let pid = std::process::id();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS | TH32CS_SNAPTHREAD, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut broker = None;
    let mut valid = unsafe { Process32FirstW(snapshot, &mut entry) };
    while valid != 0 {
        if entry.th32ProcessID == pid {
            broker = Some(entry.th32ParentProcessID);
            break;
        }
        valid = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    let broker = broker.expect("terminal probe has a parent process");
    for access in [
        PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_VM_READ,
        PROCESS_VM_WRITE,
        PROCESS_DUP_HANDLE,
        PROCESS_CREATE_THREAD,
        PROCESS_TERMINATE,
        0x20000,
        0x40000,
    ] {
        let handle = unsafe { OpenProcess(access, 0, broker) };
        assert!(
            handle.is_null(),
            "restricted child obtained worker process access {access:#x}"
        );
        assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
    }
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut valid = unsafe { Thread32First(snapshot, &mut entry) };
    let mut protected_threads = 0;
    while valid != 0 {
        if entry.th32OwnerProcessID == broker {
            for access in [
                THREAD_SET_CONTEXT,
                THREAD_SUSPEND_RESUME,
                THREAD_TERMINATE,
                THREAD_DIRECT_IMPERSONATION,
                THREAD_IMPERSONATE,
                0x20000,
                0x40000,
            ] {
                let handle = unsafe { OpenThread(access, 0, entry.th32ThreadID) };
                assert!(
                    handle.is_null(),
                    "restricted child obtained worker thread access {access:#x}"
                );
                assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
            }
            protected_threads += 1;
        }
        valid = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    assert!(
        protected_threads >= 3,
        "terminal worker must have launch, input and output threads"
    );
    let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let descendant = std::process::Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-Command", "Start-Sleep 60"])
        // A background child must not change the foreground probe's shared
        // console input mode. It still belongs to the same execution job.
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    std::fs::write(
        "processes.json",
        format!("[{pid},{broker},{}]", descendant.id()),
    )
    .unwrap();
    println!("worker-protected");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "accepted");
    println!("probe-complete");
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows terminal acceptance requires Windows");
    std::process::exit(1);
}
