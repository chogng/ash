//! Codex-compatible ChatGPT sign-in, credential reuse, and authentication maintenance.

mod account;
mod credential;
mod device_flow;
mod maintenance;
mod oauth;
mod storage;

pub use maintenance::ChatGptAuthManagement;

pub use storage::codex_home;

pub use account::ChatGptAccount;
pub use account::ChatGptUsageError;
pub use account::usage_endpoint;
pub use backend_client::chatgpt::CreditBalance;
pub use backend_client::chatgpt::RateLimit;
pub use backend_client::chatgpt::RateLimitWindow;
pub use backend_client::chatgpt::RateLimits;
pub use oauth::CHATGPT_RESPONSES_BASE_URL;
pub use oauth::CHATGPT_SUBSCRIPTION_PROVIDER_ID;
pub use oauth::ChatGptApiTarget;
pub use oauth::ChatGptError;
pub use oauth::ChatGptOAuth;
pub use oauth::sign_in_endpoint;

#[cfg(test)]
#[path = "chatgpt_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;
