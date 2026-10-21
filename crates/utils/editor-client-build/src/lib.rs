//! Build-time source identity for admitted editor client components.

use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::path::PathBuf;

fn sources(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("editor client source directory") {
        let entry = entry.expect("editor client source entry");
        // Bazel materializes declared sources as symlinks; hash their bytes like Cargo's files.
        let kind = std::fs::metadata(entry.path()).expect("editor client source metadata");
        if kind.is_dir() {
            sources(&entry.path(), files);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "ts" || extension == "css")
        {
            files.push(entry.path());
        }
    }
}

/// Bind the executable to normalized package-relative client paths and their source bytes.
/// The Renderer binds this identity to the admitted module and its verified package bytes.
pub fn emit_client_digest() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    emit_client_digest_at(&root, "ASH_EDITOR_CLIENT_DIGEST");
}

/// Emit a named component identity for a host's bundled-provider deployment metadata.
/// Only source bytes are read at build time; the host never links the provider implementation.
pub fn emit_client_digest_at(root: &Path, variable: &str) {
    println!("cargo:rustc-env={variable}=sha256:{}", source_digest(root));
}

fn source_digest(root: &Path) -> String {
    let mut files = Vec::new();
    println!("cargo:rerun-if-changed={}", root.join("browser").display());
    sources(&root.join("browser"), &mut files);
    let common = root.join("common");
    if common.exists() {
        println!("cargo:rerun-if-changed={}", common.display());
        sources(&common, &mut files);
    }
    files.sort();
    let mut digest = Sha256::new();
    for file in files {
        let relative = file.strip_prefix(root).expect("editor client source path");
        digest.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        digest.update(b"\0");
        digest.update(std::fs::read(file).expect("editor client source bytes"));
        digest.update(b"\0");
    }
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests;
