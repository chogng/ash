use crate::AgentImportDiagnostic;
use crate::AgentImportError;
use crate::AgentImportLocation;
use crate::ExternalAgent;
use crate::ImportItemKind;
use crate::detect::claude_instruction_candidates;
use crate::source::Source;
use std::path::Path;
use std::path::PathBuf;

/// Exact, bounded Claude instruction text selected from a known source path.
pub struct ExternalInstruction {
    relative_path: PathBuf,
    content: String,
}

impl ExternalInstruction {
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    pub fn content(&self) -> &str {
        &self.content
    }
}

/// One checked read, including diagnostics for excluded sources.
pub struct ClaudeInstructionRead {
    selected: Option<ExternalInstruction>,
    diagnostics: Vec<AgentImportDiagnostic>,
}

impl ClaudeInstructionRead {
    pub fn selected(&self) -> Option<&ExternalInstruction> {
        self.selected.as_ref()
    }

    pub fn diagnostics(&self) -> &[AgentImportDiagnostic] {
        &self.diagnostics
    }
}

/// Reads Claude's first nonempty instruction file without invoking an Agent or writing a target.
pub fn read_claude_instructions(
    location: AgentImportLocation,
) -> Result<ClaudeInstructionRead, AgentImportError> {
    if location.agent() != ExternalAgent::Claude {
        return Err(AgentImportError::UnsupportedInstructionAgent {
            agent: location.agent(),
        });
    }
    let mut source = Source::new(location)?;
    let mut selected = None;
    for relative_path in claude_instruction_candidates(source.location.scope()) {
        if let Some(document) =
            source.read(&relative_path, ImportItemKind::Instructions, |content| {
                Ok(content.to_owned())
            })
            && !document.value.trim().is_empty()
        {
            selected = Some(ExternalInstruction {
                relative_path,
                content: document.value,
            });
            break;
        }
    }
    Ok(ClaudeInstructionRead {
        selected,
        diagnostics: source.diagnostics,
    })
}

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
