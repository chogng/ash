use crate::HostExecutableName;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

/// Frozen installation directories used to find automatic background helpers.
///
/// Searches never consult PATH, PATHEXT, or the working directory. The operating system's
/// installation directories and their contents must be trusted by the host. This type selects
/// executable files; it neither starts them nor grants permission to perform their operations.
#[derive(Clone, Debug)]
pub struct SystemExecutables {
    directories: Vec<PathBuf>,
    roots: Vec<PathBuf>,
}

impl SystemExecutables {
    /// Captures the platform's conventional system and package-manager installation locations.
    pub fn current() -> Self {
        let (directories, roots) = platform_directories();
        Self::from_directories(directories, roots)
    }

    /// Finds an installed executable and rejects links whose destination is outside installation roots.
    pub fn find(&self, name: &HostExecutableName) -> io::Result<PathBuf> {
        let name = executable_name(name);
        for directory in &self.directories {
            let candidate = directory.join(&name);
            let resolved = match dunce::canonicalize(&candidate) {
                Ok(path) => path,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if !self.roots.iter().any(|root| resolved.starts_with(root)) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "system executable resolves outside installation directories",
                ));
            }
            let metadata = resolved.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "system executable is not a file",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "system file is not executable",
                    ));
                }
            }
            return Ok(resolved);
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "installed executable `{}` was not found",
                name.to_string_lossy()
            ),
        ))
    }

    /// Builds the PATH inherited by automatic helpers from the same installation directories.
    pub fn search_path(&self) -> io::Result<OsString> {
        if self.directories.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "no system executable directories",
            ));
        }
        std::env::join_paths(&self.directories)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
    }

    fn from_directories(directories: Vec<PathBuf>, roots: Vec<PathBuf>) -> Self {
        Self {
            directories: existing_directories(directories),
            roots: existing_directories(roots),
        }
    }
}

fn existing_directories(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for path in paths {
        if path.is_absolute()
            && let Ok(path) = dunce::canonicalize(path)
            && path.is_dir()
            && !directories.contains(&path)
        {
            directories.push(path);
        }
    }
    directories
}

fn executable_name(name: &HostExecutableName) -> OsString {
    if cfg!(windows) && !name.as_str().to_ascii_lowercase().ends_with(".exe") {
        return format!("{}.exe", name.as_str()).into();
    }
    name.as_str().into()
}

#[cfg(windows)]
fn platform_directories() -> (Vec<PathBuf>, Vec<PathBuf>) {
    // These are installation-root variables, captured independently of command search variables.
    let mut roots = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    let mut directories = roots
        .iter()
        .flat_map(|root| [root.join("Git/cmd"), root.join("Git/bin")])
        .collect::<Vec<_>>();
    if let Some(windows) = std::env::var_os("SystemRoot") {
        let system = PathBuf::from(windows).join("System32");
        directories.push(system.clone());
        directories.push(system.join("OpenSSH"));
        roots.push(system);
    }
    (directories, roots)
}

#[cfg(not(windows))]
fn platform_directories() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let directories = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/Library/Developer/CommandLineTools/usr/bin",
        "/Applications/Xcode.app/Contents/Developer/usr/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    let roots = [
        "/opt/homebrew",
        "/usr/local",
        "/opt/local",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/nix/store",
        "/Library/Developer/CommandLineTools",
        "/Applications/Xcode.app/Contents/Developer",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    (directories, roots)
}

#[cfg(test)]
#[path = "system_tests.rs"]
mod tests;
