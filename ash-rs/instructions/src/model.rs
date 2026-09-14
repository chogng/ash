use globset::Glob;
use std::path::PathBuf;
use std::sync::Arc;

/// Canonical policy controlling when one Instruction contributes model-facing content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstructionLoadPolicy {
    Global,
    Contextual { patterns: Vec<String> },
    OnDemand,
}

/// One validated Ash Instruction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstructionArtifact {
    name: String,
    relative_path: PathBuf,
    load_policy: InstructionLoadPolicy,
    body: String,
}

impl InstructionArtifact {
    pub(crate) fn new(
        name: String,
        relative_path: PathBuf,
        load_policy: InstructionLoadPolicy,
        body: String,
    ) -> Self {
        Self {
            name,
            relative_path,
            load_policy,
            body,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn relative_path(&self) -> &std::path::Path {
        &self.relative_path
    }

    pub fn load_policy(&self) -> &InstructionLoadPolicy {
        &self.load_policy
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn render(&self) -> String {
        format!(
            "<instruction name=\"{}\" source=\"{}\">\n{}\n</instruction>",
            self.name,
            self.relative_path.display(),
            self.body
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum InstructionDiagnosticCode {
    SourceUnavailable,
    EntryLimitExceeded,
    UnsupportedFileType,
    SymlinkNotAllowed,
    InvalidName,
    InvalidFrontmatter,
    InvalidLoadPolicy,
    ContentTooLarge,
    ContentInvalidUtf8,
    EmptyBody,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstructionDiagnostic {
    relative_path: Option<PathBuf>,
    code: InstructionDiagnosticCode,
    message: String,
}

impl InstructionDiagnostic {
    pub(crate) fn new(
        relative_path: Option<PathBuf>,
        code: InstructionDiagnosticCode,
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

    pub fn code(&self) -> InstructionDiagnosticCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InstructionCatalogSnapshot {
    generation: u64,
    always_on: Arc<[AlwaysOnInstruction]>,
    entries: Arc<[InstructionArtifact]>,
    diagnostics: Arc<[InstructionDiagnostic]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AlwaysOnInstruction {
    pub(crate) source: PathBuf,
    pub(crate) body: String,
}

impl AlwaysOnInstruction {
    pub(crate) fn render(&self) -> String {
        let source = self.source.display().to_string();
        let source = source
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;");
        format!(
            "<instruction name=\"{}\" source=\"{}\">\n{}\n</instruction>",
            self.source
                .file_name()
                .expect("always-on source has a filename")
                .to_string_lossy(),
            source,
            self.body
        )
    }
}

impl InstructionCatalogSnapshot {
    pub(crate) fn new(
        generation: u64,
        always_on: Vec<AlwaysOnInstruction>,
        entries: Vec<InstructionArtifact>,
        diagnostics: Vec<InstructionDiagnostic>,
    ) -> Self {
        Self {
            generation,
            always_on: always_on.into(),
            entries: entries.into(),
            diagnostics: diagnostics.into(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn entries(&self) -> &[InstructionArtifact] {
        &self.entries
    }

    pub(crate) fn always_on(&self) -> &[AlwaysOnInstruction] {
        &self.always_on
    }

    pub fn diagnostics(&self) -> &[InstructionDiagnostic] {
        &self.diagnostics
    }

    /// Renders all Global Instructions in deterministic catalog order.
    pub fn global_content(&self) -> Option<String> {
        self.render_content(|entry| matches!(entry.load_policy(), InstructionLoadPolicy::Global))
    }

    /// Renders Global and file-matched Contextual Instructions for one invocation.
    pub fn automatic_content(&self, paths: &[PathBuf]) -> Option<String> {
        self.render_content(|entry| match entry.load_policy() {
            InstructionLoadPolicy::Global => true,
            InstructionLoadPolicy::Contextual { patterns } => patterns.iter().any(|pattern| {
                let matcher = Glob::new(pattern)
                    .expect("catalog validation accepts only valid patterns")
                    .compile_matcher();
                paths.iter().any(|path| matcher.is_match(path))
            }),
            InstructionLoadPolicy::OnDemand => false,
        })
    }

    fn render_content(&self, include: impl Fn(&InstructionArtifact) -> bool) -> Option<String> {
        let mut sections = self
            .always_on
            .iter()
            .map(AlwaysOnInstruction::render)
            .collect::<Vec<_>>();
        sections.extend(
            self.entries
                .iter()
                .filter(|entry| include(entry))
                .map(InstructionArtifact::render)
                .collect::<Vec<_>>(),
        );
        let content = sections.join("\n\n");
        (!content.is_empty()).then_some(content)
    }
}
