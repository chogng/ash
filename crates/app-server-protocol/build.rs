fn main() {
    // The exporter derives its identity from Rust, so it can bootstrap without artifacts.
    if std::env::var_os("CARGO_FEATURE_EXPORT").is_some() {
        return;
    }
    // Shared Cargo caches can reuse the build-script executable across source roots.
    // Read Cargo's invocation directory at runtime instead of embedding the compiling root.
    let path = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must provide the manifest directory"),
    )
    .join("../../.build/protocol/metadata.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let source = std::fs::read_to_string(path).expect(
        "protocol metadata is missing; run just generate-protocol before direct Cargo builds",
    );
    let metadata: serde_json::Value =
        serde_json::from_str(&source).expect("generated protocol metadata must be valid JSON");
    let hash = metadata["schemaHash"]
        .as_str()
        .expect("protocol metadata must contain a schema hash");
    println!("cargo:rustc-env=ASH_APP_SERVER_SCHEMA_HASH={hash}");
}
