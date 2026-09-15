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

use crate::AgentImportDiagnosticCode as Code;
use crate::AgentImportError;
use crate::AgentImportLocation;
use crate::ExternalAgent;
use crate::ImportItemKind;
use crate::ImportScope;
use crate::MigrationItemDetail;
use crate::MigrationPlan;
use crate::MigrationPlanItem;
use crate::agent_paths::ExpectedEntryKind;
use crate::source::Source;
use std::path::Path;
use std::path::PathBuf;

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
    let mut items = Vec::new();
    match source.location.agent() {
        ExternalAgent::Copilot => return crate::copilot::detect(source),
        ExternalAgent::Codex => {
            let prefix = if source.location.scope() == ImportScope::User {
                ".codex/"
            } else {
                ""
            };
            let override_path = PathBuf::from(format!("{prefix}AGENTS.override.md"));
            let ordinary = PathBuf::from(format!("{prefix}AGENTS.md"));
            let diagnostics_before = source.diagnostics.len();
            let candidate = source.read(&override_path, ImportItemKind::Instructions, |text| {
                Ok(text.to_owned())
            });
            if let Some(candidate) =
                candidate.filter(|candidate| !candidate.value.trim().is_empty())
            {
                let mut item = MigrationPlanItem::new(
                    source.location.agent(),
                    source.location.scope(),
                    ImportItemKind::Instructions,
                    vec![candidate.path],
                    MigrationItemDetail::Instruction {
                        document: plain(&candidate.value).expect("nonempty source"),
                    },
                );
                if source.location.scope() == ImportScope::Project {
                    // Ash already loads AGENTS.md. Appending an override would change its meaning.
                    if source
                        .read(&ordinary, ImportItemKind::Instructions, |text| {
                            Ok(!text.trim().is_empty())
                        })
                        .is_some_and(|document| document.value)
                    {
                        if let MigrationItemDetail::Instruction { document } = &mut item.detail {
                            document.unsupported = Some("Codex overrides AGENTS.md here; Ash keeps that shared file active. Resolve the shared-rule conflict before importing.".into());
                        }
                    }
                }
                items.push(item);
            } else if source.location.scope() == ImportScope::User
                && source.diagnostics.len() == diagnostics_before
            {
                items.extend(read(
                    source,
                    &ordinary,
                    ExternalInstructionKind::Root,
                    plain,
                ));
            }
        }
        ExternalAgent::Claude => {
            if source.location.scope() == ImportScope::User {
                items.extend(read(
                    source,
                    Path::new(".claude/CLAUDE.md"),
                    ExternalInstructionKind::Root,
                    claude_plain,
                ));
            } else {
                items.extend(read(
                    source,
                    Path::new("CLAUDE.md"),
                    ExternalInstructionKind::Root,
                    claude_plain,
                ));
                items.extend(read(
                    source,
                    Path::new(".claude/CLAUDE.md"),
                    ExternalInstructionKind::Rule {
                        name: "claude-project".into(),
                    },
                    claude_plain,
                ));
                if let Some(mut item) = read(
                    source,
                    Path::new("CLAUDE.local.md"),
                    ExternalInstructionKind::Rule {
                        name: "claude-local".into(),
                    },
                    claude_plain,
                ) {
                    if let MigrationItemDetail::Instruction { document } = &mut item.detail {
                        document.unsupported = Some("CLAUDE.local.md contains private project preferences. Choose a private Ash destination before importing; project rules may be committed.".into());
                    }
                    items.push(item);
                }
            }
            rules(
                source,
                Path::new(".claude/rules"),
                Path::new(".claude/rules"),
                "claude",
                "md",
                claude_rule,
                &mut items,
            );
        }
        ExternalAgent::Cursor => {
            if source.location.scope() == ImportScope::Project {
                items.extend(read(
                    source,
                    Path::new(".cursorrules"),
                    ExternalInstructionKind::Root,
                    cursor_plain,
                ));
                rules(
                    source,
                    Path::new(".cursor/rules"),
                    Path::new(".cursor/rules"),
                    "cursor",
                    "mdc",
                    cursor_rule,
                    &mut items,
                );
            }
        }
    }
    items
}

fn read(
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

fn rules(
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

fn plain(text: &str) -> Result<ExternalInstruction, Code> {
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

fn claude_plain(text: &str) -> Result<ExternalInstruction, Code> {
    let mut document = plain(text)?;
    reject_references(&mut document);
    Ok(document)
}

fn cursor_plain(text: &str) -> Result<ExternalInstruction, Code> {
    claude_plain(text)
}

fn reject_references(document: &mut ExternalInstruction) {
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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeHeader {
    paths: Option<Vec<String>>,
}

fn claude_rule(text: &str) -> Result<ExternalInstruction, Code> {
    let (header, body) = crate::frontmatter::instruction_header(text)?;
    let header: ClaudeHeader = serde_yaml::from_value(header).map_err(|_| Code::InvalidContent)?;
    let load = match header.paths {
        Some(patterns)
            if !patterns.is_empty()
                && patterns.iter().all(|pattern| !pattern.trim().is_empty()) =>
        {
            ExternalInstructionLoad::Files { patterns }
        }
        Some(_) => return Err(Code::InvalidContent),
        None => ExternalInstructionLoad::Always,
    };
    let mut document = plain(text)?;
    if body.trim().is_empty() {
        return Err(Code::InvalidContent);
    }
    document.body = body;
    document.load = load;
    reject_references(&mut document);
    Ok(document)
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Globs {
    Text(String),
    List(Vec<String>),
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CursorHeader {
    description: Option<String>,
    globs: Option<Globs>,
    #[serde(default)]
    always_apply: bool,
}

fn cursor_rule(text: &str) -> Result<ExternalInstruction, Code> {
    if !text.starts_with("---") {
        return Err(Code::InvalidContent);
    }
    let (header, body) = crate::frontmatter::instruction_header(text)?;
    let header: CursorHeader = serde_yaml::from_value(header).map_err(|_| Code::InvalidContent)?;
    let patterns = match header.globs {
        Some(Globs::Text(text)) if !text.trim().is_empty() => split_patterns(&text)?,
        Some(Globs::List(patterns)) => patterns,
        _ => Vec::new(),
    };
    if patterns.iter().any(|pattern| pattern.trim().is_empty()) || body.trim().is_empty() {
        return Err(Code::InvalidContent);
    }
    let mut document = plain(text)?;
    document.description = header.description.filter(|value| !value.trim().is_empty());
    document.body = body;
    document.load = if header.always_apply {
        ExternalInstructionLoad::Always
    } else if !patterns.is_empty() {
        ExternalInstructionLoad::Files { patterns }
    } else {
        ExternalInstructionLoad::Selected
    };
    reject_references(&mut document);
    Ok(document)
}

#[cfg(test)]
#[path = "instruction_tests.rs"]
mod tests;
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
