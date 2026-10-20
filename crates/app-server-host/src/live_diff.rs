use ash_app_server_protocol::protocol::error::AppServerError;
use ash_dev_build::ReloadableModule;
use serde_json::Value;
use std::sync::OnceLock;

pub(super) fn compute(params: &Value) -> Result<Value, AppServerError> {
    static MODULE: OnceLock<Option<ReloadableModule>> = OnceLock::new();
    let module = MODULE.get_or_init(|| {
        std::env::var_os("ASH_RUST_LIVE_DIRECTORY")
            .filter(|path| !path.is_empty())
            .map(|path| {
                ReloadableModule::new(ash_dev_build::contract_directory(
                    std::path::Path::new(&path),
                    &ash_app_server_protocol::schema_hash(),
                ))
            })
    });
    if let Some(module) = module {
        let output = serde_json::to_vec(params)
            .map_err(|error| error.to_string())
            .and_then(|input| module.call(&input))
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()));
        match output {
            Ok(result) => return result,
            Err(error) => eprintln!("[ash-build] Using compiled diff adapter: {error}"),
        }
    }
    ash_app_server_diff::compute(params)
}
