//! Provider event-schema decoders.
//!
//! `ash-client` owns byte-stream framing and exposes provider-neutral
//! `SseFrame` values. This module owns API event lifecycle interpretation; it
//! deliberately contains no HTTP, retry, buffering, or heartbeat timeout
//! behavior.

mod anthropic_messages;
mod openai_chat_completions;

pub use anthropic_messages::AnthropicMessagesSseDecoder;
pub use openai_chat_completions::OpenAiChatCompletionsSseDecoder;

#[cfg(test)]
#[path = "sse/anthropic_messages_tests.rs"]
mod anthropic_messages_tests;

#[cfg(test)]
#[path = "sse/openai_chat_completions_tests.rs"]
mod openai_chat_completions_tests;
