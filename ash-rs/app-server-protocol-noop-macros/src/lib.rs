//! Schema helper attributes for builds that do not export protocol types.

use proc_macro::TokenStream;

/// Accepts schema attributes without generating a schema implementation.
#[proc_macro_derive(JsonSchema, attributes(schemars))]
pub fn derive_json_schema(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}

/// Accepts TypeScript attributes without generating a TypeScript implementation.
#[proc_macro_derive(TS, attributes(ts))]
pub fn derive_ts(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
