use crate::GitHub;
use crate::endpoint;
use ash_http_client::HttpMethod;
use github::CheckAnnotation;
use github::CheckDetails;
use github::Error;
use github::Repository;
use github::Result;
use serde::Deserialize;

#[derive(Deserialize)]
struct Run {
    id: u64,
    head_sha: String,
    status: String,
    details_url: Option<String>,
    app: App,
    output: Output,
}
#[derive(Deserialize)]
struct App {
    slug: Option<String>,
}
#[derive(Deserialize)]
struct Output {
    title: Option<String>,
    summary: Option<String>,
    text: Option<String>,
}
#[derive(Deserialize)]
struct Job {
    id: u64,
    head_sha: String,
    check_run_url: String,
    status: String,
}

impl GitHub {
    async fn check_context(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<Run> {
        if check_id == 0
            || commit.len() != 40
            || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::InvalidInput(
                "Use a check ID and its full head commit".into(),
            ));
        }
        let pull = self.pull_request(repository, number).await?;
        if !pull.head.sha.eq_ignore_ascii_case(commit) {
            return Err(Error::Conflict("Pull request head changed".into()));
        }
        let run: Run = self
            .api(
                repository,
                HttpMethod::Get,
                &endpoint(repository, &format!("check-runs/{check_id}")),
                None,
            )
            .await?;
        if run.id != check_id || !run.head_sha.eq_ignore_ascii_case(commit) {
            return Err(Error::Conflict(
                "Check belongs to a different commit".into(),
            ));
        }
        Ok(run)
    }

    pub async fn check_details(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
        page: u32,
    ) -> Result<CheckDetails> {
        if !(1..=100).contains(&page) {
            return Err(Error::InvalidInput("Invalid check annotation page".into()));
        }
        let run = self
            .check_context(repository, number, commit, check_id)
            .await?;
        let annotations: Vec<CheckAnnotation> = self
            .api(
                repository,
                HttpMethod::Get,
                &endpoint(
                    repository,
                    &format!("check-runs/{check_id}/annotations?per_page=100&page={page}"),
                ),
                None,
            )
            .await?;
        if page == 100 && annotations.len() == 100 {
            return Err(Error::InvalidResponse(
                "Check annotations exceed the supported page limit; open the full results".into(),
            ));
        }
        if annotations.iter().any(|annotation| {
            annotation.start_line == 0 || annotation.end_line < annotation.start_line
        }) {
            return Err(Error::InvalidResponse(
                "Invalid check annotation location".into(),
            ));
        }
        let actions_job = action_job_id(repository, &run).is_some();
        Ok(CheckDetails {
            title: run.output.title.unwrap_or_default(),
            summary: run.output.summary.unwrap_or_default(),
            text: run.output.text.unwrap_or_default(),
            next_page: (annotations.len() == 100).then_some(page + 1),
            annotations,
            actions_job,
        })
    }

    async fn checked_job(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<Job> {
        let run = self
            .check_context(repository, number, commit, check_id)
            .await?;
        let id = action_job_id(repository, &run)
            .ok_or_else(|| Error::InvalidInput("This check is not a GitHub Actions job".into()))?;
        if run.status != "completed" {
            return Err(Error::Conflict("Check is still running".into()));
        }
        let job: Job = self
            .api(
                repository,
                HttpMethod::Get,
                &endpoint(repository, &format!("actions/jobs/{id}")),
                None,
            )
            .await?;
        let api_host = if repository.host.eq_ignore_ascii_case("github.com") {
            "api.github.com"
        } else {
            &repository.host
        };
        let path = format!(
            "{}{}",
            if repository.host.eq_ignore_ascii_case("github.com") {
                "/"
            } else {
                "/api/v3/"
            },
            endpoint(repository, &format!("check-runs/{check_id}"))
        );
        let checked_url = url::Url::parse(&job.check_run_url).ok();
        if job.id != id
            || !job.head_sha.eq_ignore_ascii_case(commit)
            || job.status != "completed"
            || !checked_url.as_ref().is_some_and(|url| {
                url.scheme() == "https"
                    && url.port_or_known_default() == Some(443)
                    && url
                        .host_str()
                        .is_some_and(|host| host.eq_ignore_ascii_case(api_host))
                    && url.path().eq_ignore_ascii_case(&path)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
        {
            return Err(Error::Conflict(
                "Workflow job does not match the selected check".into(),
            ));
        }
        Ok(job)
    }

    pub async fn check_log(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<String> {
        let job = self
            .checked_job(repository, number, commit, check_id)
            .await?;
        self.log_link(
            repository,
            &endpoint(repository, &format!("actions/jobs/{}/logs", job.id)),
        )
        .await
    }

    pub async fn rerun_check(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<()> {
        let job = self
            .checked_job(repository, number, commit, check_id)
            .await?;
        let response = self
            .request_raw(
                &repository.host,
                HttpMethod::Post,
                &endpoint(repository, &format!("actions/jobs/{}/rerun", job.id)),
                Some(serde_json::json!({})),
                crate::api::Operation::Write,
            )
            .await?;
        if response.status() >= 500 {
            return Err(Error::SubmissionUncertain);
        }
        crate::error::validate_status(
            response.status(),
            response
                .headers()
                .iter()
                .map(|header| (header.name(), header.value())),
        )
    }
}

fn action_job_id(repository: &Repository, run: &Run) -> Option<u64> {
    if run.app.slug.as_deref() != Some("github-actions") {
        return None;
    }
    let url = url::Url::parse(run.details_url.as_deref()?).ok()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.host_str()?.eq_ignore_ascii_case(&repository.host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    if !segments.first()?.eq_ignore_ascii_case(&repository.owner)
        || !segments.get(1)?.eq_ignore_ascii_case(&repository.name)
    {
        return None;
    }
    let job = match segments.as_slice() {
        [_, _, "actions", "runs", _, "job", job]
        | [_, _, "runs", _, "jobs", job]
        | [_, _, "runs", job] => job,
        _ => return None,
    };
    job.parse::<u64>().ok().filter(|id| *id > 0)
}

#[cfg(test)]
#[path = "checks_tests.rs"]
mod tests;
