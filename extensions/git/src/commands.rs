use crate::GitRuntime;
use crate::api::decode;
use crate::api::file_uri;
use crate::api::invalid;
use crate::model::Head;
use crate::model::Repository;
use crate::model::Status;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::ConfigurationTarget;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

impl GitRuntime {
    pub(crate) fn command(
        &self,
        command: &str,
        arguments: &[Value],
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        token.check_cancelled()?;
        if matches!(
            command,
            "git.finishTerminalEdit" | "git.cancelTerminalEdit" | "git.commit"
        ) && self.finish_terminal_edit(command == "git.cancelTerminalEdit", token)?
        {
            return Ok(Value::Null);
        }
        if matches!(command, "git.finishTerminalEdit" | "git.cancelTerminalEdit") {
            return Ok(Value::Null);
        }
        match command {
            "git.readSettings" => {
                let configuration = self.lock().configuration.clone();
                self.migrate_shared_settings(&configuration, Some(token))?;
                let current =
                    self.api
                        .request("readConfig", json!({}), &configuration, Some(token))?;
                return Ok(
                    json!({"autoFetch":match current["git"]["autofetch"].as_str() {Some("off")=>json!(false),Some("all")=>json!("all"),_=>json!(true)},"autoFetchPeriod":current["git"]["autofetchPeriod"],"rebaseWhenSync":current["git"]["rebaseWhenSync"]}),
                );
            }
            "git.updateRebaseWhenSync" | "git.updateAutoFetch" | "git.updateAutoFetchPeriod" => {
                return self.update_shared_setting(
                    command,
                    arguments.first().unwrap_or(&Value::Null),
                    token,
                );
            }
            "git.clone" => return self.clone_repository(arguments, token),
            "git.init" => return self.initialize_repository(token),
            "git.getRepositoryContexts" => {
                // Commands can activate Git before the initial SCM callback has discovered folders.
                self.refresh(Some(token))?;
                let repositories: Vec<_> = self.lock().repositories.values().cloned().collect();

                let mut values = vec![];
                for repository in repositories {
                    let status = self.api.status(&repository, Some(token))?;
                    let graph = self.api.repository_request(
                        &repository,
                        "graph",
                        json!({"limit":1}),
                        token,
                    )?;
                    values.push(json!({"id":repository.descriptor.id,"label":repository.descriptor.label,"path":repository.descriptor.path,"root":repository.root_uri,"head":status.head,"remotes":graph["remotes"],"uncommittedChanges":status.changes.len()}));
                }
                return Ok(json!(values));
            }
            "git.showOutput" => {
                return self.api.editor(
                    json!({"method":"output","channelId":"git","action":"show"}),
                    Some(token),
                );
            }
            _ => {}
        }
        if command == "git.refresh" {
            self.lock().discovery_signature = None;
        }
        // Commands observe the current scoped policy immediately, even between background polls.
        self.refresh(Some(token))?;
        let context = arguments.first().unwrap_or(&Value::Null);
        let id = context
            .as_str()
            .or_else(|| context["repositoryId"].as_str())
            .or_else(|| context["repository"]["provider"]["id"].as_str());
        let repository = self.repository(id)?;
        if command == "git.refresh" {
            self.accept_status(self.api.status(&repository, Some(token))?);
            let catalog =
                decode(
                    self.api
                        .repository_request(&repository, "catalog", json!({}), token)?,
                )?;
            if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
                current.catalog = Some(catalog);
            }
            self.publish()?;
            return Ok(Value::Null);
        }
        if command == "git.openChangesSource" {
            let scope = arguments
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("uncommitted");
            return self.show_multi_diff(&repository, scope, token);
        }
        if matches!(
            command,
            "git.openStagedChanges" | "git.openUnstagedChanges" | "git.openUncommittedChanges"
        ) {
            return self.show_multi_diff(
                &repository,
                match command {
                    "git.openStagedChanges" => "staged",
                    "git.openUnstagedChanges" => "unstaged",
                    _ => "uncommitted",
                },
                token,
            );
        }
        if command == "git.openChanges" {
            return self.open_reviewed_changes(context, token);
        }
        if command == "git.openFile" {
            return self.open_working_file(context, token);
        }
        if command == "git.timeline" {
            return self.timeline(&repository, token);
        }
        if command == "git.showBlame" {
            return self.show_blame(&repository, token);
        }
        if command.starts_with("git.diff.") {
            return self.diff_action(&repository, command, context, token);
        }
        if matches!(
            command,
            "git.stageHunk"
                | "git.stageSelectedRanges"
                | "git.unstageHunk"
                | "git.unstageSelectedRanges"
        ) {
            return self.select_index_change(&repository, command, token);
        }
        // Serialize mutations per repository while leaving draft updates and other repositories live.
        let gate = {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| invalid("Git operation state failed"))?;
            Arc::clone(
                operations
                    .entry(repository.descriptor.id.clone())
                    .or_default(),
            )
        };
        let _guard = gate
            .lock()
            .map_err(|_| invalid("Git operation state failed"))?;
        token.check_cancelled()?;
        if let Some(repository) = self.lock().repositories.get_mut(&repository.descriptor.id) {
            repository.operation = Some(
                if matches!(
                    command,
                    "git.sync"
                        | "git.syncRebase"
                        | "git.pull"
                        | "git.pullRebase"
                        | "ash.git.pull"
                        | "git.push"
                        | "git.pushForce"
                        | "ash.git.push"
                        | "git.publish"
                ) {
                    crate::model::RepositoryOperation::Preparing
                } else {
                    crate::model::RepositoryOperation::Other
                },
            );
            repository.error.clear();
        }
        self.publish()?;
        let outcome = if context["type"] == "historyItemViewModel" {
            self.graph_action(&repository, command, context, token)
        } else {
            self.run_command(command, arguments, &repository, token)
        };
        // A failed or cancelled Git operation can still update refs, the index or
        // integration state. Refresh independently of its cancelled invocation token.
        if outcome.is_err() {
            if let Ok(status) = self.api.status(&repository, None) {
                self.accept_status(status);
            }
        }
        if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
            current.operation = None;
            current.pending_paths = None;
            if let Err(error) = &outcome {
                if error.code != external_ext_sdk::HostErrorCode::Cancelled {
                    current.error = error.message.clone();
                }
            }
        }
        let _ = self.publish();
        if matches!(command, "git.sync" | "git.syncRebase")
            && outcome
                .as_ref()
                .is_err_and(|error| error.code == external_ext_sdk::HostErrorCode::Cancelled)
        {
            return Ok(Value::Null);
        }
        outcome
    }
    fn run_command(
        &self,
        command: &str,
        arguments: &[Value],
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        match command {
            id if id.starts_with("git.commit") => self.commit(repository, id, token),
            "git.stageAll" | "git.unstageAll" | "git.cleanAll" | "git.stageFile"
            | "git.unstageFile" | "git.discardFile" => self.mutate_paths(
                repository,
                command,
                arguments.get(1).and_then(Value::as_str),
                token,
            ),
            "git.deleteFile" => {
                self.delete_file(repository, arguments.get(1).and_then(Value::as_str), token)
            }
            "git.fetch" | "git.fetchAll" | "git.pull" | "git.pullRebase" | "git.push"
            | "git.pushForce" | "git.sync" | "git.syncRebase" | "ash.git.pull" | "ash.git.push"
            | "git.publish" => self.remote(repository, command, token),
            "git.branch" | "git.branchForCommit" | "git.switchBranch" | "git.deleteBranch" => {
                self.branch(repository, command, token)
            }
            "git.createWorktree" | "git.openWorktree" | "git.deleteWorktree" => {
                self.worktree(repository, command, token)
            }
            "git.executeRepositoryCommand" => {
                let intent = arguments
                    .get(1)
                    .filter(|value| value.is_object())
                    .ok_or_else(|| invalid("Missing Git command intent"))?;
                let account = credential_account(arguments.get(2))?;
                let result = self.api.repository_request(
                    repository,
                    "executeCommand",
                    json!({"command":intent,"credentialAccountId":account}),
                    token,
                )?;
                self.accept_status(decode(result["status"].clone())?);
                Ok(result)
            }
            "git.undoCommit" => {
                let status = self.api.status(repository, Some(token))?;
                let Some(head) = status.head.object_id() else {
                    return Ok(Value::Null);
                };
                if !self.api.confirm("git.undoCommitConfirm", &[head], token)? {
                    return Ok(Value::Null);
                }
                self.execute(
                    repository,
                    json!({"kind":"undoCommit","expectedHead":head}),
                    token,
                )
            }
            _ => self.repository_command(repository, command, token),
        }
    }
    pub(crate) fn execute(
        &self,
        repository: &Repository,
        command: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let result = self.api.repository_request(
            repository,
            "executeCommand",
            json!({"command":command}),
            token,
        )?;
        self.accept_status(decode(result["status"].clone())?);
        Ok(result)
    }
    fn mutate_paths(
        &self,
        repository: &Repository,
        command: &str,
        path: Option<&str>,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let method = if command.starts_with("git.unstage") {
            "unstage"
        } else if command == "git.cleanAll" || command == "git.discardFile" {
            "discardWorktree"
        } else {
            "stage"
        };
        // Whole-file index operations target the paths already shown by the owning
        // repository model. Their backend result returns the authoritative status;
        // querying it twice first delays the existing optimistic group update.
        // Discard still reviews fresh state before removing working-tree content.
        let status = if matches!(method, "stage" | "unstage") {
            match self.repository(Some(&repository.descriptor.id))?.status {
                Some(status) => status,
                None => self.api.status(repository, Some(token))?,
            }
        } else {
            self.api.status(repository, Some(token))?
        };
        let paths: Vec<_> = status
            .changes
            .iter()
            .filter(|change| path.is_none_or(|path| change.path == path))
            .filter(|change| match method {
                "stage" => change.conflicted || change.worktree_status != "unmodified",
                "unstage" => !change.conflicted && change.index_status != "unmodified",
                _ => !change.conflicted && change.worktree_status != "unmodified",
            })
            .flat_map(|change| {
                let mut paths = vec![change.path.clone()];
                if method != "discardWorktree" {
                    if let Some(path) = &change.original_path {
                        paths.push(path.clone());
                    }
                }
                paths
            })
            .collect();
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        let removal = if method == "discardWorktree" {
            let untracked: Vec<_> = status
                .changes
                .iter()
                .filter(|change| {
                    change.worktree_status == "untracked" && paths.contains(&change.path)
                })
                .map(|change| change.path.clone())
                .collect();
            if untracked.is_empty() {
                None
            } else {
                Some(self.api.repository_request(
                    repository,
                    "reviewRemoval",
                    json!({"paths":untracked}),
                    token,
                )?)
            }
        } else {
            None
        };
        if method == "discardWorktree"
            && !self
                .api
                .confirm("git.action.discardConfirm", &[&paths.join(", ")], token)?
        {
            return Ok(Value::Null);
        }
        for change in status
            .changes
            .iter()
            .filter(|change| change.conflicted && paths.contains(&change.path))
        {
            let dirty = self.api.editor(
                json!({"method":"dirty","uri":file_uri(&repository.root_uri,&change.path)?}),
                Some(token),
            )?;
            if dirty
                .as_array()
                .is_some_and(|copies| copies.iter().any(|copy| copy["isDirty"] == true))
            {
                return Err(invalid(
                    &self.api.text("git.action.saveConflict", &[&change.path]),
                ));
            }
        }
        if method == "discardWorktree" {
            let current = self.api.status(repository, Some(token))?;
            if current.stream_instance_id != status.stream_instance_id
                || current.revision != status.revision
            {
                return Err(invalid(&self.api.text("git.reopenComparison", &[])));
            }
        }
        if matches!(method, "stage" | "unstage")
            && repository.configuration.boolean("optimisticUpdate", true)
        {
            if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
                current.pending_paths = Some(crate::model::PendingPaths {
                    operation: if method == "stage" {
                        crate::model::PathOperation::Stage
                    } else {
                        crate::model::PathOperation::Unstage
                    },
                    paths: paths.iter().cloned().collect(),
                });
            }
            self.publish()?;
        }
        let mut paths = paths;
        let mut removed = None;
        if let Some(review) = removal {
            let entries: Vec<_> = review["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| entry["file"].clone())
                .collect();
            paths.retain(|path| !entries.iter().any(|entry| entry["path"] == *path));
            let result=self.api.repository_request(repository,"removeFiles",json!({"entries":entries,"expectedHead":review["head"],"mode":if repository.configuration.boolean("discardUntrackedChangesToTrash",true) {"trash"} else {"permanent"}}),token)?;
            self.accept_status(decode(result["status"].clone())?);
            removed = Some(result);
        }
        let result = if paths.is_empty() {
            removed.unwrap_or(Value::Null)
        } else {
            self.api
                .repository_request(repository, method, json!({"paths":paths}), token)?
        };
        self.accept_status(decode(result["status"].clone())?);
        self.complete_operation(repository, token)?;
        Ok(result)
    }
    fn delete_file(
        &self,
        repository: &Repository,
        path: Option<&str>,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let path = if let Some(path) = path {
            path.to_owned()
        } else {
            let editor = self
                .api
                .editor(json!({"method":"activeEditor"}), Some(token))?;
            crate::changes::relative_resource(
                repository,
                editor["input"]["resource"].as_str().unwrap_or_default(),
            )
            .ok_or_else(|| invalid(&self.api.text("git.diff.noFile", &[])))?
        };
        let dirty = self.api.editor(
            json!({"method":"dirty","uri":file_uri(&repository.root_uri,&path)?}),
            Some(token),
        )?;
        if dirty
            .as_array()
            .is_some_and(|copies| copies.iter().any(|copy| copy["isDirty"] == true))
        {
            return Err(invalid(&self.api.text("git.action.saveConflict", &[&path])));
        }
        let review = self.api.repository_request(
            repository,
            "reviewRemoval",
            json!({"paths":[path]}),
            token,
        )?;
        let clean_committed = review["entries"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .all(|entry| entry["committed"] == true && entry["changed"] == false)
        });
        if (!clean_committed
            || repository
                .configuration
                .boolean("confirmCommittedDelete", true))
            && !self.api.confirm("git.deleteConfirm", &[&path], token)?
        {
            return Ok(Value::Null);
        }
        let entries: Vec<_> = review["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| entry["file"].clone())
            .collect();
        let result = self.api.repository_request(
            repository,
            "removeFiles",
            json!({"entries":entries,"expectedHead":review["head"],"mode":"trash"}),
            token,
        )?;
        self.accept_status(decode(result["status"].clone())?);
        self.complete_operation(repository, token)?;
        Ok(result)
    }
    fn commit(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = &repository.configuration;
        let mut before = self.api.status(repository, Some(token))?;
        if before.changes.iter().any(|change| change.conflicted) {
            return Err(invalid(&self.api.text("git.resolveConflicts", &[])));
        }
        let locally_protected = before.head.name().is_some_and(|name| {
            config
                .strings("branchProtection")
                .iter()
                .any(|pattern| wildcard(pattern, name))
        });
        let remotely_protected = if let Some(branch) = before
            .head
            .name()
            .filter(|_| config.text("branchProtectionPrompt", "alwaysPrompt") != "alwaysCommit")
        {
            let graph =
                self.api
                    .repository_request(repository, "graph", json!({"limit":1}), token)?;
            let remotes = graph["remotes"].as_array().cloned().unwrap_or_default();
            if remotes
                .iter()
                .any(|remote| remote["identity"]["provider"] == "github")
            {
                // The optional provider supplies GitHub rules. Network/permission failures stop this
                // commit instead of silently treating a protected branch as unprotected.
                self.api
                    .client
                    .execute_command(
                        "github.isBranchProtected",
                        vec![json!(branch), json!(remotes)],
                        token,
                    )?
                    .as_bool()
                    .ok_or_else(|| invalid("Invalid branch protection response"))?
            } else {
                false
            }
        } else {
            false
        };
        if (locally_protected || remotely_protected)
            && config.text("branchProtectionPrompt", "alwaysPrompt") != "alwaysCommit"
        {
            let create = if config.text("branchProtectionPrompt", "alwaysPrompt")
                == "alwaysCommitToNewBranch"
            {
                true
            } else {
                match self.api.pick(
                    "git.protectedBranchPrompt",
                    vec![
                        (self.api.text("git.protectedCommitCurrent", &[]), None),
                        (self.api.text("git.protectedCreateBranch", &[]), None),
                    ],
                    token,
                )? {
                    Some(index) => index == 1,
                    None => return Ok(Value::Null),
                }
            };
            if create {
                if self.branch(repository, "git.branchForCommit", token)? == false {
                    return Ok(Value::Null);
                }
                before = self.api.status(repository, Some(token))?;
            }
        }
        let captured = self.repository(Some(&repository.descriptor.id))?;
        let revision = captured.input_revision;
        let mut message = captured.draft.trim().to_owned();
        if command.ends_with("FromChanges") {
            let Some(value) = self.api.input("git.commitMessageTitle", &message, token)? else {
                return Ok(Value::Null);
            };
            message = value.trim().to_owned();
        }
        if message.is_empty() && config.boolean("useEditorAsCommitInput", true) {
            let uri = commit_uri(&repository.descriptor.id);
            let existing = self.api.editor(
                json!({"method":"readEditorDocument","uri":uri}),
                Some(token),
            )?;
            if existing["text"].is_string()
                && captured
                    .commit_editor_head
                    .as_ref()
                    .is_some_and(|head| !head.same_target(&before.head))
            {
                return Err(invalid(&self.api.text("git.commitHeadChanged", &[])));
            }
            if let Some(text) = existing["text"].as_str() {
                message = strip_comments(text);
            } else {
                let mut text = format!(
                    "\n# {}\n",
                    self.api.text("git.commitEditorInstructions", &[])
                );
                if config.boolean("verboseCommit", false) {
                    for change in before.changes.iter().take(50) {
                        let file=self.api.repository_request(repository,"changeFile",json!({"path":change.path,"comparison":if change.index_status!="unmodified" {"staged"} else {"unstaged"}}),token)?;
                        text.push_str(&format!("# --- {}\n", change.path));
                        for (side, prefix) in [("original", "-"), ("modified", "+")] {
                            if let Some(contents) = file[side]["text"].as_str() {
                                for line in
                                    contents.chars().take(100000).collect::<String>().lines()
                                {
                                    text.push_str(&format!("# {prefix}{line}\n"));
                                }
                            }
                        }
                        if text.len() > 500000 {
                            break;
                        }
                    }
                }
                self.api.editor(json!({"method":"openEditorDocument","uri":uri,"label":self.api.text("git.commitEditorTitle",&[]),"text":text}),Some(token))?;
                if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
                    current.commit_editor_head = Some(before.head.clone());
                }
                return Ok(Value::Null);
            }
        }
        if message.is_empty() {
            return Err(invalid(&self.api.text("git.commitMessageRequired", &[])));
        }
        let staged = before
            .changes
            .iter()
            .any(|change| change.index_status != "unmodified");
        let mut scope = "staged";
        if command.contains("All") || command.ends_with("FromChanges") {
            let scopes = if command.ends_with("FromChanges") {
                vec!["staged", "tracked", "includeUntracked"]
            } else {
                vec!["tracked", "includeUntracked"]
            };
            let Some(index) = self.api.pick(
                "git.commitScope",
                scopes
                    .iter()
                    .map(|scope| {
                        (
                            self.api.text(
                                match *scope {
                                    "staged" => "git.commitStaged",
                                    "tracked" => "git.commitTracked",
                                    _ => "git.commitIncludingUntracked",
                                },
                                &[],
                            ),
                            None,
                        )
                    })
                    .collect(),
                token,
            )?
            else {
                return Ok(Value::Null);
            };
            scope = scopes[index];
        } else if !staged && !command.contains("Staged") && command != "git.commitEmpty" {
            let smart = config.boolean("enableSmartCommit", false);
            if !smart
                && (!config.boolean("suggestSmartCommit", true)
                    || !self.api.confirm("git.smartCommitConfirm", &[], token)?)
            {
                return Ok(Value::Null);
            }
            scope = if config.text("smartCommitChanges", "all") == "tracked" {
                "tracked"
            } else {
                "includeUntracked"
            };
        }
        let skip_hooks = command == "git.commitNoVerify";
        if skip_hooks
            && (!config.boolean("allowNoVerifyCommit", false)
                || config.boolean("confirmNoVerifyCommit", true)
                    && !self.api.confirm("git.noVerifyConfirm", &[], token)?)
        {
            return Ok(Value::Null);
        }
        if command == "git.commitEmpty"
            && config.boolean("confirmEmptyCommits", true)
            && !self.api.confirm("git.emptyCommitConfirm", &[], token)?
        {
            return Ok(Value::Null);
        }
        let paths: Vec<_> = before
            .changes
            .iter()
            .filter(|change| {
                scope == "includeUntracked"
                    || scope == "tracked" && change.worktree_status != "untracked"
                    || change.index_status != "unmodified"
            })
            .map(|change| file_uri(&repository.root_uri, &change.path))
            .collect::<Result<_, _>>()?;
        if !self.api.editor(json!({"method":"prepareRepositoryOperation","root":repository.root_uri,"paths":paths,"saveMode":config.text("promptToSaveFilesBeforeCommit","always"),"diagnostics":if config.boolean("diagnosticsCommitHook.enabled",false) {config.value("diagnosticsCommitHook.sources").clone()} else {Value::Null}}),Some(token))?.as_bool().unwrap_or(false) {return Ok(Value::Null)}
        let current = self.api.status(repository, Some(token))?;
        if !current.head.same_target(&before.head)
            || self
                .repository(Some(&repository.descriptor.id))?
                .input_revision
                != revision
        {
            return Err(invalid(&self.api.text("git.commitHeadChanged", &[])));
        }
        let attribution = config.text("addAICoAuthor", "off");
        if attribution != "off" {
            let edited = self.api.editor(
                json!({"method":"aiEditedResources","root":repository.root_uri,"mode":attribution}),
                Some(token),
            )?;
            let evidence: Vec<_> = edited
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    crate::changes::relative_resource(repository, entry["uri"].as_str()?)
                        .map(|path| json!({"path":path,"text":entry["text"]}))
                })
                .collect();
            let provenance = self.api.repository_request(
                repository,
                "aiContribution",
                json!({"scope":scope,"editorEvidence":evidence}),
                token,
            )?;
            if provenance["present"] == true {
                let author = provenance["coAuthor"]
                    .as_str()
                    .unwrap_or("Ash AI <ai@localhost>");
                let trailer = format!("Co-authored-by: {author}");
                if !message
                    .lines()
                    .any(|line| line.eq_ignore_ascii_case(&trailer))
                {
                    message.push_str(&format!("\n\n{trailer}"));
                }
            }
        }
        let mut params = json!({"message":message,"scope":scope,"hooks":if skip_hooks {"skip"} else {"run"},"identity":if config.boolean("requireGitUserConfig",true) {"configured"} else {"inferred"}});
        if !matches!(before.head, Head::Unborn { .. }) {
            params["expectedHead"] = json!(before.head);
        }
        if command.contains("Amend") {
            params["mode"] = json!("amend");
        }
        if command.contains("Signed") || config.boolean("alwaysSignOff", false) {
            params["signoff"] = json!("add");
        }
        if config.boolean("enableCommitSigning", false) {
            params["signing"] = json!("required");
        }
        if command == "git.commitEmpty" {
            params["empty"] = json!("allow");
        }
        let result = self
            .api
            .repository_request(repository, "commit", params, token)?;
        self.accept_status(decode(result["status"].clone())?);
        if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
            if current.input_revision == revision {
                current.draft.clear();
                current.input_revision += 1;
            }
            current.commit_editor_head = None;
        }
        let uri = commit_uri(&repository.descriptor.id);
        let existing = self.api.editor(
            json!({"method":"readEditorDocument","uri":uri}),
            Some(token),
        )?;
        if existing["text"]
            .as_str()
            .is_some_and(|text| strip_comments(text) == message)
        {
            self.api.editor(
                json!({"method":"closeEditorDocument","uri":uri,"expectedText":existing["text"]}),
                Some(token),
            )?;
        }
        self.complete_operation(repository, token)?;
        let post = if command == "git.commitAndPushFromChanges" {
            "push"
        } else {
            config.text("postCommitCommand", "none")
        };
        if command == "git.commitAndPushFromChanges"
            && config.boolean("rememberPostCommitCommand", false)
        {
            self.api.client.update_configuration(
                "git.postCommitCommand",
                json!("push"),
                ConfigurationTarget::User,
                token,
            )?;
        }
        if matches!(post, "push" | "sync") {
            self.remote(
                repository,
                if post == "push" {
                    "git.push"
                } else {
                    "git.sync"
                },
                token,
            )?;
        }
        Ok(result)
    }
    fn complete_operation(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        if repository
            .configuration
            .boolean("closeDiffOnOperation", false)
        {
            self.api.editor(
                json!({"method":"closeRelatedDiffs","root":repository.root_uri}),
                Some(token),
            )?;
        }
        Ok(())
    }
    fn transport(&self, repository: &Repository) -> Value {
        let configuration = &repository.configuration;
        json!({"prune":configuration.boolean("pruneOnFetch",false),"pullTags":configuration.boolean("pullTags",true),"replaceTags":configuration.boolean("replaceTagsWhenPull",false),"autoStash":configuration.boolean("autoStash",false),"followTags":false,"pushMode":"normal"})
    }
    fn remote(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = &repository.configuration;
        let before = self.api.status(repository, Some(token))?;
        let mut transport = self.transport(repository);
        if command == "git.publish"
            || matches!(command, "git.sync" | "git.syncRebase") && before.head.upstream().is_none()
        {
            let Head::Branch {
                name, object_id, ..
            } = &before.head
            else {
                return Ok(Value::Null);
            };
            let catalog = self
                .api
                .repository_request(repository, "catalog", json!({}), token)?;
            let remotes = catalog["remotes"].as_array().cloned().unwrap_or_default();
            let mut choices = remotes.clone();
            if remotes.len() > 1 {
                choices.push(json!(self.api.text("git.menu.addRemote", &[])));
            }
            let Some(index) = self.choose("git.publishChooseRemote", &choices, "", token)? else {
                return Ok(Value::Null);
            };
            let remote = if index == remotes.len() {
                if self
                    .repository_command(repository, "git.addRemote", token)?
                    .is_null()
                {
                    return Ok(Value::Null);
                }
                let catalog =
                    self.api
                        .repository_request(repository, "catalog", json!({}), token)?;
                let Some(remote) = catalog["remotes"]
                    .as_array()
                    .and_then(|values| values.iter().find(|value| !remotes.contains(value)))
                else {
                    return Ok(Value::Null);
                };
                remote.clone()
            } else {
                remotes[index].clone()
            };
            self.start_remote_operation(repository)?;
            let result=self.execute(repository,json!({"kind":"publishBranch","remote":remote,"name":name,"branch":name,"expectedHead":object_id}),token)?;
            self.notify_pushed(repository, token)?;
            return Ok(result);
        }
        if command == "git.pushForce" {
            if !config.boolean("allowForcePush", false) {
                return Err(invalid(&self.api.text("git.forcePushDisabled", &[])));
            }
            if config.boolean("confirmForcePush", true)
                && !self.api.confirm(
                    "git.forcePushConfirm",
                    &[before.head.name().unwrap_or("HEAD")],
                    token,
                )?
            {
                return Ok(Value::Null);
            }
            transport["pushMode"] = json!(if !config.boolean("useForcePushWithLease", true) {
                "force"
            } else if config.boolean("useForcePushIfIncludes", true) {
                "leaseIfIncludes"
            } else {
                "lease"
            });
        }
        let sync = matches!(command, "git.sync" | "git.syncRebase");
        let sync_catalog = if sync {
            self.api
                .repository_request(repository, "catalog", json!({}), token)?
        } else {
            Value::Null
        };
        if sync {
            let catalog = decode(sync_catalog.clone())?;
            if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
                current.catalog = Some(catalog);
            }
        }
        if sync && sync_catalog["upstreamReadOnly"] != true && config.boolean("confirmSync", true) {
            let choice = self.api.editor(
                json!({"method":"prompt", "severity":"warning",
                    "message":self.api.text("git.syncConfirm", &[&before.head.upstream().expect("sync has upstream").name]),
                    "buttons":[self.api.text("git.syncConfirm.ok", &[]), self.api.text("git.syncConfirm.neverAgain", &[])]}),
                Some(token),
            )?;
            match choice["selection"].as_u64() {
                Some(0) => {}
                Some(1) => self.api.client.update_configuration(
                    "git.confirmSync",
                    json!(false),
                    ConfigurationTarget::User,
                    token,
                )?,
                None if choice["selection"].is_null() => return Ok(Value::Null),
                _ => return Err(invalid("Invalid Git confirmation selection")),
            }
        }

        let current = self.api.status(repository, Some(token))?;
        if !current.head.same_target(&before.head)
            || current.head.upstream().map(|upstream| &upstream.name)
                != before.head.upstream().map(|upstream| &upstream.name)
        {
            return Err(invalid(&self.api.text("git.commitHeadChanged", &[])));
        }
        if !matches!(command, "git.fetch" | "git.fetchAll") {
            self.start_remote_operation(repository)?;
        }
        let result = if matches!(command, "git.fetch" | "git.fetchAll") {
            let catalog = self
                .api
                .repository_request(repository, "catalog", json!({}), token)?;
            let remotes = catalog["remotes"].as_array().cloned().unwrap_or_default();
            let mode = if command == "git.fetchAll" {
                json!("all")
            } else if remotes.len() > 1 {
                let Some(index) = self.choose("git.fetchChooseRemote", &remotes, "", token)? else {
                    return Ok(Value::Null);
                };
                json!({"remote":remotes[index]})
            } else {
                json!("default")
            };
            self.api.repository_request(
                repository,
                "fetch",
                json!({"mode":mode,"transport":transport}),
                token,
            )?
        } else if matches!(command, "git.push" | "ash.git.push" | "git.pushForce") {
            self.api.repository_request(
                repository,
                "push",
                json!({"transport":transport,"expectedHead":before.head}),
                token,
            )?
        } else {
            if config.boolean("fetchOnPull", false) {
                self.api.repository_request(
                    repository,
                    "fetch",
                    json!({"mode":"all","transport":transport,"synchronizing":sync}),
                    token,
                )?;
            }
            if !config.boolean("ignoreRebaseWarning", false) {
                let preflight =
                    self.api
                        .repository_request(repository, "pullPreflight", json!({}), token)?;
                if preflight["upstreamRewritten"] == true {
                    let choice = self.api.editor(json!({"method":"prompt", "severity":"warning",
                        "message":self.api.text("git.rewrittenPullConfirm", &[]),
                        "buttons":[self.api.text("git.rewrittenPull.always", &[]), self.api.text("git.rewrittenPull.once", &[])]}), Some(token))?;
                    match choice["selection"].as_u64() {
                        Some(0) => self.api.client.update_configuration(
                            "git.ignoreRebaseWarning",
                            json!(true),
                            ConfigurationTarget::User,
                            token,
                        )?,
                        Some(1) => {}
                        None if choice["selection"].is_null() => return Ok(Value::Null),
                        _ => return Err(invalid("Invalid Git pull warning selection")),
                    }
                }
            }

            let mut pull = json!({"mode":if command.ends_with("Rebase") {"rebase"} else if sync {"sync"} else {"configured"},"transport":transport,"synchronizing":sync});
            if sync {
                pull["expectedHead"] = serde_json::to_value(&before.head)
                    .map_err(|_| invalid("Invalid Git sync target"))?;
            }
            let mut pulled =
                self.api
                    .repository_request(repository, "pull", pull.clone(), token)?;
            if pulled["outcome"]["kind"] == "tagConflict" {
                self.accept_status(decode(pulled["status"].clone())?);
                let tags: Vec<String> = decode(pulled["outcome"]["tags"].clone())?;
                let message = self.api.text("git.tagConflict", &[&tags.join(", ")]);
                if config.boolean("replaceTagsWhenPull", false) {
                    return Err(invalid(&message));
                }
                let choice = self.api.editor(json!({"method":"prompt", "severity":"error", "message":message,
                    "buttons":[self.api.text("git.tagConflict.replace", &[]), self.api.text("git.tagConflict.always", &[])]}), Some(token))?;
                match choice["selection"].as_u64() {
                    Some(0) => {}
                    Some(1) => self.api.client.update_configuration(
                        "git.replaceTagsWhenPull",
                        json!(true),
                        ConfigurationTarget::User,
                        token,
                    )?,
                    None if choice["selection"].is_null() => return Ok(pulled),
                    _ => return Err(invalid("Invalid Git tag conflict selection")),
                }
                pull["transport"]["replaceTags"] = json!(true);
                pulled = self
                    .api
                    .repository_request(repository, "pull", pull, token)?;
                if pulled["outcome"]["kind"] == "tagConflict" {
                    return Err(invalid(&message));
                }
            }
            self.accept_status(decode(pulled["status"].clone())?);
            if sync {
                let status: Status = decode(pulled["status"].clone())?;
                if status.head.name() != before.head.name()
                    || status.head.upstream().map(|upstream| &upstream.name)
                        != before.head.upstream().map(|upstream| &upstream.name)
                    || status.changes.iter().any(|change| change.conflicted)
                    || status
                        .head
                        .upstream()
                        .is_none_or(|upstream| upstream.ahead == 0)
                    || sync_catalog["upstreamReadOnly"] == true
                {
                    return Ok(pulled);
                }
                transport["followTags"] = json!(config.boolean("followTagsWhenSync", false));
                self.api.repository_request(
                    repository,
                    "push",
                    json!({"transport":transport,"expectedHead":status.head}),
                    token,
                )?
            } else {
                pulled
            }
        };
        self.accept_status(decode(result["status"].clone())?);
        if matches!(
            command,
            "git.push" | "ash.git.push" | "git.pushForce" | "git.sync" | "git.syncRebase"
        ) {
            self.notify_pushed(repository, token)?;
        }
        Ok(result)
    }
    fn start_remote_operation(&self, repository: &Repository) -> Result<(), ExtensionError> {
        if let Some(current) = self.lock().repositories.get_mut(&repository.descriptor.id) {
            current.operation = Some(crate::model::RepositoryOperation::Synchronize);
        }
        self.publish()
    }
    fn notify_pushed(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        if repository
            .configuration
            .boolean("showPushSuccessNotification", false)
        {
            self.api.client.show_message(
                external_ext_sdk::client::MessageSeverity::Information,
                self.api
                    .text("git.pushSucceeded", &[&repository.descriptor.label]),
                token,
            )?;
        }
        Ok(())
    }
    pub(crate) fn choose(
        &self,
        key: &str,
        values: &[Value],
        label_field: &str,
        token: &CancellationToken,
    ) -> Result<Option<usize>, ExtensionError> {
        if values.is_empty() {
            return Ok(None);
        }
        if values.len() == 1 {
            return Ok(Some(0));
        }
        self.api.pick(
            key,
            values
                .iter()
                .map(|value| {
                    (
                        (if label_field.is_empty() {
                            value.as_str()
                        } else {
                            value[label_field].as_str()
                        })
                        .unwrap_or_default()
                        .to_owned(),
                        None,
                    )
                })
                .collect(),
            token,
        )
    }
    pub(crate) fn branch(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = &repository.configuration;
        if command == "git.branch" || command == "git.branchForCommit" {
            let prefix = config.text("branchPrefix", "");
            let random = if config.boolean("branchRandomName.enable", false) {
                random_branch(config)?
            } else {
                String::new()
            };
            let pattern = config.text("branchValidationRegex", "");
            let expression = if pattern.is_empty() {
                None
            } else {
                Some(
                    regex::Regex::new(pattern)
                        .map_err(|_| invalid(&self.api.text("git.invalidBranchRegex", &[])))?,
                )
            };
            let mut value = format!("{prefix}{random}");
            let mut validation: Option<String> = None;
            let name = loop {
                token.check_cancelled()?;
                let entered=self.api.editor(json!({"method":"input","title":self.api.text("git.newBranchName",&[]),"value":value,"validationMessage":validation}),Some(token))?;
                let Some(entered) = entered.as_str() else {
                    return Ok(json!(false));
                };
                let entered = entered
                    .trim()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(config.text("branchWhitespaceChar", "-"));
                value = if entered.starts_with(prefix) {
                    entered
                } else {
                    format!("{prefix}{entered}")
                };
                if expression
                    .as_ref()
                    .is_some_and(|expression| !expression.is_match(&value))
                {
                    validation = Some(self.api.text("git.branchNameDoesNotMatch", &[]));
                    continue;
                }
                break value;
            };
            self.api
                .repository_request(repository, "createBranch", json!({"name":name}), token)?;
            if command == "git.branchForCommit" {
                let status=self.api.repository_request(repository,"switchBranch",json!({"name":name,"pullBeforeCheckout":config.boolean("pullBeforeCheckout",false)}),token)?;
                self.accept_status(decode(status["status"].clone())?);
            }
            Ok(json!(true))
        } else if command == "git.deleteBranch" {
            let branches = self
                .api
                .repository_request(repository, "branches", json!({}), token)?;
            let values: Vec<_> = branches["branches"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|value| value["current"] != true)
                .cloned()
                .collect();
            let Some(index) = self.choose("git.selectBranch", &values, "name", token)? else {
                return Ok(Value::Null);
            };
            if !self.api.confirm(
                "git.deleteBranchConfirm",
                &[values[index]["name"].as_str().unwrap_or_default()],
                token,
            )? {
                return Ok(Value::Null);
            }
            self.api.repository_request(
                repository,
                "deleteBranch",
                json!({"name":values[index]["name"]}),
                token,
            )
        } else {
            let graph = self
                .api
                .repository_request(repository, "historyRefs", json!({}), token)?;
            let types = if config.strings("checkoutType").is_empty() {
                vec!["local".into(), "remote".into(), "tags".into()]
            } else {
                config.strings("checkoutType")
            };
            let mut refs: Vec<_> = graph["references"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|reference| {
                    types.iter().any(|kind| {
                        kind == match reference["kind"].as_str().unwrap_or_default() {
                            "localBranch" => "local",
                            "remoteBranch" => "remote",
                            _ => "tags",
                        }
                    })
                })
                .cloned()
                .collect();
            if config.text("branchSortOrder", "committerdate") == "alphabetically" {
                refs.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
            }
            let branches = graph["branches"].as_array().cloned().unwrap_or_default();
            let items = refs
                .iter()
                .map(|reference| {
                    let branch = branches
                        .iter()
                        .find(|branch| branch["name"] == reference["name"]);
                    let description = if reference["current"] == true {
                        Some(self.api.text("git.currentBranch", &[]))
                    } else {
                        branch.and_then(|branch| branch["upstream"].as_str().map(str::to_owned))
                    };
                    let detail =
                        if branch.is_some_and(|branch| branch["checkedOutElsewhere"] == true) {
                            Some(self.api.text("git.branchWorktreeOccupancy", &[]))
                        } else {
                            config
                                .boolean("showReferenceDetails", true)
                                .then(|| {
                                    reference["objectId"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .chars()
                                        .take(config.number("commitShortHashLength", 7) as usize)
                                        .collect()
                                })
                                .filter(|detail: &String| !detail.is_empty())
                        };
                    external_ext_sdk::client::QuickPickItem {
                        label: reference["name"].as_str().unwrap_or_default().into(),
                        description,
                        detail,
                    }
                })
                .collect();
            let Some(index) = self.api.client.show_quick_pick_items(
                items,
                self.api.text("git.selectBranch", &[]),
                token,
            )?
            else {
                return Ok(Value::Null);
            };
            let reference = &refs[index];
            if reference["current"] == true {
                return Ok(Value::Null);
            }
            match reference["kind"].as_str() {
                Some("localBranch") => {
                    let result=self.api.repository_request(repository,"switchBranch",json!({"name":reference["name"],"pullBeforeCheckout":config.boolean("pullBeforeCheckout",false)}),token)?;
                    self.accept_status(decode(result["status"].clone())?);
                    Ok(result)
                }
                Some("remoteBranch") => {
                    let name = reference["name"].as_str().unwrap_or_default();
                    let remote = reference["remoteName"].as_str().unwrap_or_default();
                    self.execute(repository,json!({"kind":"checkoutRemoteBranch","reference":name,"name":name.strip_prefix(&format!("{remote}/")).unwrap_or(name)}),token)
                }
                _ => self.execute(
                    repository,
                    json!({"kind":"checkoutDetached","objectId":reference["objectId"]}),
                    token,
                ),
            }
        }
    }
    fn repository_command(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let kind = match command {
            "git.stashApply" => "applyStash",
            "git.stashPop" => "popStash",
            "git.stashDrop" => "dropStash",
            value => value.strip_prefix("git.").unwrap_or(value),
        };
        let mut intent = json!({"kind":kind});
        match kind {
            "continue" | "abort" => {
                let catalog =
                    self.api
                        .repository_request(repository, "catalog", json!({}), token)?;
                if catalog["operation"].is_null() {
                    return Ok(Value::Null);
                }
                if kind == "abort" && !self.api.confirm("git.abortConfirm", &[], token)? {
                    return Ok(Value::Null);
                }
                intent["operation"] = catalog["operation"].clone();
            }
            "merge" | "rebase" | "cherryPick" => {
                let graph = self.api.repository_request(
                    repository,
                    "graph",
                    json!({"limit":200}),
                    token,
                )?;
                let values = graph[if kind == "cherryPick" {
                    "commits"
                } else {
                    "references"
                }]
                .as_array()
                .cloned()
                .unwrap_or_default();
                let Some(index) = self.choose(
                    if kind == "cherryPick" {
                        "git.chooseCommit"
                    } else {
                        "git.chooseIntegrationRef"
                    },
                    &values,
                    if kind == "cherryPick" {
                        "subject"
                    } else {
                        "name"
                    },
                    token,
                )?
                else {
                    return Ok(Value::Null);
                };
                intent["reference"] = values[index]["objectId"].clone();
            }
            "renameBranch" => {
                let branches =
                    self.api
                        .repository_request(repository, "branches", json!({}), token)?;
                let values = branches["branches"].as_array().cloned().unwrap_or_default();
                let Some(index) = self.choose("git.chooseBranch", &values, "name", token)? else {
                    return Ok(Value::Null);
                };
                let Some(name) = self.api.input(
                    "git.renameBranchName",
                    values[index]["name"].as_str().unwrap_or_default(),
                    token,
                )?
                else {
                    return Ok(Value::Null);
                };
                intent["name"] = values[index]["name"].clone();
                intent["newName"] = json!(name);
            }
            "deleteRemoteBranch" => {
                let graph =
                    self.api
                        .repository_request(repository, "graph", json!({"limit":1}), token)?;
                let values: Vec<_> = graph["references"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|value| {
                        value["kind"] == "remoteBranch" && value["remoteName"].is_string()
                    })
                    .cloned()
                    .collect();
                let Some(index) = self.choose("git.chooseRemoteBranch", &values, "name", token)?
                else {
                    return Ok(Value::Null);
                };
                let remote = values[index]["remoteName"].as_str().unwrap_or_default();
                let name = values[index]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .strip_prefix(&format!("{remote}/"))
                    .unwrap_or_default();
                if !self
                    .api
                    .confirm("git.deleteRemoteBranchConfirm", &[name, remote], token)?
                {
                    return Ok(Value::Null);
                }
                intent["remote"] = json!(remote);
                intent["name"] = json!(name);
            }
            "stash" => {
                let status = self.api.status(repository, Some(token))?;
                let paths: Vec<_> = status
                    .changes
                    .iter()
                    .filter(|change| change.index_status != "unmodified")
                    .map(|change| file_uri(&repository.root_uri, &change.path))
                    .collect::<Result<_, _>>()?;
                if self.api.editor(json!({"method":"prepareRepositoryOperation","root":repository.root_uri,"paths":paths,"saveMode":repository.configuration.text("promptToSaveFilesBeforeStash","always"),"diagnostics":null}),Some(token))?!=true {return Ok(Value::Null)}
                let initial = if repository
                    .configuration
                    .boolean("useCommitInputAsStashMessage", false)
                {
                    repository.draft.as_str()
                } else {
                    ""
                };
                let Some(message) = self.api.input("git.stashMessage", initial, token)? else {
                    return Ok(Value::Null);
                };
                let Some(index) = self.api.pick(
                    "git.stashScope",
                    vec![
                        (self.api.text("git.stashTracked", &[]), None),
                        (self.api.text("git.stashUntracked", &[]), None),
                    ],
                    token,
                )?
                else {
                    return Ok(Value::Null);
                };
                intent["message"] = json!(message);
                intent["mode"] = json!(if index == 0 {
                    "tracked"
                } else {
                    "includeUntracked"
                });
            }
            "applyStash" | "popStash" | "dropStash" => {
                let catalog =
                    self.api
                        .repository_request(repository, "catalog", json!({}), token)?;
                let values = catalog["stashes"].as_array().cloned().unwrap_or_default();
                let Some(index) = self.choose("git.chooseStash", &values, "subject", token)? else {
                    return Ok(Value::Null);
                };
                if kind == "dropStash"
                    && !self.api.confirm(
                        "git.dropStashConfirm",
                        &[values[index]["subject"].as_str().unwrap_or_default()],
                        token,
                    )?
                {
                    return Ok(Value::Null);
                }
                intent["objectId"] = values[index]["objectId"].clone();
            }
            "createTag" => {
                let Some(name) = self.api.input("git.tagName", "", token)? else {
                    return Ok(Value::Null);
                };
                let Some(reference) = self.api.input("git.tagReference", "HEAD", token)? else {
                    return Ok(Value::Null);
                };
                intent["name"] = json!(name);
                intent["reference"] = json!(reference);
            }
            "deleteTag" | "removeRemote" => {
                let catalog =
                    self.api
                        .repository_request(repository, "catalog", json!({}), token)?;
                let values = catalog[if kind == "deleteTag" {
                    "tags"
                } else {
                    "remotes"
                }]
                .as_array()
                .cloned()
                .unwrap_or_default();
                let Some(index) = self.choose(
                    if kind == "deleteTag" {
                        "git.chooseTag"
                    } else {
                        "git.chooseRemote"
                    },
                    &values,
                    if kind == "deleteTag" { "name" } else { "" },
                    token,
                )?
                else {
                    return Ok(Value::Null);
                };
                let name = if kind == "deleteTag" {
                    values[index]["name"].as_str()
                } else {
                    values[index].as_str()
                }
                .unwrap_or_default();
                if !self.api.confirm(
                    if kind == "deleteTag" {
                        "git.deleteTagConfirm"
                    } else {
                        "git.removeRemoteConfirm"
                    },
                    &[name],
                    token,
                )? {
                    return Ok(Value::Null);
                }
                intent["name"] = json!(name);
            }
            "addRemote" => {
                let Some(name) = self.api.input("git.remoteName", "", token)? else {
                    return Ok(Value::Null);
                };
                let Some(url) = self.api.input("git.remoteUrl", "", token)? else {
                    return Ok(Value::Null);
                };
                intent["name"] = json!(name);
                intent["url"] = json!(url);
            }
            _ => return Err(invalid("Unsupported Git command")),
        }
        let result = self.execute(repository, intent, token)?;
        self.complete_operation(repository, token)?;
        Ok(result)
    }
    pub(crate) fn migrate_shared_settings(
        &self,
        configuration: &crate::model::Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<(), ExtensionError> {
        let mut migrated = self
            .migration
            .lock()
            .map_err(|_| invalid("Git settings migration failed"))?;
        if *migrated {
            return Ok(());
        }
        let inspect = |key: &str| match token {
            Some(token) => self.api.client.inspect_configuration(key, None, token),
            None => self.api.background.inspect_configuration(key, None),
        };
        let mode = inspect("git.autofetch")?["userLocalValue"].clone();
        let period = inspect("git.autofetchPeriod")?["userLocalValue"].clone();
        if mode.is_null() && period.is_null() {
            *migrated = true;
            return Ok(());
        }
        if !mode.is_null() && !mode.is_boolean() && mode != "all"
            || !period.is_null()
                && !period
                    .as_u64()
                    .is_some_and(|period| (1..=86400).contains(&period))
        {
            return Err(invalid(&self.api.text("git.legacySettingsInvalid", &[])));
        }
        let current = self
            .api
            .request("readConfig", json!({}), configuration, token)?;
        let mut desired = current["git"].clone();
        if !mode.is_null() {
            desired["autofetch"] = if mode == true {
                json!("default")
            } else if mode == false {
                json!("off")
            } else {
                mode.clone()
            };
        }
        if !period.is_null() {
            desired["autofetchPeriod"] = period.clone();
        }
        if current["gitConfigured"] == true && desired != current["git"] {
            self.api.warning("git.legacySettingsConflict", &[], token)?;
            *migrated = true;
            return Ok(());
        }
        if current["gitConfigured"] != true {
            self.api.request("updateConfig",json!({"commandId":random_id()?,"expectedRevision":current["revision"],"git":desired}),configuration,token)?;
        }
        let durable = self
            .api
            .request("readConfig", json!({}), configuration, token)?;
        if durable["git"] != desired {
            return Err(invalid(&self.api.text("git.legacySettingsConflict", &[])));
        }
        for (key, value) in [("git.autofetch", mode), ("git.autofetchPeriod", period)] {
            if !value.is_null() {
                match token {
                    Some(token) => self.api.client.reset_configuration(
                        key,
                        ConfigurationTarget::User,
                        token,
                    )?,
                    None => self
                        .api
                        .background
                        .reset_configuration(key, ConfigurationTarget::User)?,
                }
            }
        }
        *migrated = true;
        Ok(())
    }
    fn update_shared_setting(
        &self,
        command: &str,
        value: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = self.lock().configuration.clone();
        self.migrate_shared_settings(&config, Some(token))?;
        let mut current = self
            .api
            .request("readConfig", json!({}), &config, Some(token))?;
        let key = match command {
            "git.updateRebaseWhenSync" => {
                if !value.is_boolean() {
                    return Err(invalid(&self.api.text("git.rebaseWhenSync.invalid", &[])));
                }
                "rebaseWhenSync"
            }
            "git.updateAutoFetchPeriod" => {
                if !value
                    .as_u64()
                    .is_some_and(|value| (1..=86400).contains(&value))
                {
                    return Err(invalid("Invalid Git autofetch period"));
                }
                "autofetchPeriod"
            }
            _ => "autofetch",
        };
        current["git"][key] = if key == "autofetch" {
            match value {
                Value::Bool(false) => json!("off"),
                Value::Bool(true) => json!("default"),
                value if value == "all" => json!("all"),
                _ => return Err(invalid("Invalid Git autofetch mode")),
            }
        } else {
            value.clone()
        };
        self.api.request("updateConfig",json!({"commandId":random_id()?,"expectedRevision":current["revision"],"git":current["git"]}),&config,Some(token))
    }
    fn clone_repository(
        &self,
        arguments: &[Value],
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = self.api.configuration(None, Some(token))?;
        let url = if let Some(value) = arguments.first() {
            value
                .as_str()
                .filter(|value| {
                    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
                })
                .ok_or_else(|| invalid("Invalid clone URL"))?
                .to_owned()
        } else {
            let Some(url) = self.api.input("git.cloneUrl", "", token)? else {
                return Ok(Value::Null);
            };
            url
        };
        let reference = arguments
            .get(1)
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= 1024
                            && !value.chars().any(char::is_control)
                    })
                    .ok_or_else(|| invalid("Invalid clone reference"))
            })
            .transpose()?;
        let account = credential_account(arguments.get(2))?;
        let parent = self.api.editor(
            json!({"method":"pickFolder","defaultPath":config.value("defaultCloneDirectory")}),
            Some(token),
        )?;
        if !parent.is_string() {
            return Ok(Value::Null);
        }
        let result = self.api.request(
            "clone",
            json!({"url":url.trim(),"parentPath":parent,"reference":reference,"credentialAccountId":account}),
            &config,
            Some(token),
        )?;
        let path = result["repositoryPath"]
            .as_str()
            .ok_or_else(|| invalid("Invalid clone path"))?;
        let policy = config.text("openAfterClone", "prompt");
        let open = matches!(policy, "always" | "alwaysNewWindow")
            || policy == "whenNoFolderOpen" && self.lock().folders.is_empty()
            || policy == "prompt"
                && self
                    .api
                    .confirm("git.cloneCompleteMessage", &[path], token)?;
        if open {
            self.api.editor(json!({"method":"openWorkspace","path":path,"forceNewWindow":policy=="alwaysNewWindow"}),Some(token))?;
        }
        Ok(result)
    }
    fn initialize_repository(&self, token: &CancellationToken) -> Result<Value, ExtensionError> {
        let state = self.lock();
        let folders = state.folders.clone();
        drop(state);
        let config = self.api.configuration(None, Some(token))?;
        let Some(index) = self.choose("git.initFolder", &folders, "name", token)? else {
            return Ok(Value::Null);
        };
        let Some(branch) = self.api.input(
            "git.initBranch",
            config.text("defaultBranchName", "main"),
            token,
        )?
        else {
            return Ok(Value::Null);
        };
        let result = self.api.request(
            "initialize",
            json!({"dirId":folders[index]["id"],"initialBranch":branch.trim()}),
            &config,
            Some(token),
        )?;
        self.refresh(Some(token))?;
        Ok(result)
    }
    fn worktree(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        if command == "git.createWorktree" {
            let Some(name) = self.api.input("git.newWorktreeName", "", token)? else {
                return Ok(Value::Null);
            };
            let result = self.api.repository_request(
                repository,
                "createWorktree",
                json!({"name":name.trim(),"includeFiles":repository.configuration.strings("worktreeIncludeFiles"),"symlinkFolders":repository.configuration.strings("worktreeSymlinkFolders")}),
                token,
            )?;
            if self.api.confirm(
                "git.openWorktreeConfirm",
                &[result["path"].as_str().unwrap_or_default()],
                token,
            )? {
                self.api.editor(
                    json!({"method":"openWorkspace","path":result["path"]}),
                    Some(token),
                )?;
            }
            return Ok(result);
        }
        let result = self
            .api
            .repository_request(repository, "worktrees", json!({}), token)?;
        let values = result["worktrees"].as_array().cloned().unwrap_or_default();
        let Some(index) =
            self.choose("git.selectWorktreeToOpen", &values, "checkoutRoot", token)?
        else {
            return Ok(Value::Null);
        };
        let checkout = &values[index]["checkoutRoot"];
        if command == "git.openWorktree" {
            let result = self.api.repository_request(
                repository,
                "resolveWorktree",
                json!({"checkoutRoot":checkout}),
                token,
            )?;
            self.api.editor(
                json!({"method":"openWorkspace","path":result["path"]}),
                Some(token),
            )
        } else {
            if !self.api.confirm(
                "git.deleteWorktreeConfirm",
                &[checkout.as_str().unwrap_or_default()],
                token,
            )? {
                return Ok(Value::Null);
            }
            self.api.repository_request(
                repository,
                "deleteWorktree",
                json!({"commandId":random_id()?,"checkoutRoot":checkout,"mode":"unbound"}),
                token,
            )
        }
    }
}
fn strip_comments(text: &str) -> String {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}
fn commit_uri(id: &str) -> String {
    format!(
        "untitled:/git/{}/COMMIT_EDITMSG",
        url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
    )
}
pub(crate) fn random_id() -> Result<String, ExtensionError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| invalid("Randomness unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn random_branch(configuration: &crate::model::Configuration) -> Result<String, ExtensionError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| invalid("Randomness unavailable"))?;
    let configured = configuration.strings("branchRandomName.dictionary");
    let dictionaries = if configured.is_empty() {
        vec!["adjectives".to_owned(), "animals".to_owned()]
    } else {
        configured
    };
    if dictionaries.len() > 5 {
        return Err(invalid("Invalid branch dictionary selection"));
    }
    let mut words = Vec::new();
    for (index, dictionary) in dictionaries.iter().enumerate() {
        let choices = match dictionary.as_str() {
            "colors" => &["amber", "blue", "coral", "green", "indigo", "teal"][..],
            "animals" => &["badger", "falcon", "fox", "otter", "panda", "swift"][..],
            "adjectives" => &["bright", "calm", "clear", "quiet", "rapid", "steady"][..],
            "numbers" => {
                words
                    .push(u16::from_be_bytes([bytes[index * 2], bytes[index * 2 + 1]]).to_string());
                continue;
            }
            _ => return Err(invalid("Invalid branch dictionary")),
        };
        words.push(choices[bytes[index * 2] as usize % choices.len()].to_owned());
    }
    Ok(words.join("-"))
}
fn wildcard(pattern: &str, text: &str) -> bool {
    let pattern: Vec<_> = pattern.chars().collect();
    let text: Vec<_> = text.chars().collect();
    let mut previous = vec![false; text.len() + 1];
    previous[0] = true;
    for character in pattern {
        let mut current = vec![false; text.len() + 1];
        if character == '*' {
            current[0] = previous[0];
        }
        for index in 1..=text.len() {
            current[index] = if character == '*' {
                previous[index] || current[index - 1]
            } else {
                previous[index - 1] && (character == '?' || character == text[index - 1])
            };
        }
        previous = current;
    }
    previous[text.len()]
}

// This is invocation metadata for the askpass broker, never persisted Git configuration.
fn credential_account(value: Option<&Value>) -> Result<Option<&str>, ExtensionError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value))
        }
        Some(_) => Err(invalid("Invalid credential account selection")),
    }
}
