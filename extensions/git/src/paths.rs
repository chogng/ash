//! Editor resources retain their owner; Git names remain repository-relative paths.
use crate::api::invalid;
use ash_utils_path_uri::PathUri;
use external_ext_sdk::ExtensionError;
use serde::Deserialize;
use serde::Serialize;

/// A file path with the editor authority that owns its resources. PathUri still
/// owns cross-platform path algebra; a remote workspace must never become a
/// local file identity merely because Git executes on that machine.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct ResourceUri {
    path: PathUri,
    authority: Option<String>,
}

impl ResourceUri {
    pub(crate) fn parse(value: &str) -> Result<Self, ExtensionError> {
        let uri = url::Url::parse(value).map_err(|_| invalid("Invalid Git resource URI"))?;
        if uri.scheme() == "file" {
            return PathUri::parse(value)
                .map(|path| Self {
                    path,
                    authority: None,
                })
                .map_err(|_| invalid("Invalid Git file URI"));
        }
        if uri.scheme() != "ash-remote"
            || uri.host_str().is_none_or(str::is_empty)
            || !uri.username().is_empty()
            || uri.password().is_some()
            || uri.port().is_some()
            || uri.query().is_some()
            || uri.fragment().is_some()
        {
            return Err(invalid("Invalid Git remote resource URI"));
        }
        let decoded = urlencoding::decode(uri.path())
            .map_err(|_| invalid("Invalid Git remote resource path"))?;
        let path = decoded.strip_prefix('/').filter(|path| {
            matches!(path.as_bytes(), [drive, b':', b'/', ..] if drive.is_ascii_alphabetic())
        }).unwrap_or(&decoded);
        let windows = path.starts_with("//")
            || matches!(path.as_bytes(), [drive, b':', b'/', ..] if drive.is_ascii_alphabetic());
        if !decoded.starts_with('/')
            || decoded.chars().any(char::is_control)
            || uri.path().split('/').any(|segment| {
                urlencoding::decode(segment).is_ok_and(|part| {
                    matches!(part.as_ref(), "." | "..")
                        || part.contains('/')
                        || windows && part.contains('\\')
                })
            })
        {
            return Err(invalid("Invalid Git remote resource path"));
        }
        let path = PathUri::from_native_path(
            path,
            if windows {
                ash_utils_path_uri::PathConvention::Windows
            } else {
                ash_utils_path_uri::PathConvention::Posix
            },
        )
        .map_err(|_| invalid("Invalid Git remote resource path"))?;
        Ok(Self {
            path,
            authority: uri.host_str().map(str::to_owned),
        })
    }

    fn with_path(&self, path: PathUri) -> Self {
        Self {
            path,
            authority: self.authority.clone(),
        }
    }

    pub(crate) fn infer_path_convention(&self) -> Option<ash_utils_path_uri::PathConvention> {
        self.path.infer_path_convention()
    }

    pub(crate) fn execution_path(&self) -> String {
        self.path.inferred_native_path_string()
    }

    pub(crate) fn to_host_path(&self) -> std::io::Result<std::path::PathBuf> {
        self.path
            .to_host_path()
            .map(|path| path.as_path().to_owned())
    }

    pub(crate) fn lexical_depth(&self) -> Option<usize> {
        self.path.lexical_depth()
    }

    fn relative_components_from(&self, base: &Self) -> Option<Vec<String>> {
        (self.authority == base.authority)
            .then(|| self.path.relative_components_from(&base.path))
            .flatten()
    }

    fn join_descendant(&self, path: &str) -> Result<Self, ash_utils_path_uri::PathUriParseError> {
        self.path
            .join_descendant(path)
            .map(|path| self.with_path(path))
    }
}

impl TryFrom<String> for ResourceUri {
    type Error = ExtensionError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ResourceUri> for String {
    fn from(value: ResourceUri) -> Self {
        value.to_string()
    }
}

impl std::fmt::Display for ResourceUri {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Some(authority) = &self.authority else {
            return self.path.fmt(formatter);
        };
        let mut path = self.path.inferred_native_path_string();
        if self.infer_path_convention() == Some(ash_utils_path_uri::PathConvention::Windows) {
            path = path.replace('\\', "/");
            if !path.starts_with('/') {
                path.insert(0, '/');
            }
        }
        let encoded = path
            .split('/')
            .map(|segment| {
                let mut value = urlencoding::encode(segment).into_owned();
                // Match the editor URI owner's encodeURIComponent/encodeURI spelling.
                for (escaped, literal) in [
                    ("%21", "!"),
                    ("%27", "'"),
                    ("%28", "("),
                    ("%29", ")"),
                    ("%2A", "*"),
                ] {
                    value = value.replace(escaped, literal);
                }
                if !authority.starts_with("ssh+") {
                    for (escaped, literal) in [
                        ("%3B", ";"),
                        ("%2C", ","),
                        ("%3A", ":"),
                        ("%40", "@"),
                        ("%26", "&"),
                        ("%3D", "="),
                        ("%2B", "+"),
                        ("%24", "$"),
                    ] {
                        value = value.replace(escaped, literal);
                    }
                }
                value
            })
            .collect::<Vec<_>>()
            .join("/");
        write!(formatter, "ash-remote://{authority}{encoded}")
    }
}

/// A non-empty path in Git's slash-separated namespace. Validation is lexical;
/// filesystem authorization and symlink resolution remain with the backend.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize)]
#[serde(try_from = "String")]
pub(crate) struct RepoPath(String);

impl RepoPath {
    pub(crate) fn parse(value: &str) -> Result<Self, ExtensionError> {
        Self::try_from(value.to_owned())
    }

    pub(crate) fn resolve(&self, root: &ResourceUri) -> Result<ResourceUri, ExtensionError> {
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

    pub(crate) fn from_resource(root: &ResourceUri, resource: &ResourceUri) -> Option<Self> {
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
pub(crate) fn repository_root(
    root: &ResourceUri,
    path: &str,
) -> Result<ResourceUri, ExtensionError> {
    if path.is_empty() {
        Ok(root.clone())
    } else {
        RepoPath::parse(path)?.resolve(root)
    }
}

/// Configuration accepts either a file URI or an absolute path in the target
/// repository's convention. It never interprets a remote path using this host.
pub(crate) fn matches_configured_root(root: &ResourceUri, value: &str) -> bool {
    let candidate = ResourceUri::parse(value).ok().or_else(|| {
        PathUri::from_native_path(value, root.infer_path_convention()?)
            .ok()
            .map(|path| root.with_path(path))
    });
    candidate.is_some_and(|mut candidate| {
        if candidate.authority.is_none() {
            candidate.authority = root.authority.clone();
        }
        candidate
            .relative_components_from(root)
            .is_some_and(|parts| parts.is_empty())
    })
}

pub(crate) fn target_path(root: &ResourceUri, value: &str) -> Result<ResourceUri, ExtensionError> {
    let convention = root
        .infer_path_convention()
        .ok_or_else(|| invalid("Unsupported repository path convention"))?;
    PathUri::from_native_path(value, convention)
        .map(|path| root.with_path(path))
        .map_err(|_| invalid("Invalid absolute Git path"))
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
