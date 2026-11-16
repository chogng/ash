fn find_python() -> Option<String> {
    ["python3", "python"]
        .into_iter()
        .find(|program| {
            std::process::Command::new(program)
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .map(str::to_owned)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn descriptor_cleanup_covers_sparse_fds_above_a_lowered_limit() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::os::unix::process::CommandExt;

    let python =
        find_python().ok_or_else(|| anyhow::anyhow!("Python is required for FD validation"))?;
    let file = std::fs::File::open("/dev/null")?;
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let high = limit.rlim_cur.min(4096) as i32 - 3;
    anyhow::ensure!(high > 64, "test requires at least 68 descriptors");
    let duplicate = |minimum: i32| -> anyhow::Result<OwnedFd> {
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, minimum) };
        if fd == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let unwanted = duplicate(high)?;
    let preserved = duplicate(high + 1)?;
    let cloexec = duplicate(high + 2)?;
    let extra_preserved = duplicate(high - 1)?;
    let cloexec_fd = cloexec.as_raw_fd();
    if unsafe { libc::fcntl(cloexec_fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let preserved_fd = preserved.as_raw_fd();
    let extra_preserved_fd = extra_preserved.as_raw_fd();
    let mut command = std::process::Command::new(python);
    command.args([
        "-c",
        "import errno, os, sys\nfor fd in map(int, sys.argv[1:3]):\n    try: os.fstat(fd)\n    except OSError as e: assert e.errno == errno.EBADF\n    else: raise AssertionError('unexpected inherited descriptor')\nfor fd in map(int, sys.argv[3:]): assert os.read(fd, 1) == b''",
    ]);
    command.arg(unwanted.as_raw_fd().to_string());
    command.arg(cloexec_fd.to_string());
    command.arg(preserved_fd.to_string());
    command.arg(extra_preserved_fd.to_string());
    // Only the forked child's limit changes. Existing sparse descriptors survive
    // lowering RLIMIT_NOFILE and still need to be covered by the cleanup sweep.
    unsafe {
        command.pre_exec(move || {
            limit.rlim_cur = 64;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            {
                // Probe an already-CLOEXEC descriptor in this child, preserving
                // its flags. Older kernels retain the sparse-FD /proc coverage
                // but cannot promise cleanup with every low descriptor occupied.
                let close_range_supported = if libc::syscall(
                    libc::SYS_close_range,
                    cloexec_fd as u32,
                    cloexec_fd as u32,
                    libc::CLOSE_RANGE_CLOEXEC,
                ) == 0
                {
                    true
                } else {
                    let error = std::io::Error::last_os_error();
                    if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
                        return Err(error);
                    }
                    false
                };
                if close_range_supported {
                    loop {
                        // The modern-kernel path must not need another slot.
                        if libc::fcntl(preserved_fd, libc::F_DUPFD, 3) == -1 {
                            let error = std::io::Error::last_os_error();
                            if error.raw_os_error() != Some(libc::EMFILE) {
                                return Err(error);
                            }
                            break;
                        }
                    }
                }
            }
            // The owning caller need not sort or deduplicate its exceptions.
            crate::descriptors::close_inherited_fds_except(&[
                preserved_fd,
                extra_preserved_fd,
                preserved_fd,
            ])
        });
    }
    let output = command.output()?;
    anyhow::ensure!(
        output.status.success(),
        "descriptor validation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
