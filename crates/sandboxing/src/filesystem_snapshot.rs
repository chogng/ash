//! Bind prepared execution to existing filesystem objects across process handoff.
use ash_file_identity::FileInformation;
use serde::Deserialize;
use serde::Serialize;
use std::io;
use std::path::Path;
use std::path::PathBuf;

/// Captures the objects authorized when execution is prepared. A path retaining
/// its spelling does not retain authority after its object has been replaced.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct FilesystemSnapshot {
    objects: Vec<(PathBuf, FileInformation)>,
}

impl FilesystemSnapshot {
    pub fn capture(paths: impl IntoIterator<Item = PathBuf>) -> io::Result<Self> {
        let mut objects = Vec::new();
        for path in paths {
            let path = std::fs::canonicalize(path)?;
            let identity = FileInformation::from_path(&path)?;
            objects.push((path, identity));
        }
        objects.sort_by(|left, right| left.0.cmp(&right.0));
        objects.dedup();
        Ok(Self { objects })
    }

    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.objects.iter().map(|(path, _)| path.as_path())
    }

    pub fn validate(&self) -> io::Result<()> {
        for (path, expected) in &self.objects {
            if !FileInformation::from_path(path)?.same_file_as(*expected) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "filesystem object changed after preparation: '{}'",
                        path.display()
                    ),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "filesystem_snapshot_tests.rs"]
mod tests;
