//! C ABI adapter for the existing stateless diff domain, used only by ash-build.

#[cfg(panic = "abort")]
compile_error!("development native modules require panic=unwind for their C ABI boundary");

use ash_app_server_protocol::protocol::error::AppServerError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_dev_build::ReloadableModule;
use ash_dev_build::UsizeFunction;
use ash_dev_build::WriteResponse;
use serde_json::Value;
use std::cell::Cell;
use std::ffi::c_void;
use std::sync::OnceLock;

#[unsafe(no_mangle)]
pub extern "C" fn ash_dev_abi_version() -> u32 {
    ash_dev_build::ABI_VERSION
}

/// Copies a serialized domain result to the host without sharing Rust allocations.
///
/// # Safety
/// The host must provide readable input and a synchronous, non-unwinding callback
/// with a live context, as specified by `ash_dev_build::respond`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ash_dev_invoke_v1(
    input: *const u8,
    length: usize,
    write: WriteResponse,
    context: *mut c_void,
) -> i32 {
    // SAFETY: the exported entry preserves the host's buffer and callback contract.
    unsafe { ash_dev_build::respond(input, length, write, context, compute) }
}

fn compute(input: &[u8]) -> Vec<u8> {
    // Snapshot once per request, so all row/hunk indices use one generation.
    let function = line_index_function();
    let result: Result<Value, AppServerError> = serde_json::from_slice(input)
        .map_err(|_| AppServerError::new(-32602, AppServerErrorName::InvalidParams))
        .and_then(|params| {
            let failed = Cell::new(false);
            let result = ash_app_server_diff::compute_with_line_index(&params, |value| {
                let function = function.as_ref()?;
                match function.call(value) {
                    Ok(value) => Some(value),
                    Err(_) => {
                        failed.set(true);
                        None
                    }
                }
            });
            if failed.get() {
                // Reproject the entire request; never mix replacement and native
                // line numbering in one successful response after a function panic.
                eprintln!(
                    "[ash-build] Using compiled projection after function invocation failure"
                );
                ash_app_server_diff::compute(&params)
            } else {
                result
            }
        });
    serde_json::to_vec(&result).expect("diff results contain JSON-compatible values")
}

fn line_index_function() -> Option<UsizeFunction> {
    static FUNCTION: OnceLock<Option<ReloadableModule>> = OnceLock::new();
    FUNCTION
        .get_or_init(|| {
            let generation = option_env!("ASH_DIFF_LIVE_GENERATION")?;
            let directory =
                std::env::var_os("ASH_RUST_LIVE_DIRECTORY").filter(|path| !path.is_empty())?;
            let directory = ash_dev_build::contract_directory(
                std::path::Path::new(&directory),
                &ash_app_server_protocol::schema_hash(),
            );
            Some(ReloadableModule::new_usize(
                directory
                    .join("functions")
                    .join(generation)
                    .join("zero_based_line_index"),
            ))
        })
        .as_ref()?
        .usize_function()
        .ok()
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
