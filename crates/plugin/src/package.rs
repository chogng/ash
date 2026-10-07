mod digest;
mod local;

#[cfg(test)]
#[path = "package/test_support.rs"]
mod test_support;

pub use local::{
    LocalPluginCatalog, LocalPluginPackage, PackageFileStats, PluginPackageDigestAlgorithm,
    PluginPackageSource,
};
