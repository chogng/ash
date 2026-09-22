use crate::RequestError;
use ::client::OperationClient;
use ::client::ResolvedApiTarget;
use url::Url;

pub const BASE_URL: &str = "https://chatgpt.com/backend-api";

/// Selects the upstream route independently of the hostname.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteStyle {
    Codex,
    ChatGpt,
}

/// ChatGPT business operations using caller-owned authentication.
pub struct Client<'a> {
    pub(super) http: crate::client::Client<'a>,
    route: RouteStyle,
}

impl<'a> Client<'a> {
    pub fn new(
        client: &'a dyn OperationClient,
        target: &'a ResolvedApiTarget,
        route: RouteStyle,
    ) -> Result<Self, RequestError> {
        Ok(Self {
            http: crate::client::Client::new(client, target)?,
            route,
        })
    }
    pub(super) fn endpoint(&self, path: &[&str]) -> Result<Url, RequestError> {
        let prefix: &[&str] = match self.route {
            RouteStyle::Codex => &["api", "codex"],
            RouteStyle::ChatGpt => &["wham"],
        };
        self.http.endpoint(prefix.iter().chain(path).copied())
    }
    pub(super) fn api_key_endpoint(&self) -> Url {
        self.http.origin_endpoint("/v1/analytics/codex/turn-costs")
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
