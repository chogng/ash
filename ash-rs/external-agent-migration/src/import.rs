use std::fmt;
use std::path::{Path, PathBuf};

/// External coding-agent setup whose documented filesystem layout can be discovered.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExternalAgent {
    Codex,
    Claude,
    Copilot,
    Cursor,
}

/// User or project ownership of one external configuration source.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ImportScope {
    User,
    Project,
}

/// One caller-selected root in which a supported external agent may keep configuration.
///
/// User roots are user home directories. Project roots are repository or selected directories.
#[derive(Clone, Eq, PartialEq)]
pub struct AgentImportLocation {
    agent: ExternalAgent,
    scope: ImportScope,
    root: PathBuf,
}

impl AgentImportLocation {
    /// Uses default `.codex/` and `.agents/skills/` locations below one user home directory.
    pub fn codex_user(user_home: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Codex, ImportScope::User, user_home)
    }

    /// Uses documented Codex locations below one project root.
    pub fn codex_project(project_root: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Codex, ImportScope::Project, project_root)
    }

    /// Uses the default `.claude/` location below one user home directory.
    pub fn claude_user(user_home: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Claude, ImportScope::User, user_home)
    }

    /// Uses documented Claude locations below one project root.
    pub fn claude_project(project_root: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Claude, ImportScope::Project, project_root)
    }

    /// Uses Copilot's repository instruction layout below a selected project root.
    pub fn copilot_project(project_root: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Copilot, ImportScope::Project, project_root)
    }

    /// Uses Cursor's project rule layout below a selected project root.
    pub fn cursor_project(project_root: impl Into<PathBuf>) -> Self {
        Self::new(ExternalAgent::Cursor, ImportScope::Project, project_root)
    }

    pub fn agent(&self) -> ExternalAgent {
        self.agent
    }

    pub fn scope(&self) -> ImportScope {
        self.scope
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn new(agent: ExternalAgent, scope: ImportScope, root: impl Into<PathBuf>) -> Self {
        Self {
            agent,
            scope,
            root: root.into(),
        }
    }
}

impl fmt::Debug for AgentImportLocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentImportLocation")
            .field("agent", &self.agent)
            .field("scope", &self.scope)
            .field("root", &"<private>")
            .finish()
    }
}

/// Domain kind represented by one discovered external item.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ImportItemKind {
    Instructions,
    Settings,
    Skills,
    Commands,
    Agents,
    InstructionRules,
    ExecutionRules,
    McpServers,
    Hooks,
    Plugins,
    Memory,
}

/// Additional review boundary required before a candidate can be applied.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ImportReviewCategory {
    Content,
    Configuration,
    Connection,
    ExecutionPolicy,
}

/// One existing, canonicalized file or directory that can be shown in an import preview.
#[derive(Clone, Eq, PartialEq)]
pub struct AgentImportCandidate {
    agent: ExternalAgent,
    scope: ImportScope,
    kind: ImportItemKind,
    review: ImportReviewCategory,
    relative_path: PathBuf,
    source_path: PathBuf,
}

impl AgentImportCandidate {
    pub(crate) fn new(
        location: &AgentImportLocation,
        kind: ImportItemKind,
        review: ImportReviewCategory,
        relative_path: PathBuf,
        source_path: PathBuf,
    ) -> Self {
        Self {
            agent: location.agent,
            scope: location.scope,
            kind,
            review,
            relative_path,
            source_path,
        }
    }

    pub fn agent(&self) -> ExternalAgent {
        self.agent
    }

    pub fn scope(&self) -> ImportScope {
        self.scope
    }

    pub fn kind(&self) -> ImportItemKind {
        self.kind
    }

    pub fn review(&self) -> ImportReviewCategory {
        self.review
    }

    /// Returns the non-secret path relative to the caller-selected root.
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    /// Returns the canonical host path for a trusted host adapter to inspect or apply.
    pub fn source_path(&self) -> &Path {
        &self.source_path
    }
}

impl fmt::Debug for AgentImportCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentImportCandidate")
            .field("agent", &self.agent)
            .field("scope", &self.scope)
            .field("kind", &self.kind)
            .field("review", &self.review)
            .field("relative_path", &self.relative_path)
            .field("source_path", &"<private>")
            .finish()
    }
}

/// Non-fatal reason why an existing known path was excluded from an inspection.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum AgentImportDiagnosticCode {
    MetadataUnavailable,
    UnexpectedFileType,
    SymlinkNotAllowed,
    EscapesSelectedRoot,
    InvalidContent,
    LimitExceeded,
}

/// Safe diagnostic for one known path excluded during discovery.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct AgentImportDiagnostic {
    agent: ExternalAgent,
    scope: ImportScope,
    kind: ImportItemKind,
    relative_path: PathBuf,
    code: AgentImportDiagnosticCode,
}

impl AgentImportDiagnostic {
    pub(crate) fn new(
        location: &AgentImportLocation,
        kind: ImportItemKind,
        relative_path: PathBuf,
        code: AgentImportDiagnosticCode,
    ) -> Self {
        Self {
            agent: location.agent,
            scope: location.scope,
            kind,
            relative_path,
            code,
        }
    }

    pub fn agent(&self) -> ExternalAgent {
        self.agent
    }

    pub fn scope(&self) -> ImportScope {
        self.scope
    }

    pub fn kind(&self) -> ImportItemKind {
        self.kind
    }

    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    pub fn code(&self) -> AgentImportDiagnosticCode {
        self.code
    }
}

/// Deterministically ordered result of inspecting supported external-agent paths.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPathInspection {
    candidates: Vec<AgentImportCandidate>,
    diagnostics: Vec<AgentImportDiagnostic>,
}

impl AgentPathInspection {
    pub(crate) fn new(
        candidates: Vec<AgentImportCandidate>,
        diagnostics: Vec<AgentImportDiagnostic>,
    ) -> Self {
        Self {
            candidates,
            diagnostics,
        }
    }

    pub fn candidates(&self) -> &[AgentImportCandidate] {
        &self.candidates
    }

    pub fn diagnostics(&self) -> &[AgentImportDiagnostic] {
        &self.diagnostics
    }
}
