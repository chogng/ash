//! Windows PSEC host filesystem visibility.
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::SandboxError;
use std::path::Path;
use std::path::PathBuf;

/// Materialize host visibility as ordinary PSEC grants, without authorizing ACL changes.
pub(super) fn host_paths(
    cwd: &Path,
    access: FileSystemAccess,
    write_grants: &[String],
) -> Result<Vec<String>, SandboxError> {
    let mut roots =
        ash_file_identity::volume_roots().map_err(|error| crate::unavailable(error.to_string()))?;
    if let Some(root) = cwd.ancestors().last() {
        roots.push(root.to_owned());
    }
    roots.sort();
    roots.dedup();
    expand_roots(roots, access, write_grants)
}

fn expand_roots(
    roots: impl IntoIterator<Item = PathBuf>,
    access: FileSystemAccess,
    write_grants: &[String],
) -> Result<Vec<String>, SandboxError> {
    let mut paths = Vec::new();
    for root in roots {
        match std::fs::read_dir(&root) {
            Ok(entries) => {
                // Read-only volume grants recurse. An existing write grant prevents
                // adding a read-only grant at that root, so keep its child read grants.
                let expand = match access {
                    FileSystemAccess::ReadOnly | FileSystemAccess::DirectoryWrite => {
                        write_grants.iter().any(|path| Path::new(path) == root)
                    }
                    FileSystemAccess::FullAccess => true,
                };
                paths.push(root);
                if !expand {
                    continue;
                }
                for entry in entries {
                    let path = entry
                        .map_err(|error| crate::unavailable(error.to_string()))?
                        .path();
                    // Generated visibility does not authorize inaccessible objects.
                    // Explicit grants were captured separately and always fail closed.
                    use mxc_sdk::v1::ExistingObjectComparison;
                    use mxc_sdk::v1::compare_existing_filesystem_objects;
                    if compare_existing_filesystem_objects(&path, &path)
                        != ExistingObjectComparison::Same
                    {
                        continue;
                    }
                    paths.push(path);
                    if paths.len() > 4096 {
                        return Err(crate::unavailable(
                            "host filesystem expansion exceeds 4096 paths",
                        ));
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
                ) || matches!(error.raw_os_error(), Some(21 | 53 | 1201 | 1167)) => {}
            Err(error) => return Err(crate::unavailable(error.to_string())),
        }
    }
    paths
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| crate::unavailable("MXC requires Unicode filesystem paths"))
        })
        .collect()
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
