use crate::api::Api;
use crate::model::Change;
use crate::model::Head;
use crate::model::Repository;
use serde_json::Value;
use serde_json::json;

pub fn primary_action(repository: &Repository) -> &'static str {
    if !repository.draft.trim().is_empty()
        || repository.status.as_ref().is_none_or(|status| {
            !status.changes.is_empty() || !matches!(status.head, Head::Branch { .. })
        })
    {
        "commit"
    } else if let Some(upstream) = repository
        .status
        .as_ref()
        .and_then(|status| status.head.upstream())
    {
        if upstream.ahead > 0 || upstream.behind > 0 {
            "sync"
        } else {
            "commit"
        }
    } else {
        "publish"
    }
}
fn action(api: &Api, id: &str, key: &str, icon: &str, enabled: bool) -> Value {
    let label = api.text(key, &[]);
    json!({"id":id,"label":label,"tooltip":label,"icon":icon,"enabled":enabled})
}
pub fn decoration(api: &Api, change: &Change, staged: bool) -> Value {
    let status = if change.conflicted {
        "unmerged"
    } else if staged {
        &change.index_status
    } else {
        &change.worktree_status
    };
    let (badge, key, kind) = match status {
        "added" => ("A", "git.status.added", "added"),
        "deleted" => ("D", "git.status.deleted", "deleted"),
        "renamed" => ("R", "git.status.renamed", "renamed"),
        "copied" => ("C", "git.status.copied", "added"),
        "untracked" => ("U", "git.status.untracked", "untracked"),
        "unmerged" => ("!", "git.status.conflicted", "conflicting"),
        _ => ("M", "git.status.modified", "modified"),
    };
    json!({"badge":badge,"tooltip":api.text(key,&[]),"kind":kind})
}
pub fn snapshot(
    api: &Api,
    repository: &Repository,
    selected: bool,
    selection_revision: u64,
) -> Result<Value, external_ext_sdk::ExtensionError> {
    let configuration = &repository.configuration;
    let changes = repository
        .status
        .as_ref()
        .map(|status| status.changes.as_slice())
        .unwrap_or_default();
    let optimistic: Vec<_> = changes
        .iter()
        .cloned()
        .map(|mut change| {
            if let Some(pending) = &repository.pending_paths {
                if pending.paths.contains(&change.path) && !change.conflicted {
                    match pending.operation {
                        crate::model::PathOperation::Stage => {
                            change.index_status = if change.worktree_status == "untracked" {
                                "added".into()
                            } else {
                                change.worktree_status.clone()
                            };
                            change.worktree_status = "unmodified".into();
                        }
                        crate::model::PathOperation::Unstage => {
                            if change.worktree_status == "unmodified" {
                                change.worktree_status = change.index_status.clone();
                            }
                            change.index_status = "unmodified".into();
                        }
                    }
                }
            }
            change
        })
        .collect();
    let changes = optimistic.as_slice();
    let changes: Vec<_> = changes
        .iter()
        .filter(|change| {
            !configuration.boolean("ignoreSubmodules", false) || !change.submodule.is_submodule
        })
        .collect();
    let limit = configuration.number("statusLimit", 10000) as usize;
    let limit_reached = limit > 0 && changes.len() > limit;
    let changes = if limit_reached {
        &changes[..limit]
    } else {
        &changes[..]
    };
    let untracked = configuration.text("untrackedChanges", "mixed");
    let mut groups = Vec::new();
    for (group, key) in [
        ("merge", "git.mergeChanges"),
        ("staged", "git.stagedChanges"),
        ("changes", "git.changes"),
        ("untracked", "git.untrackedChanges"),
    ] {
        let resources: Vec<Value> = changes.iter().filter(|change| match group {
            "merge" => change.conflicted,
            "staged" => !change.conflicted && change.index_status != "unmodified",
            "untracked" => !change.conflicted && change.worktree_status == "untracked" && untracked == "separate",
            _ => !change.conflicted && change.worktree_status != "unmodified" && (change.worktree_status != "untracked" || untracked == "mixed"),
        }).map(|change| {
            let staged = group == "staged";
            let mut actions = vec![];
            let action_id = |kind: &str| format!("{kind}:{group}:{}", change.path);
            if configuration.boolean("showInlineOpenFileAction", true) && change.worktree_status != "deleted" {
                let mut open = action(api, &action_id("openFile"), "git.openFile", "go-to-file", !repository.is_busy());
                let label = api.text("git.openFile", &[&change.path]);
                open["label"] = json!(label);
                open["tooltip"] = json!(label);
                actions.push(open);
            }
            if !change.conflicted && change.worktree_status != "unmodified" { actions.push(action(api,&action_id("discard"),"git.discardChanges","discard",!repository.is_busy())); }
            if !staged { actions.push(action(api,&action_id("stage"),"git.stageChanges","add",!repository.is_busy())); }
            if staged { actions.push(action(api,&action_id("unstage"),"git.unstageChanges","remove",!repository.is_busy())); }
            Ok(json!({"id":format!("{group}:{}",change.path),"sourceUri":change.path.resolve(&repository.root_uri)?,
                "path":change.path,"originalPath":change.original_path,"decorations":decoration(api,change,staged),"openLabel":api.text("git.openChangePath",&[&change.path,&api.text(key,&[])]),"actions":actions}))
        }).collect::<Result<_, external_ext_sdk::ExtensionError>>()?;
        if resources.is_empty()
            && !(group == "staged"
                && configuration.boolean("alwaysShowStagedChangesResourceGroup", false))
        {
            continue;
        }
        let mut actions = match group {
            "staged" => vec![action(
                api,
                "unstageAll",
                "git.menu.unstageAll",
                "remove",
                !repository.is_busy(),
            )],
            "merge" | "untracked" => vec![action(
                api,
                "stageAll",
                "git.menu.stageAll",
                "add",
                !repository.is_busy(),
            )],
            _ => vec![
                action(
                    api,
                    "discardAll",
                    "git.discardChanges",
                    "discard",
                    !repository.is_busy(),
                ),
                action(
                    api,
                    "stageAll",
                    "git.menu.stageAll",
                    "add",
                    !repository.is_busy(),
                ),
            ],
        };
        if let Some(id) = match group {
            "staged" => Some("viewStagedChanges"),
            "changes" => Some("viewChanges"),
            "untracked" => Some("viewUntrackedChanges"),
            _ => None,
        } {
            let label = api.text("git.viewAll", &[&api.text(key, &[])]);
            actions.insert(
                0,
                json!({"id":id,"label":label,"tooltip":label,"icon":"diff-multiple-1","enabled":!repository.is_busy() && !resources.is_empty()}),
            );
        }
        groups.push(
            json!({"id":group,"label":api.text(key,&[]),"resources":resources,"actions":actions}),
        );
    }
    let head = repository.status.as_ref().map(|status| &status.head);
    let branch = head.and_then(Head::name);
    let primary = primary_action(repository);
    let input_validation = validate_input(api, repository);
    let staged = changes
        .iter()
        .any(|change| change.index_status != "unmodified");
    let smart = configuration.boolean("enableSmartCommit", false)
        || configuration.boolean("suggestSmartCommit", true);
    let mut statusbar = vec![];
    if let Some(head) = head {
        let text = branch
            .map(str::to_owned)
            .or_else(|| {
                head.object_id().map(|id| {
                    id.chars()
                        .take(configuration.number("commitShortHashLength", 7) as usize)
                        .collect()
                })
            })
            .unwrap_or_default();
        let (branch_aria, branch_tooltip) = match head {
            Head::Branch { name, upstream, .. } => (
                api.text("git.status.branch", &[name]),
                upstream
                    .as_ref()
                    .map(|upstream| api.text("git.status.tracks", &[name, &upstream.name]))
                    .unwrap_or_else(|| api.text("git.status.noUpstream", &[name])),
            ),
            Head::Unborn { name } => (
                api.text("git.status.unborn", &[name]),
                api.text("git.status.noCommits", &[name]),
            ),
            Head::Detached { .. } => (
                api.text("git.status.detached", &[&text]),
                api.text("git.status.detachedTooltip", &[&text]),
            ),
        };
        statusbar.push(json!({"id":"ash.status.git.branch","text":text,"ariaLabel":branch_aria,"tooltip":branch_tooltip,"priority":900,"compactGroup":"ash.status.git","icon":"git-branch","enabled":!repository.is_busy()}));
        if configuration.boolean("enableStatusBarSync", true)
            && repository
                .catalog
                .as_ref()
                .is_some_and(|catalog| !catalog.remotes.is_empty())
        {
            let (text, aria, tooltip, icon) = if let Some(upstream) = head.upstream() {
                let read_only = repository
                    .catalog
                    .as_ref()
                    .is_some_and(|catalog| catalog.upstream_read_only);
                let counts = api.text(
                    if upstream.ahead + upstream.behind == 1 {
                        "git.status.syncOne"
                    } else {
                        "git.status.syncMany"
                    },
                    &[&upstream.behind.to_string(), &upstream.ahead.to_string()],
                );
                (
                    if upstream.ahead + upstream.behind > 0 {
                        if repository
                            .catalog
                            .as_ref()
                            .is_some_and(|catalog| catalog.upstream_read_only)
                        {
                            format!("{}↓", upstream.behind)
                        } else {
                            format!("{}↓ {}↑", upstream.behind, upstream.ahead)
                        }
                    } else {
                        String::new()
                    },
                    if read_only {
                        api.text(
                            "git.status.pullTooltip",
                            &[&upstream.behind.to_string(), &upstream.name],
                        )
                    } else {
                        api.text("git.status.sync", &[&counts])
                    },
                    if upstream.ahead + upstream.behind == 0 {
                        api.text("git.status.syncIdle", &[])
                    } else if upstream.ahead == 0
                        || repository
                            .catalog
                            .as_ref()
                            .is_some_and(|catalog| catalog.upstream_read_only)
                    {
                        api.text(
                            "git.status.pullTooltip",
                            &[&upstream.behind.to_string(), &upstream.name],
                        )
                    } else if upstream.behind == 0 {
                        api.text(
                            "git.status.pushTooltip",
                            &[&upstream.ahead.to_string(), &upstream.name],
                        )
                    } else {
                        api.text("git.status.syncTooltip", &[&upstream.name, &counts])
                    },
                    "sync",
                )
            } else if let Head::Branch { name, .. } = head {
                let label = api.text("git.status.publish", &[name]);
                (String::new(), label.clone(), label, "cloud")
            } else {
                let label = api.text("git.status.noBranch", &[]);
                (String::new(), label.clone(), label, "sync")
            };
            let busy_label = repository
                .operation
                .filter(|operation| *operation != crate::model::RepositoryOperation::Preparing)
                .map(|operation| {
                    api.text(
                        if operation == crate::model::RepositoryOperation::Synchronize {
                            "git.status.synchronizing"
                        } else {
                            "git.operationProgress"
                        },
                        &[],
                    )
                });
            let synchronizing =
                repository.operation == Some(crate::model::RepositoryOperation::Synchronize);
            statusbar.push(json!({"id":"ash.status.git.sync","text":text,"ariaLabel":busy_label.as_deref().unwrap_or(&aria),"tooltip":busy_label.as_deref().unwrap_or(&tooltip),"priority":800,"compactGroup":"ash.status.git","icon":if synchronizing {"sync"} else {icon},"showProgress":synchronizing,"enabled":!repository.is_busy() && matches!(head,Head::Branch{..})}));
        }
    }
    if let Some(blame) = &repository.blame {
        if configuration.boolean("blame.statusBarItem.enabled", true) {
            // Right-side entries grow inward as priority decreases; cursor position uses 40.
            statusbar.push(json!({"id":"git.blame","icon":"git-commit","text":blame.label,"ariaLabel":blame.label,"tooltip":blame.details,"alignment":"right","priority":30,"enabled":true}));
        }
    }
    let (label, tooltip) = match (primary, head.and_then(Head::upstream)) {
        ("sync", Some(upstream)) => {
            let behind = upstream.behind.to_string();
            let ahead = upstream.ahead.to_string();
            let counts = api.text(
                if upstream.ahead + upstream.behind == 1 {
                    "git.status.syncOne"
                } else {
                    "git.status.syncMany"
                },
                &[&behind, &ahead],
            );
            (
                api.text("git.syncButton", &[&behind, &ahead]),
                api.text("git.status.sync", &[&counts]),
            )
        }
        _ => {
            let label = api.text(
                if primary == "publish" {
                    "command.git.publish"
                } else {
                    "git.commit"
                },
                &[],
            );
            (label.clone(), label)
        }
    };
    let can_accept = primary != "commit"
        || !changes.iter().any(|change| change.conflicted)
            && (staged || smart && !changes.is_empty());
    let command = |id: &str, title: String| json!({"id":id,"title":title,"arguments":[repository.descriptor.id]});
    let secondary_commands = if primary == "commit" {
        vec![
            vec![
                command("git.commitStaged", api.text("git.menu.commitStaged", &[])),
                command("git.commitAll", api.text("git.menu.commitAll", &[])),
            ],
            vec![
                command("git.commitAmend", api.text("git.menu.amend", &[])),
                command(
                    "git.commitSigned",
                    api.text("git.commitSignedCommand.label", &[]),
                ),
            ],
        ]
    } else {
        Vec::new()
    };
    let primary_command = command(
        match primary {
            "sync" => "git.sync",
            "publish" => "git.publish",
            _ => "git.commit",
        },
        format!(
            "$({}) {label}",
            match primary {
                "sync" | "publish"
                    if repository.operation
                        == Some(crate::model::RepositoryOperation::Synchronize) =>
                {
                    "sync~spin"
                }
                "sync" => "sync",
                "publish" => "cloud",
                _ => "check",
            }
        ),
    );
    let count = match configuration.text("countBadge", "all") {
        "off" => 0,
        "tracked" => changes
            .iter()
            .filter(|change| change.worktree_status != "untracked")
            .count(),
        _ => changes.len(),
    };
    let status_message = if limit_reached && !configuration.boolean("ignoreLimitWarning", false) {
        api.text("git.limitReached", &[])
    } else if repository.is_busy() && configuration.boolean("showProgress", true) {
        api.text("git.operationProgress", &[])
    } else if !repository.error.is_empty() {
        repository.error.clone()
    } else if !repository.notice.is_empty() {
        repository.notice.clone()
    } else if changes.is_empty() {
        api.text("git.noChanges", &[])
    } else {
        repository.error.clone()
    };
    let history_ref = head.map(|head| json!({"id":branch.map(|name|format!("refs/heads/{name}")).unwrap_or_else(||"HEAD".into()),"name":branch.unwrap_or("HEAD"),"revision":head.object_id(),"category":"localBranch"}));
    let remote_ref = head.and_then(Head::upstream).map(|upstream|json!({"id":format!("refs/remotes/{}",upstream.name),"name":upstream.name,"revision":upstream.object_id,"category":"remoteBranch"}));
    let source_uri = format!(
        "ash-scm://ash.git/{}",
        url::form_urlencoded::byte_serialize(repository.descriptor.id.as_bytes())
            .collect::<String>()
    );
    Ok(
        json!({"id":repository.descriptor.id,"providerId":"git","label":repository.descriptor.label,"rootUri":repository.root_uri,
        "count":count,"selected":selected,"selectionRevision":selection_revision,"groups":groups,
        "input":{"visible":configuration.boolean("showCommitInput",true),"buttonVisible":configuration.value("showActionButton").get(primary).and_then(Value::as_bool).unwrap_or(true),"value":repository.draft,
            "validationMessage":input_validation,"placeholder":api.text("git.commitMessageOnBranch",&[if cfg!(target_os="macos") {"Cmd+Enter"} else {"Ctrl+Enter"},branch.unwrap_or("HEAD")]),"enabled":true,"canAccept":can_accept,"buttonLabel":label,"buttonTooltip":tooltip},
        "actionButton":{"command":primary_command,"secondaryCommands":secondary_commands,"enabled":can_accept && !repository.is_busy()},
        "activeRepositoryName":branch,"statusMessage":status_message,"isBusy":repository.is_busy(),"statusBarCommands":statusbar,
        "timeline":{"label":api.text("git.timelineHistory",&[]),"resetKey":format!("{}:{}:{}",configuration.text("timeline.date","committed"),configuration.boolean("timeline.showAuthor",true),configuration.boolean("timeline.showUncommitted",false))},
        "hasHistory":true,"hasHistoryItemRefs":true,"hasHistoryMergeBase":true,"historyRef":history_ref,"historyRemoteRef":remote_ref,
        "historyRevision":repository.status.as_ref().map(|status|status.history_revision).unwrap_or(0),"historyRefsRevision":0,"historyRefsItems":[],"hasMerge":true,"inputRevision":repository.input_revision,
        "multiDiff":{"resourcePrefix":source_uri,"sourceActions":[
            {"id":"staged","label":api.text("git.stagedChanges",&[]),"tooltip":api.text("git.stagedChanges",&[]),"command":"git.openChangesSource","arguments":[repository.descriptor.id,"staged"]},
            {"id":"unstaged","label":api.text("git.changes",&[]),"tooltip":api.text("git.changes",&[]),"command":"git.openChangesSource","arguments":[repository.descriptor.id,"unstaged"]}],
            "repositoryActions":[{"id":"commit","label":api.text("git.commit",&[]),"tooltip":api.text("git.commit",&[]),"command":"git.commitFromChanges","arguments":[repository.descriptor.id]}]}}),
    )
}
fn validate_input(api: &Api, repository: &Repository) -> Option<String> {
    let configuration = &repository.configuration;
    if !configuration.boolean("inputValidation", true) {
        return None;
    }
    for (index, line) in repository.draft.lines().enumerate() {
        let limit = if index == 0 {
            configuration
                .value("inputValidationSubjectLength")
                .as_u64()
                .unwrap_or(configuration.number("inputValidationLength", 72))
        } else {
            configuration.number("inputValidationLength", 72)
        } as usize;
        if limit > 0 && line.chars().count() > limit {
            return Some(api.text(
                "git.commitInputTooLong",
                &[&(index + 1).to_string(), &limit.to_string()],
            ));
        }
    }
    None
}

/// A single in-flight publication with one coalesced successor. UI acknowledgements must
/// never hold the repository model or block a Git operation behind initialization.
pub(crate) struct Publisher {
    state: std::sync::Arc<(std::sync::Mutex<Publication>, std::sync::Condvar)>,
    worker: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    client: external_ext_sdk::client::BackgroundClient,
}
#[derive(Default)]
struct Publication {
    latest: Option<(u64, Vec<Value>)>,
    revision: u64,
    stopped: bool,
    error: Option<String>,
}
impl Publisher {
    pub fn start(
        client: external_ext_sdk::client::BackgroundClient,
    ) -> Result<Self, external_ext_sdk::ExtensionError> {
        let state = std::sync::Arc::new((
            std::sync::Mutex::new(Publication::default()),
            std::sync::Condvar::new(),
        ));
        let pending = std::sync::Arc::clone(&state);
        let sender = client.clone();
        let worker = std::thread::Builder::new()
            .name("git-scm-publications".into())
            .spawn(move || {
                loop {
                    let (lock, ready) = &*pending;
                    let Ok(mut state) = lock.lock() else {
                        return;
                    };
                    while state.latest.is_none() && !state.stopped {
                        let Ok(next) = ready.wait(state) else {
                            return;
                        };
                        state = next;
                    }
                    if state.stopped {
                        return;
                    }
                    let Some((revision, providers)) = state.latest.take() else {
                        continue;
                    };
                    drop(state);
                    if let Err(error) =
                        sender.update_source_control(crate::SCM_ID, revision, providers)
                    {
                        if let Ok(mut state) = lock.lock() {
                            state.error = Some(error.message);
                        }
                        return;
                    }
                }
            })
            .map_err(|_| crate::api::invalid("Git publication worker could not start"))?;
        Ok(Self {
            state,
            worker: std::sync::Mutex::new(Some(worker)),
            client,
        })
    }
    pub fn enqueue(
        &self,
        revision: u64,
        providers: Vec<Value>,
    ) -> Result<(), external_ext_sdk::ExtensionError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| crate::api::invalid("Git publication failed"))?;
        if state.stopped {
            return Ok(());
        }
        if let Some(error) = &state.error {
            return Err(crate::api::invalid(error));
        }
        if revision > state.revision {
            state.revision = revision;
            state.latest = Some((revision, providers));
            ready.notify_one();
        }
        Ok(())
    }
    pub fn stop(&self) {
        let (lock, ready) = &*self.state;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            state.latest = None;
            ready.notify_all();
        }
        self.client.close();
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        self.stop();
    }
}
