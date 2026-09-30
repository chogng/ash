//! ChatGPT cloud-task HTTP contracts. Opaque metadata stays as JSON.

use serde::Deserialize;
use serde_json::Value;

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
pub struct TaskDetailsResponse {
    pub task: TaskMetadata,
    pub task_status_display: Option<serde_json::Map<String, Value>>,
    pub current_user_turn: Option<TaskTurn>,
    pub current_assistant_turn: Option<TaskTurn>,
    pub current_diff_task_turn: Option<TaskTurn>,
}

/// Task identity and metadata returned by the task-details endpoint.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskMetadata {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
    pub environment_id: Option<String>,
    pub is_review: Option<bool>,
    pub has_generated_title: Option<bool>,
    pub current_turn_id: Option<String>,
    pub has_unread_turn: Option<bool>,
    pub denormalized_metadata: Option<serde_json::Map<String, Value>>,
    pub task_status_display: Option<serde_json::Map<String, Value>>,
    pub external_pull_requests: Vec<TaskPullRequest>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskTurn {
    pub id: Option<String>,
    pub created_at: Option<f64>,
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

#[derive(Deserialize)]
pub struct TaskId {
    pub id: String,
}

#[derive(Deserialize)]
pub struct CreatedTaskResponse {
    pub task: Option<TaskId>,
    pub id: Option<String>,
}
