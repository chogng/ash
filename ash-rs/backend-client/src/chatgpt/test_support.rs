use ::client::ResolvedApiTarget;
use http_client::HttpHeader;
pub(crate) fn target(base: &str) -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        base,
        vec![
            HttpHeader::new("Authorization", "Bearer secret"),
            HttpHeader::new("ChatGPT-Account-ID", "account-1"),
            HttpHeader::new("User-Agent", "Ash/test"),
            HttpHeader::new("X-OpenAI-Fedramp", "true"),
        ],
    )
}
