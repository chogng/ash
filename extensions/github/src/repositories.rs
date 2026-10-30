use crate::GitHub;
use crate::api::Operation;
use ash_http_client::HttpMethod;
use github::*;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Remote {
    full_name: String,
    description: Option<String>,
    #[serde(default)]
    stargazers_count: u64,
    private: bool,
    #[serde(default)]
    default_branch: String,
    html_url: String,
    clone_url: String,
    ssh_url: String,
}
impl Remote {
    fn validate(self, host: &str) -> Result<RemoteRepository> {
        let (owner, name) = self.full_name.split_once('/').ok_or_else(response)?;
        let repository =
            Repository::new(host.into(), owner.into(), name.into()).map_err(|_| response())?;
        let base = format!("https://{host}/{owner}/{name}");
        // Returned clone URLs are executable Git inputs. Never accept another authority,
        // embedded credentials, or an API-provided path outside this repository.
        if self.html_url != base
            || self.clone_url != format!("{base}.git")
            || self.ssh_url != format!("git@{host}:{owner}/{name}.git")
        {
            return Err(response());
        }
        Ok(RemoteRepository {
            repository,
            description: self.description,
            stars: self.stargazers_count,
            private: self.private,
            default_branch: self.default_branch,
            html_url: self.html_url,
            clone_url: self.clone_url,
            ssh_url: self.ssh_url,
        })
    }
}
impl GitHub {
    pub(crate) async fn search_repositories(
        &self,
        query: &str,
        page: u32,
    ) -> Result<Page<RemoteRepository>> {
        let query = query.trim();
        if query.len() > 256
            || query.chars().any(char::is_control)
            || page == 0
            || page > if query.is_empty() { 10000 } else { 10 }
        {
            return Err(Error::InvalidInput(
                "Invalid repository search or page".into(),
            ));
        }
        let host = &self.authorization.host;
        let direct = if let Ok(url) = url::Url::parse(query) {
            if url.scheme() != "https"
                || url.host_str() != Some(host)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(Error::InvalidInput(
                    "Repository URL must belong to the selected GitHub host".into(),
                ));
            }
            Some(
                url.path()
                    .trim_matches('/')
                    .trim_end_matches(".git")
                    .to_owned(),
            )
        } else {
            None
        };
        if let Some(identity) = direct {
            let (owner, name) = identity
                .split_once('/')
                .ok_or_else(|| Error::InvalidInput("Invalid repository URL".into()))?;
            let repository = Repository::new(host.clone(), owner.into(), name.into())?;
            let remote: Remote = self
                .api(
                    &repository,
                    HttpMethod::Get,
                    &format!("repos/{owner}/{name}"),
                    None,
                )
                .await?;
            return Ok(Page {
                items: vec![remote.validate(host)?],
                next_page: None,
            });
        }
        let (rows, maximum) = if query.is_empty() {
            (
                self.account_api::<Vec<Remote>>(
                    HttpMethod::Get,
                    &format!("user/repos?sort=updated&per_page=100&page={page}"),
                    None,
                )
                .await?,
                10000,
            )
        } else {
            let mut endpoint = url::Url::parse("https://api.invalid/search/repositories")
                .expect("static endpoint");
            let query = if let Some((owner, name)) =
                query.split_once('/').filter(|(owner, name)| {
                    crate::valid_component(owner) && crate::valid_component(name)
                }) {
                format!("user:{owner} {name} fork:true")
            } else {
                format!("{query} fork:true")
            };
            endpoint
                .query_pairs_mut()
                .append_pair("q", &query)
                .append_pair("sort", "stars")
                .append_pair("per_page", "100")
                .append_pair("page", &page.to_string());
            #[derive(Deserialize)]
            struct Search {
                items: Vec<Remote>,
            }
            let search: Search = self
                .account_api(
                    HttpMethod::Get,
                    &format!("search/repositories?{}", endpoint.query().expect("query")),
                    None,
                )
                .await?;
            (search.items, 10)
        };
        let next_page = (rows.len() == 100 && page < maximum).then_some(page + 1);
        Ok(Page {
            items: rows
                .into_iter()
                .map(|row| row.validate(host))
                .collect::<Result<_>>()?,
            next_page,
        })
    }
    pub(crate) async fn create_repository(
        &self,
        name: &str,
        description: &str,
        visibility: RepositoryVisibility,
    ) -> Result<RemoteRepository> {
        if name.len() > 100
            || !crate::valid_component(name)
            || description.chars().count() > 350
            || description.chars().any(char::is_control)
        {
            return Err(Error::InvalidInput(
                "Invalid repository name or description".into(),
            ));
        }
        let remote:Remote=self.account_api(HttpMethod::Post,"user/repos",Some(json!({"name":name,"description":description,"private":matches!(visibility,RepositoryVisibility::Private),"auto_init":false}))).await?;
        if remote
            .full_name
            .split_once('/')
            .is_none_or(|(_, created)| !created.eq_ignore_ascii_case(name))
        {
            return Err(Error::SubmissionUncertain);
        }
        remote
            .validate(&self.authorization.host)
            .map_err(|_| Error::SubmissionUncertain)
    }
    pub(crate) async fn repository_branches(
        &self,
        repository: &Repository,
        page: u32,
    ) -> Result<Page<RepositoryBranch>> {
        if !(1..=10000).contains(&page) {
            return Err(Error::InvalidInput("Invalid branches page".into()));
        }
        let info = self.repository(repository).await?;
        #[derive(Deserialize)]
        struct Branch {
            name: String,
        }
        let rows: Vec<Branch> = self
            .api(
                repository,
                HttpMethod::Get,
                &crate::endpoint(repository, &format!("branches?per_page=100&page={page}")),
                None,
            )
            .await?;
        let next_page = (rows.len() == 100 && page < 10000).then_some(page + 1);
        let mut items: Vec<_> = rows
            .into_iter()
            .map(|row| RepositoryBranch {
                default: row.name == info.metadata.default_branch,
                name: row.name,
            })
            .collect();
        items.sort_by_key(|row| !row.default);
        Ok(Page { items, next_page })
    }
    pub(crate) async fn branch_protection(
        &self,
        repository: &Repository,
    ) -> Result<BranchProtection> {
        let details=self.graphql(repository,"query AshRepositoryPermissions($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} viewerPermission}}",json!({"owner":repository.owner,"name":repository.name}),Operation::Read).await?;
        let details = details
            .pointer("/data/repository")
            .filter(|value| value.is_object())
            .ok_or_else(response)?;
        let default_branch = details
            .pointer("/defaultBranchRef/name")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut result = BranchProtection {
            default_branch,
            rules: vec![],
        };
        match details["viewerPermission"].as_str() {
            Some("ADMIN" | "MAINTAIN" | "WRITE") => {}
            Some("READ" | "TRIAGE") | None => return Ok(result),
            Some(_) => return Err(response()),
        }
        let mut cursor: Option<String> = None;
        let mut seen = BTreeSet::new();
        for _ in 0..100 {
            let value=self.graphql(repository,"query AshRepositoryRulesets($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){rulesets(includeParents:true,first:100,after:$cursor){nodes{target enforcement rules(type:PULL_REQUEST){totalCount} conditions{refName{include exclude}}} pageInfo{hasNextPage endCursor}}}}",json!({"owner":repository.owner,"name":repository.name,"cursor":cursor}),Operation::Read).await?;
            let rulesets = value
                .pointer("/data/repository/rulesets")
                .ok_or_else(response)?;
            let nodes = rulesets["nodes"].as_array().ok_or_else(response)?;
            for node in nodes {
                if node.is_null() {
                    continue;
                }
                if node["target"] != "BRANCH"
                    || node["enforcement"] != "ACTIVE"
                    || node
                        .pointer("/rules/totalCount")
                        .and_then(Value::as_u64)
                        .ok_or_else(response)?
                        == 0
                {
                    continue;
                }
                let ref_names = node
                    .pointer("/conditions/refName")
                    .filter(|value| value.is_object())
                    .ok_or_else(response)?;
                let names = |key: &str| -> Result<Vec<String>> {
                    ref_names
                        .get(key)
                        .ok_or_else(response)?
                        .as_array()
                        .ok_or_else(response)?
                        .iter()
                        .map(|value| {
                            let name = value.as_str().ok_or_else(response)?;
                            match name {
                                "~ALL" => Ok("**/*".into()),
                                "~DEFAULT_BRANCH" => {
                                    result.default_branch.clone().ok_or_else(response)
                                }
                                name => Ok(name.strip_prefix("refs/heads/").unwrap_or(name).into()),
                            }
                        })
                        .collect()
                };
                result.rules.push(BranchProtectionRule {
                    include: names("include")?,
                    exclude: names("exclude")?,
                });
            }
            match rulesets
                .pointer("/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
            {
                Some(false) => return Ok(result),
                Some(true) => {
                    let next = rulesets
                        .pointer("/pageInfo/endCursor")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty() && value.len() <= 4096)
                        .ok_or_else(response)?;
                    if !seen.insert(next.to_owned()) {
                        return Err(response());
                    }
                    cursor = Some(next.into());
                }
                None => return Err(response()),
            }
        }
        Err(Error::InvalidResponse(
            "Repository rulesets exceed the supported page limit".into(),
        ))
    }
}
fn response() -> Error {
    Error::InvalidResponse("Invalid GitHub repository response".into())
}

impl GitHub {
    pub(crate) async fn repository_tree(
        &self,
        repository: &Repository,
        reference: &str,
    ) -> Result<RepositoryTree> {
        if reference.is_empty() || reference.len() > 1024 || reference.chars().any(char::is_control)
        {
            return Err(Error::InvalidInput("Invalid repository reference".into()));
        }
        #[derive(Deserialize)]
        struct Tree {
            sha: String,
            truncated: bool,
            tree: Vec<Entry>,
        }
        #[derive(Deserialize)]
        struct Entry {
            path: String,
            mode: String,
            #[serde(rename = "type")]
            kind: String,
            sha: String,
            size: Option<u64>,
        }
        let encoded: String = url::form_urlencoded::byte_serialize(reference.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        let tree: Tree = self
            .api(
                repository,
                HttpMethod::Get,
                &crate::endpoint(repository, &format!("git/trees/{encoded}?recursive=1")),
                None,
            )
            .await?;
        // A truncated recursive response cannot represent a complete filesystem or search result.
        if tree.truncated || !valid_object_sha(&tree.sha) || tree.tree.len() > 100_000 {
            return Err(response());
        }
        let mut paths = BTreeSet::new();
        let mut entries = Vec::with_capacity(tree.tree.len());
        for entry in tree.tree {
            if entry.path.len() > 4096
                || entry.path.contains('\\')
                || entry.path.chars().any(char::is_control)
                || entry
                    .path
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
                || !valid_object_sha(&entry.sha)
                || !paths.insert(entry.path.clone())
            {
                return Err(response());
            }
            let kind = match (entry.kind.as_str(), entry.mode.as_str()) {
                ("tree", "040000") => RepositoryEntryKind::Directory,
                ("blob", "100644" | "100755") => RepositoryEntryKind::File,
                ("blob", "120000") => RepositoryEntryKind::SymbolicLink,
                ("commit", "160000") => RepositoryEntryKind::Submodule,
                _ => return Err(response()),
            };
            if entry.kind == "blob" && entry.size.is_none() {
                return Err(response());
            }
            entries.push(RepositoryTreeEntry {
                path: entry.path,
                kind,
                sha: entry.sha,
                size: entry.size.unwrap_or(0),
            });
        }
        Ok(RepositoryTree {
            sha: tree.sha,
            entries,
        })
    }

    pub(crate) async fn repository_blob(
        &self,
        repository: &Repository,
        sha: &str,
    ) -> Result<RepositoryBlob> {
        use base64::Engine;
        if !valid_object_sha(sha) {
            return Err(Error::InvalidInput("Invalid blob SHA".into()));
        }
        #[derive(Deserialize)]
        struct Blob {
            sha: String,
            size: u64,
            encoding: String,
            content: String,
        }
        let blob: Blob = self
            .api(
                repository,
                HttpMethod::Get,
                &crate::endpoint(repository, &format!("git/blobs/{sha}")),
                None,
            )
            .await?;
        if blob.sha != sha
            || blob.encoding != "base64"
            || blob.size > 5 * 1024 * 1024
            || blob.content.len() > 15 * 1024 * 1024
        {
            return Err(response());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(blob.content.replace(['\r', '\n'], ""))
            .map_err(|_| response())?;
        if bytes.len() as u64 != blob.size {
            return Err(response());
        }
        Ok(RepositoryBlob {
            sha: blob.sha,
            content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
}

fn valid_object_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
#[path = "repositories_tests.rs"]
mod tests;
