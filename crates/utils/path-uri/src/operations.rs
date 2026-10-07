use crate::validation::decode_opaque_path_uri;
use crate::{PathConvention, PathUri, PathUriParseError};
use url::Url;

impl PathUri {
    /// Returns the decoded final path segment, or `None` for a root or opaque URI.
    pub fn basename(&self) -> Option<String> {
        if self.opaque_path_bytes().is_some() {
            return None;
        }
        self.0
            .path_segments()?
            .rfind(|segment| !segment.is_empty())
            .map(decode_segment)
    }

    /// Returns the lexical parent without crossing a POSIX, drive, or UNC-share root.
    pub fn parent(&self) -> Option<Self> {
        if self.opaque_path_bytes().is_some() {
            return None;
        }
        let convention = self.infer_path_convention()?;
        let anchor_depth = usize::from(convention == PathConvention::Windows);
        let depth = self
            .0
            .path_segments()?
            .filter(|segment| !segment.is_empty())
            .count();
        if depth <= anchor_depth {
            return None;
        }
        let mut url = self.0.clone();
        url.path_segments_mut().ok()?.pop_if_empty().pop();
        Self::try_from(url).ok()
    }

    /// Returns this URI followed by each lexical parent up to its path root.
    pub fn ancestors(&self) -> impl Iterator<Item = Self> {
        std::iter::successors(Some(self.clone()), Self::parent)
    }

    /// Returns whether this URI is lexically equal to or beneath `base`.
    ///
    /// Authority and segment boundaries are exact. Encoded native separators
    /// fail closed because decoding them could introduce hidden path segments.
    pub fn starts_with(&self, base: &Self) -> bool {
        if self == base {
            return true;
        }
        if decode_opaque_path_uri(&self.0).is_some()
            || decode_opaque_path_uri(&base.0).is_some()
            || self.0.host_str() != base.0.host_str()
            || self.infer_path_convention() != base.infer_path_convention()
        {
            return false;
        }
        let Some(path_segments) = containment_segments(
            &self.0,
            self.infer_path_convention()
                .unwrap_or(PathConvention::Posix),
        ) else {
            return false;
        };
        let Some(base_segments) = containment_segments(
            &base.0,
            base.infer_path_convention()
                .unwrap_or(PathConvention::Posix),
        ) else {
            return false;
        };
        segments_start_with(&path_segments, &base_segments)
    }

    /// Counts unambiguous lexical segments, including a drive or share anchor.
    /// Opaque paths and encoded separators have no lexical depth.
    pub fn lexical_depth(&self) -> Option<usize> {
        if self.is_opaque() {
            return None;
        }
        containment_segments(&self.0, self.infer_path_convention()?).map(|segments| segments.len())
    }

    /// Reports whether the two lexical subtrees overlap, or `None` for ambiguous paths.
    /// Equal values always overlap, including opaque values.
    pub fn overlaps(&self, other: &Self) -> Option<bool> {
        if self == other {
            return Some(true);
        }
        self.lexical_depth()?;
        other.lexical_depth()?;
        Some(self.starts_with(other) || other.starts_with(self))
    }

    /// Returns the decoded native relative path from `base` to this URI.
    pub fn relative_path_from(&self, base: &Self) -> Option<String> {
        if self == base {
            return Some(String::new());
        }
        if self.opaque_path_bytes().is_some()
            || base.opaque_path_bytes().is_some()
            || self.0.host_str() != base.0.host_str()
            || self.infer_path_convention() != base.infer_path_convention()
        {
            return None;
        }
        let convention = self.infer_path_convention()?;
        let path = containment_segments(&self.0, convention)?;
        let base = containment_segments(&base.0, convention)?;
        if !segments_start_with(&path, &base) {
            return None;
        }
        let relative = &path[base.len()..];
        let separator = match convention {
            PathConvention::Posix => "/",
            PathConvention::Windows => "\\",
        };
        Some(
            relative
                .iter()
                .map(|segment| decode_segment(segment))
                .collect::<Vec<_>>()
                .join(separator),
        )
    }

    /// Lexically resolves absolute or relative native path text against this URI.
    ///
    /// Absolute input replaces the base. Relative `..` components cannot escape
    /// a POSIX root, Windows drive, or UNC share. Drive-relative Windows paths
    /// such as `C:child` are rejected.
    pub fn join(&self, path: &str) -> Result<Self, PathUriParseError> {
        if path.contains('\0') {
            return Err(PathUriParseError::InvalidFileUriPath {
                path: path.to_string(),
            });
        }
        if path.is_empty() {
            return Ok(self.clone());
        }
        let convention =
            self.infer_path_convention()
                .ok_or_else(|| PathUriParseError::InvalidFileUriPath {
                    path: self.to_string(),
                })?;
        if let Ok(absolute) = Self::from_native_path(path, convention) {
            return Ok(absolute);
        }
        let bytes = path.as_bytes();
        if convention == PathConvention::Windows
            && matches!(bytes, [drive, b':', ..] if drive.is_ascii_alphabetic())
        {
            return Err(PathUriParseError::InvalidFileUriPath {
                path: path.to_string(),
            });
        }
        if self.opaque_path_bytes().is_some() {
            return Err(PathUriParseError::InvalidFileUriPath {
                path: self.to_string(),
            });
        }

        let mut url = self.0.clone();
        let anchor_depth = usize::from(convention == PathConvention::Windows);
        let mut depth = url
            .path_segments()
            .map(|segments| segments.filter(|segment| !segment.is_empty()).count())
            .unwrap_or_default();
        let root_relative_windows = convention == PathConvention::Windows
            && matches!(bytes, [b'\\' | b'/', rest @ ..] if !matches!(rest, [b'\\' | b'/', ..]));
        {
            let mut segments = url
                .path_segments_mut()
                .expect("validated file URL supports path segments");
            segments.pop_if_empty();
            if root_relative_windows {
                while depth > anchor_depth {
                    segments.pop();
                    depth -= 1;
                }
            }
            let path = match convention {
                PathConvention::Posix => path.to_string(),
                PathConvention::Windows => path.replace('\\', "/"),
            };
            for component in path.split('/') {
                match component {
                    "" | "." => {}
                    ".." if depth > anchor_depth => {
                        segments.pop();
                        depth -= 1;
                    }
                    ".." => {}
                    component => {
                        segments.push(component);
                        depth += 1;
                    }
                }
            }
        }
        Self::try_from(url)
    }

    /// Joins non-empty relative path text without parent, root, drive or stream components.
    /// This establishes lexical containment only; the host still owns filesystem authorization.
    pub fn join_descendant(&self, path: &str) -> Result<Self, PathUriParseError> {
        let windows = self.infer_path_convention() == Some(PathConvention::Windows);
        if path.is_empty()
            || path.starts_with('/')
            || windows && (path.starts_with('\\') || path.contains(':'))
            || path
                .split(|character| character == '/' || windows && character == '\\')
                .any(|segment| segment == "..")
            || self.lexical_depth().is_none()
        {
            return Err(PathUriParseError::InvalidFileUriPath { path: path.into() });
        }
        let joined = self.join(path)?;
        if !joined.starts_with(self) {
            return Err(PathUriParseError::InvalidFileUriPath { path: path.into() });
        }
        Ok(joined)
    }
}

fn segments_start_with(path: &[&str], base: &[&str]) -> bool {
    path.len() >= base.len()
        && path.iter().zip(base).all(|(path, base)| {
            urlencoding::decode_binary(path.as_bytes())
                == urlencoding::decode_binary(base.as_bytes())
        })
}

fn containment_segments(url: &Url, convention: PathConvention) -> Option<Vec<&str>> {
    let segments = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    (!segments.iter().any(|segment| {
        urlencoding::decode_binary(segment.as_bytes())
            .iter()
            .any(|byte| *byte == b'/' || (convention == PathConvention::Windows && *byte == b'\\'))
    }))
    .then_some(segments)
}

fn decode_segment(segment: &str) -> String {
    urlencoding::decode(segment)
        .map(std::borrow::Cow::into_owned)
        .unwrap_or_else(|_| segment.to_string())
}
