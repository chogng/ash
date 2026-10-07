use std::path::PathBuf;

use crate::GitResult;

#[cfg(unix)]
pub(crate) fn path_from_git_bytes(bytes: &[u8], command: &str) -> GitResult<PathBuf> {
    if bytes.is_empty() {
        return Err(crate::GitError::invalid_output(
            command,
            "Git path was empty",
        ));
    }
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    Ok(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

#[cfg(not(unix))]
pub(crate) fn path_from_git_bytes(bytes: &[u8], command: &str) -> GitResult<PathBuf> {
    use crate::GitError;

    if bytes.is_empty() {
        return Err(GitError::invalid_output(command, "Git path was empty"));
    }
    let value = String::from_utf8(bytes.to_vec()).map_err(|_| {
        GitError::invalid_output(command, "Git path output was not valid platform UTF-8")
    })?;
    Ok(PathBuf::from(value))
}
