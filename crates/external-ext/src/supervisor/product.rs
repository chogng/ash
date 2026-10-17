//! Starts an explicitly requested, product-owned resource using the existing supervisor.
use super::ExtensionHostSupervisor;
use crate::ActivateParams;
use crate::ActivationAuthority;
use crate::ActivationLease;
use crate::ExtensionActivationSpec;
use crate::ExtensionCapability;
use crate::ExtensionHostError;
use crate::ExtensionHostLimits;
use crate::ExtensionLaunchCommand;
use crate::PackageBinding;
use crate::ProcessIsolationPolicy;
use crate::ProductExecutableLauncher;
use crate::RestartPolicy;
use sha2::Digest;
use std::num::NonZeroU64;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

struct ProductAuthority(Arc<Option<ash_package_store::PackageLease>>);
impl ActivationLease for ProductAuthority {}
impl ActivationAuthority for ProductAuthority {
    fn authorizes(&self) -> bool {
        true
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        Some(Box::new(Self(Arc::clone(&self.0))))
    }
}
impl ExtensionHostSupervisor {
    /// Starts a product-owned executable after its domain has authorized the operation.
    /// No package is installed here; the selected generation stays leased for the resource.
    pub fn start_product_resource(
        executable: &Path,
        extension_id: &str,
        maximum_payload_bytes: usize,
    ) -> Result<Self, ExtensionHostError> {
        if !executable.is_absolute() || !executable.is_file() {
            return Err(ExtensionHostError::SpawnFailed);
        }
        let lease = ash_package_store::acquire_package_lease_for_executable(executable)?;
        let mut digest = sha2::Sha256::new();
        std::io::copy(&mut std::fs::File::open(executable)?, &mut digest)?;
        let digest = format!("sha256:{:x}", digest.finalize());
        let launcher = ProductExecutableLauncher::new(executable.to_owned())?;
        let environment = [
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (key.into(), value)))
        .collect();
        let command = ExtensionLaunchCommand::new(
            executable,
            std::iter::empty::<String>(),
            executable.parent().ok_or(ExtensionHostError::SpawnFailed)?,
            environment,
        )?;
        let activation = ExtensionActivationSpec::new(
            ActivateParams {
                initialization: None,
                extension_id: extension_id.into(),
                package: PackageBinding {
                    package_id: extension_id.into(),
                    package_digest: digest,
                    entrypoint: executable
                        .file_name()
                        .ok_or(ExtensionHostError::SpawnFailed)?
                        .to_string_lossy()
                        .into_owned(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onResourceRequest".into()],
                capabilities: vec![ExtensionCapability::DataChannel],
            },
            NonZeroU64::new(1).unwrap(),
            Arc::new(ProductAuthority(Arc::new(lease))),
        );
        let supervisor = Self::new(
            Arc::new(launcher),
            command,
            activation,
            ExtensionHostLimits {
                maximum_frame_bytes: maximum_payload_bytes.checked_add(64 * 1024).ok_or(
                    ExtensionHostError::InvalidLimits("resource payload exceeds frame size"),
                )?,
                maximum_payload_bytes,
                request_timeout: Duration::from_secs(30),
                isolation: ProcessIsolationPolicy::AuthorizedProduct,
                ..ExtensionHostLimits::default()
            },
            RestartPolicy::default(),
        )?;
        if let Err(error) = supervisor.start() {
            let _ = supervisor.shutdown();
            return Err(error);
        }
        Ok(supervisor)
    }
}
