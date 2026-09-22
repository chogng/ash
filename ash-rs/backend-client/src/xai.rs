//! Grok subscription business APIs. Authentication belongs to the caller.

use crate::RequestError;
use ::client::OperationClient;
use ::client::ResolvedApiTarget;

mod account;
mod billing;
mod models;
pub use account::Account;
pub use account::Settings;
pub use billing::Billing;
pub use billing::BillingCycle;
pub use billing::BillingPeriodUsage;
pub use billing::Cent;
pub use billing::UsagePeriod;
pub use models::CatalogModel;

pub const BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";

/// HTTP operations against one explicitly authenticated subscription target.
pub struct Client<'a> {
    http: crate::client::Client<'a>,
}

impl<'a> Client<'a> {
    pub fn new(
        client: &'a dyn OperationClient,
        target: &'a ResolvedApiTarget,
    ) -> Result<Self, RequestError> {
        Ok(Self {
            http: crate::client::Client::new(client, target)?,
        })
    }
}

#[cfg(test)]
#[path = "xai/client_tests.rs"]
mod tests;
