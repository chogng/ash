use crate::import::{ExternalAgent, ImportItemKind, ImportReviewCategory, ImportScope};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ExpectedEntryKind {
    File,
    Directory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct AgentPath {
    pub relative_path: &'static str,
    pub kind: ImportItemKind,
    pub review: ImportReviewCategory,
    pub expected: ExpectedEntryKind,
}

const CODEX_USER: &[AgentPath] = &[
    file(
        ".codex/AGENTS.override.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".codex/AGENTS.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".codex/config.toml",
        ImportItemKind::Settings,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".agents/skills",
        ImportItemKind::Skills,
        ImportReviewCategory::Content,
    ),
    directory(
        ".codex/agents",
        ImportItemKind::Agents,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".codex/rules",
        ImportItemKind::ExecutionRules,
        ImportReviewCategory::ExecutionPolicy,
    ),
];

const CODEX_PROJECT: &[AgentPath] = &[
    file(
        "AGENTS.override.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        "AGENTS.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".codex/config.toml",
        ImportItemKind::Settings,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".agents/skills",
        ImportItemKind::Skills,
        ImportReviewCategory::Content,
    ),
    directory(
        ".codex/agents",
        ImportItemKind::Agents,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".codex/rules",
        ImportItemKind::ExecutionRules,
        ImportReviewCategory::ExecutionPolicy,
    ),
];

const CLAUDE_USER: &[AgentPath] = &[
    file(
        ".claude/CLAUDE.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".claude/settings.json",
        ImportItemKind::Settings,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".claude/skills",
        ImportItemKind::Skills,
        ImportReviewCategory::Content,
    ),
    directory(
        ".claude/agents",
        ImportItemKind::Agents,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".claude/rules",
        ImportItemKind::InstructionRules,
        ImportReviewCategory::Content,
    ),
];

const CLAUDE_PROJECT: &[AgentPath] = &[
    file(
        "CLAUDE.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        "CLAUDE.local.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".claude/CLAUDE.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    file(
        ".claude/settings.json",
        ImportItemKind::Settings,
        ImportReviewCategory::Configuration,
    ),
    file(
        ".claude/settings.local.json",
        ImportItemKind::Settings,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".claude/skills",
        ImportItemKind::Skills,
        ImportReviewCategory::Content,
    ),
    directory(
        ".claude/agents",
        ImportItemKind::Agents,
        ImportReviewCategory::Configuration,
    ),
    directory(
        ".claude/rules",
        ImportItemKind::InstructionRules,
        ImportReviewCategory::Content,
    ),
    file(
        ".mcp.json",
        ImportItemKind::McpServers,
        ImportReviewCategory::Connection,
    ),
];

const COPILOT_PROJECT: &[AgentPath] = &[
    file(
        ".github/copilot-instructions.md",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    directory(
        ".github/instructions",
        ImportItemKind::InstructionRules,
        ImportReviewCategory::Content,
    ),
];

const CURSOR_PROJECT: &[AgentPath] = &[
    file(
        ".cursorrules",
        ImportItemKind::Instructions,
        ImportReviewCategory::Content,
    ),
    directory(
        ".cursor/rules",
        ImportItemKind::InstructionRules,
        ImportReviewCategory::Content,
    ),
];

pub(super) fn paths_for(agent: ExternalAgent, scope: ImportScope) -> &'static [AgentPath] {
    match (agent, scope) {
        (ExternalAgent::Codex, ImportScope::User) => CODEX_USER,
        (ExternalAgent::Codex, ImportScope::Project) => CODEX_PROJECT,
        (ExternalAgent::Claude, ImportScope::User) => CLAUDE_USER,
        (ExternalAgent::Claude, ImportScope::Project) => CLAUDE_PROJECT,
        (ExternalAgent::Copilot, ImportScope::Project) => COPILOT_PROJECT,
        (ExternalAgent::Copilot, ImportScope::User) => &[],
        (ExternalAgent::Cursor, ImportScope::Project) => CURSOR_PROJECT,
        (ExternalAgent::Cursor, ImportScope::User) => &[],
    }
}

const fn file(
    relative_path: &'static str,
    kind: ImportItemKind,
    review: ImportReviewCategory,
) -> AgentPath {
    AgentPath {
        relative_path,
        kind,
        review,
        expected: ExpectedEntryKind::File,
    }
}

const fn directory(
    relative_path: &'static str,
    kind: ImportItemKind,
    review: ImportReviewCategory,
) -> AgentPath {
    AgentPath {
        relative_path,
        kind,
        review,
        expected: ExpectedEntryKind::Directory,
    }
}
