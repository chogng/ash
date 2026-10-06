use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
/// One local branch and its optional configured upstream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranch {
    name: String,
    object_id: String,
    current: bool,
    upstream: Option<String>,
}

impl GitBranch {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    pub fn is_current(&self) -> bool {
        self.current
    }

    pub fn upstream(&self) -> Option<&str> {
        self.upstream.as_deref()
    }
}

impl GitClient {
    pub async fn local_branches(&self, repository: &GitRepository) -> GitResult<Vec<GitBranch>> {
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "for-each-ref",
                    "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
                    "refs/heads",
                ],
            )
            .await?;
        parse_branches(&output.stdout, &output.command)
    }
}
fn parse_branches(bytes: &[u8], command: &str) -> GitResult<Vec<GitBranch>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::invalid_output(command, "branch output was not UTF-8"))?;
    let mut branches = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(GitError::invalid_output(
                command,
                format!("branch record had {} fields instead of 4", fields.len()),
            ));
        }
        if fields[0].is_empty() || fields[1].is_empty() {
            return Err(GitError::invalid_output(
                command,
                "branch record omitted name or object id",
            ));
        }
        branches.push(GitBranch {
            name: fields[0].to_string(),
            object_id: fields[1].to_string(),
            upstream: (!fields[2].is_empty()).then(|| fields[2].to_string()),
            current: fields[3] == "*",
        });
    }
    Ok(branches)
}

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
