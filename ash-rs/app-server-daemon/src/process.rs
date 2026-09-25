use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::thread;
#[cfg(unix)]
use std::time::Duration;

use ash_package_store::PackageLease;
use ash_package_store::acquire_package_lease_for_executable;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::ConnectionOptions;
use crate::MANAGED_PROCESS_ARGUMENT;
use crate::endpoint::EndpointPaths;

const MAX_PID_RECORD_BYTES: u64 = 16 * 1024;
#[cfg(unix)]
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(unix)]
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const HOME_ENV: &str = "ASH_HOME";
const DIR_ROOT_ENV: &str = "ASH_WORKSPACE_ROOT";
const DIR_GRANT_SOURCE_ENV: &str = "ASH_DIR_GRANT_SOURCE";
const EXECUTABLE_HASH_BUFFER_BYTES: usize = 64 * 1024;
const MAX_PACKAGE_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessRecord {
    pub(crate) pid: u32,
    pub(crate) instance_id: String,
    pub(crate) process_start_identity: Option<String>,
    pub(crate) daemon_version: String,
    #[serde(default)]
    pub(crate) executable_identity: Option<ExecutableIdentity>,
}

/// Binary contents and immutable package identity selected for one daemon generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutableIdentity {
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    package_build_id: Option<String>,
}

impl ExecutableIdentity {
    pub(crate) fn matches_sha256(&self, expected: &str) -> bool {
        self.sha256 == expected
    }

    pub(crate) fn same_generation(&self, other: &Self) -> bool {
        !self.sha256.is_empty()
            && self.sha256 == other.sha256
            && self.package_build_id == other.package_build_id
    }
}

pub(crate) struct BackendExecutable {
    pub(crate) path: PathBuf,
    pub(crate) identity: ExecutableIdentity,
    _package_lease: Option<PackageLease>,
}

impl ProcessRecord {
    pub(crate) fn current(endpoint: &EndpointPaths) -> Result<Self, String> {
        let pid = std::process::id();
        let process_start_identity = Some(
            process_start_identity(pid)?
                .ok_or("current backend process has no live start identity")?,
        );
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let mut digest = Sha256::new();
        digest.update(endpoint.socket.to_string_lossy().as_bytes());
        digest.update(pid.to_le_bytes());
        digest.update(now.to_le_bytes());
        if let Some(identity) = &process_start_identity {
            digest.update(identity.as_bytes());
        }
        Ok(Self {
            pid,
            instance_id: format!("{:x}", digest.finalize()),
            process_start_identity,
            daemon_version: build_info::VERSION.into(),
            executable_identity: Some(executable_identity(
                &dunce::canonicalize(std::env::current_exe().map_err(io_error)?)
                    .map_err(io_error)?,
            )?),
        })
    }
}

pub(crate) fn executable_identity(path: &Path) -> Result<ExecutableIdentity, String> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; EXECUTABLE_HASH_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(ExecutableIdentity {
        sha256: format!("{:x}", digest.finalize()),
        package_build_id: package_build_id(path)?,
    })
}

fn package_build_id(executable: &Path) -> Result<Option<String>, String> {
    let Some(root) = executable
        .parent()
        .filter(|directory| directory.file_name().is_some_and(|name| name == "bin"))
        .and_then(Path::parent)
    else {
        return Ok(None);
    };
    let file = match File::open(root.join("ash-package.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PACKAGE_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_PACKAGE_METADATA_BYTES {
        return Err("package buildId is invalid".into());
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "package buildId is invalid")?;
    let build_id = metadata
        .get("buildId")
        .and_then(serde_json::Value::as_str)
        .ok_or("package buildId is invalid")?;
    let digest = build_id
        .strip_prefix("sha256:")
        .ok_or("package buildId is invalid")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("package buildId is invalid".into());
    }
    Ok(Some(build_id.to_owned()))
}

pub(crate) fn resolve_backend_executable(
    backend_executable: &Path,
) -> Result<BackendExecutable, String> {
    let metadata = fs::symlink_metadata(backend_executable).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Local App Server daemon is not a regular executable: {}",
            backend_executable.display()
        ));
    }
    let path = dunce::canonicalize(backend_executable).map_err(io_error)?;
    let package_lease = acquire_package_lease_for_executable(&path).map_err(io_error)?;
    let identity = executable_identity(&path)?;
    Ok(BackendExecutable {
        path,
        identity,
        _package_lease: package_lease,
    })
}

pub(crate) struct ProcessRecordGuard {
    path: PathBuf,
    record: ProcessRecord,
}

impl ProcessRecordGuard {
    pub(crate) fn publish(path: &Path, record: &ProcessRecord) -> Result<Self, String> {
        let temp = path.with_extension(format!("{}.tmp", record.instance_id));
        let contents = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        let mut file = open_private_record(&temp)?;
        let written = file.write_all(&contents).and_then(|_| file.sync_all());
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&temp);
            return Err(io_error(error));
        }
        if cfg!(windows) && path.exists() {
            fs::remove_file(path).map_err(io_error)?;
        }
        if let Err(error) = fs::rename(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(io_error(error));
        }
        Ok(Self {
            path: path.to_path_buf(),
            record: record.clone(),
        })
    }
}

impl Drop for ProcessRecordGuard {
    fn drop(&mut self) {
        if read_process_record(&self.path)
            .ok()
            .flatten()
            .is_some_and(|record| record == self.record)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) fn read_process_record(path: &Path) -> Result<Option<ProcessRecord>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PID_RECORD_BYTES
    {
        return Err("Local App Server process record is not a bounded regular file".into());
    }
    let contents = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&contents)
        .map(Some)
        .map_err(|error| format!("invalid Local App Server process record: {error}"))
}

pub(crate) fn record_is_active(record: &ProcessRecord) -> Result<bool, String> {
    let expected = record
        .process_start_identity
        .as_ref()
        .ok_or("managed process record has no start identity")?;
    Ok(process_start_identity(record.pid)?.as_ref() == Some(expected))
}

pub(crate) fn remove_matching_process_record(
    path: &Path,
    expected: &ProcessRecord,
) -> Result<(), String> {
    if read_process_record(path)?.as_ref() != Some(expected) {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

pub(crate) fn remove_stale_process_record(path: &Path) -> Result<(), String> {
    if let Some(record) = read_process_record(path)? {
        if record_is_active(&record)? {
            return Err("managed backend is alive but its control endpoint is unavailable".into());
        }
        remove_matching_process_record(path, &record)?;
    }
    Ok(())
}

/// Owns an unready child. Every unsuccessful launch terminates and reaps that exact child.
pub(crate) struct SpawnedBackend {
    child: Option<Child>,
    endpoint: EndpointPaths,
    start_identity: Option<String>,
}

impl SpawnedBackend {
    pub(crate) fn exit_status(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child.as_mut().unwrap().try_wait().map_err(io_error)
    }

    pub(crate) fn release(mut self) {
        let mut child = self.child.take().unwrap();
        // Reap the child if this controller outlives it; the service itself is independently managed.
        thread::spawn(move || {
            let _ = child.wait();
        });
    }

    pub(crate) fn abort(&mut self) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        let pid = child.id();
        if child.try_wait().map_err(io_error)?.is_none() {
            child.kill().map_err(io_error)?;
        }
        child.wait().map_err(io_error)?;
        self.child.take();
        if let Some(record) = read_process_record(&self.endpoint.pid)?
            && record.pid == pid
            && self.start_identity.is_some()
            && record.process_start_identity == self.start_identity
        {
            remove_matching_process_record(&self.endpoint.pid, &record)?;
            // Only the failed child's generation may lose its stale socket.
            if read_process_record(&self.endpoint.pid)?.is_none()
                && crate::endpoint::connect_existing(&self.endpoint.socket)?.is_none()
            {
                drop(crate::endpoint::SocketCleanup::new(
                    self.endpoint.socket.clone(),
                ));
            }
        }
        Ok(())
    }
}

impl Drop for SpawnedBackend {
    fn drop(&mut self) {
        if let Err(error) = self.abort() {
            eprintln!("failed to clean up unready backend: {error}");
        }
    }
}

pub(crate) fn spawn_backend(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
    backend_executable: &Path,
) -> Result<SpawnedBackend, String> {
    let metadata = fs::symlink_metadata(backend_executable).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Local App Server daemon is not a regular executable: {}",
            backend_executable.display()
        ));
    }
    let log = endpoint.open_log()?;
    let error_log = log.try_clone().map_err(io_error)?;
    let mut command = Command::new(backend_executable);
    command
        .arg(MANAGED_PROCESS_ARGUMENT)
        .env(HOME_ENV, options.profile_root())
        .env_remove(DIR_ROOT_ENV)
        .env_remove(DIR_GRANT_SOURCE_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    detach_command(&mut command);
    let child = command.spawn().map_err(io_error)?;
    let mut spawned = SpawnedBackend {
        child: Some(child),
        endpoint: endpoint.clone(),
        start_identity: None,
    };
    spawned.start_identity = process_start_identity(spawned.child.as_ref().unwrap().id())?;
    Ok(spawned)
}

#[cfg(unix)]
fn detach_command(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn detach_command(command: &mut Command) {
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    // A managed backend must survive the controller and its containing job.
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
}

#[cfg(unix)]
pub(crate) fn force_terminate(record: &ProcessRecord) -> Result<(), String> {
    let Some(expected_start) = &record.process_start_identity else {
        return Err("managed daemon has no process start identity".into());
    };
    if process_start_identity(record.pid)?.as_ref() != Some(expected_start) {
        return Err("refusing to terminate a reused or stale daemon pid".into());
    }
    let status = Command::new("kill")
        .arg("-KILL")
        .arg(record.pid.to_string())
        .status()
        .map_err(io_error)?;
    if !status.success() {
        return Err(format!(
            "failed to force terminate Local App Server daemon {}",
            record.pid
        ));
    }
    wait_for_process_exit(record)
}

#[cfg(windows)]
pub(crate) fn force_terminate(record: &ProcessRecord) -> Result<(), String> {
    let expected = record
        .process_start_identity
        .as_deref()
        .ok_or("managed backend has no process start identity")?;
    windows::terminate(record.pid, expected)
}

#[cfg(unix)]
fn wait_for_process_exit(record: &ProcessRecord) -> Result<(), String> {
    let deadline = std::time::Instant::now() + PROCESS_EXIT_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if process_start_identity(record.pid)?.as_ref() != record.process_start_identity.as_ref() {
            return Ok(());
        }
        thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
    }
    Err(format!(
        "timed out waiting for Local App Server daemon {} to exit",
        record.pid
    ))
}

#[cfg(unix)]
fn process_start_identity(pid: u32) -> Result<Option<String>, String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat=", "-o", "lstart="])
        .output()
        .map_err(io_error)?;
    if !output.status.success() {
        return Ok(None);
    }
    let identity = String::from_utf8(output.stdout)
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    let Some((state, created)) = identity.split_once(char::is_whitespace) else {
        return Ok(None);
    };
    if state.starts_with('Z') {
        return Ok(None);
    }
    let created = created.trim();
    Ok((!created.is_empty()).then(|| created.to_owned()))
}

#[cfg(windows)]
fn process_start_identity(pid: u32) -> Result<Option<String>, String> {
    windows::start_identity(pid)
}

#[cfg(unix)]
fn open_private_record(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io_error)
}

#[cfg(windows)]
fn open_private_record(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(io_error)
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[cfg(windows)]
#[allow(unsafe_code)]
#[path = "process/windows.rs"]
mod windows;
