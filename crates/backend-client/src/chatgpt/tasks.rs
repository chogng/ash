use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::chatgpt::CreatedTaskResponse;
use backend_models::chatgpt::SiblingTurns;
use backend_models::chatgpt::TaskContent;
use backend_models::chatgpt::TaskDetailsResponse;
use backend_models::chatgpt::TaskList;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct TaskListQuery<'a> {
    pub limit: Option<u32>,
    pub task_filter: Option<&'a str>,
    pub environment_id: Option<&'a str>,
    pub cursor: Option<&'a str>,
}

/// Cloud-task interpretation over the original provider response.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskDetails {
    pub data: TaskDetailsResponse,
}

fn task_text(content: &TaskContent) -> Option<&str> {
    let text = match content {
        TaskContent::Structured {
            content_type: Some(kind),
            text,
        } if kind.eq_ignore_ascii_case("text") => text.as_deref(),
        TaskContent::Text(text) => Some(text.as_str()),
        _ => None,
    };
    text.filter(|text| !text.trim().is_empty())
}
impl TaskDetails {
    pub fn unified_diff(&self) -> Option<&str> {
        [
            self.data.current_diff_task_turn.as_ref(),
            self.data.current_assistant_turn.as_ref(),
        ]
        .into_iter()
        .flatten()
        .flat_map(|turn| turn.output_items.iter().flatten())
        .find_map(|item| {
            match item.kind.as_str() {
                "output_diff" => item.diff.as_deref(),
                "pr" => item
                    .output_diff
                    .as_ref()
                    .and_then(|diff| diff.diff.as_deref()),
                _ => None,
            }
            .filter(|diff| !diff.is_empty())
        })
    }

    pub fn user_text_prompt(&self) -> Option<String> {
        let turn = self.data.current_user_turn.as_ref()?;
        let parts: Vec<_> = turn
            .input_items
            .iter()
            .flatten()
            .filter(|item| {
                item.kind == "message"
                    && item
                        .role
                        .as_ref()
                        .is_none_or(|role| role.eq_ignore_ascii_case("user"))
            })
            .flat_map(|item| item.content.iter().flatten())
            .filter_map(task_text)
            .collect();
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    }

    pub fn assistant_text_messages(&self) -> Vec<&str> {
        let mut texts = Vec::new();
        for turn in [
            self.data.current_diff_task_turn.as_ref(),
            self.data.current_assistant_turn.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            texts.extend(
                turn.output_items
                    .iter()
                    .flatten()
                    .filter(|item| item.kind == "message")
                    .flat_map(|item| item.content.iter().flatten())
                    .filter_map(task_text),
            );
            texts.extend(
                turn.worklog
                    .iter()
                    .flat_map(|log| log.messages.iter().flatten())
                    .filter(|message| {
                        message
                            .author
                            .as_ref()
                            .and_then(|author| author.role.as_deref())
                            .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
                    })
                    .filter_map(|message| message.content.as_ref())
                    .flat_map(|content| &content.parts)
                    .filter_map(task_text),
            );
        }
        texts
    }

    pub fn assistant_error_message(&self) -> Option<String> {
        let error = self.data.current_assistant_turn.as_ref()?.error.as_ref()?;
        let parts: Vec<_> = [error.code.as_deref(), error.message.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(": "))
    }
}

impl Client<'_> {
    pub fn list_tasks(
        &self,
        query: &TaskListQuery<'_>,
        cancellation: &CancellationToken,
    ) -> Result<TaskList, RequestError> {
        if query.limit == Some(0) {
            return Err(RequestError::InvalidRequest);
        }
        let mut url = self.endpoint(&["tasks", "list"])?;
        if let Some(limit) = query.limit {
            url.query_pairs_mut()
                .append_pair("limit", &limit.to_string());
        }
        for (name, value) in [
            ("task_filter", query.task_filter),
            ("cursor", query.cursor),
            ("environment_id", query.environment_id),
        ] {
            if let Some(value) = value {
                url.query_pairs_mut().append_pair(name, value);
            }
        }
        self.http.get(url, &[], cancellation)
    }

    pub fn read_task(
        &self,
        task_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<TaskDetails, RequestError> {
        let data: TaskDetailsResponse =
            self.http
                .get(self.endpoint(&["tasks", task_id])?, &[], cancellation)?;
        if data.task.id != task_id {
            return Err(RequestError::InvalidResponse);
        }
        Ok(TaskDetails { data })
    }

    pub fn list_sibling_turns(
        &self,
        task_id: &str,
        turn_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<SiblingTurns, RequestError> {
        self.http.get(
            self.endpoint(&["tasks", task_id, "turns", turn_id, "sibling_turns"])?,
            &[],
            cancellation,
        )
    }

    /// The task owner supplies the backend task object, including environment and input items.
    /// This operation is never replayed automatically.
    pub fn create_task(
        &self,
        body: &serde_json::Map<String, Value>,
        cancellation: &CancellationToken,
    ) -> Result<String, RequestError> {
        let created: CreatedTaskResponse =
            self.http
                .post(self.endpoint(&["tasks"])?, body, cancellation)?;
        let id = match (created.task, created.id) {
            (Some(task), None) => task.id,
            (None, Some(id)) => id,
            (Some(task), Some(id)) if task.id == id => id,
            _ => return Err(RequestError::InvalidResponse),
        };
        if id.trim().is_empty() {
            return Err(RequestError::InvalidResponse);
        }
        Ok(id)
    }
}

#[cfg(test)]
#[path = "tasks_tests.rs"]
mod tests;
