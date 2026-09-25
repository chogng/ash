use super::*;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;
use ash_protocol::CommandId;
use core_api::StartThreadRequest;
use serde_json::json;
use std::sync::Arc;

struct Model;
impl core_api::ModelService for Model {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ash_protocol::ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, core_api::CoreError> {
        unreachable!("Import must not invoke a model")
    }
}

fn setup(root: &Path) -> (AppServer, Value) {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(Model),
    );
    let thread = server
        .start_thread(StartThreadRequest {
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("import-root").unwrap(),
            title: "import".into(),
        })
        .unwrap();
    server
        .env_runtime
        .read()
        .unwrap()
        .dir_grants
        .add_dir(
            thread.session_id.clone(),
            Grant::for_session_tree(
                thread.session_id.clone(),
                Dir::open_local(root).unwrap(),
                GrantSource::HostConfiguration,
                Permissions::new([
                    Permission::BrowseFiles,
                    Permission::ReadFiles,
                    Permission::WriteFiles,
                    Permission::LoadInstructions,
                ]),
            ),
        )
        .unwrap();
    (server, json!({"sessionId":thread.session_id, "path":root}))
}

fn fixture(root: &Path) {
    std::fs::create_dir_all(root.join(".github/instructions")).unwrap();
    std::fs::write(root.join("AGENTS.md"), "Shared original").unwrap();
    std::fs::write(
        root.join(".github/copilot-instructions.md"),
        "Common imported rule. [Rust](instructions/rust.instructions.md)",
    )
    .unwrap();
    std::fs::write(
        root.join(".github/instructions/rust.instructions.md"),
        "---\napplyTo: '**/*.rs,**/Cargo.toml'\n---\nRust imported rule.",
    )
    .unwrap();
}

#[test]
fn instruction_import_rpc_publishes_reviewed_files_and_retries_without_overwriting() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let (server, directory) = setup(root.path());
    let mut connection = server.connection();
    let mut request_id = 0;
    let mut rpc = |method: &str, params: Value| -> Value {
        request_id += 1;
        let response: Value = serde_json::from_str(&server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}).to_string(),
        ))
        .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    };
    rpc(
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
    );
    let preview = rpc(
        "instructions/importPreview",
        json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
    );
    assert_eq!(preview["items"].as_array().unwrap().len(), 2);
    assert!(!root.path().join("ASH.md").exists());
    let params = json!({"scope":"directory","source":"copilot","directory":directory,"sources":[],"digest":preview["digest"]});
    let applied = rpc("instructions/import", params.clone());
    assert!(
        applied["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "imported"),
        "{applied}"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("AGENTS.md")).unwrap(),
        "Shared original"
    );
    assert!(
        std::fs::read_to_string(root.path().join("ASH.md"))
            .unwrap()
            .contains("(.ash/instructions/copilot-rust.md)")
    );
    let snapshot = ash_instructions::InstructionCatalog::discover(root.path()).snapshot();
    assert!(snapshot.diagnostics().is_empty());
    assert!(
        snapshot
            .automatic_content(&[PathBuf::from("src/main.rs")])
            .unwrap()
            .contains("Rust imported rule.")
    );
    assert!(
        !snapshot
            .automatic_content(&[PathBuf::from("src/main.ts")])
            .unwrap()
            .contains("Rust imported rule.")
    );
    let retried = rpc("instructions/import", params.clone());
    assert!(
        retried["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "unchanged")
    );
    std::fs::write(root.path().join("ASH.md"), "User edited rule").unwrap();
    let conflict = rpc("instructions/import", params);
    assert_eq!(conflict["items"][0]["status"], "conflict");
    assert_eq!(
        std::fs::read_to_string(root.path().join("ASH.md")).unwrap(),
        "User edited rule"
    );
}

#[test]
fn instruction_import_rejects_stale_sources_and_revoked_write_permission() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let (server, directory) = setup(root.path());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    let params = json!({"scope":"directory","source":"copilot","directory":directory,"sources":[],"digest":preview["digest"]});
    std::fs::write(
        root.path().join(".github/copilot-instructions.md"),
        "Changed since preview",
    )
    .unwrap();
    assert!(server.instruction_import(&params).is_err());
    assert!(!root.path().join("ASH.md").exists());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    let session = serde_json::from_value(directory["sessionId"].clone()).unwrap();
    let runtime = server.env_runtime.read().unwrap();
    let revision = runtime.dir_grants.revision(&session);
    runtime
        .dir_grants
        .set_permissions(
            &session,
            root.path(),
            revision,
            Permissions::new([Permission::ReadFiles, Permission::BrowseFiles]),
        )
        .unwrap();
    drop(runtime);
    assert!(
        server
            .instruction_import(
                &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[],"digest":preview["digest"]})
            )
            .is_err()
    );
    assert!(!root.path().join("ASH.md").exists());
}

#[test]
fn instruction_import_rebases_links_without_changing_code_or_external_urls() {
    let mappings = BTreeMap::from([(
        PathBuf::from(".github/instructions/rust.instructions.md"),
        PathBuf::from(".ash/instructions/copilot-rust.md"),
    )]);
    let body = "[Rust](rust.instructions.md#tests) [Docs](../../docs/build.md) [Web](https://example.com)\n\n[reference][rule]\n\n[rule]: rust.instructions.md\n\n```md\n[code](rust.instructions.md)\n```";
    let rewritten = rewrite_links(
        body,
        Path::new(".github/instructions/main.instructions.md"),
        Path::new(".ash/instructions/main.md"),
        &mappings,
    );
    assert!(
        rewritten.contains("[Rust](copilot-rust.md#tests)"),
        "{rewritten}"
    );
    assert!(rewritten.contains("[Docs](../../docs/build.md)"));
    assert!(rewritten.contains("[Web](https://example.com)"));
    assert!(rewritten.contains("[rule]: copilot-rust.md"));
    assert!(rewritten.contains("[code](rust.instructions.md)"));
}

#[test]
fn instruction_import_preserves_manual_selection_and_rejects_invalid_targets() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    std::fs::write(
        root.path()
            .join(".github/instructions/manual.instructions.md"),
        "---\ndescription: Manual rule\n---\nSelect explicitly",
    )
    .unwrap();
    std::fs::write(
        root.path()
            .join(".github/instructions/INVALID.instructions.md"),
        "---\napplyTo: '**'\n---\nInvalid target",
    )
    .unwrap();
    let (server, directory) = setup(root.path());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    assert!(
        preview["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["status"] == "unsupported")
    );
    let selected = vec![".github/instructions/manual.instructions.md"];
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":selected}),
        )
        .unwrap();
    server
        .instruction_import(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":selected,"digest":preview["digest"]}),
        )
        .unwrap();
    let snapshot = ash_instructions::InstructionCatalog::discover(root.path()).snapshot();
    assert_eq!(
        snapshot.entries()[0].load_policy(),
        &ash_instructions::InstructionLoadPolicy::OnDemand
    );
    assert!(
        server
            .instruction_import_preview(
                &json!({"scope":"directory","source":"copilot","directory":directory,"sources":["AGENTS.md"]})
            )
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn instruction_import_refuses_symlink_targets_even_within_the_project() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    std::fs::write(root.path().join("existing.md"), "").unwrap();
    std::os::unix::fs::symlink("existing.md", root.path().join("ASH.md")).unwrap();
    let (server, directory) = setup(root.path());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    assert_eq!(preview["items"][0]["status"], "conflict");
    server
        .instruction_import(&json!({"scope":"directory","source":"copilot","directory":directory,"sources":[],"digest":preview["digest"]}))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("existing.md")).unwrap(),
        ""
    );
    assert!(
        !root
            .path()
            .join(".ash/instructions/copilot-rust.md")
            .exists()
    );
}

#[test]
fn instruction_import_does_not_publish_rules_that_exceed_catalog_capacity() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    std::fs::create_dir_all(root.path().join(".ash/instructions")).unwrap();
    for index in 0..128 {
        std::fs::write(
            root.path()
                .join(format!(".ash/instructions/rule-{index}.md")),
            "---\nload: on-demand\n---\nExisting",
        )
        .unwrap();
    }
    let (server, directory) = setup(root.path());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    assert!(
        preview["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "unsupported")
    );
    server
        .instruction_import(&json!({"scope":"directory","source":"copilot","directory":directory,"sources":[],"digest":preview["digest"]}))
        .unwrap();
    assert!(!root.path().join("ASH.md").exists());
}

#[test]
fn instruction_import_uses_one_pipeline_for_claude_codex_and_cursor() {
    for (source, path, body, target, automatic) in [
        (
            "claude",
            ".claude/rules/global.md",
            "Claude global",
            ".ash/instructions/claude-global.md",
            "Claude global",
        ),
        (
            "cursor",
            ".cursor/rules/ui.mdc",
            "---\nglobs: '**/*.ts'\nalwaysApply: false\n---\nCursor scoped",
            ".ash/instructions/cursor-ui.md",
            "Cursor scoped",
        ),
        (
            "codex",
            "AGENTS.override.md",
            "Codex rule",
            "ASH.md",
            "Codex rule",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
        let (server, directory) = setup(root.path());
        let preview = server
            .instruction_import_preview(
                &json!({"scope":"directory","source":source,"directory":directory,"sources":[]}),
            )
            .unwrap();
        assert_eq!(preview["items"][0]["target"], target);
        assert_eq!(preview["items"][0]["status"], "ready", "{preview}");
        let result = server.instruction_import(&json!({"scope":"directory","source":source,"directory":directory,"sources":[],"digest":preview["digest"]})).unwrap();
        assert_eq!(result["items"][0]["status"], "imported", "{result}");
        let catalog = ash_instructions::InstructionCatalog::discover(root.path()).snapshot();
        assert!(catalog.diagnostics().is_empty());
        assert!(
            catalog
                .automatic_content(&[PathBuf::from("src/main.ts")])
                .unwrap()
                .contains(automatic)
        );
        if source == "cursor" {
            assert!(
                catalog
                    .automatic_content(&[PathBuf::from("src/main.rs")])
                    .is_none()
            );
        }
    }
}

#[test]
fn instruction_import_binds_source_identity_and_reports_colliding_rule_names() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    std::fs::write(root.path().join("CLAUDE.md"), "Other source").unwrap();
    let (server, directory) = setup(root.path());
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"copilot","directory":directory,"sources":[]}),
        )
        .unwrap();
    assert!(server.instruction_import(&json!({"scope":"directory","source":"claude","directory":directory,"sources":[],"digest":preview["digest"]})).is_err());
    assert!(
        server
            .instruction_import_preview(
                &json!({"scope":"directory","directory":directory,"sources":[]})
            )
            .is_err()
    );
    assert!(!root.path().join("ASH.md").exists());
    std::fs::create_dir_all(root.path().join(".claude/rules/a")).unwrap();
    for path in [".claude/rules/a/b.md", ".claude/rules/a-b.md"] {
        std::fs::write(root.path().join(path), "Rule").unwrap();
    }
    let preview = server
        .instruction_import_preview(
            &json!({"scope":"directory","source":"claude","directory":directory,"sources":[]}),
        )
        .unwrap();
    assert_eq!(
        preview["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["status"] == "unsupported")
            .count(),
        2
    );
    server.instruction_import(&json!({"scope":"directory","source":"claude","directory":directory,"sources":[],"digest":preview["digest"]})).unwrap();
    assert!(!root.path().join("ASH.md").exists());
}

fn grant_target(server: &AppServer, directory: &Value, root: &Path, permissions: Permissions) {
    let session: ash_protocol::SessionId =
        serde_json::from_value(directory["sessionId"].clone()).unwrap();
    server
        .env_runtime
        .read()
        .unwrap()
        .dir_grants
        .add_dir(
            session.clone(),
            Grant::for_session_tree(
                session,
                Dir::open_local(root).unwrap(),
                GrantSource::HostConfiguration,
                permissions,
            ),
        )
        .unwrap();
}

#[test]
fn instruction_import_user_rpc_publishes_to_selected_home_and_refreshes_user_catalog() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(source.path().join(".claude/rules")).unwrap();
    std::fs::write(
        source.path().join(".claude/CLAUDE.md"),
        "User root [rule](rules/global.md) [notes](notes.md)",
    )
    .unwrap();
    std::fs::write(
        source.path().join(".claude/rules/global.md"),
        "User global rule",
    )
    .unwrap();
    std::fs::write(
        source.path().join(".claude/rules/rust.md"),
        "---\npaths: ['**/*.rs']\n---\nUser Rust rule",
    )
    .unwrap();
    std::fs::write(source.path().join(".claude/notes.md"), "Linked notes").unwrap();
    let (server, directory) = setup(source.path());
    let home = Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(target.path()).unwrap(),
    ));
    let server = server.with_home(home.clone());
    grant_target(
        &server,
        &directory,
        target.path(),
        Permissions::new([
            Permission::ReadFiles,
            Permission::BrowseFiles,
            Permission::WriteFiles,
        ]),
    );
    let mut connection = server.connection();
    let mut id = 0;
    let mut rpc = |method: &str, params: Value| {
        id += 1;
        let response: Value = serde_json::from_str(&server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
        ))
        .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    };
    rpc(
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
    );
    let preview = rpc(
        "instructions/importPreview",
        json!({"scope":"user","source":"claude","directory":directory,"sources":[]}),
    );
    assert_eq!(
        PathBuf::from(preview["targetDirectory"].as_str().unwrap()),
        dunce::canonicalize(target.path()).unwrap()
    );
    assert_eq!(preview["items"].as_array().unwrap().len(), 3);
    assert!(
        preview["items"][0]["content"]
            .as_str()
            .unwrap()
            .contains("(instructions/claude-global.md)")
    );
    let content = preview["items"][0]["content"].as_str().unwrap();
    let notes_link = pulldown_cmark::Parser::new(content)
        .find_map(|event| match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link { dest_url, .. })
                if dest_url.ends_with("notes.md") =>
            {
                Some(dest_url.into_string())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        dunce::canonicalize(target.path().join(notes_link)).unwrap(),
        dunce::canonicalize(source.path().join(".claude/notes.md")).unwrap()
    );
    let params = json!({"scope":"user","source":"claude","directory":directory,"sources":[],"digest":preview["digest"]});
    let applied = rpc("instructions/import", params.clone());
    assert!(
        applied["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "imported")
    );
    assert!(!source.path().join("ASH.md").exists());
    assert!(!target.path().join(".ash").exists());
    let catalog = home.instructions();
    assert!(catalog.diagnostics().is_empty());
    let body = catalog
        .automatic_content(&[PathBuf::from("src/main.rs")])
        .unwrap();
    assert!(
        body.contains("User root")
            && body.contains("User global rule")
            && body.contains("User Rust rule")
    );
    assert!(
        !catalog
            .automatic_content(&[PathBuf::from("src/main.ts")])
            .unwrap()
            .contains("User Rust rule")
    );
    let listing = rpc(
        "instructions/list",
        json!({"sessionId":directory["sessionId"]}),
    );
    assert!(
        listing["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["scope"] == "user")
    );
    assert_eq!(listing["instructions"].as_array().unwrap().len(), 3);
    let retry = rpc("instructions/import", params.clone());
    assert!(
        retry["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "unchanged")
    );
    std::fs::write(target.path().join("ASH.md"), "User edits").unwrap();
    let conflict = rpc("instructions/import", params);
    assert_eq!(conflict["items"][0]["status"], "conflict");
    assert_eq!(
        std::fs::read_to_string(target.path().join("ASH.md")).unwrap(),
        "User edits"
    );
}

#[test]
fn instruction_import_user_checks_separate_target_permissions_scope_and_home_identity() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::create_dir(source.path().join(".codex")).unwrap();
    std::fs::write(source.path().join(".codex/AGENTS.md"), "Ordinary").unwrap();
    std::fs::write(source.path().join(".codex/AGENTS.override.md"), "Override").unwrap();
    let (server, directory) = setup(source.path());
    let request = json!({"scope":"user","source":"codex","directory":directory,"sources":[]});
    assert!(server.instruction_import_preview(&request).is_err());
    let mut server = server.with_home(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(target.path()).unwrap(),
    )));
    assert!(server.instruction_import_preview(&request).is_err());
    grant_target(
        &server,
        &directory,
        target.path(),
        Permissions::new([Permission::ReadFiles, Permission::BrowseFiles]),
    );
    let preview = server.instruction_import_preview(&request).unwrap();
    assert_eq!(preview["items"][0]["content"], "Override");
    assert_eq!(preview["items"].as_array().unwrap().len(), 1);
    let apply = json!({"scope":"user","source":"codex","directory":directory,"sources":[],"digest":preview["digest"]});
    assert!(server.instruction_import(&apply).is_err());
    let session = serde_json::from_value(directory["sessionId"].clone()).unwrap();
    let runtime = server.env_runtime.read().unwrap();
    runtime
        .dir_grants
        .set_permissions(
            &session,
            target.path(),
            runtime.dir_grants.revision(&session),
            Permissions::new([
                Permission::ReadFiles,
                Permission::BrowseFiles,
                Permission::WriteFiles,
            ]),
        )
        .unwrap();
    drop(runtime);
    let mut wrong_scope = apply.clone();
    wrong_scope["scope"] = json!("directory");
    assert!(server.instruction_import(&wrong_scope).is_err());
    grant_target(
        &server,
        &directory,
        other.path(),
        Permissions::new([
            Permission::ReadFiles,
            Permission::BrowseFiles,
            Permission::WriteFiles,
        ]),
    );
    server.home = Some(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(other.path()).unwrap(),
    )));
    assert!(server.instruction_import(&apply).is_err());
    assert!(!other.path().join("ASH.md").exists());
    server.home = Some(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(target.path()).unwrap(),
    )));
    std::fs::write(source.path().join(".codex/AGENTS.override.md"), "Changed").unwrap();
    assert!(server.instruction_import(&apply).is_err());
    assert!(!target.path().join("ASH.md").exists());
    for unsupported in ["cursor", "copilot"] {
        let mut request = request.clone();
        request["source"] = json!(unsupported);
        assert!(server.instruction_import_preview(&request).is_err());
    }
}

#[cfg(unix)]
#[test]
fn instruction_import_user_rejects_symlink_rule_directory() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let actual = target.path().join("actual");
    std::fs::create_dir(&actual).unwrap();
    std::fs::create_dir_all(source.path().join(".claude/rules")).unwrap();
    std::fs::write(source.path().join(".claude/rules/global.md"), "User rule").unwrap();
    std::os::unix::fs::symlink(&actual, target.path().join("instructions")).unwrap();
    let (server, directory) = setup(source.path());
    let server = server.with_home(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(target.path()).unwrap(),
    )));
    grant_target(
        &server,
        &directory,
        target.path(),
        Permissions::new([
            Permission::ReadFiles,
            Permission::BrowseFiles,
            Permission::WriteFiles,
        ]),
    );
    let request = json!({"scope":"user","source":"claude","directory":directory,"sources":[]});
    let preview = server.instruction_import_preview(&request).unwrap();
    assert_eq!(preview["items"][0]["status"], "conflict");
    server.instruction_import(&json!({"scope":"user","source":"claude","directory":directory,"sources":[],"digest":preview["digest"]})).unwrap();
    assert!(!actual.join("claude-global.md").exists());
}
