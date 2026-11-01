//! A process outside the owner's runtime keeps an owned Unix session from becoming orphaned.

use std::ffi::CString;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;

pub const PROCESS_GUARD_ARGUMENT: &str = "--ash-process-session-guard";

struct GuardExecutable {
    program: CString,
    arguments: Vec<CString>,
}

static EXECUTABLE: OnceLock<GuardExecutable> = OnceLock::new();

/// Enables session guards in an executable that dispatches the corresponding internal role.
/// Library consumers without that role retain their explicitly owned in-process cleanup.
pub fn enable_process_guard() -> io::Result<()> {
    if EXECUTABLE.get().is_none() {
        let program = CString::new(std::env::current_exe()?.as_os_str().as_bytes())?;
        let _ = EXECUTABLE.set(GuardExecutable {
            program,
            arguments: vec![CString::new(PROCESS_GUARD_ARGUMENT)?],
        });
    }
    Ok(())
}

/// Owns the guard's lifeline. Only the creating process retains its writing endpoint after exec.
pub struct ProcessGuard {
    _lifetime: UnixStream,
}

/// Adds a guard before an owned session's command can execute any package code.
/// Call after configuring a new session and retain the lease through the owner's final cleanup.
pub fn configure_command_guard(command: &mut Command) -> io::Result<Option<ProcessGuard>> {
    let Some(executable) = EXECUTABLE.get() else {
        return Ok(None);
    };
    let (owner, lifetime) = UnixStream::pair()?;
    let owner = UnixStream::from(private_descriptor(owner)?);
    let lifetime = UnixStream::from(private_descriptor(lifetime)?);
    let (ready_reader, ready_writer) = UnixStream::pair()?;
    let ready_reader = UnixStream::from(private_descriptor(ready_reader)?);
    let ready_writer = UnixStream::from(private_descriptor(ready_writer)?);
    let null = private_descriptor(
        OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/null")?,
    )?;
    // The post-fork branch cannot allocate, lock, or run Rust destructors. Prepare
    // argv and descriptor bounds now and use only async-signal-safe syscalls there.
    let maximum_fd = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    if maximum_fd <= 0 || maximum_fd > i32::MAX as libc::c_long {
        return Err(io::Error::other(
            "could not determine guard descriptor limit",
        ));
    }
    unsafe {
        command.pre_exec(move || {
            if libc::getsid(0) != libc::getpid() {
                return Err(io::Error::from_raw_os_error(libc::EPERM));
            }
            let guardian = libc::fork();
            if guardian == -1 {
                return Err(io::Error::last_os_error());
            }
            if guardian == 0 {
                // Keep membership in the target session to pin its identity even
                // after the owner and leader die. A separate group avoids killing
                // this guard before it can sweep child-created process groups.
                if libc::setpgid(0, 0) == -1
                    || libc::dup2(lifetime.as_raw_fd(), 0) == -1
                    || libc::dup2(ready_writer.as_raw_fd(), 3) == -1
                    || libc::dup2(null.as_raw_fd(), 1) == -1
                    || libc::dup2(null.as_raw_fd(), 2) == -1
                {
                    libc::_exit(127);
                }
                if !close_descriptors(maximum_fd as i32) {
                    libc::_exit(127);
                }
                let mut arguments = [std::ptr::null(); 17];
                arguments[0] = executable.program.as_ptr();
                for (index, argument) in executable.arguments.iter().enumerate() {
                    arguments[index + 1] = argument.as_ptr();
                }
                libc::execv(executable.program.as_ptr(), arguments.as_ptr());
                libc::_exit(127);
            }
            // Do not leak the guard's readiness writer into the executed command.
            libc::close(ready_writer.as_raw_fd());
            let mut poll = libc::pollfd {
                fd: ready_reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            loop {
                let result = libc::poll(&mut poll, 1, 5_000);
                if result > 0 {
                    let mut ready = 0_u8;
                    if libc::read(poll.fd, (&mut ready as *mut u8).cast(), 1) == 1 && ready == b'R'
                    {
                        return Ok(());
                    }
                    break;
                }
                if result == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
            libc::kill(guardian, libc::SIGKILL);
            Err(io::Error::from_raw_os_error(libc::ETIMEDOUT))
        });
    }
    Ok(Some(ProcessGuard { _lifetime: owner }))
}

fn private_descriptor(source: impl AsRawFd) -> io::Result<OwnedFd> {
    // Standard streams can be closed in a native host. Keep private channels above
    // fd 3 so Command's stdio setup and the guard's dup2 operations cannot replace them.
    // SAFETY: source owns a live descriptor throughout duplication; the new one is exclusive.
    let fd = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

// Called only in the forked branch, before exec. Keep stdout/stderr isolated and
// never retain the parent's listeners, protocol pipes, secrets, or spawn error pipe.
unsafe fn close_descriptors(maximum_fd: i32) -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = maximum_fd;
        // Reuse descriptor-table enumeration, including sparse descriptors above
        // a lowered RLIMIT_NOFILE. CLOEXEC descriptors close at the immediate exec.
        crate::pipe::close_inherited_fds_except(&[3]).is_ok()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        for fd in 4..maximum_fd {
            unsafe { libc::close(fd) };
        }
        true
    }
}

/// Runs the internal guard with its private lifeline on stdin and readiness socket on fd 3.
/// The guard owns no business state and exits after its session has been reclaimed.
pub fn run_process_guard() -> io::Result<()> {
    let own = std::process::id();
    let session = unsafe { libc::getsid(0) };
    if session <= 1 || session as u32 == own || unsafe { libc::getpgrp() } != own as i32 {
        return Err(io::Error::other("invalid process session guard context"));
    }
    for fd in [0, 3] {
        let mut status: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut status) } != 0
            || status.st_mode & libc::S_IFMT != libc::S_IFSOCK
        {
            return Err(io::Error::other("missing private process guard socket"));
        }
    }
    let mut lifetime = unsafe { UnixStream::from_raw_fd(0) };
    let mut ready = unsafe { UnixStream::from_raw_fd(3) };
    ready.write_all(b"R")?;
    drop(ready);
    loop {
        match lifetime.read(&mut [0]) {
            Ok(0) => break,
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let mut system = sysinfo::System::new();
    for _ in 0..3 {
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            // Linux exposes threads as tasks too. Signalling one of this guard's
            // own TIDs would kill the guard before it finishes reclaiming children.
            sysinfo::ProcessRefreshKind::nothing().without_tasks(),
        );
        for pid in system.processes().keys().map(|pid| pid.as_u32()) {
            if pid != own && unsafe { libc::getsid(pid as i32) } == session {
                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "process_guard_tests.rs"]
mod tests;
