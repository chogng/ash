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
pub use backend_client::chatgpt::CreditBalance;
pub use backend_client::chatgpt::RateLimit;
pub use backend_client::chatgpt::RateLimitWindow;
pub use backend_client::chatgpt::RateLimits;
pub use oauth::CHATGPT_RESPONSES_BASE_URL;
pub use oauth::ChatGptApiTarget;
pub use oauth::ChatGptError;
pub use oauth::ChatGptOAuth;
pub use oauth::OPENAI_CHATGPT_PROVIDER_ID;

#[cfg(test)]
#[path = "chatgpt_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;
