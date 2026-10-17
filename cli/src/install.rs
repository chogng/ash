//! Publishes downloaded CLI packages using the same lock and selection as updates.

use crate::CliError;
use crate::nls;
use crate::nls::Message;
use crate::update;
use clap::Args;
use semver::Version;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Args)]
pub(crate) struct Options {
    #[arg(long)]
    package: PathBuf,
    #[arg(long)]
    install_root: PathBuf,
    #[arg(long)]
    bin_dir: PathBuf,
}

pub(crate) fn run(options: Options) -> Result<(), CliError> {
    let result = (|| {
        let version =
            Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
        install_package(options, &version, update::current_target()?)
    })();
    let installed = result
        .map_err(|error: String| CliError::failure(nls::format(Message::InstallFailed, error)))?;
    println!(
        "{}",
        nls::format(Message::Installed, installed.display().to_string())
    );
    Ok(())
}

fn install_package(options: Options, version: &Version, target: &str) -> Result<PathBuf, String> {
    let source = fs::canonicalize(options.package).map_err(detail)?;
    update::validate_package(&source, version, target)?;
    let root = std::path::absolute(options.install_root).map_err(detail)?;
    let bin = std::path::absolute(options.bin_dir).map_err(detail)?;
    fs::create_dir_all(&root).map_err(detail)?;
    fs::create_dir_all(&bin).map_err(detail)?;
    let root_identity = fs::canonicalize(&root).map_err(detail)?;
    let bin_identity = fs::canonicalize(&bin).map_err(detail)?;
    if root_identity.starts_with(&source)
        || bin_identity.starts_with(&source)
        || bin_identity.starts_with(root_identity.join("versions"))
    {
        return Err(nls::text(Message::InstallRecursivePath).into());
    }
    let _lock = update::UpdateLock::acquire(&root)?;
    // Bootstrap and background updates mutate the same installation. All checks
    // and publication happen under the OS lock, which is released even on crash.
    if root.join(update::INSTALL_MARKER).exists()
        || fs::symlink_metadata(root.join("current")).is_ok()
    {
        update::require_install_marker(&root)?;
    }
    if let Ok(metadata) = fs::symlink_metadata(root.join("current")) {
        #[cfg(unix)]
        let owned = metadata.file_type().is_symlink();
        #[cfg(windows)]
        let owned = metadata.is_file() && !metadata.file_type().is_symlink();
        if !owned {
            return Err(nls::format(
                Message::InstallUnmanagedCurrent,
                root.join("current").display().to_string(),
            ));
        }
    }
    let versions = root.join("versions");
    fs::create_dir_all(&versions).map_err(detail)?;
    update::clean_staging(&versions)?;
    let staging = versions.join(format!(".update-install-{}", std::process::id()));
    fs::create_dir(&staging).map_err(detail)?;
    let result = (|| {
        let package = staging.join("package");
        // Stage on the destination filesystem. TMPDIR and the installation may
        // live on different volumes, so moving the downloaded tree is unsafe.
        copy_package(&source, &package).map_err(detail)?;
        let installed = update::publish_package(&versions, &package, version, target)?;
        ash_utils_path::write_atomically(
            &root.join(update::INSTALL_MARKER),
            format!(
                "{{\"schemaVersion\":1,\"repository\":\"{}\"}}\n",
                update::REPOSITORY
            )
            .as_bytes(),
        )
        .map_err(detail)?;
        // Prepare the launcher first: failure must leave an existing selection usable.
        prepare_launcher(&root, &bin, &installed)?;
        update::select_package(&root, &installed)?;
        Ok(installed)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

fn copy_package(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let output = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_package(&entry.path(), &output)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), output)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                nls::text(Message::InstallUnsupportedFile),
            ));
        }
    }
    Ok(())
}

fn prepare_launcher(root: &Path, bin: &Path, installed: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let _ = installed;
    fs::create_dir_all(bin).map_err(detail)?;
    // Distinct installation roots may target the same command directory. Protect
    // launcher ownership independently of each installation's publication lock.
    let _lock = update::UpdateLock::acquire_launcher(bin)?;
    #[cfg(unix)]
    {
        let launcher = bin.join("ash");
        let target = root.join("current/bin/ash");
        match fs::symlink_metadata(&launcher) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                std::os::unix::fs::symlink(target, &launcher).map_err(detail)?;
            }
            Ok(_) if fs::read_link(&launcher).ok().as_ref() == Some(&target) => {}
            Ok(_) => kept_launcher(&launcher),
            Err(error) => return Err(detail(error)),
        }
    }
    #[cfg(windows)]
    prepare_windows_launcher(root, bin, installed)?;

    Ok(())
}

fn kept_launcher(launcher: &Path) {
    eprintln!(
        "{}",
        nls::format(Message::InstallLauncherKept, launcher.display().to_string())
    );
}

// The command file contains no installation path or non-ASCII bytes. Its binary
// adapter reads the UTF-8 binding, then forwards OS arguments without a shell or
// console-code-page changes. The adapter's v1 layout is stable across CLI updates.
#[cfg(windows)]
const WINDOWS_LAUNCHER: &str =
    "@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0ash-launcher.exe\" %*\r\nexit /b\r\n";

#[cfg(windows)]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherBinding {
    schema_version: u8,
    install_root: PathBuf,
}

#[cfg(windows)]
fn prepare_windows_launcher(root: &Path, bin: &Path, installed: &Path) -> Result<(), String> {
    let command = bin.join("ash.cmd");
    match fs::read(&command) {
        Ok(previous)
            if previous == WINDOWS_LAUNCHER.as_bytes()
                || previous == legacy_windows_launcher(root).as_bytes() => {}
        Ok(_) => {
            kept_launcher(&command);
            return Ok(());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(detail(error)),
    }
    let binding_path = bin.join("ash-launcher.json");
    let adapter = bin.join("ash-launcher.exe");
    match read_launcher_binding(&binding_path) {
        Ok(binding) => {
            if fs::canonicalize(&binding.install_root).map_err(detail)?
                != fs::canonicalize(root).map_err(detail)?
            {
                return Err(nls::text(Message::InstallForeignLauncher).into());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if fs::symlink_metadata(&adapter).is_ok() {
                return Err(nls::text(Message::InstallForeignLauncher).into());
            }
        }
        Err(error) => return Err(detail(error)),
    }
    let binding = serde_json::to_vec(&LauncherBinding {
        schema_version: 1,
        install_root: root.to_owned(),
    })
    .map_err(|error| error.to_string())?;
    ash_utils_path::write_atomically(&binding_path, &binding).map_err(detail)?;
    if !adapter.exists() {
        let source = installed.join("bin/ash.exe");
        // A hard link avoids an additional CLI-sized allocation on the usual
        // single-volume install. Copy via staging when the bin directory is on
        // another volume. The adapter stays immutable while commands run.
        if fs::hard_link(&source, &adapter).is_err() {
            let next = bin.join(format!(".ash-launcher-{:016x}.next", rand::random::<u64>()));
            let result = (|| {
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&next)?;
                std::io::copy(&mut fs::File::open(&source)?, &mut output)?;
                output.sync_all()?;
                drop(output);
                fs::rename(&next, &adapter)
            })();
            let _ = fs::remove_file(next);
            result.map_err(detail)?;
        }
    }
    ash_utils_path::write_atomically(&command, WINDOWS_LAUNCHER.as_bytes()).map_err(detail)
}

/// Handles the immutable Windows adapter before product commands and helper roles.
/// Its only authority is the adjacent installation binding and selected version.
#[cfg(windows)]
pub fn run_managed_launcher() -> Option<i32> {
    let executable = std::env::current_exe().ok()?;
    if !executable
        .file_name()?
        .to_str()
        .is_some_and(|name| name.eq_ignore_ascii_case("ash-launcher.exe"))
    {
        return None;
    }
    let result = (|| {
        use std::io::Read;
        let bin = executable
            .parent()
            .ok_or_else(|| nls::text(Message::InstallForeignLauncher).to_owned())?;
        let binding = read_launcher_binding(&bin.join("ash-launcher.json")).map_err(detail)?;
        let mut selected = String::new();
        fs::File::open(binding.install_root.join("current"))
            .map_err(detail)?
            .take(4097)
            .read_to_string(&mut selected)
            .map_err(detail)?;
        let selected = selected.trim();
        let valid = selected.len() <= 4096
            && selected.rsplit_once('-').is_some_and(|(version, digest)| {
                Version::parse(version).is_ok()
                    && digest.len() == 16
                    && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !valid {
            return Err(nls::text(Message::InstallForeignLauncher).into());
        }
        let target = binding
            .install_root
            .join("versions")
            .join(selected)
            .join("bin/ash.exe");
        let status = std::process::Command::new(target)
            .args(std::env::args_os().skip(1))
            .status()
            .map_err(detail)?;
        status
            .code()
            .ok_or_else(|| nls::text(Message::InstallForeignLauncher).to_owned())
    })();
    Some(match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!(
                "ash: {}",
                nls::format(Message::InstallLauncherFailed, error)
            );
            1
        }
    })
}

#[cfg(windows)]
fn read_launcher_binding(path: &Path) -> io::Result<LauncherBinding> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            nls::text(Message::InstallForeignLauncher),
        )
    };
    if bytes.len() > 64 * 1024 {
        return Err(invalid());
    }
    let binding: LauncherBinding = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if binding.schema_version != 1 || !binding.install_root.is_absolute() {
        return Err(invalid());
    }
    Ok(binding)
}

#[cfg(windows)]
fn legacy_windows_launcher(root: &Path) -> String {
    let value = format!(
        "@echo off\r\nset /p ASH_VERSION=<\"{}\\current\"\r\n\"{}\\versions\\%ASH_VERSION%\\bin\\ash.exe\" %*\r\n",
        root.display(),
        root.display()
    );
    value
        .chars()
        .map(|character| if character.is_ascii() { character } else { '?' })
        .collect()
}

fn detail(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
