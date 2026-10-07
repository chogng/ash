//! Normal process-exit hooks for owned OS resources retained by background runtimes.

use std::sync::Mutex;
use std::sync::OnceLock;

type ExitCleanup = fn();
static CLEANUPS: OnceLock<Mutex<Vec<ExitCleanup>>> = OnceLock::new();

/// Registers cleanup for normal process termination, including `std::process::exit`.
/// Call once per resource owner. Callbacks must not panic, register more callbacks,
/// or rely on thread-local state. Abort and forced process termination bypass these hooks.
pub fn register_exit_cleanup(cleanup: ExitCleanup) {
    CLEANUPS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(cleanup);
}

// Platform-specific linker sections stay in the crate that owns process-level OS hooks.
#[ctor::dtor]
fn run_exit_cleanups() {
    if let Some(cleanups) = CLEANUPS.get() {
        let cleanups = cleanups.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for cleanup in cleanups.into_iter().rev() {
            cleanup();
        }
    }
}
