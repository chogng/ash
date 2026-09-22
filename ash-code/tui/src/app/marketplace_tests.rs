use super::App;
use super::AppCommand;
use super::CommandPanel;
use crate::lsp;
use crate::marketplace;
use crate::thread::composer::ChatInputItem;
use crate::thread::composer::SlashCommandInvocation;
use crate::thread::composer::TuiSlashCommandAction;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionPointerTarget;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::common::ServerInfo;
use ash_app_server_protocol::protocol::initialize::CapabilityContract;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityKindDto as Kind;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstalledPackageDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageDetailsDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchParams;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;
use serde_json::Value;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

struct Transport {
    replies: VecDeque<Value>,
    requests: Arc<Mutex<Vec<Value>>>,
}
impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        let id = request["id"].clone();
        self.requests.lock().unwrap().push(request);
        let reply = self.replies.pop_front().expect("unexpected request");
        Ok(if let Some(error) = reply.get("error") {
            json!({"jsonrpc":"2.0", "id":id, "error":error})
        } else {
            json!({"jsonrpc":"2.0", "id":id, "result":reply})
        }
        .to_string())
    }
}
fn client(
    replies: impl IntoIterator<Item = Value>,
) -> (AppServerClient<Transport>, Arc<Mutex<Vec<Value>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    (
        AppServerClient::new(Transport {
            replies: replies.into_iter().collect(),
            requests: requests.clone(),
        }),
        requests,
    )
}
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn focus(app: &mut App, id: &str) {
    let id = ListSelectionItemId::new(id);
    let state = match app.panels_mut().command_mut().unwrap() {
        CommandPanel::Marketplace(panel) => panel.state_mut(),
        CommandPanel::Lsp(panel) => panel.state_mut(),
        _ => panic!("wrong panel"),
    };
    assert!(state.focus_item(&id), "missing {id:?}");
}
fn screen(app: &App) -> String {
    let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(100)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}
fn package(id: &str, version: &str) -> MarketplaceInstalledPackageDto {
    serde_json::from_value(json!({
        "installationId":id,"package":{"id":"web@official","version":version,"digest":"sha256:fixture"},"state":"installed",
        "capabilities":[{"reference":{"id":"skill-reference"},"kind":"skill","id":"web-guide","contractVersion":"1","permissions":[],"authenticationProvider":null}]
    })).unwrap()
}
fn details() -> MarketplacePackageDetailsDto {
    serde_json::from_value(json!({
        "package":{"id":"web@official","version":"2.0.0","digest":"sha256:fixture"},"packageType":"plugin","displayName":"Web tools","description":"Language server and skill bundle","license":"MIT","source":"official","upstream":null,
        "capabilities":[{"kind":"skill","id":"web-guide","contractVersion":"1","permissions":[],"authenticationProvider":null},{"kind":"executable","id":"web-lsp","contractVersion":"1","permissions":["process.spawn","network:example.test"],"authenticationProvider":null}]
    })).unwrap()
}
fn lsp_page() -> lsp::Page {
    lsp::Page {
        scope: lsp::Scope::default(),
        revision: 7,
        configured: serde_json::from_value(
            json!({"web-lsp":{"mode":"enabled","executable":"/tools/web-lsp"}}),
        )
        .unwrap(),
        servers: serde_json::from_value(
            json!([{"id":"web-lsp","languageIds":["typescript","javascript"]}]),
        )
        .unwrap(),
        directories: Vec::new(),
        error: None,
    }
}
fn initialized(supports_filters: bool) -> Value {
    let mut capabilities = ServerCapabilities {
        marketplace: true,
        ..Default::default()
    };
    if supports_filters {
        capabilities.contracts.insert(
            "marketplaceSearch".into(),
            CapabilityContract { version: 1 },
        );
    }
    serde_json::to_value(InitializeResult {
        server_info: ServerInfo {
            name: "fixture".into(),
            version: "1".into(),
        },
        protocol_version: ProtocolVersion::current(),
        schema_hash: ash_app_server_protocol::protocol::common::SchemaHash(
            ash_app_server_protocol::schema_hash(),
        ),
        capabilities,
        slash_commands: Vec::new(),
    })
    .unwrap()
}
fn initialize(client: &mut AppServerClient<Transport>) {
    client
        .initialize(InitializeParams {
            client_info: ClientInfo {
                name: "tui-test".into(),
                version: "1".into(),
            },
            capabilities: Default::default(),
        })
        .unwrap();
}

#[test]
fn marketplace_slash_commands_open_panels_without_creating_a_conversation() {
    let (mut client, requests) = client([
        json!({"packages":[]}),
        json!({"instanceId":"test","generation":1,"packages":[]}),
        serde_json::to_value(crate::test_support::empty_config_snapshot()).unwrap(),
        json!({"servers":[]}),
    ]);
    let mut app = App::new();
    for (command, argument, loading_title, title) in [
        (
            TuiSlashCommandAction::Marketplace,
            "rust",
            "Marketplace",
            "Marketplace",
        ),
        (
            TuiSlashCommandAction::Plugins,
            "",
            "Plugins",
            "Plugins · Installed packages",
        ),
        (
            TuiSlashCommandAction::Lsp,
            "rust",
            "Language servers",
            "Language servers",
        ),
    ] {
        let invocation = SlashCommandInvocation {
            command: command.definition(),
            origin: ash_slash_commands::SlashCommandOrigin::Local,
            display_arguments: argument.into(),
            arguments: (!argument.is_empty())
                .then(|| ChatInputItem::Text(argument.into()))
                .into_iter()
                .collect(),
        };
        let request = AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(
            invocation.clone(),
        ));
        assert_eq!(request.panel_title(), Some(loading_title));
        let output = super::dispatch::execute_product_command(
            None,
            &mut client,
            std::path::Path::new("/workspace"),
            invocation,
        )
        .unwrap();
        assert!(output.conversation.is_none());
        for event in output.events {
            app.update(event);
        }
        assert_eq!(app.list_selection().unwrap().title(), title);
    }
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "marketplace/search",
            "marketplace/listInstalled",
            "config/read",
            "language/servers"
        ]
    );
    assert_eq!(requests[0]["params"]["query"], "rust");
}

#[test]
fn marketplace_search_uses_exact_capability_and_language_filters_and_gates_old_servers() {
    for supported in [true, false] {
        let (mut client, requests) = client([initialized(supported), json!({"packages":[]})]);
        initialize(&mut client);
        let mut app = App::new();
        app.update(lsp::Event(lsp_page()));
        focus(&mut app, "find");
        assert!(app.handle_key(key(KeyCode::Enter)).is_none());
        app.handle_paste("typescript".into());
        let Some(AppCommand::Marketplace(command)) = app.handle_key(key(KeyCode::Enter)) else {
            panic!("expected Marketplace search");
        };
        let event = marketplace::execute(&mut client, command).unwrap();
        app.update(event);
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), if supported { 2 } else { 1 });
        if supported {
            assert_eq!(requests[1]["params"]["capabilityKind"], "executable");
            assert_eq!(requests[1]["params"]["languageId"], "typescript");
            assert!(requests[1]["params"]["packageType"].is_null());
        } else {
            assert!(
                app.list_selection()
                    .unwrap()
                    .message()
                    .unwrap()
                    .contains("does not support")
            );
        }
    }
}

#[test]
fn marketplace_review_requires_confirmation_and_installs_the_reviewed_version() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Review {
        details: details(),
        installation_id: None,
    }));
    crate::tui_assert_snapshot!("marketplace_whole_package_review", screen(&app));
    assert!(matches!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(marketplace::Command::Browse(_)))
    ));
    app.update(marketplace::Event(marketplace::Page::Review {
        details: details(),
        installation_id: None,
    }));
    focus(&mut app, "confirm");
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(marketplace::Command::Install {
            package_id: "web@official".into(),
            version: "2.0.0".into()
        }))
    );
}

#[test]
fn marketplace_installed_versions_have_distinct_actions_and_offline_uninstall() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Installed {
        packages: vec![package("v1", "1.0.0"), package("v2", "2.0.0")],
        selected: Some("v1".into()),
    }));
    crate::tui_assert_snapshot!("marketplace_installed_versions", screen(&app));
    // The shared typed mouse target follows the same action path as Enter.
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Item(ListSelectionItemId::new("v1")),
        Rect::new(0, 0, 100, 32),
        crate::widgets::list_selection::ListSelectionClick::Single,
    );
    assert!(app.handle_command_panel_outcome(outcome).is_none());
    focus(&mut app, "remove");
    assert!(app.handle_key(key(KeyCode::Enter)).is_none());
    crate::tui_assert_snapshot!("marketplace_confirm_exact_removal", screen(&app));
    focus(&mut app, "remove");
    let Some(AppCommand::Marketplace(command)) = app.handle_key(key(KeyCode::Enter)) else {
        panic!("expected removal")
    };
    let (mut client, requests) = client([
        Value::Null,
        json!({"instanceId":"test","generation":2,"packages":[package("v2","2.0.0")]}),
    ]);
    app.update(marketplace::execute(&mut client, command).unwrap());
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0]["method"], "marketplace/uninstall");
    assert_eq!(
        requests[0]["params"],
        json!({"installationId":"v1","mode":"whenUnused"})
    );
    assert_eq!(requests[1]["method"], "marketplace/listInstalled");
}

#[test]
fn marketplace_update_tracks_the_new_installation_identity_and_pending_removal_is_read_only() {
    let (mut client, requests) = client([
        serde_json::to_value(package("new-v2", "2.0.0")).unwrap(),
        json!({"instanceId":"test","generation":2,"packages":[package("other","1.0.0"),package("new-v2","2.0.0")]}),
    ]);
    let mut app = App::new();
    app.update(
        marketplace::execute(
            &mut client,
            marketplace::Command::Update {
                installation_id: "old-v1".into(),
                version: "2.0.0".into(),
            },
        )
        .unwrap(),
    );
    assert_eq!(
        app.list_selection().unwrap().selected_item().unwrap().id(),
        Some(&ListSelectionItemId::new("new-v2"))
    );
    assert_eq!(
        requests.lock().unwrap()[0]["params"],
        json!({"installationId":"old-v1","version":"2.0.0"})
    );
    let mut pending = package("pending", "1.0.0");
    pending.state = ash_app_server_protocol::protocol::marketplace::MarketplaceInstallationStateDto::PendingRemoval;
    app.update(marketplace::Event(marketplace::Page::Installed {
        packages: vec![pending],
        selected: Some("pending".into()),
    }));
    app.handle_key(key(KeyCode::Enter));
    assert!(
        !app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(
                |item| item.label().contains("Uninstall") || item.label().contains("Review latest")
            )
    );
}

#[test]
fn marketplace_failed_search_keeps_offline_management_accessible_and_dismissal_rejects_late_reply()
{
    let (mut client, _) = client([json!({"error":{"code":-32000,"message":"Catalog offline"}})]);
    let mut app = App::new();
    app.update(marketplace::execute(&mut client, marketplace::Command::browse(None)).unwrap());
    crate::tui_assert_snapshot!("marketplace_catalog_offline", screen(&app));
    focus(&mut app, "installed");
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(marketplace::Command::Installed))
    );
    let generation = app.panels().generation();
    app.close_command_panel();
    app.update_for_panel(
        generation,
        marketplace::Event(marketplace::Page::Installed {
            packages: vec![],
            selected: None,
        }),
    );
    assert!(app.command_panel().is_none());
}

#[test]
fn lsp_panel_preserves_revision_and_program_and_keeps_draft_after_conflict() {
    let mut app = App::new();
    app.update(lsp::Event(lsp_page()));
    crate::tui_assert_snapshot!("lsp_available_servers", screen(&app));
    focus(&mut app, "web-lsp");
    app.handle_key(key(KeyCode::Enter));
    focus(&mut app, "mode");
    let Some(AppCommand::Lsp(lsp::Command::Configure {
        revision,
        server_id,
        config,
        ..
    })) = app.handle_key(key(KeyCode::Enter))
    else {
        panic!("expected configure")
    };
    assert_eq!(revision, 7);
    assert_eq!(server_id, "web-lsp");
    assert_eq!(
        config.mode,
        ash_app_server_protocol::protocol::config::LanguageServerModeDto::Disabled
    );
    assert_eq!(config.executable.as_deref(), Some("/tools/web-lsp"));
    focus(&mut app, "path");
    app.handle_key(key(KeyCode::Enter));
    app.handle_paste("/tools/new web-lsp".into());
    let Some(AppCommand::Lsp(command)) = app.handle_key(key(KeyCode::Enter)) else {
        panic!("expected executable configuration")
    };
    let (mut client, requests) =
        client([json!({"error":{"code":-32000,"message":"Config revision conflict"}})]);
    let generation = app.panels().generation();
    let error = lsp::execute(&mut client, None, command).err().unwrap();
    app.update_for_panel(generation, crate::thread::Event::FailureReported(error));
    assert_eq!(app.list_selection().unwrap().query(), "/tools/new web-lsp");
    assert_eq!(requests.lock().unwrap()[0]["params"]["expectedRevision"], 7);
    crate::tui_assert_snapshot!("lsp_config_conflict_keeps_input", screen(&app));
}

#[test]
fn marketplace_and_lsp_panels_render_in_inline_mode() {
    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.update(marketplace::Event(marketplace::Page::Catalog {params:MarketplaceSearchParams {capability_kind:Some(Kind::Skill),..Default::default()},packages:serde_json::from_value(json!([{"id":"guide@official","version":"1.0.0","packageType":"plugin","displayName":"Guide","description":"A bundled skill"}])).unwrap(),error:None}));
    crate::tui_assert_snapshot!("marketplace_inline_search", screen(&app));
    app.update(lsp::Event(lsp_page()));
    crate::tui_assert_snapshot!("lsp_inline_servers", screen(&app));
}

#[test]
fn lsp_writes_backend_configuration_and_restores_defaults_in_the_selected_directory() {
    let directory = ash_app_server_protocol::protocol::environment::SessionDirSelector {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        path: std::path::PathBuf::from("/workspace/project"),
    };
    let scope = lsp::Scope {
        language_id: Some("typescript".into()),
        directory: Some(directory.clone()),
    };
    let mut config = crate::test_support::empty_config_snapshot();
    config.revision = 8;
    let replies = [
        json!({"revision":8,"generation":8,"disposition":"updated"}),
        serde_json::to_value(&config).unwrap(),
        json!({"servers":[]}),
    ];
    let (mut client, requests) = client(replies);
    lsp::execute(
        &mut client,
        None,
        lsp::Command::Remove {
            scope,
            revision: 7,
            server_id: "web-lsp".into(),
        },
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["languageServer/remove", "config/read", "language/servers"]
    );
    assert_eq!(requests[0]["params"]["serverId"], "web-lsp");
    assert_eq!(requests[0]["params"]["expectedRevision"], 7);
    assert_eq!(requests[2]["params"], json!({"sessionDirectory":directory}));
}

#[test]
fn marketplace_consumer_panels_use_the_shared_installation_entry() {
    use crate::widgets::list_selection::ListSelectionClick;
    let mut app = App::new();
    let skills = ash_app_server_protocol::protocol::skills::SkillListResult {
        generation: 1,
        skills: Vec::new(),
        diagnostics: Vec::new(),
    };
    app.update(crate::skills::Event::SettingsOpened(
        crate::skills::skill_choices(&skills),
    ));
    crate::tui_assert_snapshot!("skills_marketplace_entry", screen(&app));
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Action,
        Rect::new(0, 0, 100, 32),
        ListSelectionClick::Single,
    );
    assert_eq!(
        app.handle_command_panel_outcome(outcome),
        Some(AppCommand::Marketplace(marketplace::Command::browse(Some(
            Kind::Skill
        ))))
    );
}

#[test]
fn marketplace_in_flight_actions_cannot_be_repeated_and_failure_keeps_the_review() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Review {
        details: details(),
        installation_id: None,
    }));
    focus(&mut app, "confirm");
    if let Some(CommandPanel::Marketplace(panel)) = app.panels_mut().command_mut() {
        panel.begin_request();
    }
    assert!(app.handle_key(key(KeyCode::Enter)).is_none());
    let generation = app.panels().generation();
    app.update_for_panel(
        generation,
        crate::thread::Event::FailureReported("Download failed".into()),
    );
    assert_eq!(
        app.list_selection().unwrap().title(),
        "Review package · Web tools"
    );
    assert!(matches!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(
            marketplace::Command::Install { .. }
        ))
    ));
    app.handle_key(key(KeyCode::Esc));
}
