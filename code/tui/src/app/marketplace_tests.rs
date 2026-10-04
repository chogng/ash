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
use ratatui::buffer::Buffer;
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
    frame_buffer(app)
        .content
        .chunks(100)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}
fn frame_buffer(app: &App) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
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
        initialized(true),
        json!({"instanceId":"test","generation":1,"packages":[]}),
        json!({"packages":[]}),
        json!({"revision":1,"activationGeneration":1,"packages":[]}),
        serde_json::to_value(crate::test_support::empty_config_snapshot()).unwrap(),
        json!({"servers":[]}),
    ]);
    initialize(&mut client);
    let mut app = App::new();
    for (command, argument, loading_title, title) in [
        (
            TuiSlashCommandAction::Marketplace,
            "rust",
            "Marketplace",
            "Extensions",
        ),
        (TuiSlashCommandAction::Plugins, "", "Plugins", "Extensions"),
        (
            TuiSlashCommandAction::Lsp,
            "rust",
            "Language servers",
            "Language servers",
        ),
    ] {
        let invocation = SlashCommandInvocation {
            mode: Default::default(),
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
            "initialize",
            "marketplace/listInstalled",
            "marketplace/search",
            "plugin/list",
            "config/read",
            "language/servers"
        ]
    );
    assert_eq!(requests[2]["params"]["query"], "rust");
    assert_eq!(requests[2]["params"]["capabilityKind"], Value::Null);
}

#[test]
fn marketplace_search_uses_exact_capability_and_language_filters_and_gates_old_servers() {
    for supported in [true, false] {
        let (mut client, requests) = client([
            initialized(supported),
            json!({"instanceId":"test","generation":1,"packages":[]}),
            json!({"packages":[]}),
        ]);
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
        assert_eq!(requests.len(), if supported { 3 } else { 2 });
        if supported {
            assert_eq!(requests[2]["params"]["capabilityKind"], "executable");
            assert_eq!(requests[2]["params"]["languageId"], "typescript");
            assert!(requests[2]["params"]["packageType"].is_null());
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
    crate::tui_assert_snapshot!(app = &app; "marketplace_whole_package_review", screen(&app));
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
fn marketplace_category_groups_packages_and_keeps_shortcuts_out_of_search_input() {
    let (mut client, requests) = client([
        initialized(true),
        json!({"instanceId":"test","generation":1,"packages":[package("v1", "1.0.0")]}),
        json!({"packages":[
            {"id":"web@official","version":"1.0.0","packageType":"plugin","displayName":"Web tools","description":"Installed bundle"},
            {"id":"guide@ash","version":"2.0.0","packageType":"plugin","displayName":"Guide","description":"Search guide"}
        ]}),
    ]);
    initialize(&mut client);
    let mut app = chinese_app();
    app.update(
        marketplace::execute(&mut client, marketplace::Command::browse(Some(Kind::Skill))).unwrap(),
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests[1]["method"], "marketplace/listInstalled");
    assert_eq!(requests[2]["method"], "marketplace/search");
    assert_eq!(requests[2]["params"]["capabilityKind"], "skill");
    drop(requests);
    let state = app.list_selection().unwrap();
    assert_eq!(state.tabs().len(), 5);
    assert_eq!(state.active_tab().label(), "扩展市场");
    assert_eq!(
        state
            .visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        ["ash", "插件", "Guide", "official", "插件", "Web tools"]
    );
    assert_eq!(
        state.visible_items()[2].description(),
        Some("来源：ash\n描述：Search guide\n版本：2.0.0")
    );
    assert_eq!(
        state.visible_items()[5].description(),
        Some("来源：official\n描述：Installed bundle\n版本：1.0.0")
    );
    assert_eq!(state.selected_item().unwrap().label(), "ash");
    crate::tui_assert_snapshot!(app = &app; "marketplace_category_sections", screen(&app));

    focus(&mut app, "guide@ash");
    app.handle_key(key(KeyCode::Right));
    crate::tui_assert_snapshot!(app = &app; "marketplace_expanded_package", screen(&app));
    assert_eq!(
        app.handle_key(key(KeyCode::Char('i'))),
        Some(AppCommand::Marketplace(marketplace::Command::Review {
            package_id: "guide@ash".into(),
            version: Some("2.0.0".into()),
            installation_id: None,
        }))
    );
    app.handle_key(key(KeyCode::Char('/')));
    assert!(
        app.list_selection()
            .unwrap()
            .search()
            .unwrap()
            .input_active()
    );
    app.handle_key(key(KeyCode::Char('r')));
    assert_eq!(app.list_selection().unwrap().query(), "r");
    app.handle_key(key(KeyCode::Esc));
    assert!(matches!(
        app.handle_key(key(KeyCode::Char('r'))),
        Some(AppCommand::Marketplace(marketplace::Command::Browse(_)))
    ));
    focus(&mut app, "v1");
    assert!(app.handle_key(key(KeyCode::Char('u'))).is_none());
    assert_eq!(app.list_selection().unwrap().title(), "确认卸载");
}

#[test]
fn marketplace_installed_versions_have_distinct_actions_and_offline_uninstall() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Installed {
        packages: vec![package("v1", "1.0.0"), package("v2", "2.0.0")],
        selected: Some("v1".into()),
    }));
    crate::tui_assert_snapshot!(app = &app; "marketplace_installed_versions", screen(&app));
    assert_eq!(
        app.handle_key(key(KeyCode::Char('r'))),
        Some(AppCommand::Marketplace(marketplace::Command::Installed))
    );
    focus(&mut app, "v2");
    app.handle_key(key(KeyCode::Right));
    assert!(
        app.list_selection()
            .unwrap()
            .selected_item()
            .unwrap()
            .description()
            .unwrap()
            .contains("Version: 2.0.0")
    );
    crate::tui_assert_snapshot!(app = &app; "marketplace_installed_version_expanded", screen(&app));
    focus(&mut app, "v1");
    // The shared typed mouse target follows the same action path as Enter.
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Item(ListSelectionItemId::new("v1")),
        Rect::new(0, 0, 100, 32),
        crate::widgets::list_selection::ListSelectionClick::Single,
    );
    assert!(app.handle_command_panel_outcome(outcome).is_none());
    focus(&mut app, "remove");
    assert!(app.handle_key(key(KeyCode::Enter)).is_none());
    crate::tui_assert_snapshot!(app = &app; "marketplace_confirm_exact_removal", screen(&app));
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
    let (mut client, _) = client([
        initialized(true),
        json!({"instanceId":"test","generation":1,"packages":[package("v1","1.0.0")]}),
        json!({"error":{"code":-32000,"message":"Catalog offline"}}),
    ]);
    initialize(&mut client);
    let mut app = App::new();
    app.update(marketplace::execute(&mut client, marketplace::Command::browse(None)).unwrap());
    crate::tui_assert_snapshot!(app = &app; "marketplace_catalog_offline", screen(&app));
    assert!(
        app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(|item| item
                .id()
                .is_some_and(|id| id == &ListSelectionItemId::new("v1")))
    );
    focus(&mut app, "v1");
    assert!(app.handle_key(key(KeyCode::Char('u'))).is_none());
    assert_eq!(app.list_selection().unwrap().title(), "Confirm removal");
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
    crate::tui_assert_snapshot!(app = &app; "lsp_available_servers", screen(&app));
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
    crate::tui_assert_snapshot!(app = &app; "lsp_config_conflict_keeps_input", screen(&app));
}

#[test]
fn marketplace_and_lsp_panels_render_in_inline_mode() {
    let mut app = App::new();
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    app.update(marketplace::Event(marketplace::Page::Catalog {
        params: MarketplaceSearchParams {
            capability_kind: Some(Kind::Skill),
            ..Default::default()
        },
        packages: serde_json::from_value(json!([{
            "id":"guide@official","version":"1.0.0","packageType":"plugin",
            "displayName":"Guide","description":"A bundled skill"
        }]))
        .unwrap(),
        installed: vec![],
        error: None,
    }));
    let buffer = frame_buffer(&app);
    assert_eq!(buffer[(2, 28)].symbol(), "P");
    assert_eq!(buffer[(2, 29)].symbol(), "G");
    crate::tui_assert_snapshot!(app = &app; "marketplace_inline_search", screen(&app));
    app.update(lsp::Event(lsp_page()));
    crate::tui_assert_snapshot!(app = &app; "lsp_inline_servers", screen(&app));
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
fn skills_panel_with_empty_catalog_has_no_marketplace_action() {
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
    crate::tui_assert_snapshot!(app = &app; "skills_empty_panel", screen(&app));
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Action,
        Rect::new(0, 0, 100, 32),
        ListSelectionClick::Single,
    );
    assert!(app.handle_command_panel_outcome(outcome).is_none());
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

fn chinese_app() -> App {
    let mut app = App::new();
    let mut terminal = crate::config::TerminalSettings::default();
    terminal.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::SettingsReceived(terminal));
    app
}

#[test]
fn marketplace_tabs_open_management_features_and_support_pointer_navigation() {
    let mut app = chinese_app();
    app.update(marketplace::Event(marketplace::Page::Catalog {
        params: MarketplaceSearchParams::default(),
        packages: vec![],
        installed: vec![],
        error: None,
    }));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "扩展市场"
    );
    assert!(matches!(app.handle_key(key(KeyCode::Tab)),
        Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation)))
        if invocation.command.name == "mcp"));
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Tab(4),
        Rect::new(0, 0, 100, 32),
        crate::widgets::list_selection::ListSelectionClick::Single,
    );
    assert!(matches!(app.handle_command_panel_outcome(outcome),
        Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation)))
        if invocation.command.name == "plugins"));
    app.update(marketplace::Event(marketplace::Page::Plugins(
        serde_json::from_value(json!({"revision":1,"activationGeneration":1,"packages":[]}))
            .unwrap(),
    )));
    assert_eq!(app.list_selection().unwrap().active_tab().label(), "插件");
    crate::tui_assert_snapshot!(app = &app; "marketplace_chinese_tabs", screen(&app));
}

#[test]
fn marketplace_chinese_review_and_installed_actions_preserve_package_identity() {
    let mut app = chinese_app();
    let mut package_details = details();
    package_details.display_name = "Skills".into();
    package_details.description = "Available · {0}".into();
    app.update(marketplace::Event(marketplace::Page::Review {
        details: package_details,
        installation_id: None,
    }));
    assert_eq!(app.list_selection().unwrap().title(), "检查软件包 · Skills");
    assert!(
        app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(|item| item.label() == "Available · {0}")
    );
    crate::tui_assert_snapshot!(app = &app; "marketplace_chinese_review", screen(&app));
    focus(&mut app, "confirm");
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(marketplace::Command::Install {
            package_id: "web@official".into(),
            version: "2.0.0".into()
        }))
    );
    app.update(marketplace::Event(marketplace::Page::Installed {
        packages: vec![package("v1", "1.0.0")],
        selected: Some("v1".into()),
    }));
    assert_eq!(
        app.list_selection().unwrap().active_tab().label(),
        "扩展市场"
    );
    crate::tui_assert_snapshot!(app = &app; "marketplace_chinese_installed", screen(&app));
    app.handle_key(key(KeyCode::Enter));
    focus(&mut app, "remove");
    app.handle_key(key(KeyCode::Enter));
    assert_eq!(app.list_selection().unwrap().title(), "确认卸载");
    crate::tui_assert_snapshot!(app = &app; "marketplace_chinese_removal", screen(&app));
    focus(&mut app, "remove");
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Marketplace(marketplace::Command::Uninstall {
            installation_id: "v1".into()
        }))
    );
}

#[test]
fn lsp_chinese_details_and_input_stay_localized_after_navigation() {
    let mut app = chinese_app();
    app.update(lsp::Event(lsp_page()));
    crate::tui_assert_snapshot!(app = &app; "lsp_chinese_servers", screen(&app));
    focus(&mut app, "web-lsp");
    app.handle_key(key(KeyCode::Enter));
    assert_eq!(
        app.list_selection().unwrap().title(),
        "语言服务器 · web-lsp"
    );
    crate::tui_assert_snapshot!(app = &app; "lsp_chinese_configuration", screen(&app));
    focus(&mut app, "mode");
    assert!(
        matches!(app.handle_key(key(KeyCode::Enter)), Some(AppCommand::Lsp(lsp::Command::Configure { revision: 7, server_id, config, .. })) if server_id == "web-lsp" && config.executable.as_deref() == Some("/tools/web-lsp"))
    );
    focus(&mut app, "path");
    app.handle_key(key(KeyCode::Enter));
    app.handle_paste("/tools/程序 {0}".into());
    crate::tui_assert_snapshot!(app = &app; "lsp_chinese_path", screen(&app));
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.list_selection().unwrap().title(), "语言服务器");
    focus(&mut app, "find");
    app.handle_key(key(KeyCode::Enter));
    app.handle_paste("typescript".into());
    let Some(AppCommand::Marketplace(marketplace::Command::Browse(params))) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("expected search")
    };
    assert_eq!(params.language_id.as_deref(), Some("typescript"));
    assert_eq!(params.capability_kind, Some(Kind::Executable));
}

#[test]
fn skills_and_config_chinese_panels_keep_distinct_responsibilities() {
    let mut app = chinese_app();
    app.update(crate::skills::Event::SettingsOpened(crate::skills::skill_choices(&serde_json::from_value(json!({
        "generation":1,"diagnostics":[],"skills":[{
            "id":{"name":"skills","source":"user:skill-source:personal"},"description":"Available · {0}","sourceKind":"user","contentDigest":ash_protocol::ContentDigest::sha256(b"fixture"),"enablement":"enabled","compatibility":{"type":"compatible"}
        }]
    })).unwrap())));
    let state = app.list_selection().unwrap();
    assert_eq!(state.active_tab().label(), "技能");
    assert_eq!(state.visible_items()[0].label(), "skills");
    assert_eq!(
        state.visible_items()[0].description(),
        Some("Available · {0}")
    );
    assert!(!screen(&app).contains("Available · {0}"));
    crate::tui_assert_snapshot!(app = &app; "skills_chinese_collapsed", screen(&app));
    app.handle_key(key(KeyCode::Right));
    assert!(screen(&app).contains("Available · {0}"));
    crate::tui_assert_snapshot!(app = &app; "skills_chinese_expanded", screen(&app));
    app.handle_key(key(KeyCode::Left));
    assert!(!screen(&app).contains("Available · {0}"));
    let mut terminal = crate::config::TerminalSettings::default();
    terminal.set_language(crate::nls::Language::Chinese);
    app.update(crate::config::Event::EditorOpened(
        crate::config::config_choices(
            &crate::test_support::empty_config_snapshot(),
            &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
            terminal,
            crate::status::StatusLineSettings::default(),
        ),
    ));
    assert_eq!(
        app.list_selection()
            .unwrap()
            .tabs()
            .iter()
            .map(|tab| tab.label())
            .collect::<Vec<_>>(),
        ["通用", "提供商", "议题", "网络"]
    );
    crate::tui_assert_snapshot!(app = &app; "config_chinese_without_lsp_tab", screen(&app));
}

#[test]
fn marketplace_chinese_completion_and_argument_hint_keep_the_shared_command() {
    let mut app = chinese_app();
    app.insert_text("/market");
    let completion = screen(&app);
    assert!(
        completion
            .replace(' ', "")
            .contains("查找和安装扩展市场中的包")
    );
    assert!(completion.contains("/marketplace"));
    app.handle_key(key(KeyCode::Tab));
    let hint = screen(&app);
    assert!(hint.replace(' ', "").contains("<搜索词>"));
    app.insert_text("rust");
    assert!(
        matches!(app.handle_key(key(KeyCode::Enter)), Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation))) if invocation.command == TuiSlashCommandAction::Marketplace.definition() && invocation.display_arguments == "rust")
    );
    crate::tui_assert_snapshot!(
        app = &app;
        "marketplace_chinese_command_completion",
        format!("{}\n\n{hint}", completion.trim_end_matches(' '))
    );
}

#[test]
fn marketplace_failed_load_keeps_the_loaded_view_and_can_be_retried() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Catalog {
        params: MarketplaceSearchParams::default(),
        packages: vec![],
        installed: vec![],
        error: None,
    }));
    let Some(CommandPanel::Marketplace(panel)) = app.panels_mut().command_mut() else {
        panic!("missing marketplace")
    };
    panel.begin_request();
    panel.fail("Installation records unavailable".into());
    assert_eq!(panel.state().active_tab().label(), "Marketplace");
    assert_eq!(
        panel.state().message(),
        Some("Installation records unavailable")
    );
    assert!(matches!(
        app.handle_key(key(KeyCode::Char('r'))),
        Some(AppCommand::Marketplace(marketplace::Command::Browse(_)))
    ));
}

#[test]
fn marketplace_sources_collapse_with_keyboard_and_pointer_and_keep_packages_under_categories() {
    let mut app = App::new();
    app.update(marketplace::Event(marketplace::Page::Catalog {
        params: MarketplaceSearchParams::default(),
        packages: serde_json::from_value(json!([
            {"id":"guide@ash","version":"1","packageType":"skill","displayName":"Guide","description":"Guide skill"},
            {"id":"tools@claude-plugins-official","version":"1","packageType":"plugin","displayName":"Tools","description":"Tool bundle"},
            {"id":"review@openai","version":"1","packageType":"skill","displayName":"Review","description":"Review skill"}
        ])).unwrap(), installed: vec![], error: None,
    }));
    assert_eq!(
        app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        [
            "ash",
            "Skills",
            "Guide",
            "claude-plugins-official",
            "Plugins",
            "Tools",
            "openai",
            "Skills",
            "Review"
        ]
    );
    assert!(app.handle_key(key(KeyCode::Left)).is_none());
    assert!(
        !app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(|item| item.label() == "Guide")
    );
    crate::tui_assert_snapshot!(app = &app; "marketplace_sources_collapsed", screen(&app));
    app.handle_key(key(KeyCode::Right));
    assert!(
        app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(|item| item.label() == "Guide")
    );
    let outcome = app.panels_mut().command_mut().unwrap().handle_click(
        &ListSelectionPointerTarget::Item(ListSelectionItemId::new("source:ash")),
        Rect::new(0, 0, 100, 32),
        crate::widgets::list_selection::ListSelectionClick::Single,
    );
    assert!(app.handle_command_panel_outcome(outcome).is_none());
    assert!(
        !app.list_selection()
            .unwrap()
            .visible_items()
            .iter()
            .any(|item| item.label() == "Guide")
    );
    app.handle_key(key(KeyCode::Enter));
    crate::tui_assert_snapshot!(app = &app; "marketplace_sources_expanded", screen(&app));
    focus(&mut app, "guide@ash");
    assert!(
        matches!(app.handle_key(key(KeyCode::Char('i'))), Some(AppCommand::Marketplace(marketplace::Command::Review { package_id, .. })) if package_id == "guide@ash")
    );
}

fn plugin_result(enabled: bool) -> ash_app_server_protocol::protocol::plugins::PluginListResult {
    serde_json::from_value(json!({"revision":7,"activationGeneration":3,"packages":[{
        "id":"tools@ash","version":"1.2.3","digest":"sha256:fixture","enabled":enabled,"granted":true,"effective":enabled,"revoked":false
    }]})).unwrap()
}

#[test]
fn marketplace_plugins_toggle_exact_package_revision_and_render_disabled_suffix_red() {
    for enabled in [false, true] {
        let mut app = chinese_app();
        app.update(marketplace::Event(marketplace::Page::Plugins(
            plugin_result(enabled),
        )));
        assert_eq!(app.list_selection().unwrap().active_tab().label(), "插件");
        assert_eq!(
            app.list_selection().unwrap().visible_items()[0].label(),
            if enabled {
                "tools@ash"
            } else {
                "tools@ash [disable]"
            }
        );
        if !enabled {
            let buffer = frame_buffer(&app);
            let marker = buffer
                .content
                .windows(9)
                .find(|cells| {
                    cells.iter().map(|cell| cell.symbol()).collect::<String>() == "[disable]"
                })
                .unwrap();
            let context = app.render_context();
            assert!(marker.iter().all(|cell| cell.fg == context.danger()));
            crate::tui_assert_snapshot!(app = &app; "plugins_chinese_disabled", screen(&app));
        }
        let command = match app.handle_key(key(KeyCode::Enter)).unwrap() {
            AppCommand::Marketplace(
                command @ marketplace::Command::SetPluginEnablement { revision: 7, .. },
            ) => command,
            _ => panic!("expected exact plugin enablement command"),
        };
        let (mut client, requests) = client([
            json!({"revision":8,"activationGeneration":4,"disposition":"updated"}),
            serde_json::to_value(plugin_result(!enabled)).unwrap(),
        ]);
        app.update(marketplace::execute(&mut client, command).unwrap());
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests[0]["method"],
            if enabled {
                "plugin/disable"
            } else {
                "plugin/enable"
            }
        );
        assert_eq!(requests[0]["params"]["expectedRevision"], 7);
        assert_eq!(requests[0]["params"]["id"], "tools@ash");
        assert_eq!(requests[0]["params"]["version"], "1.2.3");
        assert_eq!(requests[0]["params"]["digest"], "sha256:fixture");
        assert_eq!(requests[1]["method"], "plugin/list");
        assert_eq!(
            app.list_selection().unwrap().visible_items()[0].label(),
            if enabled {
                "tools@ash [disable]"
            } else {
                "tools@ash"
            }
        );
    }
}

#[test]
fn mcp_management_opens_without_a_redundant_marketplace_action() {
    for mode in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = chinese_app();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_language(crate::nls::Language::Chinese);
        settings.set_screen_mode(mode);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.update(crate::mcp::Event::SettingsOpened(crate::mcp::mcp_choices(
            &Default::default(),
        )));
        let state = app.list_selection().unwrap();
        assert_eq!(
            state.active_tab_index(),
            crate::extensions::Tab::Mcp.index()
        );
        assert!(state.tabs_focused());
        crate::tui_assert_snapshot!(
            app = &app;
            match mode {
                crate::terminal::ScreenMode::Fullscreen => "mcp_chinese_empty_fullscreen",
                crate::terminal::ScreenMode::Inline => "mcp_chinese_empty_inline",
            },
            screen(&app)
        );

        let servers = serde_json::from_value(json!({"docs": {
            "id": "docs", "displayName": "Documentation",
            "transport": {"type": "stdio", "command": "docs-server", "args": []},
            "credential": {"type": "unauthenticated"}, "enablement": "enabled"
        }}))
        .unwrap();
        app.update(crate::mcp::Event::SettingsOpened(crate::mcp::mcp_choices(
            &servers,
        )));
        let state = app.list_selection().unwrap();
        assert!(state.items_focused());
        assert_eq!(state.selected_item().unwrap().label(), "Documentation");
        crate::tui_assert_snapshot!(
            app = &app;
            match mode {
                crate::terminal::ScreenMode::Fullscreen => "mcp_chinese_servers_fullscreen",
                crate::terminal::ScreenMode::Inline => "mcp_chinese_servers_inline",
            },
            screen(&app)
        );
        assert!(matches!(
            app.handle_key(key(KeyCode::Enter)),
            Some(AppCommand::Mcp(crate::mcp::Command::SetEnablement {
                server_id,
                enablement: ash_app_server_protocol::protocol::config::McpServerEnablementDto::Disabled,
                ..
            })) if server_id == "docs"
        ));
        assert!(matches!(
            app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation)))
                if invocation.command.name == "marketplace"
        ));
    }
}

#[test]
fn management_tabs_cycle_through_feature_commands_and_empty_pages_focus_tabs() {
    let mut app = App::new();
    app.update(crate::skills::Event::SettingsOpened(
        crate::skills::skill_choices(
            &serde_json::from_value(json!({"generation":1,"skills":[],"diagnostics":[]})).unwrap(),
        ),
    ));
    for (index, command) in [
        (0, "marketplace"),
        (1, "mcp"),
        (2, "hooks"),
        (3, "plugins"),
        (4, "skills"),
    ] {
        assert_eq!(app.list_selection().unwrap().active_tab_index(), index);
        let next = app.handle_key(key(KeyCode::Tab));
        assert!(
            matches!(next, Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation))) if invocation.command.name == command)
        );
        match command {
            "marketplace" => app.update(marketplace::Event(marketplace::Page::Catalog {
                params: MarketplaceSearchParams::default(),
                packages: vec![],
                installed: vec![],
                error: None,
            })),
            "mcp" => app.update(crate::mcp::Event::SettingsOpened(crate::mcp::mcp_choices(
                &Default::default(),
            ))),
            "hooks" => app.update(crate::hooks::Event::Opened(
                crate::test_support::hook_catalog(vec![]),
            )),
            "plugins" => app.update(marketplace::Event(marketplace::Page::Plugins(
                serde_json::from_value(
                    json!({"revision":1,"activationGeneration":1,"packages":[]}),
                )
                .unwrap(),
            ))),
            "skills" => app.update(crate::skills::Event::SettingsOpened(
                crate::skills::skill_choices(
                    &serde_json::from_value(json!({"generation":1,"skills":[],"diagnostics":[]}))
                        .unwrap(),
                ),
            )),
            _ => unreachable!(),
        }
        if command != "hooks" {
            assert!(app.list_selection().unwrap().tabs_focused());
        }
    }
}

#[test]
fn management_hook_details_return_to_the_same_tab_without_another_request() {
    let mut app = App::new();
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![
        serde_json::from_value(json!({
            "id":"user:hook:review","event":"preToolUse","matcher":{"toolNames":[]},
            "action":{"type":"process","program":"review-hook","args":[]},"enablement":"disabled"
        })).unwrap(),
    ]),
    ));
    assert_eq!(
        app.list_selection().unwrap().visible_items()[0].label(),
        "PreToolUse (1)"
    );
    app.handle_key(key(KeyCode::Enter));
    app.handle_key(key(KeyCode::Enter));
    assert_eq!(app.list_selection().unwrap().title(), "user:hook:review");
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.list_selection().unwrap().title(), "PreToolUse");
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.list_selection().unwrap().title(), "Extensions");
    assert_eq!(app.list_selection().unwrap().active_tab().label(), "Hooks");
}

#[test]
fn hooks_detail_pointer_targets_use_the_rendered_action_area() {
    use crate::app::command_panel::{CommandPanel, CommandPanelOutcome, CommandPanelPointerTarget};
    use crate::widgets::list_selection::{ListSelectionItemId, ListSelectionPointerTarget};
    let mut app = App::new();
    app.update(crate::hooks::Event::Opened(
        crate::test_support::hook_catalog(vec![
            serde_json::from_value(
                json!({"id":"user:hook:review","event":"preToolUse","matcher":{"toolNames":[]},
        "action":{"type":"process","program":"review-hook","args":[]},"enablement":"disabled"}),
            )
            .unwrap(),
        ]),
    ));
    app.handle_key(key(KeyCode::Enter));
    app.handle_key(key(KeyCode::Enter));
    let panel = app.panels_mut().command_mut().unwrap();
    assert!(matches!(panel, CommandPanel::Hooks(_)));
    let body = ratatui::layout::Rect::new(5, 7, 60, 12);
    let actions = crate::widgets::detail_list::split_with_actions(
        body,
        panel.list_selection().unwrap().body_rows(body.width),
    )[1];
    let target = CommandPanelPointerTarget::List(ListSelectionPointerTarget::Item(
        ListSelectionItemId::new("edit-source"),
    ));
    for x in actions.x + 2..actions.right() {
        assert_eq!(
            panel.pointer_target_at(
                Default::default(),
                body,
                ratatui::layout::Position::new(x, actions.y),
                crate::render::test_context()
            ),
            Some(target.clone())
        );
    }
    assert_eq!(
        panel.pointer_target_at(
            Default::default(),
            body,
            ratatui::layout::Position::new(body.x + 2, body.y),
            crate::render::test_context()
        ),
        None
    );
    assert!(
        matches!(panel.activate_pointer_target(target, body, crate::widgets::list_selection::ListSelectionClick::Single), CommandPanelOutcome::Hooks(crate::hooks::Outcome::Edit(path)) if path == std::path::PathBuf::from("/profile/config.toml"))
    );
}
