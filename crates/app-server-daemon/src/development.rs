use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use ash_package_store::PackageLease;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Generation {
    version: u32,
    runtime: String,
}

struct LeasedRuntime {
    root: PathBuf,
    _lease: PackageLease,
}

fn select_runtime(generation_file: &Path) -> Result<LeasedRuntime, String> {
    if !generation_file.is_absolute() {
        return Err("development generation path must be absolute".into());
    }
    let directory = generation_file
        .parent()
        .ok_or("generation file has no parent")?;
    let publication = OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("publish.lock"))
        .map_err(|error| error.to_string())?;
    // Selection and lease acquisition are one transaction with the Python collector.
    // The publication lock can be released only after the runtime lease is held.
    publication
        .lock_shared()
        .map_err(|error| error.to_string())?;
    let mut contents = Vec::new();
    File::open(generation_file)
        .and_then(|file| file.take(4_097).read_to_end(&mut contents))
        .map_err(|error| error.to_string())?;
    if contents.len() > 4_096 {
        return Err("development runtime generation is oversized".into());
    }
    let generation: Generation =
        serde_json::from_slice(&contents).map_err(|error| error.to_string())?;
    let digest = generation
        .runtime
        .strip_prefix("generations/")
        .ok_or("invalid development runtime generation")?;
    if generation.version != 3
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid development runtime generation".into());
    }
    let root = directory.join(generation.runtime);
    let lease = PackageLease::acquire(&root).map_err(|error| error.to_string())?;
    for name in ["", "bin", "ash-path", "ash-resources"] {
        let metadata = fs::symlink_metadata(root.join(name)).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!("invalid development runtime directory: {name}"));
        }
    }
    for name in [
        "ash-development.json",
        if cfg!(windows) {
            "bin/ash-app-server.exe"
        } else {
            "bin/ash-app-server"
        },
        if cfg!(windows) {
            "bin/ash-app-server-daemon.exe"
        } else {
            "bin/ash-app-server-daemon"
        },
    ] {
        let metadata = fs::symlink_metadata(root.join(name)).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!("invalid development runtime file: {name}"));
        }
    }
    Ok(LeasedRuntime {
        root,
        _lease: lease,
    })
}

pub(crate) fn hold_runtime_lease(generation_file: &Path) -> Result<(), String> {
    let selected = select_runtime(generation_file)?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(
        &mut stdout,
        &serde_json::json!({ "runtime": selected.root }),
    )
    .map_err(|error| error.to_string())?;
    writeln!(stdout)
        .and_then(|()| stdout.flush())
        .map_err(|error| error.to_string())?;
    // Electron owns the pipe. Window/profile disposal or a host crash closes stdin
    // and releases the OS lease without a persistent PID file or stale lock cleanup.
    let mut input = [0];
    if std::io::stdin()
        .read(&mut input)
        .map_err(|error| error.to_string())?
        != 0
    {
        return Err("development lease expects stdin to close".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "development_tests.rs"]
mod tests;
