use super::App;
use super::AppCommand;
use super::usage_tests::render;
use crate::config;
use crate::config::Command as ConfigCommand;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::config::network::Operation;
use crate::nls::Language;
use crate::status::StatusLineSettings;
use crate::terminal::ScreenMode;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde_json::Value;
use serde_json::json;

#[test]
fn network_config_diagnostics_routes_the_rpc_renders_both_modes_and_copies_domains() {
    let mut app = open_config(Language::English, ScreenMode::Fullscreen);
    crate::tui_assert_snapshot!("network_config_entry", render(&app, 100, 24));
    let command = app.handle_key(key(KeyCode::Enter)).unwrap();
    assert_ne!(
        super::requests::request_key(&command),
        super::requests::request_key(&AppCommand::Config(ConfigCommand::OpenEditor))
    );
    assert!(
        matches!(&command, AppCommand::Config(ConfigCommand::Network(request)) if request.operation == Operation::Diagnose)
    );
    let AppCommand::Config(command) = command else {
        unreachable!()
    };
    crate::tui_assert_snapshot!("network_diagnostics_loading", render(&app, 100, 24));
    let mut client = AppServerClient::new(Transport {
        response: json!({"result": report()}),
    });
    app.update(config::execute(&mut client, command).unwrap());
    let screen = render(&app, 100, 30);
    assert!(screen.contains("HTTP reachable · status 401"), "{screen}");
    assert!(
        screen.contains("Proxy: proxy.example.test:8080"),
        "{screen}"
    );
    assert!(screen.contains("DNS lookup failed"), "{screen}");
    assert!(screen.contains("Account usage query failed"), "{screen}");
    crate::tui_assert_snapshot!("network_diagnostics_fullscreen", screen);
    let mut terminal = TerminalSettings::default();
    terminal.set_screen_mode(ScreenMode::Inline);
    app.update(ConfigEvent::SettingsReceived(terminal));
    crate::tui_assert_snapshot!("network_diagnostics_inline", render(&app, 100, 24));
    terminal.set_screen_mode(ScreenMode::Fullscreen);
    app.update(ConfigEvent::SettingsReceived(terminal));
    app.handle_key(key(KeyCode::Down));
    assert_eq!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Host(crate::host::Command::CopyText(
            "api.example.test\nusage.example.test".into()
        )))
    );
    assert!(matches!(
        app.command_panel(),
        Some(super::CommandPanel::Config(_))
    ));
    let refresh = app.handle_key(key(KeyCode::Char('r'))).unwrap();
    let AppCommand::Config(ConfigCommand::Network(request)) = &refresh else {
        panic!("refresh must issue diagnostics")
    };
    assert_eq!(request.operation, Operation::Diagnose);
    assert!(app.handle_key(key(KeyCode::Char('r'))).is_none());
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(app.list_selection().unwrap().tabs().len(), 4);
    crate::tui_assert_snapshot!("network_diagnostics_back_to_config", render(&app, 100, 24));
    let AppCommand::Config(command) = refresh else {
        unreachable!()
    };
    app.update(config::execute(&mut client, command).unwrap());
    assert_eq!(
        app.list_selection().unwrap().tabs().len(),
        4,
        "late diagnostics must not reopen the child page"
    );
    app.handle_key(key(KeyCode::Esc));
    assert!(app.command_panel().is_none());
}

#[test]
fn network_config_required_domains_stay_read_only_and_localize_chinese_inline() {
    let mut app = open_config(Language::Chinese, ScreenMode::Inline);
    app.handle_key(key(KeyCode::Down));
    let Some(AppCommand::Config(command @ ConfigCommand::Network(_))) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("required domains must emit a network command")
    };
    assert!(
        matches!(&command, ConfigCommand::Network(request) if request.operation == Operation::Domains)
    );
    let mut client = AppServerClient::new(Transport {
        response: json!({"result":report()["network"]}),
    });
    app.update(config::execute(&mut client, command).unwrap());
    let screen = render(&app, 100, 24);
    assert!(screen.contains("复制所需域名"), "{screen}");
    assert!(screen.contains("usage.example.test"), "{screen}");
    assert!(!screen.contains("HTTP reachable"), "{screen}");
    crate::tui_assert_snapshot!("network_required_domains_chinese_inline", screen);
    app.handle_key(key(KeyCode::Esc));
    app.handle_key(key(KeyCode::Up));
    let Some(AppCommand::Config(command)) = app.handle_key(key(KeyCode::Enter)) else {
        panic!("diagnostics action must remain selected")
    };
    let mut client = AppServerClient::new(Transport {
        response: json!({"error":{"code":-32603,"message":"InternalError","data":{"message":"private details"}}}),
    });
    app.update(config::execute(&mut client, command).unwrap());
    let screen = render(&app, 100, 24);
    assert!(!screen.contains("private details"), "{screen}");
    crate::tui_assert_snapshot!("network_diagnostics_retry_chinese_inline", screen);
    assert!(matches!(
        app.handle_key(key(KeyCode::Enter)),
        Some(AppCommand::Config(ConfigCommand::Network(_)))
    ));
}

fn open_config(language: Language, mode: ScreenMode) -> App {
    let mut app = App::new();
    let mut terminal = TerminalSettings::default();
    terminal.set_language(language);
    terminal.set_screen_mode(mode);
    app.update(ConfigEvent::SettingsReceived(terminal));
    app.update(ConfigEvent::EditorOpened(config::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ProviderListResult {
            providers: Vec::new(),
        },
        terminal,
        StatusLineSettings::default(),
    )));
    for _ in 0..3 {
        app.handle_key(key(KeyCode::Tab));
    }
    app
}

pub(super) fn report() -> Value {
    json!({
        "network":{"revision":1,"httpMode":"http2","targets":[
            {"id":"model","connection":"Example","displayName":"Example","host":"api.example.test","port":443,"purpose":"model","route":{"type":"proxy","host":"proxy.example.test","port":8080}},
            {"id":"usage","connection":"Example","displayName":"Example","host":"usage.example.test","port":443,"purpose":"usage","route":{"type":"direct"}}
        ]},
        "checks":[
            {"connection":"Example","targetId":"model","outcome":{"type":"reachable","httpStatus":401}},
            {"connection":"Example","targetId":"usage","outcome":{"type":"failed","failure":"dns"}},
            {"connection":"Example","targetId":null,"outcome":{"type":"failed","failure":"accountOperation"}}
        ]
    })
}

struct Transport {
    response: Value,
}
impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        assert!(matches!(
            request["method"].as_str(),
            Some("network/read" | "network/diagnostics/run")
        ));
        assert_eq!(request["params"], json!({}));
        if request["method"] == "network/read" {
            assert!(self.response["result"]["checks"].is_null());
        }
        let mut response = self.response.clone();
        response["id"] = request["id"].clone();
        response["jsonrpc"] = json!("2.0");
        Ok(response.to_string())
    }
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
#[cfg(feature = "in-process-tests")]
fn network_config_runs_through_the_local_product_composition_and_real_http() {
    use ash_app_server_client::InProcessClientOptions;
    use ash_app_server_client::start_in_process_client;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::config::ProviderConfigureParams;
    use std::io::Read;
    use std::io::Write;
    let _guard = crate::test_support::in_process_test_guard();
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 2048];
        let size = socket.read(&mut bytes).unwrap();
        assert!(
            std::str::from_utf8(&bytes[..size])
                .unwrap()
                .starts_with("GET / HTTP/1.1")
        );
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            profile.path(),
            ClientInfo {
                name: "network-test".into(),
                version: "1".into(),
            },
        )
        .with_codex_home(home.path())
        .without_built_in_skills(),
    )
    .unwrap();
    let configured = client
        .configure_provider(
            serde_json::from_value::<ProviderConfigureParams>(json!({
                "commandId":"configure-local","expectedRevision":0,"config":{
                    "provider":"custom-local","connection":"custom-local","baseUrl":endpoint,
                    "custom":{"name":"Local service","protocol":"responses"}
                }
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(configured.revision, 1);
    let targets = client.read_network().unwrap();
    assert_eq!(
        targets.targets.len(),
        1,
        "isolated product composition must list only the configured local connection"
    );
    assert_eq!(targets.targets[0].display_name, "Local service");
    assert_eq!(
        targets.targets[0].route,
        ash_app_server_protocol::protocol::diagnostics::NetworkRouteDto::Direct
    );
    let mut app = open_config(Language::English, ScreenMode::Fullscreen);
    let Some(AppCommand::Config(command)) = app.handle_key(key(KeyCode::Enter)) else {
        panic!("network action must emit a request")
    };
    app.update(config::execute(&mut client, command).unwrap());
    let screen = render(&app, 100, 30);
    assert!(screen.contains("Local service"), "{screen}");
    assert!(screen.contains("HTTP reachable · status 404"), "{screen}");
    worker.join().unwrap();
    app.handle_key(key(KeyCode::Esc));
    app.handle_key(key(KeyCode::Esc));
    assert!(app.command_panel().is_none());
}

#[test]
fn network_diagnostics_reply_uses_the_current_language_after_a_pending_locale_change() {
    let mut app = open_config(Language::English, ScreenMode::Fullscreen);
    let Some(AppCommand::Config(command)) = app.handle_key(key(KeyCode::Enter)) else {
        panic!("network action must emit a request")
    };
    let mut terminal = TerminalSettings::default();
    terminal.set_language(Language::Chinese);
    terminal.set_screen_mode(ScreenMode::Inline);
    app.update(ConfigEvent::Updated(config::ConfigEditResult {
        terminal,
        status_line: StatusLineSettings::default(),
        choices: config::config_choices(
            &crate::test_support::empty_config_snapshot(),
            &ProviderListResult {
                providers: Vec::new(),
            },
            terminal,
            StatusLineSettings::default(),
        ),
    }));
    let mut client = AppServerClient::new(Transport {
        response: json!({"result": report()}),
    });
    app.update(config::execute(&mut client, command).unwrap());
    let screen = render(&app, 100, 24);
    assert!(screen.contains("HTTP 可达"), "{screen}");
    assert!(screen.contains("账号用量查询失败"), "{screen}");
    crate::tui_assert_snapshot!(
        "network_diagnostics_current_language_chinese_inline",
        screen
    );
}
