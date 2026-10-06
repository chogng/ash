use std::path::Path;
use std::path::PathBuf;

use crate::ExtensionCatalogError;

pub(crate) fn validate_relative_path(path: &str) -> Result<PathBuf, ExtensionCatalogError> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
    {
        return Err(ExtensionCatalogError::InvalidPath);
    }
    let mut relative = PathBuf::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\0') {
            return Err(ExtensionCatalogError::InvalidPath);
        }
        relative.push(segment);
    }
    Ok(relative)
}

pub(crate) fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.strip_prefix(root).is_ok()
}

pub(crate) fn mime_type(path: &Path) -> String {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => "application/json",
        Some("plist") => "application/xml",
        Some("yaml") | Some("yml") => "application/yaml",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
    .into()
}
