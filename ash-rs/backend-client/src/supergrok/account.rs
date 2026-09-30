use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::supergrok::Account;
use backend_models::supergrok::Settings;
use http_client::HttpHeader;

impl Client<'_> {
    pub fn read_account(&self, cancellation: &CancellationToken) -> Result<Account, RequestError> {
        let mut url = self.http.endpoint(["user"])?;
        url.query_pairs_mut().append_pair("include", "subscription");
        let account: Account = self.http.get(
            url,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )?;
        if account.user_id.trim().is_empty() {
            return Err(RequestError::InvalidResponse);
        }
        Ok(account)
    }

    pub fn read_settings(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Settings, RequestError> {
        self.http.get(
            self.http.endpoint(["settings"])?,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )
    }
}
