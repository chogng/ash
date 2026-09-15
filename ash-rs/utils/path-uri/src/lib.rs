//! Typed, immutable `file:` URIs with cross-platform lexical path operations.

mod native;
mod operations;
mod validation;

use ash_utils_absolute_path::AbsolutePathBuf;
use base64::Engine;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;
use thiserror::Error;
use ts_rs::TS;
use url::Url;

pub const FILE_SCHEME: &str = "file";
const OPAQUE_PATH_PREFIX: &str = "file:///%00/ash/opaque-path/";

/// An immutable, cross-platform representation of one absolute `file:` URI.
///
/// The URI retains POSIX, Windows drive, or UNC spelling independently of the
/// operating system running Ash. Lexical operations do not access the host
/// filesystem, resolve symlinks, or apply filesystem case-folding.
#[derive(Clone, Debug, Eq, Hash, JsonSchema, PartialEq, TS)]
#[schemars(transparent)]
#[ts(type = "string")]
pub struct PathUri(#[schemars(with = "String")] Url);

impl PathUri {
    /// Parses and validates a `file:` URI.
    pub fn parse(uri: &str) -> Result<Self, PathUriParseError> {
        Url::parse(uri)?.try_into()
    }

    /// Converts an absolute path on the current host to a `file:` URI.
    ///
    /// Paths that cannot be represented losslessly as an ordinary URL use a
    /// reserved opaque URI.
    pub fn from_absolute_path(path: &AbsolutePathBuf) -> Self {
        if let Ok(url) = Url::from_file_path(path)
            && let Ok(uri) = Self::try_from(url)
        {
            return uri;
        }
        Self::from_opaque_path_bytes(&host_path_bytes(path))
    }

    /// Parses an absolute path using an explicit POSIX or Windows convention.
    pub fn from_native_path(
        path: &str,
        convention: PathConvention,
    ) -> Result<Self, PathUriParseError> {
        native::parse_native_path(path, convention).ok_or_else(|| {
            PathUriParseError::InvalidNativePath {
                path: path.to_string(),
                convention,
            }
        })
    }

    /// Returns the percent-encoded URI path without the authority.
    pub fn encoded_path(&self) -> &str {
        self.0.path()
    }

    /// Returns the decoded URI path bytes without imposing UTF-8 on file names.
    pub fn decoded_path_bytes(&self) -> std::borrow::Cow<'_, [u8]> {
        urlencoding::decode_binary(self.encoded_path().as_bytes())
    }

    /// Whether this value stores a path in the reserved opaque representation.
    pub fn is_opaque(&self) -> bool {
        self.opaque_path_bytes().is_some()
    }

    /// Infers whether the URI represents POSIX or Windows path syntax.
    pub fn infer_path_convention(&self) -> Option<PathConvention> {
        native::infer_path_convention(self)
    }

    /// Renders the URI using its inferred native path syntax.
    ///
    /// If the URI cannot be rendered losslessly, its canonical URI string is returned.
    pub fn inferred_native_path_string(&self) -> String {
        self.infer_path_convention()
            .and_then(|convention| native::render_native_path(self, convention).ok())
            .unwrap_or_else(|| self.to_string())
    }

    /// Converts this URI to an absolute path for the current host.
    ///
    /// Foreign path conventions are rejected rather than projected onto an
    /// unrelated local path.
    pub fn to_host_path(&self) -> io::Result<AbsolutePathBuf> {
        if self.infer_path_convention() != Some(PathConvention::native()) {
            return Err(invalid_host_path(self));
        }
        if let Some(bytes) = self.opaque_path_bytes() {
            let path = path_from_host_bytes(bytes).ok_or_else(|| invalid_host_path(self))?;
            if let Ok(path) = AbsolutePathBuf::from_absolute(path)
                && Self::from_absolute_path(&path) == *self
            {
                return Ok(path);
            }
            return Err(invalid_host_path(self));
        }
        if self.lexical_depth().is_none() {
            return Err(invalid_host_path(self));
        }
        let path = self
            .0
            .to_file_path()
            .map_err(|()| invalid_host_path(self))?;
        AbsolutePathBuf::from_absolute(path).map_err(|_| invalid_host_path(self))
    }

    /// Returns a clone of the canonical URL.
    pub fn to_url(&self) -> Url {
        self.0.clone()
    }

    fn from_opaque_path_bytes(bytes: &[u8]) -> Self {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        Self::parse(&format!("{OPAQUE_PATH_PREFIX}{encoded}"))
            .expect("URL-safe base64 always produces a valid opaque path URI")
    }

    fn opaque_path_bytes(&self) -> Option<Vec<u8>> {
        validation::decode_opaque_path_uri(&self.0)
    }
}

impl TryFrom<Url> for PathUri {
    type Error = PathUriParseError;

    fn try_from(url: Url) -> Result<Self, Self::Error> {
        validation::validated_file_url(url).map(Self)
    }
}

impl TryFrom<String> for PathUri {
    type Error = PathUriParseError;

    fn try_from(uri: String) -> Result<Self, Self::Error> {
        Self::parse(&uri)
    }
}

impl FromStr for PathUri {
    type Err = PathUriParseError;

    fn from_str(uri: &str) -> Result<Self, Self::Err> {
        Self::parse(uri)
    }
}

impl fmt::Display for PathUri {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for PathUri {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> Deserialize<'de> for PathUri {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// Path grammar used to interpret or render a [`PathUri`].
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum PathConvention {
    Posix,
    Windows,
}

impl PathConvention {
    /// Returns the convention used by the current process.
    #[cfg(windows)]
    pub const fn native() -> Self {
        Self::Windows
    }

    /// Returns the convention used by the current process.
    #[cfg(unix)]
    pub const fn native() -> Self {
        Self::Posix
    }

    /// Splits path text using this convention without validating absoluteness.
    pub fn segments(self, path: &str) -> impl DoubleEndedIterator<Item = &str> {
        path.split(move |character| match self {
            Self::Posix => character == '/',
            Self::Windows => matches!(character, '/' | '\\'),
        })
    }
}

impl fmt::Display for PathConvention {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Posix => formatter.write_str("POSIX"),
            Self::Windows => formatter.write_str("Windows"),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathUriParseError {
    #[error("invalid URI: {0}")]
    InvalidUri(#[from] url::ParseError),
    #[error("unsupported path URI scheme `{0}`")]
    UnsupportedScheme(String),
    #[error("credentials are not allowed in path URIs")]
    CredentialsNotAllowed,
    #[error("ports are not allowed in path URIs")]
    PortNotAllowed,
    #[error("query parameters are not allowed in path URIs")]
    QueryNotAllowed,
    #[error("fragments are not allowed in path URIs")]
    FragmentNotAllowed,
    #[error("invalid file URI path `{path}`")]
    InvalidFileUriPath { path: String },
    #[error("path `{path}` is not absolute using {convention} syntax")]
    InvalidNativePath {
        path: String,
        convention: PathConvention,
    },
}

fn invalid_host_path(path: &PathUri) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        PathUriParseError::InvalidFileUriPath {
            path: path.to_string(),
        },
    )
}

#[cfg(unix)]
fn host_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn host_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(unix)]
fn path_from_host_bytes(bytes: Vec<u8>) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(OsString::from_vec(bytes)))
}

#[cfg(windows)]
fn path_from_host_bytes(bytes: Vec<u8>) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    bytes.len().is_multiple_of(2).then(|| {
        let wide = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        PathBuf::from(OsString::from_wide(&wide))
    })
}

#[cfg(test)]
#[path = "path_uri_tests.rs"]
mod tests;
