use crate::LocalProductServicesConfig;
use crate::OpenAppServerError;
use ash_install_context::discovered_product_services_path;
use std::path::Path;

/// Loads the discovered product services document against one profile cache root.
pub fn load_discovered_product_services(
    profile_root: impl AsRef<Path>,
) -> Result<Option<LocalProductServicesConfig>, OpenAppServerError> {
    discovered_product_services_path()
        .map(|path| LocalProductServicesConfig::load(path, profile_root))
        .transpose()
}
