#![allow(unsafe_code)]

use crate::FileInformation;
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ID_128, FILE_ID_INFO, FILE_STANDARD_INFO, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx,
};

pub(super) fn inspect(file: &File) -> io::Result<FileInformation> {
    let handle = file.as_raw_handle() as HANDLE;
    let mut identity = FILE_ID_INFO {
        VolumeSerialNumber: 0,
        FileId: FILE_ID_128 {
            Identifier: [0; 16],
        },
    };
    // SAFETY: `file` owns a live handle for the duration of the call, `identity` is the exact
    // output type for `FileIdInfo`, and the supplied buffer size matches that type.
    let identity_succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&raw mut identity).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if identity_succeeded == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut standard = FILE_STANDARD_INFO {
        AllocationSize: 0,
        EndOfFile: 0,
        NumberOfLinks: 0,
        DeletePending: 0,
        Directory: 0,
    };
    // SAFETY: `file` owns a live handle for the duration of the call, `standard` is the exact
    // output type for `FileStandardInfo`, and the supplied buffer size matches that type.
    let standard_succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&raw mut standard).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if standard_succeeded == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(FileInformation::new(
        identity.VolumeSerialNumber,
        identity.FileId.Identifier,
        u64::from(standard.NumberOfLinks),
    ))
}
