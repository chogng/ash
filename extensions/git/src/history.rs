use crate::GitRuntime;
use crate::api::decode;
use crate::api::invalid;
use crate::model::Repository;
use crate::model::RepositoryCommand;
use base64::Engine;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use serde_json::Value;
use serde_json::json;

impl GitRuntime {
    pub(crate) fn history(
        &self,
        repository: &Repository,
        payload: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let args = payload["arguments"].as_array().cloned().unwrap_or_default();
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        match payload["methodName"].as_str().unwrap_or_default() {
            "refresh" => {
                self.accept_status(self.api.history_refs(repository, Some(token))?.status);
                self.publish()?;
                Ok(Value::Null)
            }
            "provideHistoryItemRefs" => {
                let refs = json!(self.api.history_refs(repository, Some(token))?);
                let filter = arg(0);
                Ok(json!(
                    refs["references"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|reference| filter.is_null()
                            || filter.as_array().is_some_and(
                                |values| values.contains(&json!(reference_id(reference)))
                            ))
                        .map(history_ref)
                        .collect::<Vec<_>>()
                ))
            }
            "resolveHistoryItemRefsCommonAncestor" => {
                let values: Vec<Value> = crate::api::decode(arg(0))?;
                let Some(mut ancestor) = values.first().cloned() else {
                    return Ok(Value::Null);
                };
                for reference in values.iter().skip(1) {
                    ancestor = json!(
                        self.api
                            .compare_changes(
                                repository,
                                &decode::<String>(ancestor)?,
                                &decode::<String>(reference.clone())?,
                                crate::model::CompareMode::MergeBase,
                                token
                            )?
                            .base_object_id
                    );
                }
                Ok(ancestor)
            }
            "provideHistoryItems" => {
                let options = arg(0);
                let skip = options["skip"].as_u64().unwrap_or(0) as usize;
                let limit = options["limit"].as_u64().unwrap_or(50).min(1000) as usize;
                if skip > 100000 || limit == 0 {
                    return Err(invalid("Invalid Git history page"));
                }
                let mut cursor = Value::Null;
                let mut consumed = 0;
                let mut commits = Vec::new();
                while commits.len() < limit {
                    let query = crate::model::GraphQuery {
                        limit: (skip + limit - consumed).min(1000),
                        cursor: decode(cursor.clone())?,
                        revisions: decode(options["historyItemRefs"].clone())?,
                    };
                    let page = json!(self.api.graph(repository, &query, token)?);
                    let references = page["references"].as_array().cloned().unwrap_or_default();
                    for commit in page["commits"].as_array().into_iter().flatten() {
                        if consumed >= skip && commits.len() < limit {
                            commits.push(history_item(
                                commit,
                                &references,
                                &page["remotes"],
                                repository.configuration.number("commitShortHashLength", 7)
                                    as usize,
                            ));
                        }
                        consumed += 1;
                    }
                    if page["hasMore"] != true || page["nextCursor"].is_null() {
                        break;
                    }
                    cursor = page["nextCursor"].clone();
                }
                Ok(json!(commits))
            }
            "resolveHistoryItemDetails" => {
                let mut result = json!(self.api.commit_details(
                    repository,
                    &decode::<String>(arg(0).clone())?,
                    token
                )?);
                result["timestamp"] =
                    json!(result["timestampSeconds"].as_i64().unwrap_or(0) * 1000);
                Ok(result)
            }
            "provideHistoryItemChanges" => {
                let id = arg(0);
                let parent = arg(1);
                let changes = json!(self.api.commit_changes(
                    repository,
                    &decode::<String>(id.clone())?,
                    token
                )?);
                let changes = if !parent.is_null() && parent != changes["parentObjectId"] {
                    let comparison = json!(self.api.compare_changes(
                        repository,
                        &decode::<String>(id.clone())?,
                        &decode::<String>(parent.clone())?,
                        crate::model::CompareMode::Direct,
                        token
                    )?);
                    json!({"changes":comparison["changes"],"parentObjectId":comparison["baseObjectId"]})
                } else {
                    changes
                };
                Ok(json!(changes["changes"].as_array().into_iter().flatten().map(|change|{
                    let path=change["path"].as_str().unwrap_or_default();let original=change["originalPath"].as_str().unwrap_or(path);let id=id.as_str().unwrap_or_default();let parent=changes["parentObjectId"].as_str().unwrap_or("root");
                    json!({"uri":commit_file_uri(&repository.descriptor.id,id,path,"modified"),"originalUri":commit_file_uri(&repository.descriptor.id,parent,original,"original"),"modifiedUri":commit_file_uri(&repository.descriptor.id,id,path,"modified"),"path":path,"originalPath":change["originalPath"],"status":change["status"],"parentId":changes["parentObjectId"]})
                }).collect::<Vec<_>>()))
            }
            "resolveHistoryItemChangeContents" => {
                let change = arg(1);
                let mut file = json!(self.api.commit_file(
                    repository,
                    &decode::<String>(arg(0))?,
                    &decode(change["path"].clone())?,
                    change["parentId"].as_str(),
                    token
                )?);
                for side in ["original", "modified"] {
                    if let Some(bytes) = file[side]["data"].as_str().and_then(|data| {
                        base64::engine::general_purpose::STANDARD.decode(data).ok()
                    }) {
                        file[side]["bytes"] = json!(bytes);
                        file[side]
                            .as_object_mut()
                            .expect("binary content object")
                            .remove("data");
                    }
                }
                file["parentId"] = change["parentId"].clone();
                Ok(file)
            }
            "resolveHistoryItemChatContext" | "resolveHistoryItemChangeRangeChatContext" => {
                let id = arg(0);
                let changes = json!(self.api.commit_changes(
                    repository,
                    &decode::<String>(id.clone())?,
                    token
                )?);
                let path = arg(2);
                let mut output = format!("Commit: {}\n", id.as_str().unwrap_or_default());
                for change in changes["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|change| path.is_null() || change["path"] == path)
                    .take(40)
                {
                    let file = json!(self.api.commit_file(
                        repository,
                        &decode::<String>(id.clone())?,
                        &decode(change["path"].clone())?,
                        None,
                        token
                    )?);
                    output.push_str(&format!(
                        "\nFile: {}\n",
                        change["path"].as_str().unwrap_or_default()
                    ));
                    for (side, prefix) in [("original", "-"), ("modified", "+")] {
                        if let Some(text) = file[side]["text"].as_str() {
                            for line in text.chars().take(65536).collect::<String>().lines() {
                                output.push_str(&format!("{prefix}{line}\n"));
                            }
                        }
                    }
                    if output.len() > 512 * 1024 {
                        output = output.chars().take(512 * 1024).collect();
                        break;
                    }
                }
                Ok(json!(output))
            }
            _ => Err(invalid("Unsupported Git history operation")),
        }
    }
    pub(crate) fn graph_action(
        &self,
        repository: &Repository,
        command: &str,
        context: &Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let item = &context["historyItemViewModel"]["historyItem"];
        let id = &item["id"];
        if command == "git.copyCommitId" {
            return self
                .api
                .editor(json!({"method":"clipboard","text":id}), Some(token));
        }
        if command == "git.copyCommitMessage" {
            let message = json!(self.api.commit_message(
                repository,
                &decode::<String>(id.clone())?,
                token
            )?);
            return self.api.editor(
                json!({"method":"clipboard","text":message["message"]}),
                Some(token),
            );
        }
        if command == "git.graph.openRemote" {
            let links = item["remoteLinks"].as_array().cloned().unwrap_or_default();
            let Some(index) = self.choose("git.graph.chooseRemote", &links, "name", token)? else {
                return Ok(Value::Null);
            };
            return self.api.editor(
                json!({"method":"openExternal","uri":links[index]["uri"]}),
                Some(token),
            );
        }
        let refs = context["references"]
            .as_array()
            .or_else(|| item["references"].as_array())
            .cloned()
            .unwrap_or_default();
        match command {
            "git.graph.checkoutDetached" => {
                if self.api.confirm(
                    "git.graph.detachedConfirm",
                    &[id.as_str().unwrap_or_default()],
                    token,
                )? {
                    self.execute(
                        repository,
                        RepositoryCommand::CheckoutDetached {
                            object_id: decode(id.clone())?,
                        },
                        token,
                    )
                } else {
                    Ok(Value::Null)
                }
            }
            "git.branch" | "git.createTag" => {
                let Some(name) = self.api.input(
                    if command == "git.branch" {
                        "git.newBranchName"
                    } else {
                        "git.tagName"
                    },
                    repository.configuration.text("branchPrefix", ""),
                    token,
                )?
                else {
                    return Ok(Value::Null);
                };
                self.execute(
                    repository,
                    if command == "git.branch" {
                        RepositoryCommand::CreateBranchAt {
                            name: name.trim().into(),
                            object_id: decode(id.clone())?,
                        }
                    } else {
                        RepositoryCommand::CreateTag {
                            name: name.trim().into(),
                            reference: decode(id.clone())?,
                        }
                    },
                    token,
                )
            }
            "git.graph.cherryPick" => self.execute(
                repository,
                RepositoryCommand::CherryPick {
                    reference: decode(id.clone())?,
                    mainline: None,
                },
                token,
            ),
            "git.graph.checkout" | "git.graph.deleteBranch" | "git.graph.deleteTag" => {
                let values: Vec<_> = refs
                    .into_iter()
                    .filter(|reference| {
                        if command == "git.graph.deleteTag" {
                            reference["category"] == "tag"
                        } else if command == "git.graph.deleteBranch" {
                            reference["category"] != "tag"
                        } else {
                            true
                        }
                    })
                    .collect();
                let Some(index) =
                    self.choose("git.graph.chooseReference", &values, "name", token)?
                else {
                    return Ok(Value::Null);
                };
                let reference = &values[index];
                let name = reference["name"].as_str().unwrap_or_default();
                if command.starts_with("git.graph.delete") {
                    if !self.api.confirm(
                        if reference["category"] == "tag" {
                            "git.deleteTagConfirm"
                        } else {
                            "git.deleteBranchConfirm"
                        },
                        &[name],
                        token,
                    )? {
                        return Ok(Value::Null);
                    }
                    if reference["category"] == "tag" {
                        return self.execute(
                            repository,
                            RepositoryCommand::DeleteTag { name: name.into() },
                            token,
                        );
                    }
                    if reference["category"] == "localBranch" {
                        return self
                            .api
                            .delete_branch(repository, name, token)
                            .map(|result| json!(result));
                    }
                    let (remote, branch) = name
                        .split_once('/')
                        .ok_or_else(|| invalid("Invalid remote reference"))?;
                    return self.execute(
                        repository,
                        RepositoryCommand::DeleteRemoteBranch {
                            remote: remote.into(),
                            name: branch.into(),
                        },
                        token,
                    );
                }
                if reference["category"] == "localBranch" {
                    let result = json!(self.api.switch_branch(repository, name, token)?);
                    self.accept_status(crate::api::decode(result["status"].clone())?);
                    Ok(result)
                } else if reference["category"] == "tag" {
                    self.execute(
                        repository,
                        RepositoryCommand::CheckoutDetached {
                            object_id: decode(id.clone())?,
                        },
                        token,
                    )
                } else {
                    let initial = name.split_once('/').map(|(_, name)| name).unwrap_or(name);
                    let Some(branch) =
                        self.api
                            .input("git.graph.trackingBranchName", initial, token)?
                    else {
                        return Ok(Value::Null);
                    };
                    self.execute(
                        repository,
                        RepositoryCommand::CheckoutRemoteBranch {
                            reference: name.into(),
                            name: branch,
                        },
                        token,
                    )
                }
            }
            "git.graph.compareRef"
            | "git.graph.compareWithMergeBase"
            | "git.graph.compareWithRemote" => {
                let graph = json!(self.api.graph(
                    repository,
                    &crate::model::GraphQuery {
                        limit: 1,
                        cursor: None,
                        revisions: None
                    },
                    token
                )?);
                let values: Vec<_> = graph["references"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|reference| {
                        command != "git.graph.compareWithRemote"
                            || reference["kind"] == "remoteBranch"
                    })
                    .cloned()
                    .collect();
                let Some(index) =
                    self.choose("git.graph.chooseReference", &values, "name", token)?
                else {
                    return Ok(Value::Null);
                };
                let changes = json!(self.api.compare_changes(
                    repository,
                    &decode::<String>(id.clone())?,
                    &decode::<String>(values[index]["objectId"].clone())?,
                    if command == "git.graph.compareWithMergeBase" {
                        crate::model::CompareMode::MergeBase
                    } else {
                        crate::model::CompareMode::Direct
                    },
                    token
                )?);
                let input = self.committed_diff(
                    repository,
                    id.as_str().ok_or_else(|| invalid("Missing commit ID"))?,
                    changes["baseObjectId"].as_str(),
                    &changes["changes"],
                    token,
                )?;
                self.api.editor(
                    json!({"method":"open","input":input,"options":{"pinned":true}}),
                    Some(token),
                )
            }
            _ => Err(invalid("Unsupported Git history command")),
        }
    }
}
fn reference_id(reference: &Value) -> String {
    let prefix = match reference["kind"].as_str() {
        Some("localBranch") => "refs/heads",
        Some("remoteBranch") => "refs/remotes",
        Some("tag") => "refs/tags",
        _ => "refs",
    };
    format!(
        "{prefix}/{}",
        reference["name"].as_str().unwrap_or_default()
    )
}
fn history_ref(reference: &Value) -> Value {
    json!({"id":reference_id(reference),"name":reference["name"],"revision":reference["objectId"],"category":reference["kind"],"description":reference["name"],"canDelete":reference["kind"]=="tag" || reference["current"]!=true})
}
pub(crate) fn history_item(commit: &Value, refs: &[Value], remotes: &Value, short: usize) -> Value {
    let id = commit["objectId"].as_str().unwrap_or_default();
    let links: Vec<_> = remotes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|remote| {
            let identity = &remote["identity"];
            let host = identity["host"].as_str()?;
            let owner = identity["owner"].as_str()?;
            let repository = identity["repository"].as_str()?;
            let path = if host == "gitlab.com" {
                "-/commit"
            } else if host == "bitbucket.org" {
                "commits"
            } else {
                "commit"
            };
            let mut uri = url::Url::parse(&format!("https://{host}")).ok()?;
            uri.set_path(&format!("/{owner}/{repository}/{path}/{id}"));
            Some(json!({"name":remote["name"],"uri":uri.to_string()}))
        })
        .collect();
    json!({"id":id,"parentIds":commit["parentObjectIds"],"subject":commit["subject"],"message":commit["subject"],"displayId":id.chars().take(short).collect::<String>(),"timestamp":commit["timestampSeconds"].as_i64().unwrap_or(0)*1000,"references":refs.iter().filter(|reference|reference["objectId"]==id).map(history_ref).collect::<Vec<_>>(),"remoteLinks":links})
}
pub(crate) fn commit_file_uri(repository: &str, id: &str, path: &str, side: &str) -> String {
    let mut uri = url::Url::parse("git-commit:/").expect("constant URI");
    uri.set_path(&format!("/{id}/{path}"));
    uri.query_pairs_mut()
        .append_pair("repository", repository)
        .append_pair("side", side);
    uri.to_string()
}
