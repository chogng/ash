//! ConPTY stays inside its creating account worker; the caller owns only I/O and control.

use super::process;
use super::win;
use super::win::Handle;
use super::win::Result;
use ash_utils_pty::PreparedConPty;
use ash_utils_pty::TerminalSize;
use serde::Deserialize;
use serde::Serialize;
use std::fs::File;
use std::io;
use std::io::Read;
use std::io::Write;
use std::os::windows::io::FromRawHandle;
use std::sync::Arc;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::Threading::*;

const MAX_FRAME: usize = 65536;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
enum Control {
    Input(Vec<u8>),
    Resize([u16; 2]),
    Interrupt,
}

pub(super) struct Controller {
    worker: Handle,
    input: Arc<Mutex<File>>,
}

pub(super) struct Input(Arc<Mutex<File>>);

fn send(input: &Mutex<File>, control: &Control) -> io::Result<()> {
    let bytes = serde_json::to_vec(control).map_err(io::Error::other)?;
    let mut writer = input
        .lock()
        .map_err(|_| io::Error::other("terminal input lock poisoned"))?;
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)
}

impl Write for Input {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        // JSON byte arrays expand on the wire. Keep each accepted input frame bounded.
        let length = data.len().min(4096);
        send(&self.0, &Control::Input(data[..length].to_vec()))?;
        Ok(length)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Controller {
    pub(super) fn new(worker: Handle, input: File) -> (Self, Input) {
        let input = Arc::new(Mutex::new(input));
        (
            Self {
                worker,
                input: Arc::clone(&input),
            },
            Input(input),
        )
    }
    pub(super) fn resize(&self, size: TerminalSize) -> io::Result<()> {
        validate_size([size.rows, size.cols]).map_err(io::Error::other)?;
        send(&self.input, &Control::Resize([size.rows, size.cols]))
    }
    pub(super) fn interrupt(&self) -> io::Result<()> {
        send(&self.input, &Control::Interrupt)
    }
    pub(super) fn wait_for_close(&self) -> Result<()> {
        if unsafe { WaitForSingleObject(self.worker.0, 10000) } != WAIT_OBJECT_0 {
            return Err("terminal worker did not close after command exit".into());
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.worker.0, &mut code) } == 0 {
            return Err(win::error("GetExitCodeProcess(terminal worker)"));
        }
        if code != 0 {
            return Err(format!("terminal worker failed: {code:#x}"));
        }
        Ok(())
    }
}

fn validate_size([rows, cols]: [u16; 2]) -> Result<()> {
    if rows == 0 || cols == 0 || rows > i16::MAX as u16 || cols > i16::MAX as u16 {
        return Err("terminal dimensions must be between 1 and 32767".into());
    }
    Ok(())
}

fn open_streams(request: &process::Request) -> Result<[File; 3]> {
    let names = request
        .pipes
        .as_ref()
        .ok_or("terminal worker requires private I/O pipes")?;
    let mut streams = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let raw = unsafe {
            CreateFileW(
                win::wide(name).as_ptr(),
                if index == 0 {
                    GENERIC_READ
                } else {
                    GENERIC_WRITE
                },
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(win::error("CreateFileW(terminal stream)"));
        }
        streams.push(unsafe { File::from_raw_handle(raw.cast()) });
    }
    streams
        .try_into()
        .map_err(|_| "terminal worker requires three streams".into())
}

fn protect_worker(owner: &str) -> Result<()> {
    // This helper outlives the bootstrap. The child must not obtain its ordinary
    // account token, duplicate its handles, inject a thread or alter its ACL.
    // Apply the same ACL to future worker threads before creating any of them.
    let descriptor = win::descriptor(&format!("D:P(A;;0;;;OW)(A;;GA;;;SY)(A;;GA;;;{owner})"))?;
    // Windows initialization may already have created additional worker threads.
    // Protect those too; changing the primary token's default ACL only governs
    // threads created afterward and does not repair existing thread objects.
    let snapshot = Handle::new(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) },
        "terminal worker thread snapshot",
    )?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut threads = Vec::new();
    let mut found = unsafe { Thread32First(snapshot.0, &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == unsafe { GetCurrentProcessId() }
            && entry.th32ThreadID != unsafe { GetCurrentThreadId() }
        {
            threads.push(Handle::new(
                unsafe { OpenThread(WRITE_DAC, 0, entry.th32ThreadID) },
                "terminal worker thread protection",
            )?);
        }
        found = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    for object in [unsafe { GetCurrentProcess() }, unsafe {
        GetCurrentThread()
    }] {
        if unsafe { SetKernelObjectSecurity(object, DACL_SECURITY_INFORMATION, descriptor.0) } == 0
        {
            return Err(win::error("SetKernelObjectSecurity(terminal worker)"));
        }
    }
    let mut raw = std::ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | WRITE_DAC,
            &mut raw,
        )
    } == 0
    {
        return Err(win::error("OpenProcessToken(terminal worker)"));
    }
    let token = Handle::new(raw, "terminal worker token")?;
    if unsafe { SetKernelObjectSecurity(token.0, DACL_SECURITY_INFORMATION, descriptor.0) } == 0 {
        return Err(win::error("SetKernelObjectSecurity(terminal worker token)"));
    }
    let mut dacl = std::ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
    {
        return Err(win::error("GetSecurityDescriptorDacl(terminal worker)"));
    }
    let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    if unsafe {
        SetTokenInformation(
            token.0,
            TokenDefaultDacl,
            (&default_dacl as *const TOKEN_DEFAULT_DACL).cast(),
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    } == 0
    {
        return Err(win::error("SetTokenInformation(terminal worker ACL)"));
    }
    for thread in threads {
        if unsafe { SetKernelObjectSecurity(thread.0, DACL_SECURITY_INFORMATION, descriptor.0) }
            == 0
        {
            return Err(win::error(
                "SetKernelObjectSecurity(terminal worker thread)",
            ));
        }
    }
    Ok(())
}

pub(super) fn run(request: &process::Request, size: [u16; 2]) -> Result<()> {
    validate_size(size)?;
    let [mut input, mut output, _errors] = open_streams(request)?;
    // Background launchers can ignore Ctrl-C, and Windows inherits that flag.
    // A new interactive command must receive terminal signals independently
    // of its product host or test runner's own console policy.
    if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
        return Err(win::error("SetConsoleCtrlHandler(terminal worker)"));
    }
    let mut console = PreparedConPty::new(TerminalSize {
        rows: size[0],
        cols: size[1],
    })
    .map_err(|error| error.to_string())?;
    let mut child_request = request.clone();
    child_request.pipes = None;
    child_request.pseudoconsole = Some(console.pseudoconsole_handle() as usize);
    let (child, _thread, pid, tid) = process::prepare_child(&child_request)?;
    protect_worker(&request.owner)?;
    let mut writer = console.take_writer().ok_or("terminal input missing")?;
    let mut reader = console.take_reader().ok_or("terminal output missing")?;
    console
        .client_attached()
        .map_err(|error| error.to_string())?;
    let console = Arc::new(Mutex::new(Some(console)));
    let controls = Arc::clone(&console);
    std::thread::spawn(move || -> io::Result<()> {
        let mut normalizer = ash_utils_pty::WindowsTtyInputNormalizer::default();
        loop {
            let mut header = [0; 4];
            input.read_exact(&mut header)?;
            let length = u32::from_le_bytes(header) as usize;
            if length == 0 || length > MAX_FRAME {
                return Err(io::Error::other("invalid terminal control frame"));
            }
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes)?;
            match serde_json::from_slice::<Control>(&bytes).map_err(io::Error::other)? {
                Control::Input(bytes) => {
                    writer.write_all(&normalizer.normalize(&bytes))?;
                    writer.flush()?;
                }
                Control::Interrupt => {
                    writer.write_all(&normalizer.normalize(&[3]))?;
                    writer.flush()?;
                }
                Control::Resize(size) => {
                    validate_size(size).map_err(io::Error::other)?;
                    let guard = controls
                        .lock()
                        .map_err(|_| io::Error::other("terminal lock poisoned"))?;
                    guard
                        .as_ref()
                        .ok_or_else(|| io::Error::other("terminal already closed"))?
                        .resize(TerminalSize {
                            rows: size[0],
                            cols: size[1],
                        })
                        .map_err(io::Error::other)?;
                }
            }
        }
    });
    let drained = std::thread::spawn(move || io::copy(&mut reader, &mut output));
    process::publish_reply(request, pid, tid, None)?;
    if unsafe { WaitForSingleObject(child.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err(win::error("WaitForSingleObject(terminal child)"));
    }
    // Close from the creating process while output is still drained. On 23H2,
    // ReleasePseudoConsole is absent and retaining HPCON would keep output open.
    console.lock().map_err(|_| "terminal lock poisoned")?.take();
    drained
        .join()
        .map_err(|_| "terminal output worker panicked")?
        .map_err(|error| error.to_string())?;
    Ok(())
}
