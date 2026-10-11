// This file is copied from https://github.com/wezterm/wezterm (MIT license).
// Copyright (c) 2018-Present Wez Furlong
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to authorization persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

use super::WinChild;
use crate::cmdbuilder::CommandBuilder;
use crate::win::procthreadattr::ProcThreadAttributeList;
use anyhow::Error;
use anyhow::bail;
use anyhow::ensure;
use filedescriptor::FileDescriptor;
use filedescriptor::OwnedHandle;
use lazy_static::lazy_static;
use shared_library::shared_library;
use std::ffi::OsString;
use std::io::Error as IoError;
use std::mem;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::BorrowedHandle;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr;
use std::sync::Mutex;
use winapi::shared::minwindef::DWORD;
use winapi::shared::ntdef::NTSTATUS;
use winapi::shared::ntstatus::STATUS_SUCCESS;
use winapi::shared::winerror::HRESULT;
use winapi::shared::winerror::S_OK;
use winapi::um::handleapi::*;
use winapi::um::processthreadsapi::*;
use winapi::um::winbase::CREATE_UNICODE_ENVIRONMENT;
use winapi::um::winbase::EXTENDED_STARTUPINFO_PRESENT;
use winapi::um::winbase::STARTF_USESTDHANDLES;
use winapi::um::winbase::STARTUPINFOEXW;
use winapi::um::wincon::COORD;
use winapi::um::winnt::HANDLE;
use winapi::um::winnt::OSVERSIONINFOW;

pub type HPCON = HANDLE;

pub const PSEUDOCONSOLE_RESIZE_QUIRK: DWORD = 0x2;

// https://learn.microsoft.com/en-gb/windows/console/createpseudoconsole
// https://learn.microsoft.com/en-gb/windows/release-health/release-information
const MIN_CONPTY_BUILD: u32 = 17_763;

shared_library!(ConPtyFuncs,
    pub fn CreatePseudoConsole(
        size: COORD,
        hInput: HANDLE,
        hOutput: HANDLE,
        flags: DWORD,
        hpc: *mut HPCON
    ) -> HRESULT,
    pub fn ResizePseudoConsole(hpc: HPCON, size: COORD) -> HRESULT,
    pub fn ClosePseudoConsole(hpc: HPCON),
);

shared_library!(Ntdll,
    pub fn RtlGetVersion(
        version_info: *mut OSVERSIONINFOW
    ) -> NTSTATUS,
);

shared_library!(ConPtyReleaseFuncs,
    pub fn ReleasePseudoConsole(hpc: HPCON) -> HRESULT,
);

lazy_static! {
    static ref CONPTY: ConPtyFuncs = ConPtyFuncs::open(Path::new("kernel32.dll")).expect(
        "this system does not support conpty.  Windows 10 October 2018 or newer is required",
    );
    // Available starting with Windows 11 24H2. All console functions must come
    // from the same system implementation because HPCON is opaque.
    static ref CONPTY_RELEASE: Option<ConPtyReleaseFuncs> =
        ConPtyReleaseFuncs::open(Path::new("kernel32.dll")).ok();
}

/// Whether console clients can determine EOF without closing HPCON on root exit.
pub fn supports_client_lifetime() -> bool {
    CONPTY_RELEASE.is_some()
}

/// Whether this Windows version provides ConPTY.
pub fn conpty_supported() -> bool {
    windows_build_number().is_some_and(|build| build >= MIN_CONPTY_BUILD)
}

fn windows_build_number() -> Option<u32> {
    let ntdll = Ntdll::open(Path::new("ntdll.dll")).ok()?;
    let mut info: OSVERSIONINFOW = unsafe { mem::zeroed() };
    info.dwOSVersionInfoSize = mem::size_of::<OSVERSIONINFOW>() as u32;
    let status = unsafe { (ntdll.RtlGetVersion)(&mut info) };
    if status == STATUS_SUCCESS {
        Some(info.dwBuildNumber)
    } else {
        None
    }
}

pub struct PsuedoCon {
    con: HPCON,
    // Retain these only until a client attaches. Keeping the output writer
    // afterward prevents the reader from observing the console's EOF.
    creation_handles: Option<(FileDescriptor, FileDescriptor)>,
}

unsafe impl Send for PsuedoCon {}
unsafe impl Sync for PsuedoCon {}

impl Drop for PsuedoCon {
    fn drop(&mut self) {
        unsafe { (CONPTY.ClosePseudoConsole)(self.con) };
    }
}

impl PsuedoCon {
    pub fn raw_handle(&self) -> HPCON {
        self.con
    }

    pub fn new(size: COORD, input: FileDescriptor, output: FileDescriptor) -> Result<Self, Error> {
        let mut con: HPCON = INVALID_HANDLE_VALUE;
        let result = unsafe {
            // Clients send VT bytes. Cursor inheritance would require a query
            // responder, and Win32 input mode would require structured input events.
            (CONPTY.CreatePseudoConsole)(
                size,
                input.as_raw_handle() as _,
                output.as_raw_handle() as _,
                PSEUDOCONSOLE_RESIZE_QUIRK,
                &mut con,
            )
        };
        ensure!(
            result == S_OK,
            "failed to create psuedo console: HRESULT {result}"
        );
        Ok(Self {
            con,
            creation_handles: Some((input, output)),
        })
    }

    /// Completes attachment after a client was successfully created with this console.
    /// The console keeps running until its last client exits on supported Windows versions.
    pub fn client_attached(&mut self) -> Result<(), Error> {
        if self.creation_handles.is_none() {
            return Ok(());
        }
        if let Some(release) = CONPTY_RELEASE.as_ref() {
            let result = unsafe { (release.ReleasePseudoConsole)(self.con) };
            ensure!(
                result == S_OK,
                "failed to release pseudoconsole ownership: HRESULT {result}"
            );
        }
        self.creation_handles.take();
        Ok(())
    }

    pub fn resize(&self, size: COORD) -> Result<(), Error> {
        let result = unsafe { (CONPTY.ResizePseudoConsole)(self.con, size) };
        ensure!(
            result == S_OK,
            "failed to resize console to {}x{}: HRESULT: {}",
            size.X,
            size.Y,
            result
        );
        Ok(())
    }

    pub fn spawn_command(
        &mut self,
        cmd: CommandBuilder,
        job: Option<BorrowedHandle<'_>>,
    ) -> anyhow::Result<WinChild> {
        let mut si: STARTUPINFOEXW = unsafe { mem::zeroed() };
        si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;

        let mut attrs = ProcThreadAttributeList::with_capacity(if job.is_some() { 2 } else { 1 })?;
        attrs.set_pty(self.con)?;
        if let Some(job) = job {
            attrs.set_job(job.as_raw_handle().cast())?;
        }
        si.lpAttributeList = attrs.as_mut_ptr();

        let mut pi: PROCESS_INFORMATION = unsafe { mem::zeroed() };

        let (mut exe, mut cmdline) = cmd.cmdline()?;
        let cmd_os = OsString::from_wide(&cmdline);

        let cwd = cmd.current_directory();
        let mut env_block = cmd.environment_block();

        let res = unsafe {
            CreateProcessW(
                exe.as_mut_ptr(),
                cmdline.as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env_block.as_mut_ptr() as *mut _,
                cwd.as_ref().map_or(ptr::null(), std::vec::Vec::as_ptr),
                &mut si.StartupInfo,
                &mut pi,
            )
        };
        if res == 0 {
            let err = IoError::last_os_error();
            let msg = format!(
                "CreateProcessW `{:?}` in cwd `{:?}` failed: {}",
                cmd_os,
                cwd.as_ref().map(|c| OsString::from_wide(c)),
                err
            );
            log::error!("{msg}");
            bail!("{msg}");
        }

        let _main_thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread as _) };
        let proc = unsafe { OwnedHandle::from_raw_handle(pi.hProcess as _) };

        if let Err(error) = self.client_attached() {
            // A launch that cannot finish attachment must not leave a running child behind.
            unsafe { TerminateProcess(proc.as_raw_handle().cast(), 1) };
            return Err(error);
        }
        Ok(WinChild {
            proc: Mutex::new(proc),
        })
    }
}
