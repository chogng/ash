use crate::AgentImportDiagnosticCode as Code;
use crate::AgentImportError;
use crate::AgentImportLocation;
use crate::ExternalAgent;
use crate::ImportItemKind;
use crate::MigrationItemDetail;
use crate::MigrationPlan;
use crate::MigrationPlanItem;
use crate::agent_paths::ExpectedEntryKind;
use crate::source::Source;
use std::path::Path;

/// Source loading semantics shared by all supported instruction formats.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExternalInstructionLoad {
    Always,
    Files { patterns: Vec<String> },
    Selected,
}

/// A bounded source document; Debug intentionally omits its contents.
#[derive(Clone, Eq, PartialEq)]
pub struct ExternalInstruction {
    pub kind: ExternalInstructionKind,
    pub unsupported: Option<String>,
    pub description: Option<String>,
    pub load: ExternalInstructionLoad,
    pub body: String,
    /// Exact source bytes used by the host to bind preview and apply.
    pub source: String,
}

impl std::fmt::Debug for ExternalInstruction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ExternalInstruction(<redacted>)")
    }
}

/// Distinguishes a root instruction file from independently named rules.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExternalInstructionKind {
    Root,
    Rule { name: String },
}

/// Discovers only instructions, without reading settings, MCP definitions, hooks or credentials.
pub fn detect_instruction_plan(
    location: AgentImportLocation,
) -> Result<MigrationPlan, AgentImportError> {
    let mut source = Source::new(location)?;
    let mut items = detect(&mut source);
    items.sort_by(|left, right| left.source_paths().cmp(right.source_paths()));
    Ok(MigrationPlan::new(items, source.diagnostics))
}

pub(crate) fn detect(source: &mut Source) -> Vec<MigrationPlanItem> {
    match source.location.agent() {
        ExternalAgent::Copilot => crate::copilot::detect(source),
        ExternalAgent::Codex => crate::codex::detect(source),
        ExternalAgent::Claude => crate::claude::detect(source),
        ExternalAgent::Cursor => crate::cursor::detect(source),
    }
}

pub(crate) fn read(
    source: &mut Source,
    path: &Path,
    kind: ExternalInstructionKind,
    parse: fn(&str) -> Result<ExternalInstruction, Code>,
) -> Option<MigrationPlanItem> {
    let item_kind = match kind {
        ExternalInstructionKind::Root => ImportItemKind::Instructions,
        ExternalInstructionKind::Rule { .. } => ImportItemKind::InstructionRules,
    };
    let mut document = source.read(path, item_kind, parse)?;
    document.value.kind = kind;
    Some(MigrationPlanItem::new(
        source.location.agent(),
        source.location.scope(),
        item_kind,
        vec![document.path],
        MigrationItemDetail::Instruction {
            document: document.value,
        },
    ))
}

pub(crate) fn rules(
    source: &mut Source,
    root: &Path,
    directory: &Path,
    prefix: &str,
    extension: &str,
    parse: fn(&str) -> Result<ExternalInstruction, Code>,
    items: &mut Vec<MigrationPlanItem>,
) {
    let Some(entries) = source.directory(directory, ImportItemKind::InstructionRules) else {
        return;
    };
    for entry in entries.entries {
        if entry.kind == ExpectedEntryKind::Directory {
            rules(
                source,
                root,
                &entry.relative_path,
                prefix,
                extension,
                parse,
                items,
            );
        } else if entry
            .relative_path
            .extension()
            .and_then(|value| value.to_str())
            == Some(extension)
        {
            let name = entry
                .relative_path
                .strip_prefix(root)
                .expect("descendant rule")
                .with_extension("")
                .to_string_lossy()
                .replace(['/', '\\'], "-");
            items.extend(read(
                source,
                &entry.relative_path,
                ExternalInstructionKind::Rule {
                    name: format!("{prefix}-{name}"),
                },
                parse,
            ));
        }
    }
}

pub(crate) fn plain(text: &str) -> Result<ExternalInstruction, Code> {
    if text.trim().is_empty() {
        return Err(Code::InvalidContent);
    }
    Ok(ExternalInstruction {
        kind: ExternalInstructionKind::Root,
        unsupported: None,
        description: None,
        load: ExternalInstructionLoad::Always,
        body: text.into(),
        source: text.into(),
    })
}

pub(crate) fn reject_references(document: &mut ExternalInstruction) {
    // External @ imports have activation semantics; copying their spelling would silently lose them.
    // Do not follow arbitrary files or turn them into ordinary Markdown links.
    let mut in_code = false;
    for event in pulldown_cmark::Parser::new(&document.body) {
        match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::CodeBlock(_)) => in_code = true,
            pulldown_cmark::Event::End(pulldown_cmark::TagEnd::CodeBlock) => in_code = false,
            pulldown_cmark::Event::Text(text)
                if !in_code
                    && text.split_whitespace().any(|word| {
                        word.trim_start_matches(['(', '[', '\"', '\''])
                            .starts_with('@')
                    }) =>
            {
                document.unsupported = Some("Source-specific @ references require explicit conversion; their activation cannot be preserved by copying the text.".into());
                break;
            }
            _ => {}
        }
    }
}

// Commas inside brace alternatives or character classes belong to the glob, not the list.
pub(crate) fn split_patterns(value: &str) -> Result<Vec<String>, Code> {
    let mut depth = 0usize;
    let mut start = 0;
    let mut patterns = Vec::new();
    for (index, ch) in value.char_indices() {
        match ch {
            '{' | '[' => depth += 1,
            '}' | ']' => depth = depth.checked_sub(1).ok_or(Code::InvalidContent)?,
            ',' if depth == 0 => {
                patterns.push(value[start..index].trim().to_owned());
                start = index + 1;
            }
            '\\' => return Err(Code::InvalidContent),
            _ => {}
        }
    }
    patterns.push(value[start..].trim().to_owned());
    if depth != 0 || patterns.iter().any(String::is_empty) {
        return Err(Code::InvalidContent);
    }
    Ok(patterns)
}

#[cfg(test)]
#[path = "instruction_tests.rs"]
mod tests;
