use ash_app_server_protocol::schema_hash;

#[test]
fn product_dependency_graph_preserves_the_checked_in_protocol_schema_hash() {
    let fixture = include_str!("../../app-server-protocol/schema/typescript/protocol.ts");
    let declaration = format!(
        "export const APP_SERVER_SCHEMA_HASH = {:?} as const;",
        schema_hash()
    );

    assert!(fixture.lines().any(|line| line == declaration));
}
