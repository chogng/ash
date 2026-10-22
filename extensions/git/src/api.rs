use crate::model;
use crate::model::Configuration;
use crate::model::Repository;
use crate::model::Status;
use crate::paths::RepoPath;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::client::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;

#[derive(Clone)]
pub struct Api {
    pub client: Client,
    pub background: BackgroundClient,
    pub services: external_ext_sdk::services::Services,
    pub interaction: std::sync::OnceLock<std::sync::Weak<crate::GitRuntime>>,
    english: Value,
    translated: Value,
    output: external_ext_sdk::window::OutputChannel,
}
impl Api {
    pub fn new(
        client: Client,
        background: BackgroundClient,
        services: external_ext_sdk::services::Services,
        language: Option<&str>,
        output: external_ext_sdk::window::OutputChannel,
    ) -> Self {
        Self {
            client,
            background,
            services,
            interaction: Default::default(),
            output,
            english: serde_json::from_str(include_str!("../package.nls.json"))
                .expect("valid bundled messages"),
            translated: if language
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("zh"))
            {
                serde_json::from_str(include_str!("../package.nls.zh-CN.json"))
                    .expect("valid bundled Chinese messages")
            } else {
                Value::Null
            },
        }
    }
    pub fn text(&self, key: &str, arguments: &[&str]) -> String {
        let mut message = self.translated[key]
            .as_str()
            .or_else(|| self.english[key].as_str())
            .unwrap_or(key)
            .to_owned();
        for (index, argument) in arguments.iter().enumerate() {
            message = message.replace(&format!("{{{index}}}"), argument);
        }
        message
    }
    pub fn editor(
        &self,
        payload: Value,
        token: Option<&CancellationToken>,
    ) -> Result<Value, ExtensionError> {
        match token {
            Some(token) => self.client.editor_operation(payload, token),
            None => self.background.editor_operation(payload),
        }
    }
    pub fn configuration(
        &self,
        resource: Option<String>,
        token: Option<&CancellationToken>,
    ) -> Result<Configuration, ExtensionError> {
        Ok(Configuration(match token {
            Some(token) => self.client.get_configuration("git", resource, token)?,
            None => self.background.get_configuration("git", resource)?,
        }))
    }
    /// The adapter adds invocation policy and decodes structured backend failures before models see them.
    fn request(
        &self,
        method: &str,
        mut params: Value,
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<Value, ExtensionError> {
        let synchronizing = params
            .as_object_mut()
            .and_then(|params| params.remove("synchronizing"))
            == Some(json!(true));
        let cancellable = configuration.boolean("supportCancellation", false) && method != "push";
        let credential_account_id = params
            .as_object_mut()
            .and_then(|params| params.remove("credentialAccountId"))
            .and_then(|value| value.as_str().map(str::to_owned));
        if !matches!(method, "readConfig" | "updateConfig") {
            let paths = match configuration.value("path") {
                Value::String(path) => vec![path.clone()],
                Value::Array(paths) => paths
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            };
            if !paths.is_empty() || configuration.number("similarityThreshold", 50) != 50 {
                params["client"] = json!({ "paths": paths, "similarityThreshold": configuration.number("similarityThreshold",50) });
            }
        }
        let mut interaction_lease = None;
        if let Some(token) = token.filter(|_| configuration.boolean("useIntegratedAskPass", true)) {
            if matches!(
                method,
                "fetch" | "pull" | "push" | "clone" | "commit" | "execute" | "executeCommand"
            ) {
                let connection = self
                    .interaction
                    .get()
                    .and_then(std::sync::Weak::upgrade)
                    .map(|runtime| runtime.interaction_connection())
                    .transpose()?;
                if let Some(connection) = connection {
                    let mut hosts = Vec::new();
                    if method == "clone" {
                        if let Some(host) = params["url"]
                            .as_str()
                            .and_then(|value| url::Url::parse(value).ok())
                            .filter(|uri| uri.scheme() == "https")
                            .and_then(|uri| uri.host_str().map(str::to_owned))
                        {
                            hosts.push(host);
                        }
                    } else if matches!(
                        method,
                        "fetch" | "pull" | "push" | "execute" | "executeCommand"
                    ) && params["repositoryId"].is_string()
                    {
                        if let Ok(refs) = self.request(
                            "historyRefs",
                            json!({"repositoryId":params["repositoryId"]}),
                            configuration,
                            Some(token),
                        ) {
                            hosts = refs["remotes"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|remote| {
                                    remote["identity"]["host"].as_str().map(str::to_owned)
                                })
                                .collect();
                        }
                    }
                    let id = crate::commands::random_id()?;
                    connection
                        .scopes
                        .lock()
                        .map_err(|_| invalid("Git scope failed"))?
                        .insert(
                            id.clone(),
                            crate::interaction::Scope {
                                configuration: configuration.clone(),
                                token: token.clone(),
                                hosts,
                                credential_account_id: credential_account_id.clone(),
                            },
                        );
                    if !params["client"].is_object() {
                        params["client"] = json!({"paths":[]});
                    }
                    params["client"]["interaction"] = json!({"address":connection.address.to_string(),"token":connection.token,"scope":id});
                    interaction_lease = Some(crate::interaction::ScopeLease { connection, id });
                }
            }
        }
        // The lease must remain live until the Git process has returned its terminal result.
        let _interaction_lease = interaction_lease;
        let logged = configuration
            .strings("commandsToLog")
            .iter()
            .any(|command| command == method);
        let started = std::time::Instant::now();
        if logged {
            let _ = self.output.append_line(format!("[Git] {method} started"));
        }
        let result = (|| -> Result<Value, ExtensionError> {
            let (wire_method, wire_params) = if token.is_some()
                && matches!(method, "fetch" | "pull" | "push")
            {
                let operation = match method {
                    "fetch" => json!({"kind":"fetch","mode":params["mode"]}),
                    "pull" => {
                        let mut operation = json!({"kind":"pull","mode":params["mode"].as_str().unwrap_or("configured")});
                        if let Some(head) = params.get("expectedHead") {
                            operation["expectedHead"] = head.clone();
                        }
                        operation
                    }
                    _ => json!({"kind":"push","expectedHead":params["expectedHead"]}),
                };
                (
                    "runTransport",
                    json!({"operationId":crate::commands::random_id()?,"repositoryId":params["repositoryId"],"client":params["client"],"transport":params["transport"],"operation":operation}),
                )
            } else {
                (method, params)
            };
            let value = match token {
                Some(token)
                    if wire_method == "runTransport"
                        && (configuration.boolean("showProgress", true) || cancellable) =>
                {
                    self.client.request_backend_with_progress(
                        "git.repository",
                        wire_method,
                        wire_params,
                        external_ext_sdk::client::ProgressOptions {
                            title: self.text(
                                if synchronizing && cancellable {
                                    "git.syncCancellation"
                                } else {
                                    "git.operationProgress"
                                },
                                &[],
                            ),
                            cancellable,
                        },
                        token,
                    )?
                }
                Some(token) => self.client.request_backend(
                    "git.repository",
                    wire_method,
                    wire_params,
                    token,
                )?,
                None => {
                    self.background
                        .request_backend("git.repository", wire_method, wire_params)?
                }
            };
            if let Some(error) = value.get("backendError") {
                let message = if error["name"] == "GitUnavailable" {
                    self.text("git.unavailable", &[])
                } else {
                    error["message"]
                        .as_str()
                        .filter(|message| !message.is_empty())
                        .or_else(|| error["name"].as_str())
                        .unwrap_or("Unavailable")
                        .to_owned()
                };
                return Err(ExtensionError::new(
                    if error["name"] == "RequestCancelled" {
                        HostErrorCode::Cancelled
                    } else {
                        HostErrorCode::Internal
                    },
                    message,
                ));
            }
            Ok(value)
        })();
        if logged {
            let _ = self.output.append_line(format!(
                "[Git] {method} {} ({} ms)",
                if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                },
                started.elapsed().as_millis()
            ));
        }
        result
    }
    pub fn warning(
        &self,
        key: &str,
        arguments: &[&str],
        token: Option<&CancellationToken>,
    ) -> Result<(), ExtensionError> {
        let message = self.text(key, arguments);
        match token {
            Some(token) => self.client.show_message(
                external_ext_sdk::client::MessageSeverity::Warning,
                message,
                token,
            ),
            None => self
                .background
                .show_message(external_ext_sdk::client::MessageSeverity::Warning, message),
        }
    }
    pub fn information(&self, key: &str, token: &CancellationToken) -> Result<(), ExtensionError> {
        self.client.show_message(
            external_ext_sdk::client::MessageSeverity::Information,
            self.text(key, &[]),
            token,
        )
    }
    pub fn status(
        &self,
        repository: &Repository,
        token: Option<&CancellationToken>,
    ) -> Result<Status, ExtensionError> {
        decode(self.request(
            "status",
            json!({"repositoryId": repository.descriptor.id}),
            &repository.configuration,
            token,
        )?)
    }
    pub fn installation(
        &self,
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<crate::model::Installation, ExtensionError> {
        let response = self.request("version", json!({}), configuration, token)?;
        decode(response["installation"].clone())
    }
    pub fn discover(
        &self,
        folders: &[crate::model::DiscoveryFolder],
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<crate::model::Discovery, ExtensionError> {
        decode(self.request(
            "repositories",
            json!({"folders": folders, "includeStatus": true}),
            configuration,
            token,
        )?)
    }
    pub fn catalog(
        &self,
        repository: &Repository,
        token: Option<&CancellationToken>,
    ) -> Result<crate::model::Catalog, ExtensionError> {
        decode(self.request(
            "catalog",
            json!({"repositoryId": repository.descriptor.id}),
            &repository.configuration,
            token,
        )?)
    }
    pub fn changes_summary(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<model::ChangesSummary, ExtensionError> {
        #[derive(serde::Deserialize)]
        struct Response {
            status: Status,
            statistics: model::CommitStatistics,
        }
        let response: Response = decode(self.repository_request(
            repository,
            "textDiff",
            json!({"projection":"statistics"}),
            token,
        )?)?;
        let files = response.status.changes.len();
        Ok(model::ChangesSummary {
            files,
            additions: response.statistics.additions,
            deletions: response.statistics.deletions,
            partial: response.statistics.files < files,
        })
    }
    pub fn change_file(
        &self,
        repository: &Repository,
        path: &crate::paths::RepoPath,
        comparison: crate::model::Comparison,
        token: &CancellationToken,
    ) -> Result<crate::model::FileComparison, ExtensionError> {
        decode(self.repository_request(
            repository,
            "changeFile",
            json!({"path":path,"comparison":comparison}),
            token,
        )?)
    }
    pub fn index_diff(
        &self,
        repository: &Repository,
        path: &crate::paths::RepoPath,
        comparison: crate::model::Comparison,
        token: &CancellationToken,
    ) -> Result<crate::model::IndexDiff, ExtensionError> {
        decode(self.repository_request(
            repository,
            "indexDiff",
            json!({"path":path,"comparison":comparison}),
            token,
        )?)
    }
    pub fn edit_index(
        &self,
        repository: &Repository,
        path: &crate::paths::RepoPath,
        comparison: crate::model::Comparison,
        reviewed: &crate::model::IndexDiff,
        selection: crate::model::IndexSelection,
        token: &CancellationToken,
    ) -> Result<crate::model::Mutation, ExtensionError> {
        decode(self.repository_request(repository, "editIndex", json!({"path":path,"comparison":comparison,"expectedOriginal":reviewed.original,"expectedModified":reviewed.modified,"selection":selection}), token)?)
    }
    pub fn mutate_paths(
        &self,
        repository: &Repository,
        operation: crate::model::PathMutation,
        paths: &[crate::paths::RepoPath],
        token: &CancellationToken,
    ) -> Result<crate::model::Mutation, ExtensionError> {
        let method = match operation {
            crate::model::PathMutation::Stage => "stage",
            crate::model::PathMutation::Unstage => "unstage",
            crate::model::PathMutation::Discard => "discardWorktree",
        };
        decode(self.repository_request(repository, method, json!({"paths":paths}), token)?)
    }
    pub fn review_removal(
        &self,
        repository: &Repository,
        paths: &[crate::paths::RepoPath],
        token: &CancellationToken,
    ) -> Result<crate::model::RemovalReview, ExtensionError> {
        decode(self.repository_request(
            repository,
            "reviewRemoval",
            json!({"paths":paths}),
            token,
        )?)
    }
    pub fn remove_files(
        &self,
        repository: &Repository,
        review: crate::model::RemovalReview,
        mode: crate::model::RemovalMode,
        token: &CancellationToken,
    ) -> Result<crate::model::Mutation, ExtensionError> {
        let entries: Vec<_> = review.entries.into_iter().map(|entry| entry.file).collect();
        decode(self.repository_request(
            repository,
            "removeFiles",
            json!({"entries":entries,"expectedHead":review.head,"mode":mode}),
            token,
        )?)
    }
    pub fn execute_command(
        &self,
        repository: &Repository,
        command: crate::model::RepositoryCommand,
        account: Option<&str>,
        token: &CancellationToken,
    ) -> Result<crate::model::ExecutedCommand, ExtensionError> {
        decode(self.repository_request(
            repository,
            "executeCommand",
            json!({"command":command,"credentialAccountId":account}),
            token,
        )?)
    }
    pub fn commit(
        &self,
        repository: &Repository,
        intent: crate::model::CommitIntent,
        token: &CancellationToken,
    ) -> Result<crate::model::Committed, ExtensionError> {
        decode(self.repository_request(repository, "commit", json!(intent), token)?)
    }
    pub fn attribution(
        &self,
        repository: &Repository,
        scope: crate::model::CommitScope,
        evidence: &[crate::model::EditorEvidence],
        token: &CancellationToken,
    ) -> Result<crate::model::Attribution, ExtensionError> {
        decode(self.repository_request(
            repository,
            "aiContribution",
            json!({"scope":scope,"editorEvidence":evidence}),
            token,
        )?)
    }
    pub fn transport(
        &self,
        repository: &Repository,
        operation: crate::model::TransportOperation<'_>,
        options: &crate::model::TransportOptions,
        synchronizing: bool,
        token: &CancellationToken,
    ) -> Result<crate::model::TransportResult, ExtensionError> {
        use crate::model::TransportOperation;
        let (method, mut params) = match operation {
            TransportOperation::Fetch(mode) => ("fetch", json!({"mode":mode})),
            TransportOperation::Pull {
                mode,
                expected_head,
            } => {
                let mut params = json!({"mode":mode});
                if let Some(head) = expected_head {
                    params["expectedHead"] = json!(head);
                }
                ("pull", params)
            }
            TransportOperation::Push { expected_head } => {
                ("push", json!({"expectedHead":expected_head}))
            }
        };
        params["transport"] = json!(options);
        params["synchronizing"] = json!(synchronizing);
        decode(self.repository_request(repository, method, params, token)?)
    }
    fn repository_request(
        &self,
        repository: &Repository,
        method: &str,
        mut params: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        params["repositoryId"] = json!(repository.descriptor.id);
        let mut result = self.request(method, params, &repository.configuration, Some(token))?;
        if result.get("status").is_some()
            && repository.configuration.number("similarityThreshold", 50) != 50
        {
            result["status"] = serde_json::to_value(self.status(repository, Some(token))?)
                .map_err(|_| invalid("Invalid Git view snapshot"))?;
        }
        Ok(result)
    }
    pub fn graph(
        &self,
        repository: &Repository,
        query: &model::GraphQuery,
        token: &CancellationToken,
    ) -> Result<model::GraphPage, ExtensionError> {
        decode(self.repository_request(repository, "graph", json!(query), token)?)
    }
    pub fn history_refs(
        &self,
        repository: &Repository,
        token: Option<&CancellationToken>,
    ) -> Result<model::HistoryRefs, ExtensionError> {
        decode(self.request(
            "historyRefs",
            json!({"repositoryId":repository.descriptor.id}),
            &repository.configuration,
            token,
        )?)
    }
    pub fn branches(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<model::Branches, ExtensionError> {
        decode(self.repository_request(repository, "branches", json!({}), token)?)
    }
    pub fn commit_message(
        &self,
        repository: &Repository,
        object_id: &str,
        token: &CancellationToken,
    ) -> Result<model::CommitMessage, ExtensionError> {
        decode(self.repository_request(
            repository,
            "commitMessage",
            json!({"objectId":object_id}),
            token,
        )?)
    }
    pub fn commit_details(
        &self,
        repository: &Repository,
        object_id: &str,
        token: &CancellationToken,
    ) -> Result<model::CommitDetails, ExtensionError> {
        decode(self.repository_request(
            repository,
            "commitDetails",
            json!({"objectId":object_id}),
            token,
        )?)
    }
    pub fn commit_changes(
        &self,
        repository: &Repository,
        object_id: &str,
        token: &CancellationToken,
    ) -> Result<model::CommitChanges, ExtensionError> {
        decode(self.repository_request(
            repository,
            "commitChanges",
            json!({"objectId":object_id}),
            token,
        )?)
    }
    pub fn compare_changes(
        &self,
        repository: &Repository,
        object_id: &str,
        base: &str,
        mode: model::CompareMode,
        token: &CancellationToken,
    ) -> Result<model::ComparedChanges, ExtensionError> {
        decode(self.repository_request(
            repository,
            "compareChanges",
            json!({"objectId":object_id,"baseReference":base,"mode":mode}),
            token,
        )?)
    }
    pub fn commit_file(
        &self,
        repository: &Repository,
        object_id: &str,
        path: &RepoPath,
        parent: Option<&str>,
        token: &CancellationToken,
    ) -> Result<model::FileComparison, ExtensionError> {
        let mut params = json!({"objectId":object_id,"path":path});
        if let Some(parent) = parent {
            params["parentObjectId"] = json!(parent);
        }
        decode(self.repository_request(repository, "commitFile", params, token)?)
    }
    pub fn file_history(
        &self,
        repository: &Repository,
        path: &RepoPath,
        token: &CancellationToken,
    ) -> Result<model::FileHistory, ExtensionError> {
        decode(self.repository_request(repository, "fileHistory", json!({"path":path}), token)?)
    }
    pub fn conflict_file(
        &self,
        repository: &Repository,
        path: &RepoPath,
        token: &CancellationToken,
    ) -> Result<model::ConflictFile, ExtensionError> {
        decode(self.repository_request(repository, "conflictFile", json!({"path":path}), token)?)
    }
    pub fn complete_conflict(
        &self,
        repository: &Repository,
        resolution: model::ResolveConflict,
        token: &CancellationToken,
    ) -> Result<model::Mutation, ExtensionError> {
        decode(self.repository_request(repository, "completeConflict", json!(resolution), token)?)
    }
    pub fn ignored(
        &self,
        repository: &Repository,
        path: &RepoPath,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            ignored_paths: Vec<RepoPath>,
        }
        let result: Response = decode(self.repository_request(
            repository,
            "checkIgnore",
            json!({"operationId":crate::commands::random_id()?,"paths":[path]}),
            token,
        )?)?;
        Ok(!result.ignored_paths.is_empty())
    }
    pub fn blame(
        &self,
        repository: &Repository,
        path: &RepoPath,
        line: usize,
        contents: Option<&str>,
        token: Option<&CancellationToken>,
    ) -> Result<model::BlameLine, ExtensionError> {
        decode(self.request("blame", json!({"repositoryId":repository.descriptor.id,"path":path,"line":line,"contents":contents,"ignoreWhitespace":repository.configuration.boolean("blame.ignoreWhitespace",false)}), &repository.configuration, token)?)
    }
    pub fn create_branch(
        &self,
        repository: &Repository,
        name: &str,
        token: &CancellationToken,
    ) -> Result<model::Branches, ExtensionError> {
        decode(self.repository_request(repository, "createBranch", json!({"name":name}), token)?)
    }
    pub fn delete_branch(
        &self,
        repository: &Repository,
        name: &str,
        token: &CancellationToken,
    ) -> Result<model::Branches, ExtensionError> {
        decode(self.repository_request(repository, "deleteBranch", json!({"name":name}), token)?)
    }
    pub fn switch_branch(
        &self,
        repository: &Repository,
        name: &str,
        token: &CancellationToken,
    ) -> Result<model::Mutation, ExtensionError> {
        decode(self.repository_request(repository, "switchBranch", json!({"name":name,"pullBeforeCheckout":repository.configuration.boolean("pullBeforeCheckout",false)}), token)?)
    }
    pub fn upstream_rewritten(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            upstream_rewritten: bool,
        }
        let result: Response =
            decode(self.repository_request(repository, "pullPreflight", json!({}), token)?)?;
        Ok(result.upstream_rewritten)
    }
    pub fn read_settings(
        &self,
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<model::SettingsSnapshot, ExtensionError> {
        decode(self.request("readConfig", json!({}), configuration, token)?)
    }
    pub fn update_settings(
        &self,
        revision: u64,
        settings: &model::SharedSettings,
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<model::SettingsUpdated, ExtensionError> {
        decode(self.request("updateConfig", json!({"commandId":crate::commands::random_id()?,"expectedRevision":revision,"git":settings}), configuration, token)?)
    }
    pub fn initialize(
        &self,
        folder: &model::WorkspaceFolder,
        branch: &str,
        configuration: &Configuration,
        token: &CancellationToken,
    ) -> Result<model::Discovery, ExtensionError> {
        decode(self.request(
            "initialize",
            json!({"dirId":folder.id,"initialBranch":branch}),
            configuration,
            Some(token),
        )?)
    }
    pub fn clone_repository(
        &self,
        url: &str,
        parent: &crate::paths::ResourceUri,
        reference: Option<&str>,
        account: Option<&str>,
        configuration: &Configuration,
        token: &CancellationToken,
    ) -> Result<crate::paths::ResourceUri, ExtensionError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            repository_path: String,
        }
        let result: Response = decode(self.request("clone", json!({"url":url,"parentPath":parent.execution_path(),"reference":reference,"credentialAccountId":account}), configuration, Some(token))?)?;
        crate::paths::target_path(parent, &result.repository_path)
    }
    pub fn create_worktree(
        &self,
        repository: &Repository,
        name: &str,
        token: &CancellationToken,
    ) -> Result<crate::paths::ResourceUri, ExtensionError> {
        #[derive(serde::Deserialize)]
        struct Response {
            path: String,
        }
        let result: Response = decode(self.repository_request(repository, "createWorktree", json!({"name":name,"includeFiles":repository.configuration.strings("worktreeIncludeFiles"),"symlinkFolders":repository.configuration.strings("worktreeSymlinkFolders")}), token)?)?;
        crate::paths::target_path(&repository.root_uri, &result.path)
    }
    pub fn resolve_worktree(
        &self,
        repository: &Repository,
        checkout: &crate::paths::ResourceUri,
        token: &CancellationToken,
    ) -> Result<crate::paths::ResourceUri, ExtensionError> {
        #[derive(serde::Deserialize)]
        struct Response {
            path: String,
        }
        let result: Response = decode(self.repository_request(
            repository,
            "resolveWorktree",
            json!({"checkoutRoot":checkout.execution_path()}),
            token,
        )?)?;
        crate::paths::target_path(&repository.root_uri, &result.path)
    }
    pub fn worktrees(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<Vec<model::Worktree>, ExtensionError> {
        decode_worktrees(
            &repository.root_uri,
            self.repository_request(repository, "worktrees", json!({}), token)?,
        )
    }
    pub fn delete_worktree(
        &self,
        repository: &Repository,
        checkout: &crate::paths::ResourceUri,
        token: &CancellationToken,
    ) -> Result<Vec<model::Worktree>, ExtensionError> {
        decode_worktrees(&repository.root_uri, self.repository_request(repository, "deleteWorktree", json!({"commandId":crate::commands::random_id()?,"checkoutRoot":checkout.execution_path(),"mode":"unbound"}), token)?)
    }
    pub fn confirm(
        &self,
        key: &str,
        arguments: &[&str],
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        Ok(self.editor(
            json!({"method":"confirm", "title":self.text("git.confirmOperation", &[]), "message":self.text(key,arguments), "primaryButton":self.text("git.confirmOperationButton", &[])}),
            Some(token),
        )?["confirmed"]
            .as_bool()
            .unwrap_or(false))
    }
    pub fn input(
        &self,
        key: &str,
        initial: &str,
        token: &CancellationToken,
    ) -> Result<Option<String>, ExtensionError> {
        Ok(self
            .editor(
                json!({"method":"input", "title":self.text(key,&[]), "value":initial}),
                Some(token),
            )?
            .as_str()
            .map(str::to_owned))
    }
    pub fn pick(
        &self,
        key: &str,
        items: Vec<(String, Option<String>)>,
        token: &CancellationToken,
    ) -> Result<Option<usize>, ExtensionError> {
        self.client.show_quick_pick_items(
            items
                .into_iter()
                .map(
                    |(label, description)| external_ext_sdk::client::QuickPickItem {
                        label,
                        description,
                        detail: None,
                    },
                )
                .collect(),
            self.text(key, &[]),
            token,
        )
    }
}
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T, ExtensionError> {
    serde_json::from_value(value).map_err(|error| {
        ExtensionError::new(
            HostErrorCode::InvalidRequest,
            format!("Invalid Git response: {error}"),
        )
    })
}
pub fn file_uri(
    root: &crate::paths::ResourceUri,
    path: &crate::paths::RepoPath,
) -> Result<String, ExtensionError> {
    path.resolve(root).map(|uri| uri.to_string())
}
pub fn invalid(message: &str) -> ExtensionError {
    ExtensionError::new(HostErrorCode::InvalidRequest, message)
}

fn decode_worktrees(
    root: &crate::paths::ResourceUri,
    response: Value,
) -> Result<Vec<model::Worktree>, ExtensionError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Checkout {
        checkout_root: String,
        path: String,
        branch: Option<String>,
        head: String,
        current: bool,
        state: model::WorktreeState,
    }
    #[derive(serde::Deserialize)]
    struct Response {
        worktrees: Vec<Checkout>,
    }
    let response: Response = decode(response)?;
    response
        .worktrees
        .into_iter()
        .map(|checkout| {
            Ok(model::Worktree {
                checkout_root: crate::paths::target_path(root, &checkout.checkout_root)?,
                path: crate::paths::target_path(root, &checkout.path)?,
                branch: checkout.branch,
                head: checkout.head,
                current: checkout.current,
                state: checkout.state,
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
