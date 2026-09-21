use ash_app_server_protocol::schema_hash;

#[test]
fn compiled_protocol_hash_matches_the_committed_client() {
    let typescript = include_str!("../schema/typescript/protocol.ts");
    assert!(typescript.lines().any(|line| line
        == format!(
            "export const APP_SERVER_SCHEMA_HASH = {:?} as const;",
            schema_hash()
        )));
}
