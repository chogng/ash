use crate::Error;
use ash_protocol::ApprovalMode;
use ash_protocol::ContentDigest;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub state: String,
    pub url: Option<String>,
    pub labels: Vec<String>,
    pub priority: Option<i64>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    /// A blocking issue's ID and current tracker state.
    pub blocked_by: BTreeMap<String, String>,
    pub local: bool,
    #[serde(default = "dispatchable_default")]
    pub dispatchable: bool,
}

fn dispatchable_default() -> bool {
    true
}

impl Issue {
    pub fn validate(&self) -> Result<(), Error> {
        if self.id.is_empty()
            || self.id.len() > 512
            || self.identifier.is_empty()
            || self.identifier.len() > 512
            || self.title.trim().is_empty()
            || self.title.len() > 4096
            || self.description.len() > 256 * 1024
        {
            return Err(Error::Invalid(
                "issue identity or content is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Tracker {
    Local,
    Github {
        repo: String,
    },
    Linear {
        project_slug: String,
        token_env: String,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Hooks {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Workflow {
    pub id: String,
    pub path: String,
    pub directory: String,
    pub tracker: Tracker,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
    pub required_labels: Vec<String>,
    pub poll_interval_ms: u64,
    pub max_concurrent_agents: u32,
    pub max_concurrent_agents_by_state: BTreeMap<String, u32>,
    pub max_turns: u32,
    pub max_retry_backoff_ms: u64,
    pub stall_timeout_ms: u64,
    #[serde(default)]
    pub approval_mode: Option<ApprovalMode>,
    pub hooks: Hooks,
    pub prompt: String,
    pub digest: String,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub codex: Codex,
    #[serde(default)]
    pub tracker_endpoint: Option<String>,
    #[serde(default)]
    pub tracker_assignee: Option<String>,
    #[serde(default)]
    pub provider_options: BTreeMap<String, serde_json::Value>,
}

/// Upstream execution settings retained at the workflow boundary; the host maps execution to Ash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct Codex {
    pub command: String,
    pub approval_policy: serde_json::Value,
    pub thread_sandbox: Option<String>,
    pub turn_sandbox_policy: serde_json::Value,
    pub turn_timeout_ms: u64,
    pub read_timeout_ms: u64,
    pub stall_timeout_ms: i64,
}
impl Default for Codex {
    fn default() -> Self {
        Self {
            command: "codex app-server".into(),
            approval_policy: serde_json::Value::Null,
            thread_sandbox: None,
            turn_sandbox_policy: serde_json::Value::Null,
            turn_timeout_ms: 3_600_000,
            read_timeout_ms: 5000,
            stall_timeout_ms: 300_000,
        }
    }
}

impl Codex {
    /// Extracts the existing model/effort preferences from Codex launch arguments. No shell
    /// expansion or command execution occurs while resolving configuration.
    pub fn model_selection(
        &self,
    ) -> Result<(Option<String>, Option<ash_protocol::ReasoningEffort>), Error> {
        let words = shell_words::split(&self.command)
            .map_err(|_| Error::Invalid("codex.command quoting is invalid".into()))?;
        let mut model = None;
        let mut effort = None;
        let mut words = words.iter();
        while let Some(word) = words.next() {
            let setting = if word == "--config" || word == "-c" {
                words.next().map(String::as_str)
            } else {
                word.strip_prefix("--config=")
            };
            if let Some((key, value)) = setting.and_then(|setting| setting.split_once('=')) {
                let value = value.trim().trim_matches('"');
                match key.trim() {
                    "model" => model = Some(value.into()),
                    "model_reasoning_effort" => {
                        effort =
                            Some(ash_protocol::ReasoningEffort::parse(value).ok_or_else(|| {
                                Error::Invalid("workflow reasoning effort is invalid".into())
                            })?)
                    }
                    _ => {}
                }
            }
        }
        Ok((model, effort))
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Definition {
    tracker: TrackerOptions,
    polling: Polling,
    agent: Agent,
    hooks: Hooks,
    workspace: Workspace,
    codex: Codex,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Workspace {
    root: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TrackerOptions {
    kind: String,
    provider: Provider,
    project_slug: String,
    api_key: String,
    endpoint: Option<String>,
    assignee: Option<String>,
    active_states: Vec<String>,
    terminal_states: Vec<String>,
    required_labels: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Provider {
    repo: String,
    project_slug: String,
    api_key: String,
    endpoint: Option<String>,
    assignee: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(default)]
struct Polling {
    interval_ms: u64,
}
impl Default for Polling {
    fn default() -> Self {
        Self {
            interval_ms: 30_000,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct Agent {
    max_concurrent_agents: u32,
    max_concurrent_agents_by_state: BTreeMap<String, u32>,
    max_turns: u32,
    max_retry_backoff_ms: u64,
    approval_mode: Option<ApprovalMode>,
}
impl Default for Agent {
    fn default() -> Self {
        Self {
            max_concurrent_agents: 10,
            max_concurrent_agents_by_state: BTreeMap::new(),
            max_turns: 20,
            max_retry_backoff_ms: 300_000,
            approval_mode: None,
        }
    }
}

pub fn identity(value: &str) -> String {
    ContentDigest::sha256(value.as_bytes())
        .to_string()
        .replace(':', "-")
}

impl Workflow {
    pub fn load(path: &Path) -> Result<Self, Error> {
        if !path.is_absolute() {
            return Err(Error::Invalid("select an absolute WORKFLOW.md path".into()));
        }
        let path = path
            .canonicalize()
            .map_err(|_| Error::Invalid("workflow file is unavailable".into()))?;
        let source = read_source(&path)?;
        let normalized = source.replace("\r\n", "\n");
        let (yaml, prompt) = frontmatter(&normalized);
        let definition: Definition = if yaml.trim().is_empty() {
            Definition::default()
        } else {
            serde_yaml::from_str(yaml)
                .map_err(|_| Error::Invalid("workflow YAML is invalid".into()))?
        };
        let options = definition.tracker;
        let tracker = match options.kind.as_str() {
            "" | "local" | "memory" => Tracker::Local,
            "github" => {
                let pieces: Vec<_> = options.provider.repo.split('/').collect();
                if pieces.len() != 2
                    || pieces.iter().any(|s| {
                        s.is_empty()
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                    })
                {
                    return Err(Error::Invalid(
                        "GitHub provider.repo must be owner/repository".into(),
                    ));
                }
                Tracker::Github {
                    repo: options.provider.repo,
                }
            }
            "linear" => {
                let project_slug = if options.provider.project_slug.is_empty() {
                    options.project_slug
                } else {
                    options.provider.project_slug
                };
                if project_slug.trim().is_empty() {
                    return Err(Error::Invalid("Linear project_slug is required".into()));
                }
                let api_key = if options.provider.api_key.is_empty() {
                    options.api_key
                } else {
                    options.provider.api_key
                };
                let token_env = if api_key.is_empty() {
                    "LINEAR_API_KEY".into()
                } else if let Some(name) = api_key.strip_prefix('$') {
                    if name.is_empty()
                        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    {
                        return Err(Error::Invalid(
                            "Linear credential reference is invalid".into(),
                        ));
                    }
                    name.into()
                } else {
                    // A literal credential stays in its user-owned source file, never in SQLite.
                    String::new()
                };
                Tracker::Linear {
                    project_slug,
                    token_env,
                }
            }
            _ => {
                return Err(Error::Invalid(
                    "supported trackers are local, github and linear".into(),
                ));
            }
        };
        let agent = definition.agent;
        if agent.max_concurrent_agents == 0
            || agent.max_turns == 0
            || definition.polling.interval_ms == 0
            || agent.max_retry_backoff_ms == 0
            || definition.codex.command.trim().is_empty()
            || definition.codex.turn_timeout_ms == 0
            || definition.codex.read_timeout_ms == 0
        {
            return Err(Error::Invalid(
                "workflow concurrency, polling or retry limits are invalid".into(),
            ));
        }
        if definition
            .hooks
            .timeout_ms
            .is_some_and(|timeout| timeout == 0)
            || agent
                .max_concurrent_agents_by_state
                .values()
                .any(|limit| *limit == 0)
        {
            return Err(Error::Invalid(
                "hook timeout or state concurrency limit is invalid".into(),
            ));
        }
        let prompt = if prompt.trim().is_empty() {
            "Work on {{ issue.identifier }}: {{ issue.title }}\n{{ issue.description }}".into()
        } else {
            prompt.trim().to_owned()
        };
        let path = path.to_string_lossy().into_owned();
        let github = matches!(tracker, Tracker::Github { .. });
        Ok(Self {
            id: identity(&path),
            directory: Path::new(&path)
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            path: path.clone(),
            tracker,
            active_states: if options.active_states.is_empty() {
                if github {
                    vec!["open".into()]
                } else {
                    vec!["Todo".into(), "In Progress".into()]
                }
            } else {
                options.active_states
            },
            terminal_states: if options.terminal_states.is_empty() {
                vec![
                    "Done".into(),
                    "Closed".into(),
                    "Cancelled".into(),
                    "Canceled".into(),
                    "Duplicate".into(),
                ]
            } else {
                options.terminal_states
            },
            required_labels: options.required_labels,
            poll_interval_ms: definition.polling.interval_ms,
            max_concurrent_agents: agent.max_concurrent_agents,
            max_concurrent_agents_by_state: agent
                .max_concurrent_agents_by_state
                .into_iter()
                .map(|(state, limit)| (state.trim().to_lowercase(), limit))
                .collect(),
            max_turns: agent.max_turns,
            max_retry_backoff_ms: agent.max_retry_backoff_ms,
            stall_timeout_ms: u64::try_from(definition.codex.stall_timeout_ms).unwrap_or(0),
            approval_mode: agent.approval_mode,
            hooks: definition.hooks,
            prompt,
            digest: identity(&source),
            workspace_root: definition
                .workspace
                .root
                .map(|root| resolve_root(&root, Path::new(&path).parent().unwrap()))
                .transpose()?,
            codex: definition.codex,
            tracker_endpoint: options.provider.endpoint.or(options.endpoint),
            tracker_assignee: options.provider.assignee.or(options.assignee),
            provider_options: options.provider.extra,
        })
    }

    /// Resolve credentials at IO time; source literals are not included in serialized workflows.
    pub fn linear_credential(&self) -> Result<String, Error> {
        let Tracker::Linear { token_env, .. } = &self.tracker else {
            return Err(Error::Invalid("workflow does not use Linear".into()));
        };
        let token = if token_env.is_empty() {
            let source = read_source(Path::new(&self.path))?.replace("\r\n", "\n");
            let (yaml, _) = frontmatter(&source);
            let definition: Definition = serde_yaml::from_str(yaml)
                .map_err(|_| Error::Invalid("workflow YAML is invalid".into()))?;
            if definition.tracker.provider.api_key.is_empty() {
                definition.tracker.api_key
            } else {
                definition.tracker.provider.api_key
            }
        } else {
            std::env::var(token_env).unwrap_or_default()
        };
        if token.trim().is_empty() || token.starts_with('$') {
            return Err(Error::Invalid(
                "Linear credential is unavailable; reload the workflow if its reference changed"
                    .into(),
            ));
        }
        Ok(token)
    }

    pub fn active(&self, issue: &Issue) -> bool {
        issue.local
            || (contains(&self.active_states, &issue.state)
                && !contains(&self.terminal_states, &issue.state)
                && issue.dispatchable
                && self
                    .required_labels
                    .iter()
                    .all(|label| !label.trim().is_empty() && contains(&issue.labels, label)))
    }

    pub fn dispatchable(&self, issue: &Issue) -> bool {
        self.active(issue)
            && (!issue.state.trim().eq_ignore_ascii_case("todo")
                || issue
                    .blocked_by
                    .values()
                    .all(|state| contains(&self.terminal_states, state)))
    }

    pub fn terminal(&self, issue: &Issue) -> bool {
        !issue.local && contains(&self.terminal_states, &issue.state)
    }

    pub fn render(&self, issue: &Issue, attempt: Option<u32>) -> Result<String, Error> {
        let template = liquid::ParserBuilder::with_stdlib()
            .build()
            .map_err(|_| Error::Invalid("workflow template engine is unavailable".into()))?
            .parse(&self.prompt)
            .map_err(|_| Error::Invalid("workflow template is invalid".into()))?;
        let mut issue = serde_json::to_value(issue)?;
        issue["blocked_by"] = serde_json::to_value(
            issue["blocked_by"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, state)| serde_json::json!({"id": id, "state": state}))
                .collect::<Vec<_>>(),
        )?;
        let globals = liquid::to_object(&serde_json::json!({"issue":issue,"attempt":attempt}))
            .map_err(|_| Error::Invalid("workflow template context is invalid".into()))?;
        template
            .render(&globals)
            .map_err(|_| Error::Invalid("workflow template references an unknown variable".into()))
    }
}

fn resolve_root(value: &str, directory: &Path) -> Result<String, Error> {
    let expanded = if let Some(name) = value.strip_prefix('$') {
        std::env::var(name).map_err(|_| {
            Error::Invalid("workspace root environment variable is unavailable".into())
        })?
    } else if let Some(rest) = value.strip_prefix("~/") {
        format!(
            "{}/{}",
            std::env::var("HOME")
                .map_err(|_| Error::Invalid("home directory is unavailable".into()))?,
            rest
        )
    } else {
        value.into()
    };
    let path = std::path::PathBuf::from(expanded);
    let path = if path.is_absolute() {
        path
    } else {
        directory.join(path)
    };
    Ok(path.to_string_lossy().into_owned())
}

fn contains(values: &[String], value: &str) -> bool {
    values
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(value.trim()))
}

fn read_source(path: &Path) -> Result<String, Error> {
    let file =
        File::open(path).map_err(|_| Error::Invalid("workflow file is unavailable".into()))?;
    if !file
        .metadata()
        .map_err(|_| Error::Invalid("workflow metadata is unavailable".into()))?
        .is_file()
    {
        return Err(Error::Invalid("workflow must be a regular file".into()));
    }
    let mut source = String::new();
    file.take(262_145)
        .read_to_string(&mut source)
        .map_err(|_| Error::Invalid("workflow must be UTF-8".into()))?;
    if source.len() > 262_144 {
        return Err(Error::Invalid("workflow exceeds 256 KiB".into()));
    }
    Ok(source)
}

fn frontmatter(source: &str) -> (&str, &str) {
    if let Some(front) = source.strip_prefix("---\n") {
        front
            .split_once("\n---\n")
            .or_else(|| front.strip_suffix("\n---").map(|yaml| (yaml, "")))
            .unwrap_or((front, ""))
    } else {
        ("", source)
    }
}
