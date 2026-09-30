use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::supergrok::Billing;
use backend_models::supergrok::BillingResponse;
use http_client::HttpHeader;

impl Client<'_> {
    pub fn read_billing(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<Billing>, RequestError> {
        let mut url = self.http.endpoint(["billing"])?;
        url.query_pairs_mut().append_pair("format", "credits");
        let response: BillingResponse = self.http.get(
            url,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )?;
        let billing = response.config;
        if let Some(billing) = &billing {
            if billing
                .credit_usage_percent
                .is_some_and(|value| !value.is_finite() || value < 0.0)
                || billing
                    .history
                    .iter()
                    .filter_map(|entry| entry.billing_cycle.as_ref())
                    .any(|cycle| !(1..=12).contains(&cycle.month))
            {
                return Err(RequestError::InvalidResponse);
            }
        }
        Ok(billing)
    }
}
