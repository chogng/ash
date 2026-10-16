//! Binding for the pinned log grammar shipped with this language package.
use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_log() -> *const ();
}

/// The grammar storage lives for the process lifetime.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_log) };
