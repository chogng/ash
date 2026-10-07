fn main() {
    println!("cargo:rerun-if-changed=schema/metadata.json");
    let source = std::fs::read_to_string("schema/metadata.json")
        .expect("checked-in protocol metadata must be readable");
    let metadata: serde_json::Value =
        serde_json::from_str(&source).expect("checked-in protocol metadata must be valid JSON");
    let hash = metadata["schemaHash"]
        .as_str()
        .expect("protocol metadata must contain a schema hash");
    println!("cargo:rustc-env=ASH_APP_SERVER_SCHEMA_HASH={hash}");
}
