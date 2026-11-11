//! Structured Agent questions and user answers that resolve a pending Turn interaction.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestUserInput {
    pub questions: Vec<UserInputQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub plan_review: Option<PlanReview>,
}

/// Displays a proposed plan alongside the existing user-input decision.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanReview {
    pub markdown: String,
    pub decision_question_id: String,
    pub approve_value: String,
    pub revise_value: String,
    pub feedback_question_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    /// Older pending questions omit this field and retain their required-answer behavior.
    #[serde(default = "default_required")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<UserInputOption>,
    #[serde(default)]
    pub allow_free_form: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub validation: Option<UserInputValidation>,
}

/// Bounds use decimal strings so integer limits survive JavaScript transport exactly.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInputValidation {
    String {
        min: Option<String>,
        max: Option<String>,
    },
    Number {
        min: Option<String>,
        max: Option<String>,
    },
    Integer {
        min: Option<String>,
        max: Option<String>,
    },
}

const fn default_required() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestUserInputResponse {
    pub answers: BTreeMap<String, UserInputAnswer>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    pub value: String,
}
