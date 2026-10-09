use crate::PathCaseSensitivity;
use cap_std::fs::Dir;

// These observations use the granted directory handle and never create probe files.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub(crate) fn inspect(directory: &Dir) -> PathCaseSensitivity {
    use std::os::fd::AsRawFd;
    // SAFETY: the borrowed directory keeps its descriptor alive during this read-only query.
    match unsafe { libc::fpathconf(directory.as_raw_fd(), libc::_PC_CASE_SENSITIVE) } {
        0 => PathCaseSensitivity::Insensitive,
        1 => PathCaseSensitivity::Sensitive,
        _ => PathCaseSensitivity::Unknown,
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn inspect(directory: &Dir) -> PathCaseSensitivity {
    let Ok(metadata) = rustix::fs::fstatfs(directory) else {
        return PathCaseSensitivity::Unknown;
    };
    match metadata.f_type as u64 {
        // ext4, F2FS, bcachefs and tmpfs expose per-directory casefolding through FS_IOC_GETFLAGS.
        0xef53 | 0xf2f52010 | 0xca451a4e | 0x01021994 => {
            match rustix::fs::ioctl_getflags(directory) {
                Ok(flags) if flags.bits() & 0x40000000 != 0 => PathCaseSensitivity::Insensitive,
                Ok(_) => PathCaseSensitivity::Sensitive,
                Err(_) => PathCaseSensitivity::Unknown,
            }
        }
        // XFS can have filesystem-wide ASCII folding; network, FUSE and overlay rules also
        // cannot be inferred from the filesystem type or server process OS.
        _ => PathCaseSensitivity::Unknown,
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) fn inspect(directory: &Dir) -> PathCaseSensitivity {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FileCaseSensitiveInfo;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx;
    let mut flags = 0_u32;
    // SAFETY: FileCaseSensitiveInfo writes one ULONG flag field into the correctly sized
    // buffer; directory owns the live handle for the duration of this read-only query.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            directory.as_raw_handle().cast(),
            FileCaseSensitiveInfo,
            (&raw mut flags).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    if succeeded == 0 {
        return PathCaseSensitivity::Unknown;
    }
    if flags & 1 != 0 {
        PathCaseSensitivity::Sensitive
    } else {
        PathCaseSensitivity::Insensitive
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) fn inspect(_directory: &Dir) -> PathCaseSensitivity {
    PathCaseSensitivity::Unknown
}
