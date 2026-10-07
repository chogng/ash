use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Controls how an upward marker search handles metadata errors other than `NotFound`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FindUpErrorPolicy {
    /// Return the first metadata error in ancestor and marker order.
    Propagate,
    /// Treat metadata errors as missing markers and continue searching.
    Ignore,
}

/// Finds the nearest ancestor containing one of the provided marker paths.
///
/// `start` must be absolute. The search starts there, then visits each lexical parent toward the
/// filesystem root. Within an ancestor, markers are checked in the order supplied. Marker paths
/// must be non-empty relative paths that do not contain `..`; an existing file, directory, or
/// other metadata-bearing entry counts as a match.
pub fn find_nearest_ancestor_with_markers<M>(
    start: &Path,
    markers: &[M],
    error_policy: FindUpErrorPolicy,
) -> io::Result<Option<PathBuf>>
where
    M: AsRef<Path>,
{
    if !start.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "find-up start path must be absolute",
        ));
    }
    validate_markers(markers)?;
    find_nearest_ancestor_with_probe(start, markers, error_policy, |candidate| {
        fs::metadata(candidate).map(|_| ())
    })
}

fn validate_markers<M>(markers: &[M]) -> io::Result<()>
where
    M: AsRef<Path>,
{
    for marker in markers {
        let marker = marker.as_ref();
        let mut has_normal_component = false;
        for component in marker.components() {
            match component {
                Component::Normal(_) => has_normal_component = true,
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "find-up marker must remain relative to each ancestor: {}",
                            marker.display()
                        ),
                    ));
                }
            }
        }
        if !has_normal_component {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "find-up marker must not be empty",
            ));
        }
    }
    Ok(())
}

fn find_nearest_ancestor_with_probe<M, Probe>(
    start: &Path,
    markers: &[M],
    error_policy: FindUpErrorPolicy,
    mut probe: Probe,
) -> io::Result<Option<PathBuf>>
where
    M: AsRef<Path>,
    Probe: FnMut(&Path) -> io::Result<()>,
{
    for ancestor in start.ancestors() {
        for marker in markers {
            match probe(&ancestor.join(marker.as_ref())) {
                Ok(()) => return Ok(Some(ancestor.to_path_buf())),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => match error_policy {
                    FindUpErrorPolicy::Propagate => return Err(error),
                    FindUpErrorPolicy::Ignore => {}
                },
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
#[path = "find_up_tests.rs"]
mod tests;
