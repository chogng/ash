use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::chatgpt::ConfigBundle;
use backend_models::chatgpt::UserSettings;
use backend_models::chatgpt::WorkspaceMessages;
use http_client::HttpHeader;

impl Client<'_> {
    pub fn read_config_bundle(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ConfigBundle, RequestError> {
        self.http
            .get(self.endpoint(&["config", "bundle"])?, &[], cancellation)
    }

    pub fn read_user_settings(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<UserSettings, RequestError> {
        self.http.get(
            self.endpoint(&["settings", "user"])?,
            &[HttpHeader::new("Cache-Control", "no-cache, no-store")],
            cancellation,
        )
    }

    pub fn list_workspace_messages(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<WorkspaceMessages, RequestError> {
        self.http.get(
            self.endpoint(&["workspace-messages"])?,
            &[HttpHeader::new("Cache-Control", "no-store")],
            cancellation,
        )
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
