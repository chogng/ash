use ash_external_ext as host;
use external_ext_protocol::ExtensionClientOperation as Operation;
use external_ext_protocol::ExtensionClientResult as ResultValue;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

struct Authority(AtomicBool);
struct Lease;
impl host::ActivationLease for Lease {}
impl host::ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn acquire(&self) -> Option<Box<dyn host::ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Lease) as Box<dyn host::ActivationLease>)
    }
}
struct Client {
    root: PathBuf,
    editor_requests: Mutex<Vec<Value>>,
    editor_document: Mutex<Option<String>>,
    revision: AtomicU64,
    binary_comparison: AtomicBool,
    conflict_comparison: AtomicBool,
    cancel_protected_commit: AtomicBool,
    cancel_clone_input: AtomicBool,
    configuration: Mutex<Value>,
    shared_configuration: Mutex<Value>,
    snapshots: Mutex<Vec<Value>>,
    requests: Mutex<Vec<(String, Value)>>,
}
impl Client {
    fn git(&self, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    fn status(&self) -> Value {
        if self.binary_comparison.load(Ordering::Acquire) {
            return json!({"repositoryId":"root","streamInstanceId":"11111111-1111-4111-8111-111111111111","revision":self.revision.load(Ordering::Relaxed),"historyRevision":1,"path":"","head":{"type":"branch","name":"main","objectId":self.git(&["rev-parse","HEAD"]),"upstream":null},"changes":[{"path":"image.bin","indexStatus":"modified","worktreeStatus":"modified","conflicted":self.conflict_comparison.load(Ordering::Acquire),"submodule":{"isSubmodule":false,"commitChanged":false,"trackedChanges":false,"untrackedChanges":false}}]});
        }
        let head = self.git(&["rev-parse", "HEAD"]);
        let staged = !self.git(&["diff", "--cached", "--name-only"]).is_empty();
        let unstaged = !self.git(&["diff", "--name-only"]).is_empty();
        json!({"repositoryId":"root","streamInstanceId":"11111111-1111-4111-8111-111111111111","revision":self.revision.load(Ordering::Relaxed),"historyRevision":1,"path":"","head":{"type":"branch","name":"main","objectId":head,"upstream":null},"changes":if staged||unstaged {vec![json!({"path":"file.txt","originalPath":null,"indexStatus":if staged {"modified"} else {"unmodified"},"worktreeStatus":if unstaged {"modified"} else {"unmodified"},"conflicted":false,"submodule":{"isSubmodule":false,"commitChanged":false,"trackedChanges":false,"untrackedChanges":false}})]} else {vec![]}})
    }
    fn request(&self, operation: Operation) -> Result<ResultValue, host::HostFailure> {
        let result = match operation {
            Operation::BackendState {
                wait_for_change, ..
            } => {
                if wait_for_change == Some(true) {
                    // This fixture has no notification producer; model the bounded idle tick.
                    std::thread::sleep(Duration::from_millis(500));
                }
                ResultValue::Value {
                    value: json!({"connection":"ready","sequence":0,"generation":1,"reset":false,"events":[],"folders":[{"id":"workspace","name":"test","uri":url::Url::from_directory_path(&self.root).unwrap().to_string().trim_end_matches('/')} ]}),
                }
            }
            Operation::InspectConfiguration { section, .. } => ResultValue::Configuration {
                value: json!({"userLocalValue":self.configuration.lock().unwrap()[section.strip_prefix("git.").unwrap_or(&section)]}),
            },
            Operation::ResetConfiguration { section, .. } => {
                self.configuration
                    .lock()
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(section.strip_prefix("git.").unwrap_or(&section));
                ResultValue::Done
            }
            Operation::ReadConfiguration { .. } => ResultValue::Configuration {
                value: self.configuration.lock().unwrap().clone(),
            },
            Operation::EditorOperation { payload } => {
                self.editor_requests.lock().unwrap().push(payload.clone());
                ResultValue::Value {
                    value: match payload["method"].as_str() {
                        Some("openEditorResources") => json!([]),
                        Some("activeEditor") => {
                            json!({"input":self.editor_document.lock().unwrap().as_ref().map(|uri|json!({"resource":uri})),"selection":null,"version":null,"contents":null})
                        }
                        Some("prepareRepositoryOperation") => json!(true),
                        Some("input") => {
                            if self.cancel_clone_input.swap(false, Ordering::AcqRel) {
                                Value::Null
                            } else {
                                json!("fixture password")
                            }
                        }
                        Some("readEditorDocument") => {
                            json!({"text":"Edited from terminal","dirty":true})
                        }
                        Some("openEditorDocument") => {
                            *self.editor_document.lock().unwrap() =
                                Some(payload["uri"].as_str().unwrap().into());
                            Value::Null
                        }
                        Some("closeEditorDocument") => {
                            *self.editor_document.lock().unwrap() = None;
                            Value::Null
                        }
                        Some("confirm") => json!({"confirmed":true}),
                        Some("open") => Value::Null,
                        _ => panic!("Unexpected editor request {payload}"),
                    },
                }
            }
            Operation::ExecuteCommand { command, arguments } => {
                assert_eq!(command, "github.isBranchProtected");
                assert_eq!(arguments[0], "main");
                assert_eq!(arguments[1][0]["identity"]["provider"], "github");
                ResultValue::Command {
                    value: json!(true),
                    has_value: true,
                }
            }
            Operation::ShowQuickPick { items, .. } => {
                if items.len() == 1 {
                    assert!(matches!(
                        items[0].label.as_str(),
                        "file.txt" | "initial → changed"
                    ));
                } else {
                    assert_eq!(items.len(), 2);
                }
                ResultValue::Selection {
                    index: if items.len() == 2
                        && self.cancel_protected_commit.swap(false, Ordering::AcqRel)
                    {
                        None
                    } else {
                        Some(0)
                    },
                }
            }
            Operation::ShowMessage { .. } => ResultValue::Done,
            Operation::ScmUpdate { providers, .. } => {
                self.snapshots.lock().unwrap().push(json!(providers));
                ResultValue::Done
            }
            Operation::BackendRequest { method, params, .. } => {
                self.requests
                    .lock()
                    .unwrap()
                    .push((method.clone(), params.clone()));
                let value = match method.as_str() {
                    "readConfig" => self.shared_configuration.lock().unwrap().clone(),
                    "updateConfig" => {
                        let mut shared = self.shared_configuration.lock().unwrap();
                        assert_eq!(params["expectedRevision"], shared["revision"]);
                        shared["git"] = params["git"].clone();
                        shared["gitConfigured"] = json!(true);
                        shared["revision"] = json!(shared["revision"].as_u64().unwrap() + 1);
                        // Match the manifest's updateConfig resultFields grant.
                        json!({"revision":shared["revision"]})
                    }
                    "version" => {
                        json!({"installation":{"kind":"available","version":"git version 2.50.0"}})
                    }
                    "repositories" => {
                        json!({"repositories":[{"id":"root","label":"test","path":"","dirId":"workspace"}]})
                    }
                    "status" => self.status(),
                    "catalog" => {
                        json!({"tags":[],"stashes":[],"remotes":["origin"],"upstreamReadOnly":false,"operation":null})
                    }
                    "graph" => {
                        json!({"commits":[],"references":[],"hasMore":false,"remotes":[{"name":"origin","identity":{"provider":"github","host":"github.com","owner":"synthetic","repository":"fixture"}}]})
                    }
                    "historyRefs" => {
                        json!({"status":self.status(),"references":[{"kind":"localBranch","name":"main","objectId":"abc","current":true},{"kind":"remoteBranch","name":"origin/main","objectId":"abc","current":false},{"kind":"tag","name":"v1","objectId":"abc","current":false}],"branches":[],"remotes":[],"graphRevision":1})
                    }
                    "textDiff" => {
                        assert!(self.binary_comparison.load(Ordering::Acquire));
                        json!({"status":self.status(),"diffs":[],"statistics":{"files":0,"additions":0,"deletions":0}})
                    }
                    "conflictFile" => {
                        assert!(self.conflict_comparison.load(Ordering::Acquire));
                        json!({"current":{"kind":"binary","data":"AAEA"},"result":{"kind":"binary","data":"AAIA"}})
                    }
                    "changeFile" => {
                        if self.binary_comparison.load(Ordering::Acquire) {
                            assert_eq!(params["path"], "image.bin");
                            json!({"original":{"kind":"binary","data":"AAEA"},"modified":{"kind":"binary","data":"AAIA"}})
                        } else {
                            assert_eq!(params["path"], "file.txt");
                            let staged = params["comparison"] == "staged";
                            let status = self.status();
                            let changed = &status["changes"][0][if staged {
                                "indexStatus"
                            } else {
                                "worktreeStatus"
                            }];
                            if changed == "unmodified" || changed.is_null() {
                                json!({"backendError":{"name":"GitOperationFailed","message":"No change in this comparison"}})
                            } else {
                                let original = self.git(&[
                                    "show",
                                    if staged { "HEAD:file.txt" } else { ":file.txt" },
                                ]);
                                let modified = if staged {
                                    self.git(&["show", ":file.txt"])
                                } else {
                                    std::fs::read_to_string(self.root.join("file.txt"))
                                        .unwrap()
                                        .trim()
                                        .to_string()
                                };
                                json!({"original":{"kind":"text","text":original},"modified":{"kind":"text","text":modified}})
                            }
                        }
                    }
                    "stage" => {
                        self.revision.fetch_add(1, Ordering::Relaxed);
                        self.git(&["add", "--", "file.txt"]);
                        json!({"status":self.status()})
                    }
                    "indexDiff" => {
                        assert_eq!(params["path"], "file.txt");
                        json!({"original":"initial\n","modified":"changed\n","hunks":[{"index":0,"oldStart":1,"oldCount":1,"newStart":1,"newCount":1,"preview":"initial → changed"}]})
                    }
                    "editIndex" => {
                        assert_eq!(params["path"], "file.txt");
                        assert_eq!(params["selection"], json!({"kind":"hunk","index":0}));
                        assert_eq!(params["expectedOriginal"], "initial\n");
                        assert_eq!(params["expectedModified"], "changed\n");
                        match params["comparison"].as_str().unwrap() {
                            "unstaged" => self.git(&["add", "--", "file.txt"]),
                            "staged" => self.git(&["reset", "--quiet", "HEAD", "--", "file.txt"]),
                            comparison => panic!("Unexpected comparison {comparison}"),
                        };
                        self.revision.fetch_add(1, Ordering::Relaxed);
                        json!({"status":self.status()})
                    }
                    "unstage" => {
                        self.revision.fetch_add(1, Ordering::Relaxed);
                        self.git(&["reset", "--quiet", "HEAD", "--", "file.txt"]);
                        json!({"status":self.status()})
                    }
                    "commit" => {
                        self.revision.fetch_add(1, Ordering::Relaxed);
                        assert_eq!(params["hooks"], "run");
                        assert_eq!(params["identity"], "configured");
                        let mut arguments =
                            vec!["commit", "-m", params["message"].as_str().unwrap()];
                        if params["mode"] == "amend" {
                            arguments.push("--amend");
                        }
                        self.git(&arguments);
                        json!({"objectId":self.git(&["rev-parse","HEAD"]),"status":self.status()})
                    }
                    _ => panic!("Unexpected backend method {method}: {params}"),
                };
                ResultValue::Value { value }
            }
            other => panic!("Unexpected client operation {other:?}"),
        };
        Ok(result)
    }
}
fn invocation(registration: &str, operation: &str, payload: Value) -> host::ExtensionInvocation {
    host::ExtensionInvocation {
        registration_id: registration.into(),
        operation: operation.into(),
        payload,
        deadline_unix_millis: NonZeroU64::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(10))
                .as_millis() as u64,
        )
        .unwrap(),
    }
}
fn execute(
    supervisor: &host::ExtensionHostSupervisor,
    client: &Client,
    request: host::ExtensionInvocation,
) -> Value {
    supervisor
        .begin_invoke(request)
        .unwrap()
        .wait_with_client(|operation, _, _| client.request(operation))
        .unwrap()
        .payload
}
fn initialize_git(root: &Path) {
    let run = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Extension Test"]);
    run(&["config", "user.email", "extension@example.test"]);
    std::fs::write(root.join("file.txt"), "initial\n").unwrap();
    run(&["add", "file.txt"]);
    run(&["commit", "-m", "initial"]);
    std::fs::write(root.join("file.txt"), "changed\n").unwrap();
}
fn product_supervisor(root: &Path) -> (host::ExtensionHostSupervisor, Arc<Authority>) {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-git-extension"));
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let supervisor = host::ExtensionHostSupervisor::new(
        Arc::new(host::ProductExecutableLauncher::new(executable.clone()).unwrap()),
        host::ExtensionLaunchCommand::new(
            executable,
            Vec::<String>::new(),
            root,
            // Exercise the product launcher's minimal OS environment. Inheriting
            // the test environment masks Windows loopback startup failures.
            BTreeMap::new(),
        )
        .unwrap(),
        host::ExtensionActivationSpec::new(
            host::ActivateParams {
                initialization: None,
                extension_id: "ash.git".into(),
                package: host::PackageBinding {
                    package_id: "ash.git@0.1.0".into(),
                    package_digest: format!("sha256:{}", "a".repeat(64)),
                    entrypoint: "ash-git-extension".into(),
                },
                runtime_api_version: 1,
                activation_events: vec!["onStartupFinished".into()],
                capabilities: vec![
                    host::ExtensionCapability::Command,
                    host::ExtensionCapability::SourceControl,
                    host::ExtensionCapability::TerminalProfileProvider,
                ],
            },
            NonZeroU64::new(1).unwrap(),
            authority.clone(),
        ),
        host::ExtensionHostLimits {
            isolation: host::ProcessIsolationPolicy::AuthorizedProduct,
            ..Default::default()
        },
        host::RestartPolicy::default(),
    )
    .unwrap();
    (supervisor, authority)
}

#[test]
fn product_git_activates_with_only_its_required_process_environment() {
    let directory = tempfile::tempdir().unwrap();
    let (supervisor, _) = product_supervisor(directory.path());
    let started = supervisor.start().unwrap();
    assert!(started.registrations.iter().any(|registration| matches!(
        registration.kind,
        host::RegistrationKind::SourceControl { .. }
    )));
    assert!(started.registrations.iter().any(|registration| matches!(
        registration.kind,
        host::RegistrationKind::TerminalEnvironment {}
    )));
    supervisor.shutdown().unwrap();
}

#[test]
fn rust_git_registers_scm_and_commits_through_public_client_without_a_js_host() {
    for language in ["en", "zh-CN"] {
        let directory = tempfile::tempdir().unwrap();
        initialize_git(directory.path());
        let client = Arc::new(Client {
            root: directory.path().to_path_buf(),
            editor_requests: Mutex::new(Vec::new()),
            editor_document: Mutex::new(None),
            revision: AtomicU64::new(1),
            binary_comparison: AtomicBool::new(false),
            conflict_comparison: AtomicBool::new(false),
            cancel_protected_commit: AtomicBool::new(true),
            cancel_clone_input: AtomicBool::new(false),
            configuration: Mutex::new(
                json!({"useEditorAsCommitInput":false,"enableSmartCommit":false,"suggestSmartCommit":false,"postCommitCommand":"none","autofetch":true,"autofetchPeriod":120}),
            ),
            shared_configuration: Mutex::new(
                json!({"revision":1,"gitConfigured":false,"git":{"autofetch":"off","autofetchPeriod":180,"rebaseWhenSync":false}}),
            ),
            snapshots: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
        });
        let (supervisor, authority) = product_supervisor(directory.path());
        let binding = Arc::clone(&client);
        let started = supervisor
            .start_with_client(
                Some(external_ext_protocol::ExtensionHostInitialization {
                    language: Some(language.into()),
                    localization: None,
                    workspace_folders: vec![],
                    workspace_name: None,
                    workspace_file: None,
                    configuration_values: json!({}),
                    configuration_data: json!({}),
                }),
                Some(Arc::new(move |_, operation, _, _| {
                    binding.request(operation)
                })),
            )
            .unwrap();
        assert!(started.registrations.iter().any(|registration| matches!(
            registration.kind,
            host::RegistrationKind::SourceControl { .. }
        )));
        assert!(started.registrations.iter().any(|registration|matches!(&registration.kind,host::RegistrationKind::Command{command,title,..} if command=="git.commit" && title==if language=="zh-CN" {"提交"} else {"Commit"})));
        let cold_contexts = execute(
            &supervisor,
            &client,
            invocation(
                "git.getRepositoryContexts",
                "execute",
                json!({"arguments":[]}),
            ),
        );
        assert_eq!(cold_contexts[0]["id"], "root");
        execute(
            &supervisor,
            &client,
            invocation("ash.scm", "scm", json!({"method":"initialize"})),
        );
        for arguments in [json!([]), json!(["root"])] {
            client.cancel_clone_input.store(true, Ordering::Release);
            assert_eq!(
                execute(
                    &supervisor,
                    &client,
                    invocation("git.clone", "execute", json!({"arguments":arguments})),
                ),
                Value::Null
            );
            assert_eq!(
                client.editor_requests.lock().unwrap().last().unwrap()["title"],
                if language == "zh-CN" {
                    "克隆仓库"
                } else {
                    "Clone Repository"
                }
            );
        }
        for (command, staged) in [("git.stageHunk", true), ("git.unstageHunk", false)] {
            execute(
                &supervisor,
                &client,
                invocation(command, "execute", json!({"arguments":["root"]})),
            );
            assert_eq!(
                client.git(&["diff", "--cached", "--name-only"]) == "file.txt",
                staged
            );
        }
        let status_reads = || {
            client
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "status")
                .count()
        };
        let before_stage = status_reads();
        execute(
            &supervisor,
            &client,
            invocation(
                "git.stageAll",
                "execute",
                json!({"arguments":["root"],"activeEditor":null}),
            ),
        );
        assert_eq!(client.git(&["diff", "--cached", "--name-only"]), "file.txt");
        assert_eq!(status_reads(), before_stage);
        // Moving a displayed file between groups uses watched state and each
        // mutation's returned status, without serial status round trips first.
        for (action, staged) in [
            ("unstage:staged:file.txt", false),
            ("stage:changes:file.txt", true),
        ] {
            execute(
                &supervisor,
                &client,
                invocation(
                    "ash.scm",
                    "scm",
                    json!({"method":"action","providerId":"root","actionId":action}),
                ),
            );
            assert_eq!(
                client.git(&["diff", "--cached", "--name-only"]) == "file.txt",
                staged
            );
            assert_eq!(status_reads(), before_stage);
        }
        assert!(
            client
                .configuration
                .lock()
                .unwrap()
                .get("autofetch")
                .is_none()
        );
        assert!(
            client
                .configuration
                .lock()
                .unwrap()
                .get("autofetchPeriod")
                .is_none()
        );
        let settings = execute(
            &supervisor,
            &client,
            invocation("git.readSettings", "execute", json!({"arguments":[]})),
        );
        assert_eq!(
            settings,
            json!({"autoFetch":true,"autoFetchPeriod":120,"rebaseWhenSync":false})
        );
        assert_eq!(
            client.shared_configuration.lock().unwrap()["git"]["autofetch"],
            "default"
        );

        execute(
            &supervisor,
            &client,
            invocation(
                "ash.scm",
                "scm",
                json!({"method":"setInput","providerId":"root","value":"Rust extension commit","inputRevision":1}),
            ),
        );
        // Cancelling the remotely protected branch prompt keeps HEAD and the staged files.
        execute(
            &supervisor,
            &client,
            invocation(
                "git.commit",
                "execute",
                json!({"arguments":["root"],"activeEditor":null}),
            ),
        );
        assert_eq!(client.git(&["log", "-1", "--format=%s"]), "initial");
        assert!(!client.git(&["diff", "--cached", "--name-only"]).is_empty());
        execute(
            &supervisor,
            &client,
            invocation(
                "git.commit",
                "execute",
                json!({"arguments":["root"],"activeEditor":null}),
            ),
        );
        assert_eq!(
            client.git(&["log", "-1", "--format=%s"]),
            "Rust extension commit"
        );
        assert!(client.git(&["status", "--porcelain"]).is_empty());
        // UI publication is coalesced independently of the mutation response. Observe the
        // public snapshot acknowledgement before asserting the settled input and busy state.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = supervisor.snapshot();
            let scm = snapshot
                .registrations
                .iter()
                .find(|registration| registration.registration_id == "ash.scm")
                .unwrap();
            let host::RegistrationKind::SourceControl { providers, .. } = &scm.kind else {
                panic!("SCM registration missing")
            };
            if providers[0]["input"]["value"] == "" && providers[0]["isBusy"] == false {
                assert_eq!(
                    providers[0]["inputRevision"], 1,
                    "a command acknowledges the client's draft revision"
                );
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "commit snapshot did not settle: {providers:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let parent = client.git(&["rev-parse", "HEAD^"]);
        execute(
            &supervisor,
            &client,
            invocation(
                "ash.scm",
                "scm",
                json!({"method":"setInput","providerId":"root","value":"Amended subject\n\nComplete body.","inputRevision":2}),
            ),
        );
        // Smart commit is disabled: a message-only amend must still proceed.
        execute(
            &supervisor,
            &client,
            invocation("git.commitAmend", "execute", json!({"arguments":["root"]})),
        );
        assert_eq!(
            client.git(&["log", "-1", "--format=%B"]),
            "Amended subject\n\nComplete body."
        );
        assert_eq!(client.git(&["rev-parse", "HEAD^"]), parent);
        assert!(client.git(&["status", "--porcelain"]).is_empty());
        verify_history_references(&supervisor, &client);
        verify_workspace_comparisons(&supervisor, &client);
        verify_binary_comparisons(&supervisor, &client);
        verify_terminal_helpers(&supervisor, &client, directory.path());
        supervisor.shutdown().unwrap();
        let reads = client.requests.lock().unwrap().len();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(client.requests.lock().unwrap().len(), reads);
        authority.0.store(false, Ordering::Release);
        assert!(supervisor.start().is_err());
    }
}

fn terminal_environment(
    supervisor: &host::ExtensionHostSupervisor,
    client: &Client,
) -> BTreeMap<String, String> {
    let value = execute(
        supervisor,
        client,
        invocation("git.environment", "getTerminalEnvironment", json!({})),
    );
    assert_eq!(value["persistent"], false);
    value["map"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry[0].as_str().unwrap().into(),
                entry[1]["value"].as_str().unwrap().into(),
            )
        })
        .collect()
}
fn helper(
    root: &Path,
    environment: &BTreeMap<String, String>,
    mode: &str,
    argument: &str,
) -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_ash-git-extension"));
    command
        .current_dir(root)
        .envs(environment)
        .args([mode, argument])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}
fn finish_helper(mut child: std::process::Child) -> std::process::Output {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("helper failed to finish: {:?}", output.status);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}
fn verify_terminal_helpers(
    supervisor: &host::ExtensionHostSupervisor,
    client: &Client,
    root: &Path,
) {
    client.configuration.lock().unwrap()["githubAuthentication"] = json!(false);
    let environment = terminal_environment(supervisor, client);
    assert!(environment.contains_key("GIT_ASKPASS"));
    assert!(!environment.contains_key("GIT_EDITOR"));
    let result = finish_helper(
        helper(
            root,
            &environment,
            "--askpass",
            "Password for 'https://example.test': ",
        )
        .spawn()
        .unwrap(),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(result.stdout, b"fixture password\n");
    let mut forged = environment.clone();
    forged.insert("ASH_GIT_BRIDGE_TOKEN".into(), "0".repeat(64));
    let inputs = client
        .editor_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request["method"] == "input")
        .count();
    assert!(
        !finish_helper(
            helper(root, &forged, "--askpass", "Password: ")
                .spawn()
                .unwrap()
        )
        .status
        .success()
    );
    // Background publication may inspect the active editor while the helper runs. The
    // security boundary is that a forged token never opens an authentication input.
    assert_eq!(
        client
            .editor_requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "input")
            .count(),
        inputs
    );

    client.configuration.lock().unwrap()["terminalAuthentication"] = json!(false);
    assert!(!terminal_environment(supervisor, client).contains_key("GIT_ASKPASS"));
    assert!(
        !finish_helper(
            helper(root, &environment, "--askpass", "Password: ")
                .spawn()
                .unwrap()
        )
        .status
        .success()
    );
    client.configuration.lock().unwrap()["terminalGitEditor"] = json!(true);
    let environment = terminal_environment(supervisor, client);
    assert!(environment.contains_key("GIT_EDITOR"));
    assert!(!environment.contains_key("GIT_ASKPASS"));
    let message = root.join(".git/COMMIT_EDITMSG");
    for (command, expected, success) in [
        ("git.finishTerminalEdit", "Edited from terminal", true),
        ("git.cancelTerminalEdit", "Original message", false),
    ] {
        std::fs::write(&message, "Original message").unwrap();
        let mut child = helper(root, &environment, "--editor", message.to_str().unwrap())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while client.editor_document.lock().unwrap().is_none() {
            if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "terminal editor {command} did not open: {}; extension: {:?}; recent client requests: {:?}",
                    String::from_utf8_lossy(&output.stderr),
                    supervisor.snapshot().stderr,
                    client
                        .editor_requests
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .take(5)
                        .collect::<Vec<_>>()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        execute(
            supervisor,
            client,
            invocation(command, "execute", json!({"arguments":[]})),
        );
        assert_eq!(finish_helper(child).status.success(), success);
        assert_eq!(std::fs::read_to_string(&message).unwrap(), expected);
    }
    client.configuration.lock().unwrap()["enabled"] = json!(false);
    assert!(terminal_environment(supervisor, client).is_empty());
}

fn verify_history_references(supervisor: &host::ExtensionHostSupervisor, client: &Client) {
    let references = execute(
        supervisor,
        client,
        invocation(
            "ash.scm",
            "scm",
            json!({"method":"history","providerId":"root","methodName":"provideHistoryItemRefs","arguments":[]}),
        ),
    );
    let ids: Vec<_> = references
        .as_array()
        .unwrap()
        .iter()
        .map(|reference| reference["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "refs/heads/main",
            "refs/remotes/origin/main",
            "refs/tags/v1"
        ]
    );
    let filtered = execute(
        supervisor,
        client,
        invocation(
            "ash.scm",
            "scm",
            json!({"method":"history","providerId":"root","methodName":"provideHistoryItemRefs","arguments":[["refs/tags/v1"]]}),
        ),
    );
    assert_eq!(filtered.as_array().unwrap().len(), 1);
    assert_eq!(filtered[0]["id"], "refs/tags/v1");
}

fn verify_workspace_comparisons(supervisor: &host::ExtensionHostSupervisor, client: &Client) {
    let original = client.git(&["show", "HEAD:file.txt"]);
    for (stage, modify_again, expected) in [
        (false, false, "workspace only"),
        (true, false, "workspace only"),
        (true, true, "working after index"),
    ] {
        client.git(&["reset", "--hard", "HEAD"]);
        std::fs::write(client.root.join("file.txt"), "workspace only\n").unwrap();
        if stage {
            client.git(&["add", "file.txt"]);
        }
        if modify_again {
            std::fs::write(client.root.join("file.txt"), "working after index\n").unwrap();
        }
        client.revision.fetch_add(1, Ordering::Relaxed);
        execute(
            supervisor,
            client,
            invocation(
                "git.openWorkspaceChanges",
                "execute",
                json!({"arguments":[]}),
            ),
        );
        let requests = client.editor_requests.lock().unwrap();
        let input = &requests
            .iter()
            .rev()
            .find(|request| request["method"] == "open")
            .unwrap()["input"];
        assert_eq!(input["items"].as_array().unwrap().len(), 1);
        assert_eq!(input["items"][0]["original"]["initialText"], original);
        assert_eq!(input["items"][0]["modified"]["initialText"], expected);
    }
    client.git(&["reset", "--hard", "HEAD"]);
}

fn verify_binary_comparisons(supervisor: &host::ExtensionHostSupervisor, client: &Client) {
    client.binary_comparison.store(true, Ordering::Release);
    client.revision.fetch_add(1, Ordering::Relaxed);
    let summary = execute(
        supervisor,
        client,
        invocation("git.getChangesSummary", "execute", json!({"arguments":[]})),
    );
    assert_eq!(
        summary,
        json!({"files":1,"additions":0,"deletions":0,"partial":true})
    );
    execute(
        supervisor,
        client,
        invocation(
            "git.openWorkspaceChanges",
            "execute",
            json!({"arguments":[]}),
        ),
    );
    {
        let requests = client.editor_requests.lock().unwrap();
        let input = &requests
            .iter()
            .rev()
            .find(|request| request["method"] == "open")
            .unwrap()["input"];
        assert_eq!(input["resource"], "ash-scm-workspace:/changes");
        assert_eq!(input["items"][0]["id"], "root:image.bin");
        assert_eq!(input["items"][0]["binary"], true);
        assert_eq!(
            input["items"][0]["modified"]["initialBytes"],
            json!([0, 2, 0])
        );
    }
    for scope in ["staged", "unstaged", "uncommitted"] {
        let comparison = execute(
            supervisor,
            client,
            invocation(
                "ash.scm",
                "scm",
                json!({"method":"multiDiff","providerId":"root","resource":format!("ash-scm://ash.git/root?scope={scope}")}),
            ),
        );
        assert_eq!(comparison["items"].as_array().unwrap().len(), 1);
        let item = &comparison["items"][0];
        assert_eq!(item["binary"], true);
        assert_eq!(item["label"], "image.bin");
        assert_eq!(item["original"]["readOnly"], true);
        assert_eq!(item["modified"]["readOnly"], true);
        assert_eq!(item["original"]["initialBytes"], json!([0, 1, 0]));
        assert_eq!(item["modified"]["initialBytes"], json!([0, 2, 0]));
        assert!(
            item["goToFile"]["resource"]
                .as_str()
                .unwrap()
                .ends_with("/image.bin")
        );
    }
    execute(
        supervisor,
        client,
        invocation(
            "ash.scm",
            "scm",
            json!({"method":"refresh","providerId":"root"}),
        ),
    );
    let before = client.requests.lock().unwrap().len();
    for group in ["changes", "staged"] {
        execute(
            supervisor,
            client,
            invocation(
                "ash.scm",
                "scm",
                json!({"method":"open","providerId":"root","resourceId":format!("{group}:image.bin"),"options":{"pinned":false}}),
            ),
        );
        let baseline = execute(
            supervisor,
            client,
            invocation(
                "ash.scm",
                "scm",
                json!({"method":"quickDiff","providerId":"root","resource":url::Url::from_file_path(client.root.join("image.bin")).unwrap().to_string()}),
            ),
        );
        assert!(baseline.is_null());
    }
    {
        let requests = client.requests.lock().unwrap();
        assert!(
            requests[before..]
                .iter()
                .all(|(method, _)| method != "status"),
            "Opening a published resource must not rescan the repository"
        );
        assert_eq!(
            requests[before..]
                .iter()
                .filter(|(method, _)| method == "changeFile")
                .count(),
            4
        );
    }
    let baseline = execute(
        supervisor,
        client,
        invocation(
            "ash.scm",
            "scm",
            json!({"method":"quickDiff","providerId":"root","resource":url::Url::from_file_path(client.root.join("image.bin")).unwrap().to_string()}),
        ),
    );
    assert!(baseline.is_null());
    client.conflict_comparison.store(true, Ordering::Release);
    client.revision.fetch_add(1, Ordering::Relaxed);
    execute(
        supervisor,
        client,
        invocation(
            "git.openWorkspaceChanges",
            "execute",
            json!({"arguments":[]}),
        ),
    );
    {
        let requests = client.editor_requests.lock().unwrap();
        let input = &requests
            .iter()
            .rev()
            .find(|request| request["method"] == "open")
            .unwrap()["input"];
        assert_eq!(input["items"].as_array().unwrap().len(), 1);
        let item = &input["items"][0];
        assert_eq!(item["binary"], true);
        assert_eq!(item["original"]["initialBytes"], json!([0, 1, 0]));
        assert_eq!(item["modified"]["initialBytes"], json!([0, 2, 0]));
        assert_ne!(item["original"]["resource"], item["modified"]["resource"]);
        assert!(
            item["modified"]["resource"]
                .as_str()
                .unwrap()
                .starts_with("git-conflict:/image.bin?repository=root&stream=")
        );
    }
    client.conflict_comparison.store(false, Ordering::Release);
    client.binary_comparison.store(false, Ordering::Release);
    client.revision.fetch_add(1, Ordering::Relaxed);
    execute(
        supervisor,
        client,
        invocation(
            "ash.scm",
            "scm",
            json!({"method":"refresh","providerId":"root"}),
        ),
    );
}
