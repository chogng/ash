use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_app_server_protocol::schema_hash;

#[test]
fn compiled_protocol_matches_the_committed_metadata_and_client() {
    let metadata: serde_json::Value =
        serde_json::from_str(include_str!("../schema/metadata.json")).unwrap();
    let version = ProtocolVersion::current();
    assert_eq!(
        metadata,
        serde_json::json!({
            "major": version.major,
            "revision": version.revision,
            "schemaHash": schema_hash(),
        })
    );
    let typescript = include_str!("../schema/typescript/protocol.ts");
    let expected = format!(
        "export const APP_SERVER_SCHEMA_HASH = {:?} as const;",
        schema_hash()
    );
    assert!(typescript.lines().any(|line| line == expected));
}
