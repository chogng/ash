fn main() {
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"),
    );
    ash_editor_client_build::emit_client_digest_at(
        &root.join("../../extensions/code"),
        "ASH_BUNDLED_CODE_CLIENT_DIGEST",
    );
}
