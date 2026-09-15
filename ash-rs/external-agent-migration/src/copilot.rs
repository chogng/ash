use crate::AgentImportDiagnosticCode;
use crate::ExternalInstruction;
use crate::ExternalInstructionKind;
use crate::ExternalInstructionLoad;
use crate::ImportItemKind;
use crate::MigrationItemDetail;
use crate::MigrationPlanItem;
use crate::agent_paths::ExpectedEntryKind;
use crate::frontmatter;
use crate::source::Source;
use std::path::Path;

pub(crate) fn detect(source: &mut Source) -> Vec<MigrationPlanItem> {
    let mut paths = vec![(
        std::path::PathBuf::from(".github/copilot-instructions.md"),
        ImportItemKind::Instructions,
    )];
    if let Some(directory) = source.directory(
        Path::new(".github/instructions"),
        ImportItemKind::InstructionRules,
    ) {
        paths.extend(
            directory
                .entries
                .into_iter()
                .filter(|entry| {
                    entry.kind == ExpectedEntryKind::File
                        && entry
                            .relative_path
                            .to_str()
                            .is_some_and(|path| path.ends_with(".instructions.md"))
                })
                .map(|entry| (entry.relative_path, ImportItemKind::InstructionRules)),
        );
    }
    paths
        .into_iter()
        .filter_map(|(path, kind)| {
            let mut document = source.read(&path, kind, |text| parse(text, kind))?;
            if kind == ImportItemKind::InstructionRules {
                document.value.kind = ExternalInstructionKind::Rule {
                    name: format!(
                        "copilot-{}",
                        path.file_name()?
                            .to_str()?
                            .strip_suffix(".instructions.md")?
                    ),
                };
            }
            Some(MigrationPlanItem::new(
                source.location.agent(),
                source.location.scope(),
                kind,
                vec![document.path],
                MigrationItemDetail::Instruction {
                    document: document.value,
                },
            ))
        })
        .collect()
}

fn parse(
    text: &str,
    kind: ImportItemKind,
) -> Result<ExternalInstruction, AgentImportDiagnosticCode> {
    let invalid = AgentImportDiagnosticCode::InvalidContent;
    if text.trim().is_empty() {
        return Err(invalid);
    }
    if kind == ImportItemKind::Instructions {
        return Ok(ExternalInstruction {
            kind: ExternalInstructionKind::Root,
            unsupported: None,
            description: None,
            load: ExternalInstructionLoad::Always,
            body: text.into(),
            source: text.into(),
        });
    }
    let document = frontmatter::parse_frontmatter_document(text);
    if let Some(error) = frontmatter::frontmatter_error(&document) {
        return Err(error);
    }
    // An unterminated header must not become an unrestricted instruction body.
    if text.starts_with("---") && document.body == text {
        return Err(invalid);
    }
    if document.body.trim().is_empty()
        || document
            .frontmatter
            .keys()
            .any(|key| !matches!(key.as_str(), "description" | "applyTo"))
    {
        return Err(invalid);
    }
    let description = match document.frontmatter.get("description") {
        Some(value) => Some(
            value
                .as_scalar()
                .filter(|value| !value.is_empty())
                .ok_or(invalid)?
                .to_owned(),
        ),
        None => None,
    };
    let load = match document.frontmatter.get("applyTo") {
        None => ExternalInstructionLoad::Selected,
        Some(value) => ExternalInstructionLoad::Files {
            patterns: crate::instruction::split_patterns(value.as_scalar().ok_or(invalid)?)?,
        },
    };
    Ok(ExternalInstruction {
        kind: ExternalInstructionKind::Rule {
            name: String::new(),
        },
        unsupported: None,
        description,
        load,
        body: document.body,
        source: text.into(),
    })
}

#[cfg(test)]
#[path = "copilot_tests.rs"]
mod tests;
