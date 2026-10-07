/// Returns the precomputed wire contract hash used by the initialization handshake.
pub fn schema_hash() -> String {
    #[cfg(any(test, feature = "export"))]
    {
        static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        HASH.get_or_init(crate::export::schema_hash).clone()
    }
    #[cfg(not(any(test, feature = "export")))]
    {
        env!("ASH_APP_SERVER_SCHEMA_HASH").to_owned()
    }
}
