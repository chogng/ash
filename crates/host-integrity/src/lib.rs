//! Installation integrity scans, independent of the business server and UI runtime.
use std::fs::File;
use std::io;
use std::io::Read;
use std::path::Path;

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use cap_std::fs::OpenOptions;
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

const MAX_MANIFEST: u64 = 4 * 1024 * 1024;
const REQUIRED: [&str; 3] = [
    "dist/main/src/main.js",
    "dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs",
    "dist/renderer/ash/electron-browser/workbench/workbench.html",
];

#[derive(Serialize)]
pub struct Proof {
    pub path: String,
    pub expected: String,
    pub actual: Option<String>,
}

pub fn checksum(path: &Path) -> io::Result<String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("checksum requires a file path"))?;
    let directory = Dir::open_ambient_dir(parent, ambient_authority())?;
    hash_file(open_regular(&directory, Path::new(name))?)
}

fn hash_file(mut file: File) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn scan(root: &Path) -> io::Result<Vec<Proof>> {
    // Hold a directory capability throughout the scan. String validation alone
    // cannot keep symlink resolution (including parent components) inside root.
    let directory = Dir::open_ambient_dir(root, ambient_authority())?;
    let mut manifest = Vec::new();
    open_regular(&directory, Path::new("package.json"))?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut manifest)?;
    if manifest.len() as u64 > MAX_MANIFEST {
        return Err(invalid_manifest());
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&manifest).map_err(|_| invalid_manifest())?;
    let checksums = metadata
        .get("checksums")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(invalid_manifest)?;
    if REQUIRED.iter().any(|path| !checksums.contains_key(*path)) {
        return Err(invalid_manifest());
    }
    // Validate every persisted path before opening any entry. The host alone selects root.
    for (path, expected) in checksums {
        if !(path.starts_with("dist/") || path.starts_with("resources/"))
            || path.contains(['\\', '\0', ':'])
            || path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
            || !expected.as_str().is_some_and(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(invalid_manifest());
        }
    }
    let mut proof = Vec::with_capacity(checksums.len());
    for (path, expected) in checksums {
        let actual = match open_regular(&directory, Path::new(path)).and_then(hash_file) {
            Ok(hash) => Some(hash),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        proof.push(Proof {
            path: path.clone(),
            expected: expected.as_str().expect("validated checksum").to_owned(),
            actual,
        });
    }
    Ok(proof)
}

fn open_regular(directory: &Dir, path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    // Opening a FIFO otherwise waits for a writer before metadata can reject it.
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let file = directory.open_with(path, &options)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("checksum requires a regular file"));
    }
    Ok(file.into_std())
}

fn invalid_manifest() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid application checksum manifest",
    )
}

#[cfg(test)]
mod tests;
