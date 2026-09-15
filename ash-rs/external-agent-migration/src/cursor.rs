use crate::AgentImportDiagnosticCode as Code;
use crate::ExternalInstruction;
use crate::ExternalInstructionKind;
use crate::ExternalInstructionLoad;
use crate::ImportScope;
use crate::MigrationPlanItem;
use crate::instruction;
use crate::instruction::read;
use crate::instruction::reject_references;
use crate::instruction::rules;
use crate::instruction::split_patterns;
use crate::source::Source;
use std::path::Path;

pub(crate) fn detect(source: &mut Source) -> Vec<MigrationPlanItem> {
    let mut items = Vec::new();
    if source.location.scope() == ImportScope::Project {
        items.extend(read(
            source,
            Path::new(".cursorrules"),
            ExternalInstructionKind::Root,
            parse_root,
        ));
        rules(
            source,
            Path::new(".cursor/rules"),
            Path::new(".cursor/rules"),
            "cursor",
            "mdc",
            parse_rule,
            &mut items,
        );
    }
    items
}

fn parse_root(text: &str) -> Result<ExternalInstruction, Code> {
    let mut document = instruction::plain(text)?;
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
struct Header {
    description: Option<String>,
    globs: Option<Globs>,
    #[serde(default)]
    always_apply: bool,
}

fn parse_rule(text: &str) -> Result<ExternalInstruction, Code> {
    if !text.starts_with("---") {
        return Err(Code::InvalidContent);
    }
    let (header, body) = crate::frontmatter::instruction_header(text)?;
    let header: Header = serde_yaml::from_value(header).map_err(|_| Code::InvalidContent)?;
    let patterns = match header.globs {
        Some(Globs::Text(text)) if !text.trim().is_empty() => split_patterns(&text)?,
        Some(Globs::List(patterns)) => patterns,
        _ => Vec::new(),
    };
    if patterns.iter().any(|pattern| pattern.trim().is_empty()) || body.trim().is_empty() {
        return Err(Code::InvalidContent);
    }
    let mut document = instruction::plain(text)?;
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
