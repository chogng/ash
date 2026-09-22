use std::path::PathBuf;
use std::sync::Arc;

/// Product entry points allowed to launch a packaged role.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleLaunch {
    #[default]
    Any,
    Workflow,
    Delegation,
}

/// Origin of one validated Agent role.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AgentRoleSource {
    BuiltIn,
    Directory { id: String },
}

/// One validated Agent execution role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRole {
    launch: RoleLaunch,
    callers: Vec<String>,
    delegates: Option<Vec<String>>,
    name: String,
    description: String,
    source: AgentRoleSource,
    version: Option<u64>,
    content_digest: String,
    relative_path: PathBuf,
    model: Option<String>,
    tools: Option<Vec<String>>,
    disallowed_tools: Vec<String>,
    required_tools: Vec<String>,
    delegation_tools: Option<Vec<String>>,
    disallowed_delegation_tools: Vec<String>,
    required_delegation_tools: Vec<String>,
    skills: Option<Vec<String>>,
    required_skills: Vec<String>,
    instructions: Vec<String>,
    role_instructions: String,
}

pub(crate) struct AgentRoleFields {
    pub(crate) launch: RoleLaunch,
    pub(crate) callers: Vec<String>,
    pub(crate) delegates: Option<Vec<String>>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) source: AgentRoleSource,
    pub(crate) version: Option<u64>,
    pub(crate) content_digest: String,
    pub(crate) relative_path: PathBuf,
    pub(crate) model: Option<String>,
    pub(crate) tools: Option<Vec<String>>,
    pub(crate) disallowed_tools: Vec<String>,
    pub(crate) required_tools: Vec<String>,
    pub(crate) delegation_tools: Option<Vec<String>>,
    pub(crate) disallowed_delegation_tools: Vec<String>,
    pub(crate) required_delegation_tools: Vec<String>,
    pub(crate) skills: Option<Vec<String>>,
    pub(crate) required_skills: Vec<String>,
    pub(crate) instructions: Vec<String>,
    pub(crate) role_instructions: String,
}

impl AgentRole {
    pub(crate) fn new(fields: AgentRoleFields) -> Self {
        Self {
            launch: fields.launch,
            callers: fields.callers,
            delegates: fields.delegates,
            name: fields.name,
            description: fields.description,
            source: fields.source,
            version: fields.version,
            content_digest: fields.content_digest,
            relative_path: fields.relative_path,
            model: fields.model,
            tools: fields.tools,
            disallowed_tools: fields.disallowed_tools,
            required_tools: fields.required_tools,
            delegation_tools: fields.delegation_tools,
            disallowed_delegation_tools: fields.disallowed_delegation_tools,
            required_delegation_tools: fields.required_delegation_tools,
            skills: fields.skills,
            required_skills: fields.required_skills,
            instructions: fields.instructions,
            role_instructions: fields.role_instructions,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn launch(&self) -> RoleLaunch {
        self.launch
    }

    pub fn callers(&self) -> &[String] {
        &self.callers
    }

    pub fn delegates(&self) -> Option<&[String]> {
        self.delegates.as_deref()
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn source(&self) -> &AgentRoleSource {
        &self.source
    }

    pub fn version(&self) -> Option<u64> {
        self.version
    }

    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    pub fn relative_path(&self) -> &std::path::Path {
        &self.relative_path
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn tools(&self) -> Option<&[String]> {
        self.tools.as_deref()
    }

    pub fn disallowed_tools(&self) -> &[String] {
        &self.disallowed_tools
    }

    pub fn required_tools(&self) -> &[String] {
        &self.required_tools
    }

    pub fn delegation_tools(&self) -> Option<&[String]> {
        self.delegation_tools.as_deref()
    }

    pub fn disallowed_delegation_tools(&self) -> &[String] {
        &self.disallowed_delegation_tools
    }

    pub fn required_delegation_tools(&self) -> &[String] {
        &self.required_delegation_tools
    }

    pub fn skills(&self) -> Option<&[String]> {
        self.skills.as_deref()
    }

    pub fn required_skills(&self) -> &[String] {
        &self.required_skills
    }

    pub fn instructions(&self) -> &[String] {
        &self.instructions
    }

    pub fn role_instructions(&self) -> &str {
        &self.role_instructions
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum AgentRoleDiagnosticCode {
    SourceUnavailable,
    EntryLimitExceeded,
    UnsupportedFileType,
    SymlinkNotAllowed,
    InvalidName,
    InvalidFrontmatter,
    DescriptionInvalid,
    InvalidReference,
    ContentTooLarge,
    ContentInvalidUtf8,
    EmptyBody,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRoleDiagnostic {
    relative_path: Option<PathBuf>,
    code: AgentRoleDiagnosticCode,
    message: String,
}

impl AgentRoleDiagnostic {
    pub(crate) fn new(
        relative_path: Option<PathBuf>,
        code: AgentRoleDiagnosticCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            relative_path,
            code,
            message: message.into(),
        }
    }

    pub fn relative_path(&self) -> Option<&std::path::Path> {
        self.relative_path.as_deref()
    }

    pub fn code(&self) -> AgentRoleDiagnosticCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AgentRoleCatalogSnapshot {
    generation: u64,
    entries: Arc<[AgentRole]>,
    diagnostics: Arc<[AgentRoleDiagnostic]>,
}

impl AgentRoleCatalogSnapshot {
    pub(crate) fn new(
        generation: u64,
        entries: Vec<AgentRole>,
        diagnostics: Vec<AgentRoleDiagnostic>,
    ) -> Self {
        Self {
            generation,
            entries: entries.into(),
            diagnostics: diagnostics.into(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn entries(&self) -> &[AgentRole] {
        &self.entries
    }

    pub fn diagnostics(&self) -> &[AgentRoleDiagnostic] {
        &self.diagnostics
    }
}
