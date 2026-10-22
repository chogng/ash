use std::path::Path;

use crate::GitClient;
use crate::GitResult;

/// Best-effort repository facts for immutable agent environment context.
/// Missing fields indicate an unavailable or unsafe query, including history in an unborn repository.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitEnvironmentSummary {
    pub branch: Option<String>,
    pub main_branch: Option<String>,
    pub status: Option<String>,
    pub recent_commits: Option<String>,
}

enum ContentQueries {
    MetadataOnly,
    HistoryOnly,
    StatusAndHistory,
}

impl GitClient {
    /// Captures repository context using bounded, non-interactive queries with hooks and
    /// configured filesystem-monitor programs disabled, even for repository-inspection grants.
    pub async fn environment_summary(&self, start: &Path) -> GitResult<GitEnvironmentSummary> {
        let repository = self.open_repository(start).await?;
        let cwd = repository.worktree_root();
        let branch = self
            .environment_text(cwd, &["branch", "--show-current"])
            .await
            .filter(|value| !value.is_empty());
        let main_branch = self
            .environment_text(
                cwd,
                &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            )
            .await
            .map(|value| value.trim_start_matches("origin/").trim().to_owned())
            .filter(|value| !value.is_empty())
            .or_else(|| branch.clone());
        let content_queries = self.environment_content_queries(cwd).await;
        let status = match content_queries {
            ContentQueries::StatusAndHistory => {
                self.environment_text(cwd, &["status", "--porcelain", "--ignore-submodules=all"])
                    .await
            }
            ContentQueries::MetadataOnly | ContentQueries::HistoryOnly => None,
        };
        // Signature display can start a repository-configured verifier. Environment
        // context only needs commit subjects, irrespective of the user's log settings.
        let recent_commits = match content_queries {
            ContentQueries::MetadataOnly => None,
            ContentQueries::HistoryOnly | ContentQueries::StatusAndHistory => self
                .environment_text(
                    cwd,
                    &[
                        "log",
                        "--no-show-signature",
                        "--no-patch",
                        "--oneline",
                        "-5",
                    ],
                )
                .await
                .filter(|value| !value.is_empty()),
        };
        Ok(GitEnvironmentSummary {
            branch,
            main_branch,
            status,
            recent_commits,
        })
    }

    async fn environment_text(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let output = self.run_query(cwd, args).await.ok()?;
        Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    async fn environment_content_queries(&self, cwd: &Path) -> ContentQueries {
        // Status may run clean/process filters; object reads in a partial clone may
        // fetch missing objects through configured transports. Optional environment
        // facts must not activate either. Submodule inspection is disabled separately
        // because its configuration belongs to another working copy.
        let Ok(config) = self
            .run_query_unchecked(
                cwd,
                &[
                    "config",
                    "--null",
                    "--name-only",
                    "--get-regexp",
                    "(^filter\\..*\\.(clean|process)$)|(^remote\\..*\\.promisor$)|(^extensions\\.partialclone$)",
                ],
            )
            .await
        else {
            return ContentQueries::MetadataOnly;
        };
        if config.status.code() == Some(1) {
            return ContentQueries::StatusAndHistory;
        }
        if config.status.success()
            && !config.stdout.is_empty()
            && config
                .stdout
                .split(|byte| *byte == 0)
                .filter(|key| !key.is_empty())
                .all(|key| key.starts_with(b"filter."))
        {
            // Installing a filter (for example Git LFS in global config) does not
            // activate it. Only attributes on files considered by status can do so.
            if self.environment_has_filter_attributes(cwd).await == Some(false) {
                ContentQueries::StatusAndHistory
            } else {
                ContentQueries::HistoryOnly
            }
        } else {
            ContentQueries::MetadataOnly
        }
    }

    async fn environment_has_filter_attributes(&self, cwd: &Path) -> Option<bool> {
        let paths = self
            .run_query(
                cwd,
                [
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
            )
            .await
            .ok()?;
        if paths.stdout.is_empty() {
            return Some(false);
        }
        // Attribute inspection does not execute filters. Keep the filename stream
        // NUL-delimited so spaces, newlines and non-UTF-8 paths retain their identity.
        let attributes = self
            .run_query_with_stdin(cwd, ["check-attr", "-z", "--stdin", "filter"], paths.stdout)
            .await
            .ok()?
            .require_success()
            .ok()?;
        let fields = attributes
            .stdout
            .strip_suffix(&[0])?
            .split(|byte| *byte == 0)
            .collect::<Vec<_>>();
        if fields.len() % 3 != 0 {
            return None;
        }
        Some(
            fields
                .chunks_exact(3)
                .any(|record| !matches!(record[2], b"unspecified" | b"unset")),
        )
    }
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
