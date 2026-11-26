use std::num::NonZeroU8;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ash_external_ext::ExtensionHostError;
use ash_external_ext::ExtensionHostLauncher;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostProcess;
use ash_external_ext::ExtensionLaunchCommand;
use ash_external_ext::ProductExecutableLauncher;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::RedirectPolicy;
use ash_http_client::ReqwestHttpClient;
use ash_http_client::ResponseBodyLimit;
use ash_install_context::InstallContext;
use ash_package_store::CapabilitySource;

pub(super) const TYPESCRIPT: &str = "desktop-typescript";
pub(super) const DEBUG: &str = "desktop-debug";

pub(super) fn install_native_grammar_resolver(
    home: PathBuf,
    calls: Arc<super::call_runtime::Calls>,
) {
    ash_syntax::install_native_grammar_resolver(move |grammar| {
        let kind = format!("desktop-grammar-{grammar}");
        let root = install(&home, calls.network_policy(), &kind)?;
        let lease =
            ash_package_store::PackageLease::acquire(&root).map_err(|error| error.to_string())?;
        ash_syntax::load_native_grammar(grammar, &root.join("ash-resources/grammar.dll"), lease)
    });
}

#[derive(Clone)]
pub(super) struct DebugAccess {
    pub(super) home: PathBuf,
    pub(super) calls: Arc<super::call_runtime::Calls>,
}

impl DebugAccess {
    pub(super) fn downloaded(&self) -> bool {
        let root = self.home.join("capabilities").join(DEBUG);
        root.join("manifests").is_dir()
            && ash_package_store::PackageStore::open(&root)
                .and_then(|store| store.current())
                .is_ok_and(|selected| selected.is_some())
    }

    pub(super) fn launcher(&self, binary: PathBuf) -> Arc<dyn ExtensionHostLauncher> {
        Arc::new(DebugLauncher {
            access: self.clone(),
            binary,
            lease: Mutex::new(None),
        })
    }
}

struct DebugLauncher {
    access: DebugAccess,
    binary: PathBuf,
    lease: Mutex<Option<ash_package_store::PackageLease>>,
}

impl ExtensionHostLauncher for DebugLauncher {
    fn spawn(
        &self,
        command: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Arc<dyn ExtensionHostProcess>, ExtensionHostError> {
        if command.executable() != Some(self.binary.as_path()) {
            return Err(ExtensionHostError::SpawnFailed);
        }
        let root = install(&self.access.home, self.access.calls.network_policy(), DEBUG).map_err(
            |error| {
                log::warn!("Desktop debugger capability: {error}");
                ExtensionHostError::SpawnFailed
            },
        )?;
        let lease = ash_package_store::PackageLease::acquire(&root)
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        let executables = root.join("bin");
        let binary = executables.join(
            self.binary
                .file_name()
                .ok_or(ExtensionHostError::SpawnFailed)?,
        );
        let command = command
            .clone()
            .with_product_executable(&binary, &executables)?;
        let mut held = self
            .lease
            .lock()
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        let process = ProductExecutableLauncher::new(binary)?.spawn(&command, limits)?;
        *held = Some(lease);
        Ok(process)
    }
}

pub(super) fn is_declared(kind: &str) -> bool {
    InstallContext::current()
        .bundled_resource(&format!("capabilities/{kind}.json"))
        .is_some()
}

/// Resolve a capability bound by the selected Desktop generation, using the host's network policy.
pub(super) fn install(
    home: &Path,
    policy: OutboundNetworkPolicy,
    kind: &str,
) -> Result<PathBuf, String> {
    let config = HttpClientConfig::default()
        .with_response_body_limit(
            ResponseBodyLimit::new(NonZeroUsize::new(128 * 1024 * 1024).unwrap()).unwrap(),
        )
        .with_redirect_policy(RedirectPolicy::Follow {
            max_hops: NonZeroU8::new(5).unwrap(),
        });
    let network =
        OutboundNetworkSnapshot::with_policy(config, policy).map_err(|error| error.to_string())?;
    let client = ReqwestHttpClient::with_network(network).map_err(|error| error.to_string())?;
    ash_package_store::install_capability(home, kind, CapabilitySource::ProductBound, &client)
        .map_err(|error| error.to_string())
}
