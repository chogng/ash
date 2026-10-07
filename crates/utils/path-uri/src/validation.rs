use crate::{FILE_SCHEME, OPAQUE_PATH_PREFIX, PathUriParseError};
use base64::Engine;
use url::Url;

pub(super) fn validated_file_url(mut url: Url) -> Result<Url, PathUriParseError> {
    if url.scheme() != FILE_SCHEME {
        return Err(PathUriParseError::UnsupportedScheme(
            url.scheme().to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PathUriParseError::CredentialsNotAllowed);
    }
    if url.port().is_some() {
        return Err(PathUriParseError::PortNotAllowed);
    }
    if url.query().is_some() {
        return Err(PathUriParseError::QueryNotAllowed);
    }
    if url.fragment().is_some() {
        return Err(PathUriParseError::FragmentNotAllowed);
    }
    if urlencoding::decode_binary(url.path().as_bytes()).contains(&0)
        && decode_opaque_path_uri(&url).is_none()
    {
        return Err(PathUriParseError::InvalidFileUriPath {
            path: url.to_string(),
        });
    }

    if url.host_str() == Some("localhost") {
        url.set_host(None)
            .expect("validated file URL accepts an empty localhost authority");
    }
    normalize_windows_drive_letter(&mut url);
    Ok(url)
}

pub(super) fn decode_opaque_path_uri(url: &Url) -> Option<Vec<u8>> {
    let encoded = url.as_str().strip_prefix(OPAQUE_PATH_PREFIX)?;
    if encoded.is_empty() || encoded.contains('/') {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    (base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) == encoded).then_some(bytes)
}

pub(super) fn is_windows_drive_segment(segment: &str) -> bool {
    matches!(segment.as_bytes(), [drive, b':'] if drive.is_ascii_alphabetic())
}

fn normalize_windows_drive_letter(url: &mut Url) {
    if url.host_str().is_some() {
        return;
    }
    let path = url.path();
    let Some(start) = path.bytes().position(|byte| byte != b'/') else {
        return;
    };
    let Some(drive) = path[start..].split('/').next() else {
        return;
    };
    if !is_windows_drive_segment(drive) {
        return;
    }
    let letter = char::from(drive.as_bytes()[0]).to_ascii_uppercase();
    let suffix = &path[start + 1..];
    let trailing_separator = if suffix == ":" { "/" } else { "" };
    let normalized = format!("{}{letter}{suffix}{trailing_separator}", &path[..start]);
    url.set_path(&normalized);
}
