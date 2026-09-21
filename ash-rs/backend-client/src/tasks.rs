use crate::BackendClient;
use crate::RequestError;
use async_utils::CancellationToken;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct TaskListQuery<'a> {
    pub limit: Option<u32>,
    pub task_filter: Option<&'a str>,
    pub environment_id: Option<&'a str>,
    pub cursor: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskList {
    pub items: Vec<TaskListItem>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskListItem {
    pub id: String,
    pub title: String,
    pub has_generated_title: Option<bool>,
    pub updated_at: Option<f64>,
    pub created_at: Option<f64>,
    pub task_status_display: Option<serde_json::Map<String, Value>>,
    pub archived: bool,
    pub has_unread_turn: bool,
    pub pull_requests: Option<Vec<TaskPullRequest>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskPullRequest {
    pub id: String,
    pub assistant_turn_id: String,
    pub pull_request: GitPullRequest,
    pub codex_updated_sha: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct GitPullRequest {
    pub number: i64,
    pub url: String,
    pub state: String,
    pub merged: bool,
    pub mergeable: bool,
    pub draft: Option<bool>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub merge_commit_sha: Option<String>,
    pub comments: Option<Value>,
    pub diff: Option<Value>,
    pub user: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskDetails {
    pub current_user_turn: Option<TaskTurn>,
    pub current_assistant_turn: Option<TaskTurn>,
    pub current_diff_task_turn: Option<TaskTurn>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskTurn {
    pub id: Option<String>,
    pub attempt_placement: Option<i64>,
    pub turn_status: Option<String>,
    pub sibling_turn_ids: Option<Vec<String>>,
    pub input_items: Option<Vec<TaskItem>>,
    pub output_items: Option<Vec<TaskItem>>,
    pub worklog: Option<TaskWorklog>,
    pub error: Option<TaskError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskItem {
    #[serde(rename = "type")]
    pub kind: String,
    pub role: Option<String>,
    pub content: Option<Vec<TaskContent>>,
    pub diff: Option<String>,
    pub output_diff: Option<TaskDiff>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TaskContent {
    Structured {
        content_type: Option<String>,
        text: Option<String>,
    },
    Text(String),
}

impl TaskContent {
    pub fn text(&self) -> Option<&str> {
        let text = match self {
            Self::Structured {
                content_type: Some(kind),
                text,
            } if kind.eq_ignore_ascii_case("text") => text.as_deref(),
            Self::Text(text) => Some(text.as_str()),
            _ => None,
        };
        text.filter(|text| !text.trim().is_empty())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskDiff {
    pub diff: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskWorklog {
    pub messages: Option<Vec<TaskWorklogMessage>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskWorklogMessage {
    pub author: Option<TaskAuthor>,
    pub content: Option<TaskWorklogContent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskAuthor {
    pub role: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskWorklogContent {
    pub parts: Vec<TaskContent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskError {
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SiblingTurns {
    pub sibling_turns: Vec<TaskTurn>,
}

impl TaskDetails {
    pub fn unified_diff(&self) -> Option<&str> {
        [
            self.current_diff_task_turn.as_ref(),
            self.current_assistant_turn.as_ref(),
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
        let turn = self.current_user_turn.as_ref()?;
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
            .filter_map(TaskContent::text)
            .collect();
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    }

    pub fn assistant_text_messages(&self) -> Vec<&str> {
        let mut texts = Vec::new();
        for turn in [
            self.current_diff_task_turn.as_ref(),
            self.current_assistant_turn.as_ref(),
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
                    .filter_map(TaskContent::text),
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
                    .filter_map(TaskContent::text),
            );
        }
        texts
    }

    pub fn assistant_error_message(&self) -> Option<String> {
        let error = self.current_assistant_turn.as_ref()?.error.as_ref()?;
        let parts: Vec<_> = [error.code.as_deref(), error.message.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(": "))
    }
}

impl BackendClient<'_> {
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
        self.get(url, &[], cancellation)
    }

    pub fn read_task(
        &self,
        task_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<TaskDetails, RequestError> {
        self.get(self.endpoint(&["tasks", task_id])?, &[], cancellation)
    }

    pub fn list_sibling_turns(
        &self,
        task_id: &str,
        turn_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<SiblingTurns, RequestError> {
        self.get(
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
        #[derive(Deserialize)]
        struct TaskId {
            id: String,
        }
        #[derive(Deserialize)]
        struct Created {
            task: Option<TaskId>,
            id: Option<String>,
        }
        let created: Created = self.post(self.endpoint(&["tasks"])?, body, cancellation)?;
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
