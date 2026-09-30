use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::chatgpt::ApiKeyTurnCost;
use backend_models::chatgpt::ApiKeyTurnCostsRequest;
use backend_models::chatgpt::ApiKeyTurnCostsResponse;
use backend_models::chatgpt::ChatGptThreadCosts;
use backend_models::chatgpt::ChatGptTurnCostsRequest;
use backend_models::chatgpt::ChatGptTurnCostsResponse;
use backend_models::chatgpt::TaskUsageRequest;
use backend_models::chatgpt::TaskUsageResponse;
use backend_models::chatgpt::TaskUsageThread;
use backend_models::chatgpt::ThreadUsage;
use backend_models::chatgpt::ThreadUsageRequest;
use backend_models::chatgpt::ThreadUsageResponse;
use backend_models::chatgpt::TurnCostThread;
use std::collections::BTreeMap;
use std::collections::HashSet;

impl Client<'_> {
    /// Queries 1–100 distinct threads. Missing rows and missing amounts remain unavailable.
    pub fn read_thread_usage(
        &self,
        thread_ids: &[&str],
        cancellation: &CancellationToken,
    ) -> Result<Vec<ThreadUsage>, RequestError> {
        let requested = request_ids(thread_ids.iter().copied(), 100)?;
        let response: ThreadUsageResponse = self.http.post(
            self.endpoint(&["usage", "thread_usage", "query"])?,
            &ThreadUsageRequest { thread_ids },
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
        let response: TaskUsageResponse = self.http.post(
            self.endpoint(&["usage", "thread_usage", "query_v2"])?,
            &TaskUsageRequest { threads },
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
        let query = ChatGptTurnCostsRequest {
            threads: threads
                .iter()
                .map(|(thread_id, turn_ids)| TurnCostThread {
                    thread_id,
                    turn_ids,
                })
                .collect(),
            include_settled_response_ids: true,
        };
        let response: ChatGptTurnCostsResponse = self.http.post(
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
        let response: ApiKeyTurnCostsResponse = self.http.post(
            self.api_key_endpoint(),
            &ApiKeyTurnCostsRequest { turn_ids },
            cancellation,
        )?;
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

#[cfg(test)]
#[path = "costs_tests.rs"]
mod tests;
