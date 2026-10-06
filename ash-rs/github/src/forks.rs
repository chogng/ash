use crate::Error;
use crate::GitHub;
use crate::Repository;
use crate::Result;
use ash_http_client::HttpMethod;
use serde::Deserialize;
use serde_json::json;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForkBranches {
    All,
    Default,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateFork {
    pub organization: Option<String>,
    pub name: String,
    pub branches: ForkBranches,
}

/// GitHub has accepted creation; Git objects may still be copying asynchronously.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ForkRepository {
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
}

impl GitHub {
    pub async fn create_fork(
        &self,
        repository: &Repository,
        fork: &CreateFork,
    ) -> Result<ForkRepository> {
        if !crate::valid_component(&fork.name)
            || fork
                .organization
                .as_deref()
                .is_some_and(|name| !crate::valid_component(name))
        {
            return Err(Error::InvalidInput("Invalid fork destination".into()));
        }
        let mut body =
            json!({"name":fork.name,"default_branch_only":fork.branches == ForkBranches::Default});
        if let Some(organization) = &fork.organization {
            body["organization"] = json!(organization);
        }
        let result: ForkRepository = self
            .api(
                repository,
                HttpMethod::Post,
                &repository.endpoint("forks"),
                Some(body),
            )
            .await?;
        let (owner, name) = result
            .full_name
            .split_once('/')
            .ok_or(Error::SubmissionUncertain)?;
        Repository::new(repository.host.clone(), owner.into(), name.into())
            .map_err(|_| Error::SubmissionUncertain)?;
        if name != fork.name
            || fork
                .organization
                .as_deref()
                .is_some_and(|organization| !organization.eq_ignore_ascii_case(owner))
            || result.html_url != format!("https://{}/{owner}/{name}", repository.host)
        {
            return Err(Error::SubmissionUncertain);
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "forks_tests.rs"]
mod tests;
