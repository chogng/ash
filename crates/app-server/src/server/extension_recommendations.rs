use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;

use ash_app_server_protocol::protocol::extension_packages::ExtensionsRecommendationEnvironmentResult;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsRecommendationPlatformDto;

/// Detects only the product catalog's executable names on this App Server's host, without spawning them.
pub(super) fn environment() -> ExtensionsRecommendationEnvironmentResult {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../resources/extension-recommendations.json"
    )))
    .expect("product extension recommendations must be valid JSON");
    let names: BTreeSet<String> = catalog["executables"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|tip| tip["executables"].as_array().into_iter().flatten())
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect();
    let path = std::env::var_os("PATH").unwrap_or_default();
    ExtensionsRecommendationEnvironmentResult {
        platform: if cfg!(target_os = "macos") {
            ExtensionsRecommendationPlatformDto::Macos
        } else if cfg!(target_os = "windows") {
            ExtensionsRecommendationPlatformDto::Windows
        } else if cfg!(target_os = "linux") {
            ExtensionsRecommendationPlatformDto::Linux
        } else {
            ExtensionsRecommendationPlatformDto::Other
        },
        executables: available(&names, &path),
    }
}

fn available(names: &BTreeSet<String>, path: &OsStr) -> Vec<String> {
    let directories: Vec<_> = std::env::split_paths(path)
        .filter(|directory| directory.is_absolute())
        .collect();
    names
        .iter()
        .filter(|name| {
            directories.iter().any(|directory| {
                if cfg!(windows) {
                    [".exe", ".com", ".cmd", ".bat"]
                        .iter()
                        .any(|suffix| executable(&directory.join(format!("{name}{suffix}"))))
                } else {
                    executable(&directory.join(name))
                }
            })
        })
        .cloned()
        .collect()
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
#[path = "extension_recommendations_tests.rs"]
mod tests;
