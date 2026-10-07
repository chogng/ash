use prompts::PromptArtifact;
use prompts::RenderedPrompt;
use std::fmt;
use utils_template::TemplateError;
use utils_template::render;

const GOAL_INSTRUCTIONS_TEXT: &str = include_str!("../templates/active_goal.md");
const GOAL_INSTRUCTIONS: PromptArtifact = PromptArtifact::new(
    "goal",
    "thread/active-goal",
    "thread-goal-v3",
    GOAL_INSTRUCTIONS_TEXT,
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GoalBudget {
    Unbounded,
    Limited { token_budget: u64, tokens_used: u64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GoalPromptContext<'a> {
    objective: &'a str,
    budget: GoalBudget,
}

impl<'a> GoalPromptContext<'a> {
    fn new(objective: &'a str, budget: GoalBudget) -> Result<Self, GoalPromptError> {
        if objective.trim().is_empty() {
            return Err(GoalPromptError::EmptyObjective);
        }
        Ok(Self { objective, budget })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum GoalPromptError {
    EmptyObjective,
    Template(TemplateError),
}

impl fmt::Display for GoalPromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyObjective => formatter.write_str("active goal objective must not be empty"),
            Self::Template(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for GoalPromptError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::EmptyObjective => None,
            Self::Template(error) => Some(error),
        }
    }
}

impl From<TemplateError> for GoalPromptError {
    fn from(error: TemplateError) -> Self {
        Self::Template(error)
    }
}

pub(crate) fn render_goal_instructions(
    objective: &str,
    token_budget: Option<u64>,
    tokens_used: u64,
) -> Result<RenderedPrompt, GoalPromptError> {
    let budget = match token_budget {
        Some(token_budget) => GoalBudget::Limited {
            token_budget,
            tokens_used,
        },
        None => GoalBudget::Unbounded,
    };
    let context = GoalPromptContext::new(objective, budget)?;
    let body = render(
        GOAL_INSTRUCTIONS.body(),
        [
            ("budget", budget_text(context.budget)),
            ("objective", escape_xml_text(context.objective)),
        ],
    )?;
    Ok(GOAL_INSTRUCTIONS.render(body))
}

fn budget_text(budget: GoalBudget) -> String {
    match budget {
        GoalBudget::Unbounded => "mode: unbounded".to_string(),
        GoalBudget::Limited {
            token_budget,
            tokens_used,
        } => format!(
            "mode: limited\ntoken budget: {token_budget}\ntokens used: {tokens_used}\ntokens remaining: {}",
            token_budget.saturating_sub(tokens_used)
        ),
    }
}

fn escape_xml_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
#[path = "prompt_tests.rs"]
mod tests;
