use crate::FileMetadata;
use crate::FileSystemError;
use ash_async_utils::CancellationToken;
use ash_file_access::Dir;
use rand::RngCore;
use serde::Deserialize;
use serde::Serialize;
use std::ffi::OsString;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

pub const ELEVATED_FILE_WRITE_ARGUMENT: &str = "--ash-elevated-file-write";
const MAX_BYTES: usize = 50 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(180);
const POLL: Duration = Duration::from_millis(50);

#[derive(Serialize, Deserialize)]
struct WriteJob {
    root: PathBuf,
    directory_id: String,
    path: PathBuf,
    expected_revision: Option<String>,
    #[cfg(unix)]
    creator: [u32; 2],
}

/// Internal one-shot role. It accepts a loopback port and a private credential path, never a
/// caller-selected executable or shell command. Its capability lives in a private, transient
/// file so process listings cannot reveal it. File data only crosses the authenticated socket.
pub fn run_elevated_file_helper(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<(), FileSystemError> {
    let mut arguments = arguments.into_iter();
    let port = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or(FileSystemError::ElevationDenied)?;
    let credential = arguments
        .next()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ash-elevated-auth-"))
        })
        .ok_or(FileSystemError::ElevationDenied)?;
    if arguments.next().is_some() {
        return Err(FileSystemError::ElevationDenied);
    }
    let token = read_credential(&credential)?;
    let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).map_err(io_error)?;
    socket.set_read_timeout(Some(TIMEOUT)).map_err(io_error)?;
    socket.set_write_timeout(Some(TIMEOUT)).map_err(io_error)?;
    socket.write_all(token.as_bytes()).map_err(io_error)?;
    helper(&mut socket)
}

pub(super) fn write(
    dir: &Dir,
    path: &Path,
    content: &[u8],
    expected_revision: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<FileMetadata, FileSystemError> {
    if content.len() > MAX_BYTES {
        return Err(FileSystemError::WriteLimitExceeded {
            maximum_bytes: MAX_BYTES,
        });
    }
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(FileSystemError::InvalidPath(path.into()));
    }
    dir.resolve_for_write(path)
        .map_err(|_| FileSystemError::InvalidPath(path.into()))?;
    let job = WriteJob {
        root: dir.canonical_path().into(),
        directory_id: dir.id().to_string(),
        path: path.into(),
        expected_revision: expected_revision.map(str::to_owned),
        #[cfg(unix)]
        creator: [
            rustix::process::geteuid().as_raw(),
            rustix::process::getegid().as_raw(),
        ],
    };
    exchange(dir, &job, content, cancellation, launch)
}

fn exchange(
    dir: &Dir,
    job: &WriteJob,
    content: &[u8],
    cancellation: &CancellationToken,
    launch: impl FnOnce(u16, &Path) -> Result<HelperProcess, FileSystemError>,
) -> Result<FileMetadata, FileSystemError> {
    if cancellation.is_cancelled() {
        return Err(FileSystemError::Cancelled);
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(io_error)?;
    listener.set_nonblocking(true).map_err(io_error)?;
    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let token = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut credential = tempfile::Builder::new()
        .prefix("ash-elevated-auth-")
        .tempfile()
        .map_err(io_error)?;
    credential.write_all(token.as_bytes()).map_err(io_error)?;
    credential.flush().map_err(io_error)?;
    let mut process = launch(
        listener.local_addr().map_err(io_error)?.port(),
        credential.path(),
    )?;
    let deadline = Instant::now() + TIMEOUT;
    let mut socket = loop {
        if cancellation.is_cancelled() {
            return Err(FileSystemError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(FileSystemError::ElevationTimedOut);
        }
        match listener.accept() {
            Ok((mut socket, _)) => {
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .map_err(io_error)?;
                socket.set_write_timeout(Some(TIMEOUT)).map_err(io_error)?;
                let mut presented = [0_u8; 64];
                if socket.read_exact(&mut presented).is_ok() && presented == token.as_bytes() {
                    break socket;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(io_error(error)),
        }
        if let Some(status) = process.child.try_wait().map_err(io_error)? {
            return Err(process.exit_error(status.code()));
        }
        std::thread::sleep(POLL);
    };
    if cancellation.is_cancelled() {
        return Err(FileSystemError::Cancelled);
    }
    write_json(&mut socket, job)?;
    socket
        .write_all(&(content.len() as u32).to_be_bytes())
        .map_err(io_error)?;
    socket.write_all(content).map_err(io_error)?;
    socket.set_read_timeout(Some(POLL)).map_err(io_error)?;
    let mut ready = [0_u8; 1];
    loop {
        if cancellation.is_cancelled() {
            return Err(FileSystemError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(FileSystemError::ElevationTimedOut);
        }
        match socket.read_exact(&mut ready) {
            Ok(()) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    if ready[0] == 0 {
        socket.set_read_timeout(Some(TIMEOUT)).map_err(io_error)?;
        return read_json(&mut socket, 64 * 1024)?;
    }
    if ready[0] != 1 || cancellation.is_cancelled() {
        return Err(FileSystemError::Cancelled);
    }
    let _write = dir
        .directory()
        .lock_writes()
        .map_err(|_| FileSystemError::Io("directory write lock is poisoned".into()))?;
    if cancellation.is_cancelled() {
        return Err(FileSystemError::Cancelled);
    }
    // From this point publication owns the outcome: cancellation may not hide a completed save.
    // Losing the acknowledgement leaves the editor dirty and requires a fresh read before retry.
    socket.set_read_timeout(Some(TIMEOUT)).map_err(io_error)?;
    socket
        .write_all(&[1])
        .map_err(|_| FileSystemError::WriteOutcomeUnknown)?;
    read_json(&mut socket, 64 * 1024).map_err(|_| FileSystemError::WriteOutcomeUnknown)?
}

fn helper(socket: &mut TcpStream) -> Result<(), FileSystemError> {
    let job: WriteJob = read_json(socket, 64 * 1024)?;
    let mut size = [0_u8; 4];
    socket.read_exact(&mut size).map_err(io_error)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_BYTES {
        return Err(FileSystemError::WriteLimitExceeded {
            maximum_bytes: MAX_BYTES,
        });
    }
    let mut content = vec![0_u8; size];
    socket.read_exact(&mut content).map_err(io_error)?;
    let prepared = (|| {
        let dir = Dir::open_local(&job.root)
            .map_err(|_| FileSystemError::InvalidPath(job.root.clone()))?;
        if dir.id().as_str() != job.directory_id {
            return Err(FileSystemError::InvalidPath(job.root.clone()));
        }
        crate::local::prepare_elevated_write(
            &dir,
            &job.path,
            &content,
            job.expected_revision.as_deref(),
            #[cfg(unix)]
            job.creator,
        )
    })();
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            socket.write_all(&[0]).map_err(io_error)?;
            return write_json(socket, &Err::<FileMetadata, _>(error));
        }
    };
    socket.write_all(&[1]).map_err(io_error)?;
    let mut commit = [0_u8; 1];
    // Closing the connection before this byte discards the prepared file through Drop.
    socket.read_exact(&mut commit).map_err(io_error)?;
    if commit[0] != 1 {
        return Err(FileSystemError::Cancelled);
    }
    write_json(socket, &prepared.publish())
}

struct HelperProcess {
    child: Child,
    diagnostics: tempfile::NamedTempFile,
    credential_path: PathBuf,
}

impl HelperProcess {
    fn exit_error(&self, code: Option<i32>) -> FileSystemError {
        let mut output = String::new();
        if let Ok(file) = std::fs::File::open(self.diagnostics.path()) {
            let _ = file.take(8 * 1024).read_to_string(&mut output);
        }
        // Redact the capability path even if an OS diagnostic repeats the launch command.
        let output = output.replace(
            self.credential_path.to_string_lossy().as_ref(),
            "[private credential]",
        );
        tracing::warn!(?code, diagnostics = %output.trim(), "file authorization launcher exited before connecting");
        authorization_exit_error(std::env::consts::OS, code, &output)
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn launch(port: u16, credential: &Path) -> Result<HelperProcess, FileSystemError> {
    let executable = std::env::current_exe().map_err(io_error)?;
    let executable = executable
        .to_str()
        .ok_or(FileSystemError::ElevationUnavailable)?;
    let credential = credential
        .to_str()
        .ok_or(FileSystemError::ElevationUnavailable)?;
    let mut command = launch_command(std::env::consts::OS, executable, port, credential)?;
    // A private file avoids a pipe blocking the launcher while the user authorizes it.
    // It is removed with the process, including cancellation and failed startup.
    let diagnostics = tempfile::Builder::new()
        .prefix("ash-elevation-log-")
        .tempfile()
        .map_err(io_error)?;
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            diagnostics.as_file().try_clone().map_err(io_error)?,
        ))
        .stderr(Stdio::from(
            diagnostics.as_file().try_clone().map_err(io_error)?,
        ))
        .spawn()
        .map_err(|error| {
            tracing::warn!(%error, "file authorization launcher could not start");
            FileSystemError::ElevationUnavailable
        })?;
    Ok(HelperProcess {
        child,
        diagnostics,
        credential_path: credential.into(),
    })
}

fn launch_command(
    platform: &str,
    executable: &str,
    port: u16,
    credential: &str,
) -> Result<Command, FileSystemError> {
    match platform {
        "macos" => {
            let shell = format!(
                "exec {} {} {port} {}",
                shell_quote(executable),
                ELEVATED_FILE_WRITE_ARGUMENT,
                shell_quote(credential)
            );
            let mut command = Command::new("/usr/bin/osascript");
            command.args(["-e", "on run arguments\ntry\ndo shell script (item 1 of arguments) with administrator privileges with prompt (item 2 of arguments)\non error errorMessage number errorNumber\nif errorNumber is -128 then error \"ASH_ELEVATION_DENIED\"\nerror errorMessage number errorNumber\nend try\nend run", "--", &shell, "Ash"]);
            Ok(command)
        }
        "linux" => {
            let mut command = linux_launcher(Path::new("/usr/bin"))?;
            command.args([
                executable,
                ELEVATED_FILE_WRITE_ARGUMENT,
                &port.to_string(),
                credential,
            ]);
            Ok(command)
        }
        "windows" => {
            let shell = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or(FileSystemError::ElevationUnavailable)?
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let escaped = executable.replace('\'', "''");
            let credential = credential.replace('\'', "''");
            let script = format!(
                "$ErrorActionPreference='Stop'; try {{ $helper = Start-Process -FilePath '{escaped}' -ArgumentList '{ELEVATED_FILE_WRITE_ARGUMENT} {port} \"{credential}\"' -Verb RunAs -Wait -PassThru; exit $helper.ExitCode }} catch {{ $cause = $_.Exception; while ($null -ne $cause) {{ if ($cause.NativeErrorCode -eq 1223) {{ exit 126 }}; $cause = $cause.InnerException }}; Write-Error $_ -ErrorAction Continue; exit 127 }}"
            );
            let mut command = Command::new(shell);
            command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            Ok(command)
        }
        _ => Err(FileSystemError::ElevationUnavailable),
    }
}

fn linux_launcher(directory: &Path) -> Result<Command, FileSystemError> {
    let pkexec = directory.join("pkexec");
    if pkexec.is_file() {
        let mut command = Command::new(pkexec);
        // Desktop authorization must use the graphical agent, never an invisible terminal prompt.
        command.arg("--disable-internal-agent");
        return Ok(command);
    }
    let kdesudo = directory.join("kdesudo");
    if kdesudo.is_file() {
        let mut command = Command::new(kdesudo);
        command.args(["--comment", "Ash", "-d", "--"]);
        return Ok(command);
    }
    Err(FileSystemError::ElevationUnavailable)
}

fn authorization_exit_error(platform: &str, code: Option<i32>, output: &str) -> FileSystemError {
    match (platform, code) {
        ("linux" | "windows", Some(126)) => FileSystemError::ElevationDenied,
        ("linux" | "windows", Some(127)) => FileSystemError::ElevationUnavailable,
        ("macos", _) if output.contains("ASH_ELEVATION_DENIED") => FileSystemError::ElevationDenied,
        _ => FileSystemError::ElevationFailed,
    }
}

fn read_credential(path: &Path) -> Result<String, FileSystemError> {
    #[cfg(unix)]
    let file = std::fs::File::from(
        rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| FileSystemError::ElevationDenied)?,
    );
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| FileSystemError::ElevationDenied)?
    };
    #[cfg(not(any(unix, windows)))]
    let file = std::fs::File::open(path).map_err(|_| FileSystemError::ElevationDenied)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() != 64 {
        return Err(FileSystemError::ElevationDenied);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o777 != 0o600 {
            return Err(FileSystemError::ElevationDenied);
        }
    }
    let mut token = String::new();
    file.take(65).read_to_string(&mut token).map_err(io_error)?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(FileSystemError::ElevationDenied);
    }
    Ok(token)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_json(socket: &mut TcpStream, value: &impl Serialize) -> Result<(), FileSystemError> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| FileSystemError::Io(error.to_string()))?;
    socket
        .write_all(&(encoded.len() as u32).to_be_bytes())
        .map_err(io_error)?;
    socket.write_all(&encoded).map_err(io_error)
}

fn read_json<T: serde::de::DeserializeOwned>(
    socket: &mut TcpStream,
    maximum: usize,
) -> Result<T, FileSystemError> {
    let mut size = [0_u8; 4];
    socket.read_exact(&mut size).map_err(io_error)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > maximum {
        return Err(FileSystemError::ElevationDenied);
    }
    let mut bytes = vec![0_u8; size];
    socket.read_exact(&mut bytes).map_err(io_error)?;
    serde_json::from_slice(&bytes).map_err(|error| FileSystemError::Io(error.to_string()))
}

fn io_error(error: std::io::Error) -> FileSystemError {
    FileSystemError::Io(error.to_string())
}

#[cfg(test)]
#[path = "elevated_tests.rs"]
mod tests;
