use crate::GitRuntime;
use crate::api::decode;
use crate::api::file_uri;
use crate::api::invalid;
use crate::model::Change;
use crate::model::Repository;
use crate::model::Status;
use base64::Engine;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use serde_json::Value;
use serde_json::json;

impl GitRuntime {
    pub(crate) fn open_change(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let resource = payload["resourceId"]
            .as_str()
            .ok_or_else(|| invalid("Missing Git resource"))?;
        let (group, path) = resource
            .split_once(':')
            .ok_or_else(|| invalid("Invalid Git resource"))?;
        let status = self.api.status(repository, Some(token))?;
        let change = status
            .changes
            .iter()
            .find(|change| change.path == path)
            .ok_or_else(|| invalid("Git change was removed"))?;
        let input = if change.conflicted {
            if repository.configuration.boolean("mergeEditor", false) {
                json!({"kind":"merge","resource":format!("git-merge:/{}/{}",repository.descriptor.id,path),"resultResource":file_uri(&repository.root_uri,path)?,"label":path,"repositoryId":repository.descriptor.id,"path":path})
            } else {
                json!({"resource":file_uri(&repository.root_uri,path)?,"label":path})
            }
        } else {
            let comparison = if group == "staged" {
                "staged"
            } else {
                "unstaged"
            };
            let (original, modified) =
                self.change_inputs(repository, &status, change, comparison, token)?;
            if repository.configuration.boolean("openDiffOnClick", true) {
                diff_input(original, modified, path)
            } else {
                json!({"resource":file_uri(&repository.root_uri,path)?,"label":path})
            }
        };
        self.api.editor(json!({"method":"open","input":input,"options":payload["options"],"sideBySide":payload["sideBySide"]==true}),Some(token))
    }
    fn change_inputs(
        &self,
        repository: &Repository,
        status: &Status,
        change: &Change,
        comparison: &str,
        token: &CancellationToken,
    ) -> Result<(Value, Value), ExtensionError> {
        let file = self.api.repository_request(
            repository,
            "changeFile",
            json!({"path":change.path,"comparison":comparison}),
            token,
        )?;
        let original_path = if matches!(
            (if comparison == "staged" {
                &change.index_status
            } else {
                &change.worktree_status
            })
            .as_str(),
            "renamed" | "copied"
        ) {
            change.original_path.as_deref().unwrap_or(&change.path)
        } else {
            &change.path
        };
        let mut uri = url::Url::parse("git-change:/").expect("constant URI");
        uri.set_path(&format!("/{comparison}/{}", change.path));
        uri.query_pairs_mut()
            .append_pair("repository", &repository.descriptor.id)
            .append_pair("stream", &status.stream_instance_id)
            .append_pair("revision", &status.revision.to_string())
            .append_pair("resource", &file_uri(&repository.root_uri, &change.path)?);
        let mut original_uri = uri.clone();
        original_uri.set_path(&format!("/{comparison}/{original_path}"));
        original_uri
            .query_pairs_mut()
            .append_pair("side", "original");
        uri.query_pairs_mut().append_pair("side", "modified");
        let original = content_input(&file["original"], original_uri.to_string(), original_path);
        let modified = content_input(&file["modified"], uri.to_string(), &change.path);
        Ok((original, modified))
    }
    pub(crate) fn multi_diff(
        &self,
        repository: &Repository,
        resource: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let scope = url::Url::parse(resource)
            .ok()
            .and_then(|uri| {
                uri.query_pairs()
                    .find(|(key, _)| key == "scope")
                    .map(|(_, value)| value.into_owned())
            })
            .unwrap_or_else(|| "uncommitted".into());
        self.multi_diff_input(repository, &scope, token)
    }
    fn multi_diff_input(
        &self,
        repository: &Repository,
        scope: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        if !matches!(scope, "staged" | "unstaged" | "uncommitted") {
            return Err(invalid("Invalid Git change scope"));
        }
        let status = self.api.status(repository, Some(token))?;
        let mut items = vec![];
        for change in status.changes.iter().filter(|change| {
            !change.conflicted
                && (scope != "staged" || change.index_status != "unmodified")
                && (scope != "unstaged" || change.worktree_status != "unmodified")
        }) {
            let (mut original, modified) = self.change_inputs(
                repository,
                &status,
                change,
                if scope == "staged" {
                    "staged"
                } else {
                    "unstaged"
                },
                token,
            )?;
            if scope == "uncommitted" {
                original = self
                    .change_inputs(repository, &status, change, "staged", token)?
                    .0;
            }
            let staged = change.index_status != "unmodified";
            let key = if staged {
                "git.unstageChanges"
            } else {
                "git.stageChanges"
            };
            let label = self.api.text(key, &[]);
            items.push(json!({"binary":original["contentType"]=="application/octet-stream" || modified["contentType"]=="application/octet-stream","id":change.path,"label":change.path,"original":original,"modified":modified,"goToFile":{"resource":file_uri(&repository.root_uri,&change.path)?,"label":change.path},"actions":[{"id":if staged {"unstage"} else {"stage"},"label":label,"tooltip":label,"command":if staged {"git.unstageFile"} else {"git.stageFile"},"icon":if staged {"remove"} else {"add"},"arguments":[repository.descriptor.id,change.path,scope]}]}));
        }
        let label = self.api.text(
            match scope {
                "staged" => "git.stagedChanges",
                "unstaged" => "git.changes",
                _ => "git.uncommittedChanges",
            },
            &[],
        );
        let resource = format!(
            "ash-scm://ash.git/{}?scope={scope}",
            url::form_urlencoded::byte_serialize(repository.descriptor.id.as_bytes())
                .collect::<String>()
        );
        Ok(
            json!({"kind":"multiDiff","resource":resource,"label":label,"readOnly":true,"items":items,"source":{"kind":"external","providerId":"ash.git","repositoryId":repository.descriptor.id,"label":label,"branchName":status.head.name()}}),
        )
    }
    pub(crate) fn show_multi_diff(
        &self,
        repository: &Repository,
        scope: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        self.api.editor(json!({"method":"open","input":self.multi_diff_input(repository,scope,token)?,"options":{"pinned":true}}),Some(token))
    }
    pub(crate) fn committed_diff(
        &self,
        repository: &Repository,
        id: &str,
        parent: Option<&str>,
        changes: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let mut items = Vec::new();
        for change in changes.as_array().into_iter().flatten() {
            let path = change["path"]
                .as_str()
                .ok_or_else(|| invalid("Invalid history path"))?;
            let mut params = json!({"objectId":id,"path":path});
            if let Some(parent) = parent {
                params["parentObjectId"] = json!(parent);
            }
            let file = self
                .api
                .repository_request(repository, "commitFile", params, token)?;
            let original_path = change["originalPath"].as_str().unwrap_or(path);
            items.push(json!({"id":path,"binary":file["original"]["kind"]=="binary" || file["modified"]["kind"]=="binary","label":path,"original":content_input(&file["original"],crate::history::commit_file_uri(&repository.descriptor.id,parent.unwrap_or("root"),original_path,"original"),original_path),"modified":content_input(&file["modified"],crate::history::commit_file_uri(&repository.descriptor.id,id,path,"modified"),path),"actions":[]}));
        }
        Ok(
            json!({"kind":"multiDiff","resource":format!("git-commit:/{id}?parent={}",parent.unwrap_or("root")),"label":id,"readOnly":true,"items":items}),
        )
    }
    pub(crate) fn merge(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let args = payload["arguments"]
            .as_array()
            .ok_or_else(|| invalid("Missing merge arguments"))?;
        if payload["methodName"] == "resolve" {
            return self.api.repository_request(
                repository,
                "conflictFile",
                json!({"path":args.first()}),
                token,
            );
        }
        let result=self.api.repository_request(repository,"completeConflict",json!({"path":args.first(),"expectedStageIds":args.get(1),"expectedResultObjectId":args.get(2),"resolution":args.get(3)}),token)?;
        self.accept_status(decode(result["status"].clone())?);
        self.publish()?;
        Ok(Value::Null)
    }
    pub(crate) fn quick_diff(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let Some(path) =
            relative_resource(repository, payload["resource"].as_str().unwrap_or_default())
        else {
            return Ok(Value::Null);
        };
        let status = self.api.status(repository, Some(token))?;
        let Some(change) = status
            .changes
            .iter()
            .find(|change| change.path == path && !change.conflicted)
        else {
            return Ok(Value::Null);
        };
        let comparison = if change.worktree_status != "unmodified" {
            "unstaged"
        } else {
            "staged"
        };
        let file = self.api.repository_request(
            repository,
            "changeFile",
            json!({"path":path,"comparison":comparison}),
            token,
        )?;
        if file["original"]["kind"] == "binary" || file["modified"]["kind"] == "binary" {
            return Ok(Value::Null);
        }
        Ok(
            json!({"label":if comparison=="staged" {"HEAD"} else {"Index"},"originalResource":format!("git-quickdiff:/{path}?revision={}:{}",status.stream_instance_id,status.revision),"revision":format!("{}:{}",status.stream_instance_id,status.revision),"text":file["original"]["text"].as_str().unwrap_or_default()}),
        )
    }
    pub(crate) fn file_decoration(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        if !repository
            .configuration
            .boolean("decorations.enabled", true)
        {
            return Ok(Value::Null);
        }
        let Some(path) =
            relative_resource(repository, payload["resource"].as_str().unwrap_or_default())
        else {
            return Ok(Value::Null);
        };
        let status = repository
            .status
            .as_ref()
            .ok_or_else(|| invalid("Git status unavailable"))?;
        if let Some(change) = status.changes.iter().find(|change| change.path == path) {
            let data =
                crate::scm::decoration(&self.api, change, change.worktree_status == "unmodified");
            let kind = data["kind"].as_str().unwrap_or("modified");
            return Ok(
                json!({"letter":data["badge"],"tooltip":data["tooltip"],"color":format!("gitDecoration.{kind}ResourceForeground"),"weight":10,"bubble":true,"strikethrough":kind=="deleted"}),
            );
        }
        let result = self.api.repository_request(
            repository,
            "checkIgnore",
            json!({"operationId":super::commands::random_id()?,"paths":[path]}),
            token,
        )?;
        if result["ignoredPaths"]
            .as_array()
            .is_some_and(|paths| !paths.is_empty())
        {
            Ok(
                json!({"color":"gitDecoration.ignoredResourceForeground","tooltip":self.api.text("git.ignored",&[]),"weight":1}),
            )
        } else {
            Ok(Value::Null)
        }
    }
    pub(crate) fn open_reviewed_changes(
        &self,
        context: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let id = context["status"]["repositoryId"]
            .as_str()
            .ok_or_else(|| invalid("Missing Git comparison context"))?;
        let repository = self.repository(Some(id))?;
        let status = self.api.status(&repository, Some(token))?;
        if context["status"]["streamInstanceId"] != status.stream_instance_id
            || context["status"]["revision"] != status.revision
        {
            return Ok(json!("stale"));
        }
        let input = self.multi_diff_input(
            &repository,
            context["comparison"].as_str().unwrap_or("unstaged"),
            token,
        )?;
        if input["items"].as_array().is_none_or(Vec::is_empty) {
            return Ok(json!("empty"));
        }
        self.api.editor(
            json!({"method":"open","input":input,"options":{"pinned":true}}),
            Some(token),
        )?;
        Ok(json!("opened"))
    }
    pub(crate) fn open_working_file(
        &self,
        context: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let active = self.api.editor(
            json!({"method":"activeEditor","context":context}),
            Some(token),
        )?;
        let Some(uri) = active["input"]["modified"]["resource"]
            .as_str()
            .and_then(|uri| url::Url::parse(uri).ok())
        else {
            return Ok(Value::Null);
        };
        let Some(resource) = uri
            .query_pairs()
            .find(|(key, _)| key == "resource")
            .map(|(_, value)| value.into_owned())
        else {
            return Ok(Value::Null);
        };
        self.api.editor(json!({"method":"open","input":{"resource":resource},"options":{"pinned":false,"revealIfOpened":true,"selection":active["selection"]}}),Some(token))
    }
    pub(crate) fn timeline(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let active = self
            .api
            .editor(json!({"method":"activeEditor"}), Some(token))?;
        let Some(path) = active["input"]["resource"]
            .as_str()
            .and_then(|resource| relative_resource(repository, resource))
        else {
            return Ok(Value::Null);
        };
        let history =
            self.api
                .repository_request(repository, "fileHistory", json!({"path":path}), token)?;
        let values = history["items"].as_array().cloned().unwrap_or_default();
        let date_key = if repository.configuration.text("timeline.date", "committed") == "authored"
        {
            "authorTime"
        } else {
            "commitTime"
        };
        let dates=self.api.editor(json!({"method":"formatTimestamps","timestamps":values.iter().map(|item|item[date_key].as_i64().unwrap_or(0)*1000).collect::<Vec<_>>()}),Some(token))?;
        let mut choices: Vec<_> = values
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let author = if repository
                    .configuration
                    .boolean("timeline.showAuthor", true)
                {
                    item["authorName"].as_str().unwrap_or_default()
                } else {
                    ""
                };
                (
                    item["subject"].as_str().unwrap_or_default().to_owned(),
                    Some(
                        format!(
                            "{author} {}",
                            dates[index]["date"].as_str().unwrap_or_default()
                        )
                        .trim()
                        .to_owned(),
                    ),
                )
            })
            .collect();
        let mut pending = Vec::new();
        if repository
            .configuration
            .boolean("timeline.showUncommitted", false)
        {
            let status = self.api.status(repository, Some(token))?;
            if let Some(change) = status.changes.iter().find(|change| change.path == path) {
                if change.index_status != "unmodified" {
                    pending.push(("staged", self.api.text("git.stagedChanges", &[])));
                }
                if change.worktree_status != "unmodified" {
                    pending.push(("changes", self.api.text("git.uncommittedChanges", &[])));
                }
            }
        }
        choices.extend(pending.iter().map(|(_, label)| (label.clone(), None)));
        let Some(index) = self.api.pick("git.timelineTitle", choices, token)? else {
            return Ok(Value::Null);
        };
        if index >= values.len() {
            return self.open_change(
                repository,
                &json!({"resourceId":format!("{}:{path}",pending[index-values.len()].0)}),
                token,
            );
        }
        let item = &values[index];
        let id = item["objectId"]
            .as_str()
            .ok_or_else(|| invalid("Missing file history ID"))?;
        let changes = self.api.repository_request(
            repository,
            "commitChanges",
            json!({"objectId":id}),
            token,
        )?;
        let selected: Vec<_> = changes["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|change| change["path"] == item["path"])
            .cloned()
            .collect();
        let input = self.committed_diff(repository, id, None, &json!(selected), token)?;
        self.api.editor(
            json!({"method":"open","input":input,"options":{"pinned":true}}),
            Some(token),
        )
    }
    pub(crate) fn show_blame(
        &self,
        repository: &Repository,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let active = self
            .api
            .editor(json!({"method":"activeEditor"}), Some(token))?;
        let Some(path) = active["input"]["resource"]
            .as_str()
            .and_then(|resource| relative_resource(repository, resource))
        else {
            return Ok(Value::Null);
        };
        let result=self.api.repository_request(repository,"blame",json!({"path":path,"line":active["selection"]["startLineNumber"].as_u64().unwrap_or(1),"contents":active["contents"],"ignoreWhitespace":repository.configuration.boolean("blame.ignoreWhitespace",false)}),token)?;
        self.api.client.show_message(
            external_ext_sdk::client::MessageSeverity::Information,
            format!(
                "{} <{}>\n{}\n{}",
                result["authorName"].as_str().unwrap_or_default(),
                result["authorEmail"].as_str().unwrap_or_default(),
                result["subject"].as_str().unwrap_or_default(),
                result["objectId"].as_str().unwrap_or_default()
            ),
            token,
        )?;
        Ok(result)
    }
    pub(crate) fn select_index_change(
        &self,
        repository: &Repository,
        command: &str,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let comparison = if command.starts_with("git.unstage") {
            "staged"
        } else {
            "unstaged"
        };
        let status = self.api.status(repository, Some(token))?;
        let values: Vec<_> = status
            .changes
            .iter()
            .filter(|change| {
                !change.conflicted
                    && (if comparison == "staged" {
                        &change.index_status
                    } else {
                        &change.worktree_status
                    }) != "unmodified"
            })
            .map(|change| json!({"path":change.path}))
            .collect();
        let Some(index) = self.choose("git.diff.chooseFile", &values, "path", token)? else {
            return Ok(Value::Null);
        };
        let path = &values[index]["path"];
        let reviewed = self.api.repository_request(
            repository,
            "indexDiff",
            json!({"path":path,"comparison":comparison}),
            token,
        )?;
        let hunks = reviewed["hunks"].as_array().cloned().unwrap_or_default();
        let Some(hunk) = self.choose("git.diff.chooseHunk", &hunks, "preview", token)? else {
            return Ok(Value::Null);
        };
        let selection = if command.ends_with("Ranges") {
            let Some(start) = self.api.input(
                "git.diff.startLine",
                &hunks[hunk]["newStart"].to_string(),
                token,
            )?
            else {
                return Ok(Value::Null);
            };
            let Some(end) = self.api.input("git.diff.endLine", &start, token)? else {
                return Ok(Value::Null);
            };
            json!({"kind":"lines","start":start.parse::<usize>().map_err(|_|invalid("Invalid line number"))?,"end":end.parse::<usize>().map_err(|_|invalid("Invalid line number"))?})
        } else {
            json!({"kind":"hunk","staged":hunks[hunk]["staged"]})
        };
        let result=self.api.repository_request(repository,"editIndex",json!({"path":path,"comparison":comparison,"expectedOriginal":reviewed["original"],"expectedModified":reviewed["modified"],"selection":selection}),token)?;
        self.accept_status(decode(result["status"].clone())?);
        self.publish()?;
        Ok(result)
    }
    pub(crate) fn diff_action(
        &self,
        repository: &Repository,
        command: &str,
        context: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let original = url::Url::parse(
            context["originalUri"]
                .as_str()
                .ok_or_else(|| invalid("Missing diff context"))?,
        )
        .map_err(|_| invalid("Invalid diff context"))?;
        let modified = url::Url::parse(
            context["modifiedUri"]
                .as_str()
                .ok_or_else(|| invalid("Missing diff context"))?,
        )
        .map_err(|_| invalid("Invalid diff context"))?;
        let query: std::collections::BTreeMap<_, _> = modified
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let original_query: std::collections::BTreeMap<_, _> = original
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let comparison = if command.contains("unstage") {
            "staged"
        } else {
            "unstaged"
        };
        let prefix = format!("/{comparison}/");
        if original.scheme() != "git-change"
            || modified.scheme() != "git-change"
            || !modified.path().starts_with(&prefix)
            || !original.path().starts_with(&prefix)
            || query.get("repository") != Some(&repository.descriptor.id)
            || query.get("side").map(String::as_str) != Some("modified")
            || original_query.get("side").map(String::as_str) != Some("original")
            || ["repository", "stream", "revision"]
                .iter()
                .any(|key| query.get(*key) != original_query.get(*key))
        {
            return Err(invalid(&self.api.text("git.reopenComparison", &[])));
        }
        let path = percent_decode_path(&modified.path()[prefix.len()..])?;
        let capture = || {
            self.api.editor(
                json!({"method":"diffChange","context":context}),
                Some(token),
            )
        };
        let state = capture()?;
        if !state.is_object() {
            return Err(invalid(&self.api.text("git.reopenComparison", &[])));
        }
        let status = self.api.status(repository, Some(token))?;
        if query.get("stream") != Some(&status.stream_instance_id)
            || query.get("revision") != Some(&status.revision.to_string())
        {
            return Err(invalid(&self.api.text("git.reopenComparison", &[])));
        }
        let reviewed = self.api.repository_request(
            repository,
            "indexDiff",
            json!({"path":path,"comparison":comparison}),
            token,
        )?;
        let still_current = |latest: &Value| {
            latest["originalVersion"] == state["originalVersion"]
                && latest["modifiedVersion"] == state["modifiedVersion"]
                && latest["originalText"] == state["originalText"]
                && latest["modifiedText"] == state["modifiedText"]
        };
        if reviewed["original"].as_str().unwrap_or_default()
            != state["originalFileText"].as_str().unwrap_or_default()
            || reviewed["modified"].as_str().unwrap_or_default()
                != state["modifiedFileText"].as_str().unwrap_or_default()
            || !still_current(&capture()?)
        {
            return Err(invalid(&self.api.text("git.reopenComparison", &[])));
        }
        if !command.contains("revert") {
            if state["contiguous"] != true {
                return Err(invalid(&self.api.text("git.diff.contiguousSelection", &[])));
            }
            let result=self.api.repository_request(repository,"editIndex",json!({"path":path,"comparison":comparison,"expectedOriginal":reviewed["original"],"expectedModified":reviewed["modified"],"selection":{"kind":"lines","start":state["start"],"end":state["end"]}}),token)?;
            self.accept_status(decode(result["status"].clone())?);
            self.publish()?;
            return Ok(result);
        }
        let resource = file_uri(&repository.root_uri, &path)?;
        if query.get("resource") != Some(&resource) {
            return Err(invalid(&self.api.text("git.diff.noWorktree", &[])));
        }
        let dirty = || {
            self.api
                .editor(json!({"method":"dirty","uri":resource}), Some(token))
                .map(|value| {
                    value
                        .as_array()
                        .is_some_and(|copies| copies.iter().any(|copy| copy["isDirty"] == true))
                })
        };
        if dirty()? {
            return Err(invalid(&self.api.text("git.diff.dirtyWorktree", &[])));
        }
        let file = self
            .api
            .editor(json!({"method":"readTextFile","uri":resource}), Some(token))?;
        let confirmed=self.api.editor(json!({"method":"confirm","message":self.api.text("git.diff.revertConfirm",&[&path]),"primaryButton":self.api.text("git.diff.revertButton",&[])}),Some(token))?;
        if confirmed["confirmed"] != true {
            return Ok(Value::Null);
        }
        let latest = self.api.repository_request(
            repository,
            "indexDiff",
            json!({"path":path,"comparison":comparison}),
            token,
        )?;
        if file["text"] != state["modifiedText"]
            || !file["revision"].is_string()
            || dirty()?
            || !still_current(&capture()?)
            || latest["original"] != reviewed["original"]
            || latest["modified"] != reviewed["modified"]
        {
            return Err(invalid(&self.api.text("git.reopenComparison", &[])));
        }
        let mut text: Vec<u16> = state["modifiedText"]
            .as_str()
            .unwrap_or_default()
            .encode_utf16()
            .collect();
        let mut edits = state["edits"].as_array().cloned().unwrap_or_default();
        edits.sort_by_key(|edit| std::cmp::Reverse(edit["start"].as_u64().unwrap_or(0)));
        for edit in edits {
            let start = edit["start"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid diff edit range"))?
                as usize;
            let end = edit["end"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid diff edit range"))? as usize;
            if start > end || end > text.len() {
                return Err(invalid("Invalid diff edit range"));
            }
            text.splice(
                start..end,
                edit["text"].as_str().unwrap_or_default().encode_utf16(),
            );
        }
        let result=self.api.editor(json!({"method":"saveTextFile","uri":resource,"text":String::from_utf16(&text).map_err(|_|invalid("Invalid UTF-16 diff edit"))?,"encoding":file["encoding"],"expectedRevision":file["revision"]}),Some(token))?;
        self.accept_status(self.api.status(repository, Some(token))?);
        self.publish()?;
        Ok(result)
    }
}
fn content_input(content: &Value, resource: String, label: &str) -> Value {
    if content["kind"] == "binary" {
        let mut input = json!({"resource":resource,"label":label,"readOnly":true,"contentType":"application/octet-stream"});
        if let Some(bytes) = content["data"]
            .as_str()
            .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        {
            input["initialBytes"] = json!(bytes);
        }
        return input;
    }
    let text = content["text"].as_str().unwrap_or_default();
    let mut input = json!({"resource":resource,"label":label,"readOnly":true,"initialText":text.strip_prefix('\u{feff}').unwrap_or(text)});
    if text.starts_with('\u{feff}') {
        input["encoding"] = json!("utf8bom");
    }
    input
}
fn diff_input(original: Value, modified: Value, label: &str) -> Value {
    json!({"kind":if original["contentType"]=="application/octet-stream" || modified["contentType"]=="application/octet-stream" {"binaryDiff"} else {"diff"},"resource":modified["resource"],"label":label,"original":original,"modified":modified,"readOnly":true})
}
pub(crate) fn relative_resource(repository: &Repository, resource: &str) -> Option<String> {
    let root = url::Url::parse(&repository.root_uri).ok()?;
    let resource = url::Url::parse(resource).ok()?;
    if resource.scheme() != root.scheme() || resource.host_str() != root.host_str() {
        return None;
    }
    percent_decode_path(
        resource
            .path()
            .strip_prefix(&format!("{}/", root.path().trim_end_matches('/')))?,
    )
    .ok()
}
fn percent_decode_path(path: &str) -> Result<String, ExtensionError> {
    let uri =
        url::Url::parse(&format!("file:///{path}")).map_err(|_| invalid("Invalid encoded path"))?;
    uri.to_file_path()
        .map(|path| path.to_string_lossy().trim_start_matches('/').to_owned())
        .map_err(|_| invalid("Invalid encoded path"))
}
