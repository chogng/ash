use crate::Error;
use crate::GitHub;
use crate::Result;
use ash_http_client::HttpMethod;
use serde_json::Value;

impl GitHub {
    /// Reads enterprise settings with this client's exact account grant.
    /// A missing file is an authoritative empty result; other failures retain their category.
    pub async fn managed_settings(&self) -> Result<Option<Value>> {
        match self
            .account_api::<Value>(HttpMethod::Get, "copilot_internal/managed_settings", None)
            .await
        {
            Ok(value) if value.is_object() => Ok(Some(value)),
            Ok(_) => Err(Error::InvalidResponse(
                "Invalid managed settings response".into(),
            )),
            Err(Error::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
