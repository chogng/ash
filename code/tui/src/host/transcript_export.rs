//! Directory-bounded transcript file export.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

pub(crate) fn write(
    dir_root: &Path,
    requested_path: Option<&Path>,
    contents: &str,
) -> Result<PathBuf, String> {
    let relative_path = match requested_path {
        Some(path) => validate_relative_path(path)?,
        None => available_default_path(dir_root),
    };
    let path = dir_root.join(relative_path);
    let target = bounded_target(dir_root, &path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("could not sync {}: {error}", path.display()))?;
    Ok(path)
}

fn bounded_target(dir_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_root = dir_root
        .canonicalize()
        .map_err(|error| format!("could not resolve directory root: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "export path must name a file inside the active directory".to_owned())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("could not resolve export directory: {error}"))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("export path must stay inside the active directory".into());
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| "export path must name a file inside the active directory".to_owned())?;
    Ok(canonical_parent.join(file_name))
}

fn validate_relative_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("export path must stay inside the active directory".into());
    }
    Ok(path.to_path_buf())
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
