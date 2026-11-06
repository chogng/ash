use jsonc_parser::ParseOptions;
use serde::Deserialize;

use super::package::ExtensionPackageSnapshot;
use super::resource::validate_relative_path;

const MAX_BUNDLE_BYTES: usize = 256 * 1024;
const MAX_DOCUMENTS: usize = 16;

#[derive(Deserialize)]
struct ThemeHeader {
    include: Option<String>,
}

pub(super) fn color_theme_sources(
    package: &ExtensionPackageSnapshot,
    path: &str,
) -> Option<Vec<(String, String)>> {
    let mut path = include_path("", path)?;
    let mut sources: Vec<(String, String)> = Vec::new();
    let mut remaining_bytes = MAX_BUNDLE_BYTES;
    loop {
        if sources.len() == MAX_DOCUMENTS || sources.iter().any(|(seen, _)| seen == &path) {
            return None;
        }
        let bytes = package.file(&path)?;
        remaining_bytes = remaining_bytes.checked_sub(bytes.len() + path.len())?;
        let source = std::str::from_utf8(bytes).ok()?;
        let source = source.strip_prefix('\u{feff}').unwrap_or(source);
        let header: ThemeHeader = jsonc_parser::parse_to_serde_value(
            source,
            &ParseOptions {
                allow_comments: true,
                allow_trailing_commas: true,
                allow_loose_object_property_names: false,
                allow_missing_commas: false,
                allow_single_quoted_strings: false,
                allow_hexadecimal_numbers: false,
                allow_unary_plus_numbers: false,
                allow_bare_decimal_point_numbers: false,
                allow_non_finite_numbers: false,
                allow_extended_string_escapes: false,
            },
        )
        .ok()?;
        let next = match header.include {
            Some(include) => Some(include_path(&path, &include)?),
            None => None,
        };
        sources.push((path, source.to_owned()));
        match next {
            Some(next) => path = next,
            None => return Some(sources),
        }
    }
}

// Paths in a frozen package always use slash separators, including on Windows.
fn include_path(from: &str, include: &str) -> Option<String> {
    let (_, extension) = include.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("json") || include.contains(['\\', ':', '?', '#', '\0']) {
        return None;
    }
    let mut segments: Vec<_> = from
        .rsplit_once('/')
        .map_or_else(Vec::new, |(parent, _)| parent.split('/').collect());
    for segment in include.split('/') {
        match segment {
            "" => return None,
            "." => {}
            ".." => {
                segments.pop()?;
            }
            name => segments.push(name),
        }
    }
    let path = segments.join("/");
    validate_relative_path(&path).ok()?;
    Some(path)
}
