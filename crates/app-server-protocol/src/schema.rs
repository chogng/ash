/// Returns the precomputed wire contract hash used by the initialization handshake.
pub fn schema_hash() -> String {
    env!("ASH_APP_SERVER_SCHEMA_HASH").to_owned()
}
