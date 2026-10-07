fn main() {
    // The exporter derives its identity from Rust, so it can bootstrap without artifacts.
    if std::env::var_os("CARGO_FEATURE_EXPORT").is_some() {
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
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
