use super::*;
use std::process::Command;

#[test]
fn loader_keys_preserve_unrelated_environment() {
    for key in ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"] {
        assert!(dangerous_key(std::ffi::OsStr::new(key)));
    }
    for key in ["PATH", "HOME", "BUILD_ID"] {
        assert!(!dangerous_key(std::ffi::OsStr::new(key)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        assert!(dangerous_key(std::ffi::OsStr::from_bytes(b"LD_\xff")));
    }
}

#[test]
fn child_process_applies_build_policy() {
    const CHILD: &str = "ASH_HARDENING_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        for key in ["LD_ASH_TEST", "DYLD_ASH_TEST", "LD_LIBRARY_PATH"] {
            assert_eq!(std::env::var_os(key).is_some(), cfg!(debug_assertions));
        }
        assert_eq!(std::env::var("ASH_TOOLCHAIN_TEST").unwrap(), "preserve");
        #[cfg(unix)]
        let before = core_limit();
        #[cfg(target_os = "linux")]
        // SAFETY: PR_GET_DUMPABLE takes no pointers.
        let dumpable = unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) };
        initialize().unwrap();
        #[cfg(unix)]
        assert_eq!(
            core_limit(),
            if cfg!(debug_assertions) {
                before
            } else {
                (0, 0)
            }
        );
        #[cfg(target_os = "linux")]
        // SAFETY: PR_GET_DUMPABLE takes no pointers.
        assert_eq!(
            unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) },
            if cfg!(debug_assertions) { dumpable } else { 0 }
        );
        #[cfg(unix)]
        {
            // Exercise the environment inherited by a real shell, not another Rust constructor.
            let status = Command::new("/bin/sh")
                .arg("-c")
                .arg(if cfg!(debug_assertions) {
                    "test -n \"$LD_ASH_TEST\" && test -n \"$LD_LIBRARY_PATH\" && test \"$ASH_TOOLCHAIN_TEST\" = preserve"
                } else {
                    "test -z \"$LD_ASH_TEST\" && test -z \"$LD_LIBRARY_PATH\" && test \"$ASH_TOOLCHAIN_TEST\" = preserve"
                })
                .status().unwrap();
            assert!(status.success());
        }
        return;
    }
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::child_process_applies_build_policy"])
        .env(CHILD, "1")
        .env("LD_ASH_TEST", "remove")
        .env("DYLD_ASH_TEST", "remove")
        .env("LD_LIBRARY_PATH", std::env::temp_dir())
        .env("ASH_TOOLCHAIN_TEST", "preserve")
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(unix)]
fn core_limit() -> (libc::rlim_t, libc::rlim_t) {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: writable initialized rlimit for the current process.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) }, 0);
    (limit.rlim_cur, limit.rlim_max)
}

#[cfg(target_os = "linux")]
#[test]
fn debugger_attachment_follows_build_policy() {
    use std::io::BufRead;
    use std::io::Read;
    use std::io::Write;
    use std::process::Stdio;
    const CHILD: &str = "ASH_HARDENING_ATTACH_CHILD";
    if std::env::var_os(CHILD).is_some() {
        initialize().unwrap();
        println!("ready");
        std::io::stdout().flush().unwrap();
        let _ = std::io::stdin().read(&mut [0]);
        return;
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::debugger_attachment_follows_build_policy",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        assert_ne!(
            output.read_line(&mut line).unwrap(),
            0,
            "child exited before ready"
        );
        if line.trim() == "ready" {
            break;
        }
        line.clear();
    }
    let pid = child.id() as libc::pid_t;
    // SAFETY: attach to our own waiting child; no pointer arguments are used.
    let result = unsafe {
        libc::ptrace(
            libc::PTRACE_ATTACH,
            pid,
            std::ptr::null_mut::<libc::c_void>(),
            std::ptr::null_mut::<libc::c_void>(),
        )
    };
    let error = io::Error::last_os_error();
    if result == 0 {
        let mut status = 0;
        // SAFETY: wait for the trace stop and detach our own child before reaping it.
        unsafe {
            assert_eq!(libc::waitpid(pid, &mut status, 0), pid);
            assert!(libc::WIFSTOPPED(status));
            assert_eq!(
                libc::ptrace(
                    libc::PTRACE_DETACH,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>()
                ),
                0
            );
        }
    }
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    if cfg!(debug_assertions) {
        assert_eq!(result, 0, "debug attach failed: {error}");
    } else {
        assert_eq!(result, -1, "release process allowed attachment");
        assert_eq!(error.raw_os_error(), Some(libc::EPERM));
    }
}

#[cfg(windows)]
#[test]
fn windows_excludes_current_directory_from_dll_search() {
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::Diagnostics::Debug::GetErrorMode;
    use windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX;
    use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
    const CHILD: &str = "ASH_HARDENING_DLL_CHILD";
    if std::env::var_os(CHILD).is_some() {
        initialize().unwrap();
        // SAFETY: GetErrorMode has no arguments.
        assert_ne!(unsafe { GetErrorMode() } & SEM_NOGPFAULTERRORBOX, 0);
        let name: Vec<_> = "ash-hardening-fixture.dll\0".encode_utf16().collect();
        // SAFETY: name is a terminated UTF-16 string.
        assert!(unsafe { LoadLibraryW(name.as_ptr()) }.is_null());
        use std::os::windows::ffi::OsStrExt;
        let path = std::env::current_dir()
            .unwrap()
            .join("ash-hardening-fixture.dll");
        let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: absolute path is terminated; release the successfully loaded module.
        unsafe {
            let module = LoadLibraryW(path.as_ptr());
            assert!(
                !module.is_null(),
                "fixture must be loadable by absolute path"
            );
            assert_ne!(FreeLibrary(module), 0);
        }
        return;
    }
    let dir = std::env::temp_dir().join(format!("ash-hardening-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let system = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    std::fs::copy(
        system.join("System32/version.dll"),
        dir.join("ash-hardening-fixture.dll"),
    )
    .unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::windows_excludes_current_directory_from_dll_search",
        ])
        .env(CHILD, "1")
        .current_dir(&dir)
        .status()
        .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(status.success());
}

#[cfg(target_os = "macos")]
#[test]
fn traced_process_follows_build_policy() {
    const CHILD: &str = "ASH_HARDENING_TRACED_CHILD";
    if std::env::var_os(CHILD).is_some() {
        // SAFETY: declare this isolated child traced by its parent; no pointers are used.
        assert_eq!(
            unsafe { libc::ptrace(libc::PT_TRACE_ME, 0, std::ptr::null_mut(), 0) },
            0
        );
        // macOS terminates an already traced process with ENOTSUP on PT_DENY_ATTACH.
        initialize().unwrap();
        return;
    }
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::traced_process_follows_build_policy"])
        .env(CHILD, "1")
        .status()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(if cfg!(debug_assertions) {
            0
        } else {
            libc::ENOTSUP
        })
    );
}

#[cfg(windows)]
#[test]
fn redirected_output_closes_while_a_descendant_is_running() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Duration;
    use std::time::Instant;
    const ROLE: &str = "ASH_HARDENING_PIPE_ROLE";
    const ROOT: &str = "ASH_HARDENING_PIPE_ROOT";
    const TEST: &str = "tests::redirected_output_closes_while_a_descendant_is_running";
    if let Some(role) = std::env::var_os(ROLE) {
        let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
        if role == "descendant" {
            std::fs::write(root.join("ready"), b"").unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            while !root.join("release").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            std::fs::write(root.join("done"), b"").unwrap();
        } else {
            initialize().unwrap();
            // Explicit redirection and inherited output still work after initialization.
            let output = Command::new(std::env::current_exe().unwrap())
                .arg("--list")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(!output.stdout.is_empty());
            assert!(
                Command::new(std::env::current_exe().unwrap())
                    .arg("--list")
                    .status()
                    .unwrap()
                    .success()
            );
            std::io::stdout().write_all(b"parent output\n").unwrap();
            let _descendant = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(ROLE, "descendant")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
        }
        return;
    }
    let root = std::env::temp_dir().join(format!("ash-pipe-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", TEST, "--nocapture"])
        .env(ROLE, "parent")
        .env(ROOT, &root);
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || sender.send(command.output()).unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready = root.join("ready").exists();
    let output = receiver.recv_timeout(Duration::from_secs(2));
    // Release the exact descendant before any assertions, including on regression.
    std::fs::write(root.join("release"), b"").unwrap();
    reader.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.join("done").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let done = root.join("done").exists();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(ready && done, "descendant did not complete its lifecycle");
    let output = output
        .expect("descendant retained the parent's output pipe")
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("parent output"));
    assert!(String::from_utf8_lossy(&output.stdout).contains(TEST));
}
