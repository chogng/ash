use ash_core::CoreError;
use ash_core::HarnessContext;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessInstructions;
use ash_home::AshHome;
use std::path::PathBuf;
use std::sync::Arc;

/// Supplies home Instructions even before a Directory is selected.
pub(super) struct HomeContext {
    home: Arc<AshHome>,
}

impl HomeContext {
    pub(super) fn new(home: Arc<AshHome>) -> Self {
        Self { home }
    }
}

impl HarnessContextProvider for HomeContext {
    fn snapshot(
        &self,
        request: &HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        Ok(Arc::new(HarnessContext::new(add_home_instructions(
            HarnessInstructions::default(),
            &self.home,
            &[],
            request.read_paths,
        ))))
    }
}

pub(super) fn add_home_instructions(
    instructions: HarnessInstructions,
    home: &AshHome,
    paths: &[PathBuf],
    selected: &[PathBuf],
) -> HarnessInstructions {
    let selected = selected
        .iter()
        .filter_map(|path| {
            let canonical = dunce::canonicalize(path).ok()?;
            let root = dunce::canonicalize(home.root()).ok()?;
            Some(home.root().join(canonical.strip_prefix(root).ok()?))
        })
        .collect::<Vec<_>>();
    catalog_instructions(
        ash_core::InstructionScope::User,
        &home.instructions(),
        home.root(),
        &home.root().join("instructions"),
        paths,
        &selected,
    )
    .into_iter()
    .fold(instructions, |instructions, entry| {
        instructions.with_instruction(entry)
    })
}

pub(super) fn catalog_instructions(
    scope: ash_core::InstructionScope,
    snapshot: &ash_instructions::InstructionCatalogSnapshot,
    root: &std::path::Path,
    source_root: &std::path::Path,
    paths: &[PathBuf],
    selected: &[PathBuf],
) -> Vec<ash_core::HarnessInstruction> {
    let root_text = root.display().to_string();
    let mut entries = snapshot
        .selected_files(paths, selected, root, source_root)
        .into_iter()
        .map(|file| {
            let activation = match file.selection {
                ash_instructions::InstructionSelection::AlwaysOn => {
                    ash_core::InstructionActivation::AlwaysOn
                }
                ash_instructions::InstructionSelection::PathMatch => {
                    ash_core::InstructionActivation::PathMatch
                }
                ash_instructions::InstructionSelection::Selected => {
                    ash_core::InstructionActivation::Selected
                }
            };
            ash_core::HarnessInstruction::new(
                scope,
                file.path.display().to_string(),
                &root_text,
                activation,
                file.body,
            )
        })
        .collect::<Vec<_>>();
    let root_xml = root_text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    let marker = match scope {
        ash_core::InstructionScope::User => format!("<ash-home>{root_xml}</ash-home>"),
        ash_core::InstructionScope::Directory => format!("<directory root=\"{root_xml}\" />"),
    };
    entries.push(ash_core::HarnessInstruction::new(scope, format!("{root_text}:catalog"), root_text,
        ash_core::InstructionActivation::Context,
        format!("{marker}\nThis is the current instruction catalog for this scope. Use the current versions of loaded files; historical copies do not reactivate removed rules.\n{}",
            snapshot.reference_content(paths, selected, source_root).unwrap_or_default())));
    entries
}

#[cfg(test)]
#[path = "home_context_tests.rs"]
mod tests;
