use crate::validation::is_windows_drive_segment;
use crate::{PathConvention, PathUri, PathUriParseError};
use url::Url;

pub(super) fn parse_native_path(path: &str, convention: PathConvention) -> Option<PathUri> {
    let uri = match convention {
        PathConvention::Posix => parse_posix_path(path),
        PathConvention::Windows => parse_windows_path(path),
    }?;
    if uri.infer_path_convention() == Some(convention) {
        return Some(uri);
    }
    let bytes = match convention {
        PathConvention::Posix => path.as_bytes().to_vec(),
        PathConvention::Windows => path.encode_utf16().flat_map(u16::to_le_bytes).collect(),
    };
    Some(PathUri::from_opaque_path_bytes(&bytes))
}

pub(super) fn infer_path_convention(path: &PathUri) -> Option<PathConvention> {
    if let Some(bytes) = path.opaque_path_bytes() {
        return infer_opaque_convention(&bytes);
    }
    if path.0.host_str().is_some() {
        return Some(PathConvention::Windows);
    }
    let drive = path
        .0
        .path_segments()
        .and_then(|mut segments| segments.find(|segment| !segment.is_empty()))
        .is_some_and(is_windows_drive_segment);
    Some(if drive {
        PathConvention::Windows
    } else {
        PathConvention::Posix
    })
}

pub(super) fn render_native_path(
    path: &PathUri,
    convention: PathConvention,
) -> Result<String, PathUriParseError> {
    if let Some(bytes) = path.opaque_path_bytes() {
        return render_opaque_path(path, &bytes, convention);
    }
    match convention {
        PathConvention::Posix => render_posix_path(path),
        PathConvention::Windows => render_windows_path(path),
    }
}

fn parse_posix_path(path: &str) -> Option<PathUri> {
    let relative = path.strip_prefix('/')?;
    if path.contains('\0') {
        return Some(PathUri::from_opaque_path_bytes(path.as_bytes()));
    }
    from_segments(PathConvention::Posix, None, relative.split('/'))
}

fn parse_windows_path(path: &str) -> Option<PathUri> {
    let bytes = path.as_bytes();
    let namespace = matches!(
        bytes,
        [first, second, b'.' | b'?', separator, ..]
            if is_windows_separator(*first)
                && is_windows_separator(*second)
                && is_windows_separator(*separator)
    );
    if namespace || path.contains('\0') {
        let bytes = path
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        return Some(PathUri::from_opaque_path_bytes(&bytes));
    }

    if matches!(
        bytes,
        [drive, b':', separator, ..]
            if drive.is_ascii_alphabetic() && is_windows_separator(*separator)
    ) {
        return from_segments(
            PathConvention::Windows,
            None,
            std::iter::once(&path[..2]).chain(path[3..].split(is_windows_separator_char)),
        );
    }

    if matches!(
        bytes,
        [first, second, ..] if is_windows_separator(*first) && is_windows_separator(*second)
    ) {
        let mut components = path[2..].split(is_windows_separator_char);
        let host = components.next().filter(|value| !value.is_empty())?;
        let share = components.next().filter(|value| !value.is_empty())?;
        return from_segments(
            PathConvention::Windows,
            Some(host),
            std::iter::once(share).chain(components),
        );
    }
    None
}

fn from_segments<'a>(
    convention: PathConvention,
    host: Option<&str>,
    segments: impl Iterator<Item = &'a str>,
) -> Option<PathUri> {
    let mut url = Url::parse("file:///").ok()?;
    if let Some(host) = host {
        url.set_host(Some(host)).ok()?;
    }
    let anchor_depth = usize::from(convention == PathConvention::Windows);
    let mut normalized = Vec::new();
    let mut trailing_separator = false;
    for segment in segments {
        match segment {
            "" => trailing_separator = true,
            "." => trailing_separator = false,
            ".." => {
                trailing_separator = false;
                if normalized.len() > anchor_depth {
                    normalized.pop();
                }
            }
            segment => {
                normalized.push(segment);
                trailing_separator = false;
            }
        }
    }
    if trailing_separator
        || (convention == PathConvention::Windows
            && host.is_none()
            && normalized.len() == anchor_depth)
    {
        normalized.push("");
    }
    url.path_segments_mut().ok()?.clear().extend(normalized);
    PathUri::try_from(url).ok()
}

fn render_posix_path(path: &PathUri) -> Result<String, PathUriParseError> {
    if path.0.host_str().is_some() {
        return Err(invalid_native(path, PathConvention::Posix));
    }
    let mut rendered = String::new();
    for segment in uri_segments(&path.0) {
        rendered.push('/');
        rendered.push_str(&decode_segment(segment));
    }
    Ok(rendered)
}

fn render_windows_path(path: &PathUri) -> Result<String, PathUriParseError> {
    let mut segments = uri_segments(&path.0);
    let mut rendered = String::new();
    if let Some(host) = path.0.host_str() {
        let share = segments
            .next()
            .map(decode_segment)
            .filter(|share| !share.is_empty())
            .ok_or_else(|| invalid_native(path, PathConvention::Windows))?;
        rendered.push_str(r"\\");
        rendered.push_str(host);
        rendered.push('\\');
        rendered.push_str(&share);
    } else {
        let drive = segments
            .next()
            .map(decode_segment)
            .filter(|drive| is_windows_drive_segment(drive))
            .ok_or_else(|| invalid_native(path, PathConvention::Windows))?;
        rendered.push_str(&drive);
    }
    for segment in segments {
        rendered.push('\\');
        rendered.push_str(&decode_segment(segment));
    }
    if rendered.len() == 2 {
        rendered.push('\\');
    }
    Ok(rendered)
}

fn render_opaque_path(
    path: &PathUri,
    bytes: &[u8],
    convention: PathConvention,
) -> Result<String, PathUriParseError> {
    let rendered = match convention {
        PathConvention::Posix if bytes.starts_with(b"/") => {
            Some(String::from_utf8_lossy(bytes).into_owned())
        }
        PathConvention::Windows if bytes.len().is_multiple_of(2) => {
            let wide = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            Some(String::from_utf16_lossy(&wide))
        }
        _ => None,
    };
    rendered.ok_or_else(|| invalid_native(path, convention))
}

fn infer_opaque_convention(bytes: &[u8]) -> Option<PathConvention> {
    if bytes.starts_with(b"/") {
        return Some(PathConvention::Posix);
    }
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let mut wide = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
    let first = wide.next()?;
    let second = wide.next()?;
    let drive = u8::try_from(first).is_ok_and(|value| value.is_ascii_alphabetic())
        && second == u16::from(b':');
    let unc = first == u16::from(b'\\') && second == u16::from(b'\\');
    (drive || unc).then_some(PathConvention::Windows)
}

fn uri_segments(url: &Url) -> std::str::Split<'_, char> {
    url.path_segments()
        .expect("validated file URL has hierarchical segments")
}

fn decode_segment(segment: &str) -> String {
    String::from_utf8_lossy(&urlencoding::decode_binary(segment.as_bytes())).into_owned()
}

fn invalid_native(path: &PathUri, convention: PathConvention) -> PathUriParseError {
    PathUriParseError::InvalidNativePath {
        path: path.to_string(),
        convention,
    }
}

fn is_windows_separator(byte: u8) -> bool {
    matches!(byte, b'\\' | b'/')
}

fn is_windows_separator_char(character: char) -> bool {
    matches!(character, '\\' | '/')
}
