use crate::ChangeFile;
use crate::change_file;
use ash_git::GitClient;
use ash_git::GitTreeId;
use sha2::Digest;
use sha2::Sha256;
use std::path::PathBuf;

/// Immutable endpoints selected by the Thread history owner, never by a client-supplied tree ID.
pub struct CheckpointComparison {
    pub repository_id: String,
    pub git_directory: PathBuf,
    pub before: GitTreeId,
    pub after: GitTreeId,
}

/// Repository metadata and blobs share the same immutable comparison.
pub struct RepositoryChanges {
    pub comparison: CheckpointComparison,
    pub files: Vec<ChangeFile>,
}

/// Derived read result. History and captured objects remain the only durable owners.
pub struct CheckpointChanges {
    pub sequence: u64,
    pub revision: String,
    pub repositories: Vec<RepositoryChanges>,
}

/// Compares complete repository snapshots so repeated edits, renames and reversals are netted
/// by Git. The history revision fences A-B-A navigation even when file contents are identical.
pub async fn summarize_checkpoints(
    sequence: u64,
    mut comparisons: Vec<CheckpointComparison>,
) -> Result<CheckpointChanges, ash_git::GitError> {
    comparisons.sort_by(|a, b| a.repository_id.cmp(&b.repository_id));
    let mut digest = Sha256::new();
    digest.update(sequence.to_le_bytes());
    let git = GitClient::system();
    let mut repositories = Vec::new();
    for comparison in comparisons {
        for value in [
            comparison.repository_id.as_str(),
            comparison.before.as_str(),
            comparison.after.as_str(),
        ] {
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value.as_bytes());
        }
        let files = git
            .diff_trees_at_git_dir(
                &comparison.git_directory,
                &comparison.before,
                &comparison.after,
            )
            .await?
            .into_iter()
            .map(change_file)
            .collect();
        repositories.push(RepositoryChanges { comparison, files });
    }
    Ok(CheckpointChanges {
        sequence,
        revision: format!("{:x}", digest.finalize()),
        repositories,
    })
}
