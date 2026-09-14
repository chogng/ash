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
    description: Option<String>,
    body: String,
}

impl InstructionArtifact {
    pub(crate) fn new(
        name: String,
        relative_path: PathBuf,
        load_policy: InstructionLoadPolicy,
        description: Option<String>,
        body: String,
    ) -> Self {
        Self {
            name,
            relative_path,
            load_policy,
            description,
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

    pub(crate) fn applies_to(&self, paths: &[PathBuf]) -> bool {
        match self.load_policy() {
            InstructionLoadPolicy::Global => true,
            InstructionLoadPolicy::Contextual { patterns } => patterns.iter().any(|pattern| {
                let matcher = Glob::new(pattern)
                    .expect("validated glob")
                    .compile_matcher();
                paths.iter().any(|path| matcher.is_match(path))
            }),
            InstructionLoadPolicy::OnDemand => false,
        }
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn body(&self) -> &str {
        &self.body
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

    /// Enumerates always-on file provenance and bodies within this scope.
    pub fn always_on_files(&self) -> impl Iterator<Item = (&std::path::Path, &str)> {
        self.always_on
            .iter()
            .map(|entry| (entry.source.as_path(), entry.body.as_str()))
    }

    /// Reads only a file present in this validated catalog, using its exact source path.
    pub fn body_at(
        &self,
        path: &std::path::Path,
        root: &std::path::Path,
        source_root: &std::path::Path,
    ) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| source_root.join(entry.relative_path()) == path)
            .map(InstructionArtifact::body)
            .or_else(|| {
                self.always_on_files()
                    .find(|(relative, _)| root.join(relative) == path)
                    .map(|(_, body)| body)
            })
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
        self.render_content(|entry| entry.applies_to(paths))
    }

    /// Includes selected bodies and metadata for rules the agent can read when relevant.
    /// Selected paths are authorized file mentions or successful reads, scoped to this Turn.
    pub fn context_content(
        &self,
        paths: &[PathBuf],
        selected: &[PathBuf],
        source_root: &std::path::Path,
    ) -> Option<String> {
        let selected_entry = |entry: &InstructionArtifact| {
            selected.contains(&source_root.join(entry.relative_path()))
        };
        let active = |entry: &InstructionArtifact| selected_entry(entry) || entry.applies_to(paths);
        let mut sections = self.render_content(active).into_iter().collect::<Vec<_>>();
        let references = self.entries.iter().filter(|entry| !active(entry)).map(|entry| {
            let policy = match entry.load_policy() {
                InstructionLoadPolicy::Global => "global".to_owned(),
                InstructionLoadPolicy::Contextual { patterns } => format!("contextual: {}", patterns.join(", ")),
                InstructionLoadPolicy::OnDemand => "on-demand".to_owned(),
            };
            format!("<instruction-reference name=\"{}\" path=\"{}\" load=\"{}\" description=\"{}\" />",
                escape_xml(entry.name()), escape_xml(&source_root.join(entry.relative_path()).display().to_string()),
                escape_xml(&policy), escape_xml(entry.description().unwrap_or_default()))
        }).collect::<Vec<_>>();
        if !references.is_empty() {
            sections.push(format!("<available-instructions>\nUse read_instruction to read the referenced instruction file when its description applies to the task or its patterns match a file you will create or change. The body is not loaded until selected or read. Selection lasts for this Turn.\n{}\n</available-instructions>", references.join("\n")));
        }
        if !self.diagnostics.is_empty() {
            sections.push(format!(
                "<instruction-diagnostics>\n{}\n</instruction-diagnostics>",
                self.diagnostics
                    .iter()
                    .map(|diagnostic| {
                        format!(
                            "{}: {}",
                            escape_xml(
                                &diagnostic
                                    .relative_path()
                                    .unwrap_or(std::path::Path::new("."))
                                    .display()
                                    .to_string()
                            ),
                            escape_xml(diagnostic.message())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        let content = sections.join("\n\n");
        (!content.is_empty()).then_some(content)
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
                .map(|entry| {
                    format!(
                        "<instruction name=\"{}\" source=\"{}\">\n{}\n</instruction>",
                        entry.name(),
                        entry.relative_path().display(),
                        entry.body()
                    )
                })
                .collect::<Vec<_>>(),
        );
        let content = sections.join("\n\n");
        (!content.is_empty()).then_some(content)
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
