//! Rust binding for the bundled upstream gitignore grammar.
use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_gitignore() -> *const ();
}

/// The statically linked upstream grammar; its storage lives for the process lifetime.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_gitignore) };
