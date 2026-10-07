use crate::AgentImportDiagnosticCode as Code;
use crate::ExternalInstruction;
use crate::ExternalInstructionKind;
use crate::ExternalInstructionLoad;
use crate::ImportScope;
use crate::MigrationItemDetail;
use crate::MigrationPlanItem;
use crate::instruction;
use crate::instruction::read;
use crate::instruction::reject_references;
use crate::instruction::rules;
use crate::source::Source;
use std::path::Path;

pub(crate) fn detect(source: &mut Source) -> Vec<MigrationPlanItem> {
    let mut items = Vec::new();
    if source.location.scope() == ImportScope::User {
        items.extend(read(
            source,
            Path::new(".claude/CLAUDE.md"),
            ExternalInstructionKind::Root,
            parse_root,
        ));
    } else {
        items.extend(read(
            source,
            Path::new("CLAUDE.md"),
            ExternalInstructionKind::Root,
            parse_root,
        ));
        items.extend(read(
            source,
            Path::new(".claude/CLAUDE.md"),
            ExternalInstructionKind::Rule {
                name: "claude-project".into(),
            },
            parse_root,
        ));
        if let Some(mut item) = read(
            source,
            Path::new("CLAUDE.local.md"),
            ExternalInstructionKind::Rule {
                name: "claude-local".into(),
            },
            parse_root,
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
        parse_rule,
        &mut items,
    );
    items
}

fn parse_root(text: &str) -> Result<ExternalInstruction, Code> {
    let mut document = instruction::plain(text)?;
    reject_references(&mut document);
    Ok(document)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    paths: Option<Vec<String>>,
}

fn parse_rule(text: &str) -> Result<ExternalInstruction, Code> {
    let (header, body) = crate::frontmatter::instruction_header(text)?;
    let header: Header = serde_yaml::from_value(header).map_err(|_| Code::InvalidContent)?;
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
    let mut document = instruction::plain(text)?;
    if body.trim().is_empty() {
        return Err(Code::InvalidContent);
    }
    document.body = body;
    document.load = load;
    reject_references(&mut document);
    Ok(document)
}
