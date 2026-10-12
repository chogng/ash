//! Installation-owned Electron binding for one selected backend generation.

use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_package_store::PackageStore;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

pub(crate) const ELECTRON_PATH_ENV: &str = "ASH_ELECTRON_RUN_AS_NODE_PATH";
pub(crate) const ELECTRON_SHA_ENV: &str = "ASH_ELECTRON_RUN_AS_NODE_SHA256";
const BINDING_ENV: &str = "ASH_ELECTRON_RUNTIME_BINDING";
const AVAILABLE_ENV: &str = "ASH_ELECTRON_RUNTIME_AVAILABLE";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RuntimeAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ElectronRuntimeBinding {
    executable: PathBuf,
    sha256: String,
    electron_version: String,
    node_version: String,
}

impl ElectronRuntimeBinding {
    pub(crate) fn capture(path: &Path, expected_version: &str) -> Result<Self, String> {
        if !path.is_absolute() || !path.is_file() {
            return Err("Desktop must provide an absolute Electron executable".into());
        }
        let executable = dunce::canonicalize(path).map_err(|error| error.to_string())?;
        let before = file_digest(&executable)?;
        let versions = probe(&executable)?;
        let binding = Self {
            executable,
            sha256: before,
            electron_version: versions.electron,
            node_version: versions.node,
        };
        binding.validate(expected_version)?;
        if file_digest(&binding.executable)? != binding.sha256 {
            return Err("Electron changed while its runtime was being bound".into());
        }
        Ok(binding)
    }

    pub(crate) fn validate(&self, expected_version: &str) -> Result<(), String> {
        let electron = semver::Version::parse(&self.electron_version)
            .map_err(|_| "installed Electron version is invalid")?;
        let node = semver::Version::parse(&self.node_version)
            .map_err(|_| "installed Node version is invalid")?;
        if !self.executable.is_absolute()
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || electron.to_string() != expected_version
            || node.major < 24
        {
            return Err("Electron runtime does not match the Desktop package contract".into());
        }
        Ok(())
    }

    pub(crate) fn availability(&self) -> RuntimeAvailability {
        match Self::capture(&self.executable, &self.electron_version) {
            Ok(current) if &current == self => RuntimeAvailability::Available,
            Ok(_) | Err(_) => RuntimeAvailability::Unavailable,
        }
    }

    pub(crate) fn apply(
        &self,
        command: &mut Command,
        availability: &RuntimeAvailability,
    ) -> Result<(), String> {
        command
            .env(ELECTRON_PATH_ENV, &self.executable)
            .env(ELECTRON_SHA_ENV, &self.sha256)
            .env(
                AVAILABLE_ENV,
                match availability {
                    RuntimeAvailability::Available => "1",
                    RuntimeAvailability::Unavailable => "0",
                },
            )
            .env(
                BINDING_ENV,
                serde_json::to_string(self).map_err(|error| error.to_string())?,
            );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Versions {
    electron: String,
    node: String,
}

pub(crate) fn frozen_binding() -> Result<Option<ElectronRuntimeBinding>, String> {
    let Some(value) = std::env::var_os(BINDING_ENV) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .filter(|value| value.len() <= 16 * 1024)
        .ok_or("frozen Electron binding is invalid")?;
    let binding: ElectronRuntimeBinding =
        serde_json::from_str(value).map_err(|error| error.to_string())?;
    binding.validate(&binding.electron_version)?;
    Ok(Some(binding))
}

pub(crate) fn frozen_availability() -> Result<Option<RuntimeAvailability>, String> {
    match std::env::var(AVAILABLE_ENV).as_deref() {
        Ok("1") => Ok(Some(RuntimeAvailability::Available)),
        Ok("0") => Ok(Some(RuntimeAvailability::Unavailable)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Ok(_) | Err(_) => Err("frozen Electron availability is invalid".into()),
    }
}

pub(crate) fn binding_for_backend(
    executable: &Path,
) -> Result<Option<ElectronRuntimeBinding>, String> {
    let Some(package) = executable
        .parent()
        .filter(|bin| bin.file_name().is_some_and(|name| name == "bin"))
        .and_then(Path::parent)
    else {
        return Ok(None);
    };
    let path = package.join("ash-package.json");
    if !path.exists() {
        return Ok(None);
    }
    let kind = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !kind.is_file() || kind.file_type().is_symlink() || kind.len() > 1024 * 1024 {
        return Err("backend runtime metadata is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("backend runtime metadata exceeds its size limit".into());
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let Some(expected) = metadata["javascriptRuntime"]["electronVersion"].as_str() else {
        if metadata["javascriptRuntime"]["kind"] == "hostProvidedNode"
            && metadata["buildProfile"] != "dev-small"
        {
            return Err("Desktop release backend has no Electron version contract".into());
        }
        return Ok(None);
    };
    if metadata["javascriptRuntime"]["kind"] != "hostProvidedNode" {
        return Err("Electron contract requires a host-provided runtime package".into());
    }
    let store_root = package
        .parent()
        .and_then(Path::parent)
        .filter(|packages| packages.file_name().is_some_and(|name| name == "packages"))
        .and_then(Path::parent)
        .ok_or("Desktop backend has no installed runtime binding")?;
    let selected = PackageStore::open(store_root)
        .and_then(|store| store.current())
        .map_err(|error| error.to_string())?
        .ok_or("Desktop backend has no selected package")?;
    if selected.package_root != package {
        return Err("Desktop backend is not the selected generation".into());
    }
    let binding: ElectronRuntimeBinding = serde_json::from_value(
        selected
            .installation
            .ok_or("Desktop backend has no installed runtime binding")?,
    )
    .map_err(|error| error.to_string())?;
    binding.validate(expected)?;
    Ok(Some(binding))
}

pub(crate) fn clear_binding(command: &mut Command) {
    command
        .env_remove(ELECTRON_PATH_ENV)
        .env_remove(ELECTRON_SHA_ENV)
        .env_remove(AVAILABLE_ENV)
        .env_remove(BINDING_ENV);
}

fn file_digest(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn probe(executable: &Path) -> Result<Versions, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("ash-electron-probe-{}-{nonce}", std::process::id()));
    let result = (|| {
        let output = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command.env_clear().env("ELECTRON_RUN_AS_NODE", "1")
            .args(["--input-type=commonjs", "--eval", "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node}))"])
            .stdin(Stdio::null()).stdout(output.try_clone().map_err(|error| error.to_string())?).stderr(Stdio::null());
        for name in [
            "SYSTEMROOT",
            "WINDIR",
            "HOME",
            "USERPROFILE",
            "TMP",
            "TEMP",
            "TMPDIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = ProbeChild(command.spawn().map_err(|error| error.to_string())?);
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.0.try_wait().map_err(|error| error.to_string())? {
                break status;
            }
            if Instant::now() >= deadline
                || output.metadata().map_err(|error| error.to_string())?.len() > 4096
            {
                return Err("Electron runtime probe exceeded its time or output limit".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if !status.success() || output.metadata().map_err(|error| error.to_string())?.len() > 4096 {
            return Err("Electron cannot provide the required Node runtime".into());
        }
        serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(path);
    result
}

struct ProbeChild(Child);

impl Drop for ProbeChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
