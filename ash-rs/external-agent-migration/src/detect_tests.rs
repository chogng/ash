use std::fs;
use std::path::Path;

use tempfile::TempDir;

use crate::detect_migration_plan;
use crate::import::AgentImportDiagnosticCode;
use crate::import::AgentImportLocation;
use crate::import::ImportItemKind;
use crate::plan::ExternalDocument;
use crate::plan::ExternalMcpDefinition;
use crate::plan::MarketplaceSource;
use crate::plan::MigrationItemDetail;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn kinds(plan: &crate::MigrationPlan) -> Vec<ImportItemKind> {
    plan.items().iter().map(|item| item.kind()).collect()
}

#[test]
fn claude_user_layout_produces_full_plan() {
    let home = TempDir::new().unwrap();
    let claude = home.path().join(".claude");
    write(&claude.join("CLAUDE.md"), "# Personal instructions\n");
    write(
        &claude.join("settings.json"),
        r#"{"env": {"A": "1"}, "enabledPlugins": {"reviewer@team": true}, "enabledMcpjsonServers": ["web"], "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"command": "before"}]}]}}"#,
    );
    write(
        &claude.join("settings.local.json"),
        r#"{"model": "claude"}"#,
    );
    write(&claude.join("skills/one/SKILL.md"), "s");
    write(&claude.join("skills/two/SKILL.md"), "s");
    write(
        &claude.join("commands/deploy.md"),
        "---\ndescription: Deploy\n---\n",
    );
    write(&claude.join("commands/README.md"), "docs");
    write(
        &claude.join("agents/reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code\n---\nBody\n",
    );
    write(&claude.join("agents/broken.md"), "---\nname: [broken\n");
    write(&claude.join("rules/always.md"), "rule");
    write(
        &home.path().join(".claude.json"),
        r#"{"mcpServers": {"web": {"url": "https://example.test"}}}"#,
    );
    write(
        &claude.join("plugins/known_marketplaces.json"),
        r#"{"team": {"source": {"source": "github", "repo": "acme/team-plugins"}}}"#,
    );
    write(&claude.join("projects/-tmp-proj/memory/notes.md"), "m");

    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();

    assert_eq!(
        kinds(&plan),
        vec![
            ImportItemKind::Instructions,
            ImportItemKind::Settings,
            ImportItemKind::Skills,
            ImportItemKind::Commands,
            ImportItemKind::Agents,
            ImportItemKind::InstructionRules,
            ImportItemKind::McpServers,
            ImportItemKind::Hooks,
            ImportItemKind::Plugins,
            ImportItemKind::Memory,
        ]
    );

    let settings = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::Settings)
        .unwrap();
    match settings.detail() {
        MigrationItemDetail::Settings {
            document: ExternalDocument::Json(document),
        } => {
            assert_eq!(
                document.get("model").and_then(|v| v.as_str()),
                Some("claude")
            );
            assert_eq!(
                document.pointer("/env/A").and_then(|v| v.as_str()),
                Some("1")
            );
        }
        other => panic!("unexpected settings detail: {other:?}"),
    }

    let mcp = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::McpServers)
        .unwrap();
    match mcp.detail() {
        MigrationItemDetail::McpServers { servers } => {
            assert_eq!(servers.len(), 1);
            assert_eq!(servers[0].name, "web");
            assert!(servers[0].definition.is_ok());
        }
        other => panic!("unexpected mcp detail: {other:?}"),
    }

    let plugins = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::Plugins)
        .unwrap();
    match plugins.detail() {
        MigrationItemDetail::Plugins { marketplaces } => {
            assert_eq!(marketplaces.len(), 1);
            assert_eq!(marketplaces[0].plugins, vec!["reviewer"]);
            assert_eq!(
                marketplaces[0].source,
                Some(MarketplaceSource::GitHub {
                    repo: "acme/team-plugins".to_string(),
                    reference: None,
                })
            );
        }
        other => panic!("unexpected plugins detail: {other:?}"),
    }

    let memory = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::Memory)
        .unwrap();
    match memory.detail() {
        MigrationItemDetail::Memory { files } => {
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].project_key, "-tmp-proj");
        }
        other => panic!("unexpected memory detail: {other:?}"),
    }

    assert!(plan.diagnostics().is_empty());
}

#[test]
fn claude_project_layout_cross_reads_user_home_mcp_config() {
    let home = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let canonical_project = project.path().canonicalize().unwrap();
    write(&project.path().join("CLAUDE.md"), "# Repo instructions\n");
    write(
        &project.path().join(".claude/settings.json"),
        r#"{"sandbox": {"enabled": true}}"#,
    );
    write(
        &project.path().join(".mcp.json"),
        r#"{"mcpServers": {"local": {"command": "srv", "args": ["--x"]}}}"#,
    );
    write(
        &home.path().join(".claude.json"),
        &format!(
            r#"{{"projects": {{ "{}": {{"mcpServers": {{"home-only": {{"command": "home"}}}}}} }}}}"#,
            canonical_project.display()
        ),
    );

    let plan = detect_migration_plan(
        [AgentImportLocation::claude_project(project.path())],
        Some(home.path()),
    )
    .unwrap();

    assert_eq!(
        kinds(&plan),
        vec![
            ImportItemKind::Instructions,
            ImportItemKind::Settings,
            ImportItemKind::McpServers,
        ]
    );
    let mcp = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::McpServers)
        .unwrap();
    match mcp.detail() {
        MigrationItemDetail::McpServers { servers } => {
            assert_eq!(servers.len(), 2);
            let local = servers.iter().find(|s| s.name == "local").unwrap();
            assert_eq!(
                local.definition,
                Ok(ExternalMcpDefinition::Stdio {
                    command: "srv".to_string(),
                    args: vec!["--x".to_string()],
                    env: Default::default(),
                    env_vars: Vec::new(),
                })
            );
        }
        other => panic!("unexpected mcp detail: {other:?}"),
    }
    assert!(plan.diagnostics().is_empty());
}

#[test]
fn claude_disabled_mcp_servers_are_marked_unsupported() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".claude/settings.json"),
        r#"{"disabledMcpjsonServers": ["off"]}"#,
    );
    write(
        &home.path().join(".claude.json"),
        r#"{"mcpServers": {"off": {"command": "x"}, "on": {"command": "y"}}}"#,
    );

    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    let mcp = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::McpServers)
        .unwrap();
    match mcp.detail() {
        MigrationItemDetail::McpServers { servers } => {
            let off = servers.iter().find(|server| server.name == "off").unwrap();
            assert!(off.definition.is_err());
            let on = servers.iter().find(|server| server.name == "on").unwrap();
            assert!(on.definition.is_ok());
        }
        other => panic!("unexpected mcp detail: {other:?}"),
    }
}

#[test]
fn codex_user_layout_produces_full_plan() {
    let home = TempDir::new().unwrap();
    write(&home.path().join(".codex/AGENTS.md"), "# Instructions\n");
    write(
        &home.path().join(".codex/config.toml"),
        "[mcp_servers.fs]\ncommand = \"fsrv\"\nenv = { KEY = \"value\" }\n",
    );
    write(&home.path().join(".agents/skills/one/SKILL.md"), "s");
    write(
        &home.path().join(".codex/agents/helper.toml"),
        "name = \"helper\"\ndescription = \"Helps\"\n",
    );
    write(&home.path().join(".codex/rules/strict.rules"), "rule");

    let plan = detect_migration_plan([AgentImportLocation::codex_user(home.path())], None).unwrap();

    assert_eq!(
        kinds(&plan),
        vec![
            ImportItemKind::Instructions,
            ImportItemKind::Settings,
            ImportItemKind::Skills,
            ImportItemKind::Agents,
            ImportItemKind::ExecutionRules,
            ImportItemKind::McpServers,
        ]
    );

    let agents = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::Agents)
        .unwrap();
    match agents.detail() {
        MigrationItemDetail::Agents { definitions } => {
            assert_eq!(definitions.len(), 1);
            assert_eq!(definitions[0].name, "helper");
            assert_eq!(definitions[0].description, "Helps");
        }
        other => panic!("unexpected agents detail: {other:?}"),
    }
    assert!(plan.diagnostics().is_empty());
}

#[test]
fn invalid_settings_become_diagnostics_instead_of_items() {
    let home = TempDir::new().unwrap();
    write(&home.path().join(".claude/settings.json"), "{broken");

    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();

    assert!(plan.items().is_empty());
    assert_eq!(plan.diagnostics().len(), 1);
    assert_eq!(
        plan.diagnostics()[0].code(),
        AgentImportDiagnosticCode::InvalidContent
    );
    assert_eq!(plan.diagnostics()[0].kind(), ImportItemKind::Settings);
}

#[test]
fn empty_layouts_yield_no_items() {
    let home = TempDir::new().unwrap();
    let plan = detect_migration_plan(
        [
            AgentImportLocation::claude_user(home.path()),
            AgentImportLocation::codex_user(home.path()),
        ],
        None,
    )
    .unwrap();
    assert!(plan.items().is_empty());
    assert!(plan.diagnostics().is_empty());
}

#[test]
fn duplicate_locations_deduplicate_items() {
    let home = TempDir::new().unwrap();
    write(&home.path().join(".claude/skills/one/SKILL.md"), "s");

    let plan = detect_migration_plan(
        [
            AgentImportLocation::claude_user(home.path()),
            AgentImportLocation::claude_user(home.path()),
        ],
        None,
    )
    .unwrap();
    assert_eq!(plan.items().len(), 1);
}

#[test]
fn local_only_settings_and_hooks_retain_the_actual_source() {
    let home = TempDir::new().unwrap();
    let local = home.path().join(".claude/settings.local.json");
    write(
        &local,
        r#"{"model":"local","hooks":{"PreToolUse":[{"hooks":[{"command":"local"}]}]}}"#,
    );
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    assert_eq!(
        kinds(&plan),
        [ImportItemKind::Settings, ImportItemKind::Hooks]
    );
    for item in plan.items() {
        assert_eq!(item.source_paths(), [local.canonicalize().unwrap()]);
    }
    assert!(plan.diagnostics().is_empty());
}

#[test]
fn settings_overlays_replace_values_but_hooks_accumulate_groups() {
    let home = TempDir::new().unwrap();
    let base = home.path().join(".claude/settings.json");
    let local = home.path().join(".claude/settings.local.json");
    write(
        &base,
        r#"{"model":"base","hooks":{"PreToolUse":[{"hooks":[{"command":"base"}]}]}}"#,
    );
    write(
        &local,
        r#"{"model":"local","hooks":{"PreToolUse":[{"hooks":[{"command":"local"}]},{"hooks":[null]},{"hooks":[{"command":"ok"},false]}]}}"#,
    );
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    for item in plan.items() {
        assert_eq!(item.source_paths().len(), 2);
        assert!(item.source_paths().contains(&base.canonicalize().unwrap()));
        assert!(item.source_paths().contains(&local.canonicalize().unwrap()));
        match item.detail() {
            MigrationItemDetail::Settings {
                document: ExternalDocument::Json(value),
            } => assert_eq!(value["model"], "local"),
            MigrationItemDetail::Hooks { events } => {
                assert_eq!(events.len(), 1);
                assert_eq!(events[0].groups, 4);
                assert_eq!(events[0].command_groups, 2);
            }
            _ => panic!("unexpected item"),
        }
    }
}

#[test]
fn local_disable_all_hooks_applies_to_both_documents() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".claude/settings.json"),
        r#"{"hooks":{"Stop":[{"hooks":[{"command":"base"}]}]}}"#,
    );
    write(
        &home.path().join(".claude/settings.local.json"),
        r#"{"disableAllHooks":true}"#,
    );
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    assert_eq!(kinds(&plan), [ImportItemKind::Settings]);
}

#[test]
fn memory_is_independent_of_missing_or_invalid_settings() {
    for invalid_settings in [false, true] {
        let home = TempDir::new().unwrap();
        let memory = home.path().join(".claude/projects/project/memory/notes.md");
        write(&memory, "notes");
        if invalid_settings {
            write(&home.path().join(".claude/settings.json"), "{broken");
        }
        let plan =
            detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
        assert_eq!(kinds(&plan), [ImportItemKind::Memory]);
        assert_eq!(
            plan.items()[0].source_paths(),
            [memory.canonicalize().unwrap()]
        );
    }
}

#[test]
fn codex_rules_and_disabled_mcp_preserve_source_semantics() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".codex/rules/default.rules"),
        "prefix_rule(pattern=[\"git\"], decision=\"prompt\")",
    );
    write(&home.path().join(".codex/rules/README.md"), "not a rule");
    write(
        &home.path().join(".codex/config.toml"),
        "[mcp_servers.off]\ncommand=\"fixture\"\nenabled=false\n[mcp_servers.web]\nurl=\"https://example.test\"\nenabled=false\n[mcp_servers.on]\ncommand=\"fixture\"\n",
    );
    let plan = detect_migration_plan([AgentImportLocation::codex_user(home.path())], None).unwrap();
    let rules = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::ExecutionRules)
        .unwrap();
    assert!(
        matches!(rules.detail(), MigrationItemDetail::Rules { names } if names == &["default"])
    );
    let mcp = plan
        .items()
        .iter()
        .find(|item| item.kind() == ImportItemKind::McpServers)
        .unwrap();
    let MigrationItemDetail::McpServers { servers } = mcp.detail() else {
        panic!("expected MCP")
    };
    for server in servers {
        if server.name == "on" {
            assert!(server.definition.is_ok());
        } else {
            assert_eq!(
                server.definition,
                Err(crate::McpServerUnsupported::Disabled)
            );
        }
    }
}

#[test]
fn home_only_mcp_records_the_file_actually_read() {
    let home = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let path = home.path().join(".claude.json");
    write(&path, &serde_json::json!({"projects": {project.path().canonicalize().unwrap().to_str().unwrap(): {"mcpServers": {"home": {"command": "fixture"}}}}}).to_string());
    let plan = detect_migration_plan(
        [AgentImportLocation::claude_project(project.path())],
        Some(home.path()),
    )
    .unwrap();
    assert_eq!(kinds(&plan), [ImportItemKind::McpServers]);
    assert_eq!(
        plan.items()[0].source_paths(),
        [path.canonicalize().unwrap()]
    );
}

#[cfg(unix)]
#[test]
fn rejects_external_file_and_ancestor_symlinks_before_parsing() {
    let cases = [
        (
            ".mcp.json",
            r#"{"mcpServers":{"outside":{"command":"fixture"}}}"#,
            ImportItemKind::McpServers,
        ),
        (
            ".claude/settings.local.json",
            r#"{"model":"outside","hooks":{"Stop":[{"hooks":[{"command":"fixture"}]}]}}"#,
            ImportItemKind::Settings,
        ),
        (
            ".codex/config.toml",
            "model=\"outside\"",
            ImportItemKind::Settings,
        ),
        (
            "CLAUDE.md",
            "outside instructions",
            ImportItemKind::Instructions,
        ),
    ];
    for (relative, contents, kind) in cases {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let file = outside.path().join("source");
        write(&file, contents);
        let link = project.path().join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let location = if relative.starts_with(".codex") {
            AgentImportLocation::codex_project(project.path())
        } else {
            AgentImportLocation::claude_project(project.path())
        };
        let plan = detect_migration_plan([location], None).unwrap();
        assert!(plan.items().is_empty(), "{relative}");
        assert!(
            plan.diagnostics()
                .iter()
                .any(
                    |diagnostic| diagnostic.relative_path() == Path::new(relative)
                        && diagnostic.kind() == kind
                        && diagnostic.code() == AgentImportDiagnosticCode::SymlinkNotAllowed
                )
        );
    }
    let home = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(&outside.path().join("settings.json"), "{}");
    write(
        &outside.path().join("agents/agent.md"),
        "---\nname: outside\ndescription: outside\n---\nbody",
    );
    write(
        &outside.path().join("projects/project/memory/notes.md"),
        "outside",
    );
    std::os::unix::fs::symlink(outside.path(), home.path().join(".claude")).unwrap();
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    assert!(plan.items().is_empty());
    assert!(!plan.diagnostics().is_empty());
    assert!(
        plan.diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.code() == AgentImportDiagnosticCode::SymlinkNotAllowed)
    );
}

#[cfg(unix)]
#[test]
fn rejected_overlay_and_home_mcp_do_not_discard_valid_local_sources() {
    let home = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    write(
        &project.path().join(".claude/settings.json"),
        r#"{"model":"safe"}"#,
    );
    write(&outside.path().join("settings"), r#"{"model":"outside"}"#);
    std::os::unix::fs::symlink(
        outside.path().join("settings"),
        project.path().join(".claude/settings.local.json"),
    )
    .unwrap();
    write(
        &project.path().join(".mcp.json"),
        r#"{"mcpServers":{"safe":{"command":"fixture"}}}"#,
    );
    write(&outside.path().join("mcp"), "{}");
    std::os::unix::fs::symlink(outside.path().join("mcp"), home.path().join(".claude.json"))
        .unwrap();
    let plan = detect_migration_plan(
        [AgentImportLocation::claude_project(project.path())],
        Some(home.path()),
    )
    .unwrap();
    assert_eq!(
        kinds(&plan),
        [ImportItemKind::Settings, ImportItemKind::McpServers]
    );
    let MigrationItemDetail::Settings {
        document: ExternalDocument::Json(settings),
    } = plan.items()[0].detail()
    else {
        panic!("expected settings")
    };
    assert_eq!(settings["model"], "safe");
    assert_eq!(plan.diagnostics().len(), 2);
    assert!(
        plan.diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.scope() == crate::ImportScope::User)
    );
}

#[test]
fn invalid_mcp_source_does_not_discard_other_servers() {
    let project = TempDir::new().unwrap();
    write(&project.path().join(".mcp.json"), "{broken");
    write(
        &project.path().join(".claude.json"),
        r#"{"mcpServers":{"valid":{"command":"fixture"}}}"#,
    );
    let plan =
        detect_migration_plan([AgentImportLocation::claude_project(project.path())], None).unwrap();
    assert_eq!(kinds(&plan), [ImportItemKind::McpServers]);
    assert_eq!(
        plan.items()[0].source_paths(),
        [project.path().join(".claude.json").canonicalize().unwrap()]
    );
    assert_eq!(plan.diagnostics().len(), 1);
    assert_eq!(
        plan.diagnostics()[0].relative_path(),
        Path::new(".mcp.json")
    );
}

#[test]
fn invalid_registry_produces_a_redacted_diagnostic_and_preserves_known_plugins() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".claude/settings.json"),
        r#"{"enabledPlugins":{"reviewer@claude-plugins-official":true}}"#,
    );
    write(
        &home.path().join(".claude/plugins/known_marketplaces.json"),
        "{private-invalid-content",
    );
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    assert!(kinds(&plan).contains(&ImportItemKind::Plugins));
    assert_eq!(plan.diagnostics().len(), 1);
    assert_eq!(
        plan.diagnostics()[0].relative_path(),
        Path::new(".claude/plugins/known_marketplaces.json")
    );
    assert_eq!(
        plan.diagnostics()[0].code(),
        AgentImportDiagnosticCode::InvalidContent
    );
    let debug = format!("{plan:?}");
    assert!(!debug.contains(home.path().to_str().unwrap()));
    assert!(!debug.contains("private-invalid-content"));
}

#[test]
fn oversized_files_and_deep_memory_are_isolated() {
    let home = TempDir::new().unwrap();
    write(
        &home.path().join(".claude/settings.json"),
        &"x".repeat(crate::source::MAX_FILE_BYTES + 1),
    );
    let valid_memory = home.path().join(".claude/projects/project/memory/valid.md");
    write(&valid_memory, "valid");
    let mut deep = home.path().join(".claude/projects/project/memory");
    for _ in 0..crate::source::MAX_PATH_DEPTH {
        deep.push("nested");
    }
    write(&deep.join("ignored.md"), "too deep");
    let plan =
        detect_migration_plan([AgentImportLocation::claude_user(home.path())], None).unwrap();
    assert_eq!(kinds(&plan), [ImportItemKind::Memory]);
    assert_eq!(
        plan.items()[0].source_paths(),
        [valid_memory.canonicalize().unwrap()]
    );
    assert_eq!(plan.diagnostics().len(), 2);
    assert!(
        plan.diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.code() == AgentImportDiagnosticCode::LimitExceeded)
    );
}
