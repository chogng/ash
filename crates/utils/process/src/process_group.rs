//! Unix session ownership, exit observation, and process-group signalling.

use std::io;

/// Gives a pipe-backed capability process an owned session, including child-created groups.
pub fn configure_command_session(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

/// Kills an owned session whose identity is pinned by an unreaped leader or a private guard member.
pub fn kill_process_session(session_id: u32) -> io::Result<()> {
    let session_id = session_id as libc::pid_t;
    // Stop the leader first, so its children cannot be replenished during cleanup.
    let group = kill_process_group(session_id as u32);
    let mut system = sysinfo::System::new();
    for _ in 0..3 {
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().without_tasks(),
        );
        for pid in system.processes().keys() {
            let pid = pid.as_u32() as libc::pid_t;
            // A second kernel check avoids targeting a recycled PID from the inventory.
            if unsafe { libc::getsid(pid) } == session_id {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
    group
}

/// Signals a group while the caller retains ownership of its process identity.
pub fn signal_process_group_id(pgid: libc::pid_t, signal: libc::c_int) -> io::Result<bool> {
    use std::io::ErrorKind;

    let result = unsafe { libc::killpg(pgid, signal) };
    if result == -1 {
        let err = io::Error::last_os_error();
        if err.kind() == ErrorKind::NotFound || err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        #[cfg(target_os = "macos")]
        if err.raw_os_error() == Some(libc::EPERM) && !group_has_live_members(pgid)? {
            // See Apple xnu/bsd/kern/kern_sig.c killpg1: its group filter excludes SZOMB.
            // Darwin excludes zombies from killpg's permission check, then returns EPERM
            // when no signalable member remains. Preserve real permission failures.
            return Ok(false);
        }
        return Err(err);
    }

    Ok(true)
}

/// Interrupt an owned group while its leader or session guard retains the identity.
pub fn interrupt_process_group(process_group_id: u32) -> io::Result<()> {
    signal_process_group_id(process_group_id as libc::pid_t, libc::SIGINT).map(|_| ())
}

/// Kill an owned group while its leader or session guard retains the identity.
pub fn kill_process_group(process_group_id: u32) -> io::Result<()> {
    signal_process_group_id(process_group_id as libc::pid_t, libc::SIGKILL).map(|_| ())
}

/// Checks for a child's terminal state without reaping it. The caller retains the PID until
/// cleanup and wait complete; it must not concurrently wait on this child elsewhere.
pub fn child_has_exited(pid: u32) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(target_os = "macos")]
fn group_has_live_members(pgid: libc::pid_t) -> io::Result<bool> {
    const PROC_PGRP_ONLY: u32 = 2;
    let mut pids = vec![0_i32; 4096];
    let capacity = std::mem::size_of_val(pids.as_slice());
    let bytes = unsafe {
        libc::proc_listpids(
            PROC_PGRP_ONLY,
            pgid as u32,
            pids.as_mut_ptr().cast(),
            capacity as i32,
        )
    };
    if bytes <= 0 || bytes as usize >= capacity {
        return Err(io::Error::other(
            "could not enumerate the exiting process group",
        ));
    }
    for pid in pids
        .into_iter()
        .take(bytes as usize / std::mem::size_of::<i32>())
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let result = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if result != size {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(error);
        }
        if info.pbi_pgid == pgid as u32 && info.pbi_status != libc::SZOMB {
            return Ok(true);
        }
    }
    Ok(false)
}
