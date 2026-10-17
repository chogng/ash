//! Package marker layout and bounded discovery shared by plugin package consumers.

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

const PLUGIN_METADATA_DIR: &str = ".ash-plugin";
pub const PLUGIN_MANIFEST_PATH: &str = ".ash-plugin/plugin.json";

/// Discovers this package root or its immediate package children, in deterministic path order.
///
/// A marker with an invalid file type is deliberately returned as a candidate: the package
/// validator must report the unsafe package instead of silently ignoring it. Discovery never
/// reads a manifest, follows ancestors, or admits a package for activation.
pub fn discover_plugin_roots(source_directory: &Path) -> io::Result<Vec<PathBuf>> {
    if marker_exists(&source_directory.join(PLUGIN_METADATA_DIR))? {
        return Ok(vec![source_directory.to_path_buf()]);
    }
    let mut entries = fs::read_dir(source_directory)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut roots = Vec::new();
    for entry in entries {
        let path = entry.path();
        if marker_exists(&path.join(PLUGIN_METADATA_DIR))? {
            roots.push(path);
        }
    }
    Ok(roots)
}

fn marker_exists(marker: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(marker) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "plugin_namespace_tests.rs"]
mod tests;
