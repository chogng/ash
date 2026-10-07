use std::ffi::OsStr;

pub(crate) fn generation_name(generation: u64) -> String {
    format!("{generation:020}")
}

pub(crate) fn parse_generation_name(name: &OsStr) -> Option<u64> {
    parse_padded_generation(name.to_str()?)
}

pub(crate) fn parse_manifest_name(name: &OsStr) -> Option<u64> {
    parse_padded_generation(name.to_str()?.strip_suffix(".manifest")?)
}

fn parse_padded_generation(generation: &str) -> Option<u64> {
    (generation.len() == 20 && generation.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| generation.parse().ok())
        .flatten()
}
