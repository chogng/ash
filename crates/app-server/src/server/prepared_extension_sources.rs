use ash_external_ext::packages::DynamicExtensionPackageSource;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::DynamicExtensionSourceSnapshot;
use ash_external_ext::packages::ExtensionRootKind;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

/// Selects complete development package artifacts without interpreting editor contributions.
pub(super) struct PreparedExtensionSourceProvider {
    root: PathBuf,
    state: Mutex<(u64, Option<Publication>)>,
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publication {
    schema_version: u32,
    built_in: Vec<String>,
    user: Vec<String>,
    #[serde(default)]
    package_names: BTreeMap<String, String>,
}

impl PreparedExtensionSourceProvider {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            state: Mutex::new((0, None)),
        }
    }
}

impl DynamicExtensionSourceProvider for PreparedExtensionSourceProvider {
    fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
        let path = self.root.join("current.json");
        let metadata = std::fs::symlink_metadata(&path).map_err(
            |_| "Prepared extension packages are unavailable; run pnpm prepare:extensions",
        )?;
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return Err("Prepared extension publication exceeds its file contract".into());
        }
        // Bound the actual read as well as metadata: a concurrent publisher must not
        // turn the small selection document into an unbounded allocation.
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "Prepared extension publication cannot be read")?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Prepared extension publication cannot be read")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Prepared extension publication exceeds its file contract".into());
        }
        let publication: Publication = serde_json::from_slice(&bytes)
            .map_err(|_| "Prepared extension publication is invalid")?;
        if publication.schema_version != 1
            || publication.built_in.len() + publication.user.len() > 4096
            || publication.package_names.len() > 4096
            || publication.package_names.values().any(|name| {
                name.is_empty()
                    || name.len() > 255
                    || name.contains(['/', '\\', '\0'])
                    || matches!(name.as_str(), "." | "..")
            })
        {
            return Err("Prepared extension publication is incompatible".into());
        }
        let mut packages = Vec::new();
        for (kind, snapshots) in [
            (ExtensionRootKind::BuiltIn, &publication.built_in),
            (ExtensionRootKind::User, &publication.user),
        ] {
            for snapshot in snapshots {
                let valid = match snapshot.as_bytes() {
                    bytes if bytes.len() == 64 => bytes.iter().all(u8::is_ascii_hexdigit),
                    bytes if bytes.len() == 97 && bytes[64] == b'-' => bytes[..64]
                        .iter()
                        .chain(bytes[65..].iter())
                        .all(u8::is_ascii_hexdigit),
                    _ => false,
                };
                if !valid {
                    return Err("Prepared extension package reference is invalid".into());
                }
                packages.push(DynamicExtensionPackageSource {
                    subject: publication
                        .package_names
                        .get(snapshot)
                        .cloned()
                        .unwrap_or_else(|| format!("prepared:{snapshot}")),
                    path: self.root.join("packages").join(snapshot),
                    kind: kind.clone(),
                    normalized_manifest_json: None,
                    verified_package_sha256: None,
                    renderer_client: None,
                    runtime_binding: None,
                });
            }
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Prepared extension publication lock is unavailable")?;
        if state.1.as_ref() != Some(&publication) {
            state.0 = state
                .0
                .checked_add(1)
                .ok_or("Prepared extension generation exhausted")?;
            state.1 = Some(publication);
        }
        Ok(DynamicExtensionSourceSnapshot {
            generation: state.0,
            packages,
            diagnostics: Vec::new(),
        })
    }
}

#[cfg(test)]
#[path = "prepared_extension_sources_tests.rs"]
mod tests;
