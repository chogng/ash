//! Z.AI business-token exchange HTTP contracts.

use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize)]
pub struct LoginRequest<'a> {
    pub token: &'a str,
}

#[derive(Deserialize)]
pub struct LoginResponse {
    #[serde(alias = "accessToken")]
    pub access_token: String,
}
