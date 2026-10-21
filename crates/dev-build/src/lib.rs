//! Development-only native modules. No Rust-owned value crosses the C ABI.
//!
//! The compiler owns module invalidation. Publication owns immutable images, and
//! each call retains its image until it returns, including during replacement.

#[cfg(feature = "compiler")]
mod analysis;
#[cfg(feature = "compiler")]
mod build;
#[cfg(feature = "compiler")]
mod check;
#[cfg(feature = "compiler")]
mod codegen;
#[cfg(feature = "compiler")]
mod function;
#[cfg(feature = "compiler")]
mod jit;
mod machine;
mod reload;
#[cfg(feature = "compiler")]
mod server;
#[cfg(feature = "compiler")]
mod session;
#[cfg(feature = "compiler")]
mod workspace;

#[cfg(feature = "compiler")]
pub use build::build_diff;
#[cfg(feature = "compiler")]
pub use check::rustc_wrapper;
#[cfg(feature = "compiler")]
pub use jit::evaluate;
pub use reload::ReloadableModule;
pub use reload::UsizeFunction;
#[cfg(feature = "compiler")]
pub use server::serve_diff;
#[cfg(feature = "compiler")]
pub use session::serve_functions;

use std::ffi::c_void;
use std::panic::UnwindSafe;
use std::panic::catch_unwind;
use std::path::Path;
use std::path::PathBuf;

pub const ABI_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Isolates published modules by the host's compiled wire contract. A full build
/// may publish a new protocol while an older host is still serving requests.
pub fn contract_directory(directory: &Path, contract: &str) -> PathBuf {
    directory.join(reload::digest(contract.as_bytes()))
}

/// The caller copies the bytes synchronously; their allocation stays in the module.
pub type WriteResponse = unsafe extern "C" fn(*mut c_void, *const u8, usize);

/// Runs one module invocation without unwinding across the foreign-function boundary.
///
/// # Safety
/// `input` must cover `length` readable bytes. `write` must synchronously copy its
/// input without unwinding and accept `context`, which remains owned by the caller.
pub unsafe fn respond(
    input: *const u8,
    length: usize,
    write: WriteResponse,
    context: *mut c_void,
    compute: impl FnOnce(&[u8]) -> Vec<u8> + UnwindSafe,
) -> i32 {
    if length > MAX_MESSAGE_BYTES || (input.is_null() && length != 0) {
        return 2;
    }
    let input = if length == 0 {
        &[]
    } else {
        // SAFETY: the exported entry forwards the caller's readable input buffer.
        unsafe { std::slice::from_raw_parts(input, length) }
    };
    match catch_unwind(|| compute(input)) {
        Ok(output) if output.len() <= MAX_MESSAGE_BYTES => {
            // SAFETY: the callback copies before the module releases this allocation.
            unsafe { write(context, output.as_ptr(), output.len()) };
            0
        }
        Ok(_) => 3,
        Err(_) => 1,
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
