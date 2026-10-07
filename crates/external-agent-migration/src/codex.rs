use crate::ExternalInstructionKind;
use crate::ImportItemKind;
use crate::ImportScope;
use crate::MigrationItemDetail;
use crate::MigrationPlanItem;
use crate::instruction::plain;
use crate::instruction::read;
use crate::source::Source;
use std::path::PathBuf;

pub(crate) fn detect(source: &mut Source) -> Vec<MigrationPlanItem> {
    let mut items = Vec::new();
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
    if let Some(candidate) = candidate.filter(|candidate| !candidate.value.trim().is_empty()) {
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
    items
}
