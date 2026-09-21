use crate::BackendClient;
use crate::RequestError;
use async_utils::CancellationToken;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ThreadUsage {
    pub thread_id: String,
    pub estimated_usage_credits_micros: Option<i64>,
    pub estimated_usage_usd_micros: Option<i64>,
    pub groups: Option<Vec<ThreadUsageGroup>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ThreadUsageGroup {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub speed: Option<String>,
    pub estimated_usage_credits_micros: i64,
    pub net_new_input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskUsageThread {
    pub thread_id: String,
    pub created_at: Option<String>,
    pub descendant_thread_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageResponse {
    pub data_as_of: Option<String>,
    pub threads: Vec<TaskUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskUsageStatus {
    Available,
    Partial,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsage {
    pub thread_id: String,
    pub data_status: TaskUsageStatus,
    pub usage_source: String,
    #[serde(flatten)]
    pub amounts: TaskUsageAmounts,
    pub groups: Vec<TaskUsageGroup>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageAmounts {
    #[serde(default, deserialize_with = "percentage")]
    pub five_hour_limit_percent: Option<f64>,
    #[serde(default, deserialize_with = "percentage")]
    pub weekly_limit_percent: Option<f64>,
    /// Decimal text is preserved exactly; no floating-point conversion of balance debits.
    #[serde(default, deserialize_with = "credit_amount")]
    pub balance_usage_credits: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageGroup {
    pub product_experience: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub speed: Option<String>,
    #[serde(flatten)]
    pub amounts: TaskUsageAmounts,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ChatGptTurnCost {
    pub turn_id: String,
    pub model: Option<String>,
    pub estimated_usage_usd_micros: Option<i64>,
    pub settled_response_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ChatGptThreadCosts {
    pub thread_id: String,
    pub turns: Vec<ChatGptTurnCost>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyTurnCostStatus {
    Pending,
    Priced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ApiKeyResponseCost {
    pub response_id: String,
    pub total_usd: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ApiKeyTurnCost {
    pub turn_id: String,
    pub status: ApiKeyTurnCostStatus,
    pub total_usd: Option<String>,
    pub event_count: Option<u64>,
    pub responses: Option<Vec<ApiKeyResponseCost>>,
    pub model: Option<String>,
    pub speed: Option<String>,
    pub reasoning_effort: Option<String>,
}

impl BackendClient<'_> {
    /// Queries 1–100 distinct threads. Missing rows and missing amounts remain unavailable.
    pub fn read_thread_usage(
        &self,
        thread_ids: &[&str],
        cancellation: &CancellationToken,
    ) -> Result<Vec<ThreadUsage>, RequestError> {
        let requested = request_ids(thread_ids.iter().copied(), 100)?;
        #[derive(Serialize)]
        struct Query<'a> {
            thread_ids: &'a [&'a str],
        }
        #[derive(Deserialize)]
        struct Response {
            threads: Vec<ThreadUsage>,
        }
        let response: Response = self.post(
            self.endpoint(&["usage", "thread_usage", "query"])?,
            &Query { thread_ids },
            cancellation,
        )?;
        response_ids(
            response.threads.iter().map(|row| row.thread_id.as_str()),
            &requested,
        )?;
        Ok(response.threads)
    }

    /// Queries at most 100 disjoint tasks and 1,000 total root/descendant IDs.
    pub fn read_task_usage(
        &self,
        threads: &[TaskUsageThread],
        cancellation: &CancellationToken,
    ) -> Result<TaskUsageResponse, RequestError> {
        let roots = request_ids(threads.iter().map(|thread| thread.thread_id.as_str()), 100)?;
        request_ids(
            threads.iter().flat_map(|thread| {
                std::iter::once(thread.thread_id.as_str())
                    .chain(thread.descendant_thread_ids.iter().map(String::as_str))
            }),
            1_000,
        )?;
        #[derive(Serialize)]
        struct Query<'a> {
            threads: &'a [TaskUsageThread],
        }
        let response: TaskUsageResponse = self.post(
            self.endpoint(&["usage", "thread_usage", "query_v2"])?,
            &Query { threads },
            cancellation,
        )?;
        response_ids(
            response.threads.iter().map(|row| row.thread_id.as_str()),
            &roots,
        )?;
        Ok(response)
    }

    /// Uses the current account's workspace permissions and asks for settled response IDs.
    pub fn query_chatgpt_turn_costs(
        &self,
        threads: &BTreeMap<String, Vec<String>>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ChatGptThreadCosts>, RequestError> {
        let roots = request_ids(threads.keys().map(String::as_str), usize::MAX)?;
        let requested = threads
            .iter()
            .map(|(id, turns)| {
                Ok((
                    id.as_str(),
                    request_ids(turns.iter().map(String::as_str), usize::MAX)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, RequestError>>()?;
        #[derive(Serialize)]
        struct Thread<'a> {
            thread_id: &'a str,
            turn_ids: &'a [String],
        }
        #[derive(Serialize)]
        struct Query<'a> {
            threads: Vec<Thread<'a>>,
            include_settled_response_ids: bool,
        }
        #[derive(Deserialize)]
        struct Response {
            threads: Vec<ChatGptThreadCosts>,
        }
        let query = Query {
            threads: threads
                .iter()
                .map(|(thread_id, turn_ids)| Thread {
                    thread_id,
                    turn_ids,
                })
                .collect(),
            include_settled_response_ids: true,
        };
        let response: Response = self.post(
            self.endpoint(&["usage", "thread-estimates", "query"])?,
            &query,
            cancellation,
        )?;
        response_ids(
            response.threads.iter().map(|row| row.thread_id.as_str()),
            &roots,
        )?;
        for thread in &response.threads {
            response_ids(
                thread.turns.iter().map(|turn| turn.turn_id.as_str()),
                &requested[thread.thread_id.as_str()],
            )?;
        }
        Ok(response.threads)
    }

    /// Uses an explicitly resolved API-key target (for example https://api.chatgpt.com).
    /// The caller supplies API-key auth and organization/project headers on that target.
    /// The client never moves credentials to a different origin or reuses ChatGPT login state.
    pub fn query_api_key_turn_costs(
        &self,
        turn_ids: &[String],
        cancellation: &CancellationToken,
    ) -> Result<Vec<ApiKeyTurnCost>, RequestError> {
        let requested = request_ids(turn_ids.iter().map(String::as_str), usize::MAX)?;
        #[derive(Serialize)]
        struct Query<'a> {
            turn_ids: &'a [String],
        }
        #[derive(Deserialize)]
        struct Response {
            turns: Vec<ApiKeyTurnCost>,
        }
        let response: Response =
            self.post(self.api_key_endpoint(), &Query { turn_ids }, cancellation)?;
        response_ids(
            response.turns.iter().map(|turn| turn.turn_id.as_str()),
            &requested,
        )?;
        Ok(response.turns)
    }
}

fn request_ids<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    maximum: usize,
) -> Result<HashSet<&'a str>, RequestError> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.trim().is_empty() || id.len() > 512 || !seen.insert(id) || seen.len() > maximum {
            return Err(RequestError::InvalidRequest);
        }
    }
    if seen.is_empty() {
        return Err(RequestError::InvalidRequest);
    }
    Ok(seen)
}

fn response_ids<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    requested: &HashSet<&str>,
) -> Result<(), RequestError> {
    let mut seen = HashSet::new();
    for id in ids {
        if !requested.contains(id) || !seen.insert(id) {
            return Err(RequestError::InvalidResponse);
        }
    }
    Ok(())
}

// Serde buffers flattened fields. With serde_json/arbitrary_precision, decimals in
// that buffer are represented as maps, so deserialize through Number before f64.
fn percentage<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Option::<serde_json::Number>::deserialize(deserializer)?
        .map(|number| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| serde::de::Error::custom("invalid usage percentage"))
        })
        .transpose()
}

fn credit_amount<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(amount) = &value {
        let unsigned = if amount.starts_with('-') || amount.starts_with('+') {
            &amount[1..]
        } else {
            amount
        };
        let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().is_ok()),
            None => (unsigned, true),
        };
        if amount.len() > 128
            || !exponent
            || !mantissa.bytes().any(|byte| byte.is_ascii_digit())
            || !mantissa
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
            || mantissa.bytes().filter(|byte| *byte == b'.').count() > 1
        {
            return Err(serde::de::Error::custom("invalid credit amount"));
        }
    }
    Ok(value)
}

#[cfg(test)]
#[path = "costs_tests.rs"]
mod tests;
