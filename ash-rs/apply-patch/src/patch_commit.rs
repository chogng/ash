use ash_file_access::Dir;
use ash_file_system::FileMutation;
use ash_file_system::FileMutationError;
use ash_file_system::commit_file_mutations;

pub(super) struct PatchSummary {
    pub(super) updated: Vec<String>,
    pub(super) added: Vec<String>,
    pub(super) deleted: Vec<String>,
    pub(super) moved: Vec<(String, String)>,
}

pub(super) fn commit(
    dir: &Dir,
    changes: Vec<FileMutation>,
) -> Result<PatchSummary, FileMutationError> {
    commit_file_mutations(dir, &changes)?;
    let mut summary = PatchSummary {
        updated: Vec::new(),
        added: Vec::new(),
        deleted: Vec::new(),
        moved: Vec::new(),
    };
    for change in changes {
        match change {
            FileMutation::Replace { path, .. } => summary.updated.push(path.display().to_string()),
            FileMutation::Create { path, .. } => summary.added.push(path.display().to_string()),
            FileMutation::Remove { path, .. } => summary.deleted.push(path.display().to_string()),
            FileMutation::MoveAndReplace { path, target, .. } => summary
                .moved
                .push((path.display().to_string(), target.display().to_string())),
        }
    }
    Ok(summary)
}
