//! Directory-bounded transcript file export.

use ash_utils_path::CanonicalContainmentError;
use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::join_descendant;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub(crate) fn write(
    dir_root: &Path,
    requested_path: Option<&Path>,
    contents: &str,
) -> Result<PathBuf, String> {
    let relative_path = requested_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| available_default_path(dir_root));
    let boundary = CanonicalPathRoot::new(dir_root)
        .map_err(|error| format!("could not resolve directory root: {error}"))?;
    let path = join_descendant(boundary.path(), &relative_path)
        .map_err(|_| "export path must stay inside the active directory".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "export path must name a file inside the active directory".to_owned())?;
    let parent = boundary
        .canonicalize_within(parent)
        .map_err(|error| match error {
            CanonicalContainmentError::OutsideRoot => {
                "export path must stay inside the active directory".to_owned()
            }
            CanonicalContainmentError::Unavailable(error) => {
                format!("could not resolve export directory: {error}")
            }
        })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "export path must name a file inside the active directory".to_owned())?;
    let target = parent.join(file_name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("could not sync {}: {error}", path.display()))?;
    Ok(dir_root.join(relative_path))
}

fn available_default_path(dir_root: &Path) -> PathBuf {
    let first = PathBuf::from("ash-transcript.md");
    if !dir_root.join(&first).exists() {
        return first;
    }
    for suffix in 2..=10_000 {
        let candidate = PathBuf::from(format!("ash-transcript-{suffix}.md"));
        if !dir_root.join(&candidate).exists() {
            return candidate;
        }
    }
    PathBuf::from("ash-transcript-overflow.md")
}

#[cfg(test)]
#[path = "transcript_export_tests.rs"]
mod tests;
