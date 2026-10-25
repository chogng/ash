use crate::Error;
use crate::GitHub;
use crate::Repository;
use std::collections::BTreeSet;

/// A complete observation of a PR at one head; partial or moving snapshots never trigger work.
#[derive(Debug, PartialEq)]
pub enum PullRequestFollowUp {
    Closed,
    Waiting,
    Failed { head: String, context: String },
}

impl GitHub {
    /// Reads through the selected API Provider and rechecks the head after all check pages.
    /// One repair is admitted per head, so a growing set of failures cannot create a repair loop.
    pub async fn pull_request_follow_up(
        &self,
        repository: &Repository,
        number: u64,
    ) -> crate::Result<PullRequestFollowUp> {
        self.validate_authorization()?;
        let before = self.pull_request(repository, number).await?;
        if before.state != "open" || before.merged_at.is_some() {
            return Ok(PullRequestFollowUp::Closed);
        }
        let head = before.head.sha;
        let mut page = Some(1);
        let mut pages = BTreeSet::new();
        let mut failures = BTreeSet::new();
        let mut failed_checks = BTreeSet::new();
        let mut pending = false;
        while let Some(current) = page {
            if !pages.insert(current) || pages.len() > 100 {
                return Err(Error::InvalidResponse("Incomplete PR checks".into()));
            }
            let checks = self.checks(repository, &head, current).await?;
            for check in checks.checks {
                pending |= check.status != "completed";
                if check.status == "completed"
                    && matches!(
                        check.conclusion.as_deref(),
                        Some("failure" | "timed_out" | "action_required" | "startup_failure")
                    )
                {
                    failed_checks.insert(check.id);
                    failures.insert(format!(
                        "{}: {}",
                        check.name,
                        check.details_url.unwrap_or_default()
                    ));
                }
            }
            for status in checks.statuses {
                pending |= status.state == "pending";
                if matches!(status.state.as_str(), "failure" | "error") {
                    failures.insert(format!(
                        "{}: {}",
                        status.context,
                        status.target_url.unwrap_or_default()
                    ));
                }
            }
            page = checks.next_page;
        }
        // Supply useful initial diagnostics through the same head-pinned read used by manual Fix CI.
        // Bounds apply to prompt context, not to check completeness; full result links remain available.
        let mut diagnostics = Vec::new();
        let mut truncated = failed_checks.len() > 10;
        if !pending {
            for check_id in failed_checks.into_iter().take(10) {
                let details = self
                    .check_details(repository, number, &head, check_id, 1)
                    .await?;
                truncated |= details.next_page.is_some();
                let mut text = format!("{}\n{}\n{}", details.title, details.summary, details.text);
                for annotation in details.annotations {
                    text.push_str(&format!(
                        "\n{}:{}-{}: {}",
                        annotation.path,
                        annotation.start_line,
                        annotation.end_line,
                        annotation.message
                    ));
                }
                let mut end = text.len().min(6_000);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                truncated |= end < text.len();
                text.truncate(end);
                diagnostics.push(serde_json::json!({ "checkId": check_id, "text": text }));
            }
        }
        let after = self.pull_request(repository, number).await?;
        self.validate_authorization()?;
        if after.state != "open" || after.merged_at.is_some() {
            return Ok(PullRequestFollowUp::Closed);
        }
        if head != after.head.sha || pending || failures.is_empty() {
            return Ok(PullRequestFollowUp::Waiting);
        }
        let context = serde_json::json!({
            "pullRequest": format!("https://{}/{}/{}/pull/{}", repository.host, repository.owner, repository.name, number),
            "headCommit": head,
            "failedChecks": failures.into_iter().take(200).collect::<Vec<_>>(),
            "diagnostics": diagnostics,
            "diagnosticsTruncated": truncated,
        }).to_string();
        if context.len() > 100_000 {
            return Err(Error::InvalidResponse(
                "PR check context exceeds its limit".into(),
            ));
        }
        Ok(PullRequestFollowUp::Failed { head, context })
    }
}
