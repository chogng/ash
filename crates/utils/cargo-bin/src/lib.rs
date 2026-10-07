//! Locates Cargo/Bazel test programs and resources without product dependencies.

use std::io;
use std::path::Path;
use std::path::PathBuf;

mod executable;
pub use executable::copy_executable;
#[cfg(unix)]
pub use executable::write_executable;

/// Captures Cargo's compile-time binary path at the integration-test call site.
/// Bazel targets provide the same key with a runfile path instead of an absolute path.
/// A binary must be declared by the test's build target; no sibling or PATH search occurs.
#[macro_export]
macro_rules! cargo_bin {
    ($name:literal) => {
        $crate::resolve_executable(std::path::Path::new(env!(concat!("CARGO_BIN_EXE_", $name))))
    };
}

/// The Cargo path is relative to the caller's manifest; the Bazel path is an explicit
/// rlocationpath declared in that test's data. Capture the manifest at the call site.
#[macro_export]
macro_rules! find_resource {
    ($resource:expr, $runfile:expr) => {
        $crate::resolve_resource(env!("CARGO_MANIFEST_DIR"), $resource, $runfile)
    };
}

pub fn runfiles_available() -> bool {
    ["RUNFILES_DIR", "RUNFILES_MANIFEST_FILE", "TEST_SRCDIR"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}

/// Resolves a declared test executable and rejects a missing file before spawning it.
pub fn resolve_executable(path: &Path) -> io::Result<PathBuf> {
    existing_file(if path.is_absolute() {
        path.to_path_buf()
    } else {
        resolve_runfile(path)?
    })
}

pub fn resolve_resource(
    manifest_dir: &str,
    resource: impl AsRef<Path>,
    runfile: impl AsRef<Path>,
) -> io::Result<PathBuf> {
    if runfiles_available() {
        existing_file(resolve_runfile(runfile.as_ref())?)
    } else {
        existing_file(Path::new(manifest_dir).join(resource))
    }
}

fn resolve_runfile(path: &Path) -> io::Result<PathBuf> {
    let runfiles = runfiles::Runfiles::create().map_err(io::Error::other)?;
    // Paths come from the declaring target's rlocationpath, already using canonical
    // repository names. Resolving here must not apply this helper crate's repository mapping.
    runfiles.rlocation_from(path, "").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("missing runfile: {}", path.display()),
        )
    })
}

fn existing_file(path: PathBuf) -> io::Result<PathBuf> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("test file does not exist: {}", path.display()),
        ))
    }
}

#[cfg(test)]
#[path = "cargo_bin_tests.rs"]
mod tests;
