//! Optional native grammars are built from the same locked archive as the static parsers.

use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;

use libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR;
use libloading::os::windows::LOAD_LIBRARY_SEARCH_SYSTEM32;
use libloading::os::windows::Library;

use crate::SyntaxLanguage;

type Factory = unsafe extern "C" fn() -> *const ();
type Resolver = dyn Fn(&str) -> Result<(), String> + Send + Sync;

static RESOLVER: OnceLock<Box<Resolver>> = OnceLock::new();

pub(super) fn install_resolver(resolver: Box<Resolver>) {
    let _ = RESOLVER.set(resolver);
}

pub(super) fn prepare(language: SyntaxLanguage) -> Result<(), String> {
    let Some(name) = pending(language) else {
        return Ok(());
    };
    RESOLVER
        .get()
        .ok_or("Desktop grammar resolver is unavailable")?(name)?;
    if pending(language).is_some() {
        return Err("Desktop grammar was not registered".into());
    }
    Ok(())
}

struct LoadedGrammar {
    factory: Factory,
    _library: Library,
    _lease: Box<dyn Send + Sync>,
}

macro_rules! optional_grammars {
    ($(($name:literal, $variant:ident, $symbol:literal, $module:ident),)*) => {
        $(mod $module {
            use super::*;

            pub(super) static LOADED: OnceLock<LoadedGrammar> = OnceLock::new();

            // Resolving the symbol here keeps the large fallback object out of the app-server link.
            #[unsafe(export_name = $symbol)]
            pub(super) extern "C" fn dispatch() -> *const () {
                let Some(grammar) = LOADED.get() else { std::process::abort() };
                // SAFETY: the exact product-built library and its package lease are process-pinned.
                unsafe { (grammar.factory)() }
            }
        })*

        pub(super) fn pending(language: SyntaxLanguage) -> Option<&'static str> {
            match language {
                $(SyntaxLanguage::$variant => {
                    std::hint::black_box($module::dispatch as extern "C" fn() -> *const ());
                    $module::LOADED.get().is_none().then_some($name)
                },)*
                _ => None,
            }
        }

        fn slot(name: &str) -> Option<&'static OnceLock<LoadedGrammar>> {
            match name {
                $($name => Some(&$module::LOADED),)*
                _ => None,
            }
        }
    };
}

include!(concat!(env!("OUT_DIR"), "/desktop_native_grammars.rs"));

pub(super) fn load(
    name: &str,
    path: &Path,
    lease: impl Send + Sync + 'static,
) -> Result<(), String> {
    let slot = slot(name).ok_or("unrecognized Desktop grammar")?;
    static LOAD: Mutex<()> = Mutex::new(());
    let _load = LOAD
        .lock()
        .map_err(|_| "Desktop grammar loader is unavailable")?;
    if slot.get().is_some() {
        return Ok(());
    }
    if !path.is_absolute() || !path.is_file() {
        return Err("Desktop grammar library is unavailable".into());
    }
    // SAFETY: the caller obtains the exact path from the product-bound, verified capability store.
    let library = unsafe {
        Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    }
    .map_err(|error| error.to_string())?;
    // SAFETY: the product builds this export from the locked Tree-sitter grammar's C entrypoint.
    let factory = unsafe {
        *library
            .get::<Factory>(b"ash_tree_sitter_language\0")
            .map_err(|error| error.to_string())?
    };
    // SAFETY: the export is still backed by the open product library.
    if unsafe { factory() }.is_null() {
        return Err("Desktop grammar export returned no language".into());
    }
    let _ = slot.set(LoadedGrammar {
        factory,
        _library: library,
        _lease: Box::new(lease),
    });
    Ok(())
}
