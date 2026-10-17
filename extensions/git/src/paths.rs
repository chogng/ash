//! Git paths are decoded, repository-relative names, never host paths or URLs.
use crate::api::invalid;
use ash_utils_path_uri::PathUri;
use external_ext_sdk::ExtensionError;
use serde::Deserialize;
use serde::Serialize;

/// A non-empty path in Git's slash-separated namespace. Validation is lexical;
/// filesystem authorization and symlink resolution remain with the backend.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize)]
#[serde(try_from = "String")]
pub(crate) struct RepoPath(String);

impl RepoPath {
    pub(crate) fn parse(value: &str) -> Result<Self, ExtensionError> {
        Self::try_from(value.to_owned())
    }

    pub(crate) fn resolve(&self, root: &PathUri) -> Result<PathUri, ExtensionError> {
        // Git uses '/', even on Windows. Backslashes are literal on POSIX;
        // reject them on Windows rather than silently changing the Git name.
        if root.infer_path_convention() == Some(ash_utils_path_uri::PathConvention::Windows)
            && self.0.contains('\\')
        {
            return Err(invalid("Invalid Windows repository path"));
        }
        root.join_descendant(&self.0)
            .map_err(|_| invalid("Invalid repository path"))
    }

    pub(crate) fn from_resource(root: &PathUri, resource: &PathUri) -> Option<Self> {
        Self::parse(&resource.relative_components_from(root)?.join("/")).ok()
    }
}

impl TryFrom<String> for RepoPath {
    type Error = ExtensionError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.contains('\0') || value.split('/').any(|part| matches!(part, "" | "." | "..")) {
            return Err(invalid("Invalid repository-relative Git path"));
        }
        Ok(Self(value))
    }
}
impl Serialize for RepoPath {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}
impl std::ops::Deref for RepoPath {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl std::borrow::Borrow<str> for RepoPath {
    fn borrow(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Display for RepoPath {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}
impl PartialEq<str> for RepoPath {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}
impl PartialEq<&str> for RepoPath {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

/// Workspace discovery also represents the workspace root itself with "".
pub(crate) fn repository_root(root: &PathUri, path: &str) -> Result<PathUri, ExtensionError> {
    if path.is_empty() {
        Ok(root.clone())
    } else {
        RepoPath::parse(path)?.resolve(root)
    }
}

/// Configuration accepts either a file URI or an absolute path in the target
/// repository's convention. It never interprets a remote path using this host.
pub(crate) fn matches_configured_root(root: &PathUri, value: &str) -> bool {
    let candidate = PathUri::parse(value)
        .ok()
        .or_else(|| PathUri::from_native_path(value, root.infer_path_convention()?).ok());
    candidate.is_some_and(|candidate| {
        candidate
            .relative_components_from(root)
            .is_some_and(|parts| parts.is_empty())
    })
}

pub(crate) fn target_path(root: &PathUri, value: &str) -> Result<PathUri, ExtensionError> {
    let convention = root
        .infer_path_convention()
        .ok_or_else(|| invalid("Unsupported repository path convention"))?;
    PathUri::from_native_path(value, convention).map_err(|_| invalid("Invalid absolute Git path"))
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
