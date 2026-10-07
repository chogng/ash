use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// Joins a nonempty relative path without allowing a parent, root, or platform prefix.
///
/// The base must be absolute. OS path bytes are retained without converting through UTF-8.
/// This lexical operation does not inspect symlinks or authorize filesystem access; callers
/// must apply their filesystem containment policy before reading or writing the result.
pub fn join_descendant(base: &Path, relative: &Path) -> io::Result<PathBuf> {
    if !base.is_absolute()
        || relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected an absolute base and a nonempty relative path without parent components",
        ));
    }
    Ok(base.join(relative))
}

#[cfg(test)]
#[path = "relative_tests.rs"]
mod tests;
