use super::App;
use super::AppCommand;
use super::CommandPanel;
use super::dispatch::execute_product_command;
use crate::config::Event as ConfigEvent;
use crate::config::TerminalSettings;
use crate::terminal::ScreenMode;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use crate::thread::composer::SlashCommandInvocation;
use crate::widgets::list_selection::pointer_target_at;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use serde_json::Value;
use serde_json::json;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use unicode_width::UnicodeWidthStr;

#[test]
fn usage_displays_xai_credits_without_rounding_or_inventing_missing_balances() {
    let accounts = json!({"revision":1,"accounts":[{"provider":"xai-subscription","accountId":"xai-1","status":"ready","credentialRevision":1}]});
    let data = json!({"provider":"xai-subscription","accountId":"xai-1","plan":"SuperGrokPro","limits":[],"credits":null,
        "xai":{"usedPercent":12.125,"allowed":true,"periodType":"USAGE_PERIOD_TYPE_WEEKLY","periodEnd":"2026-09-28T00:00:00Z","prepaidCents":"9007199254740993","onDemandUsedCents":"0"}});
    let (mut client, requests) = client(vec![accounts, data]);
    let mut app = App::new();
    app.update(crate::usage::load(&mut client).unwrap());
    assert_eq!(
        requests.lock().unwrap()[1],
        json!({"method":"account/rateLimits/read","params":{"provider":"xai-subscription","accountId":"xai-1"}})
    );
    let screen = render(&app, 90, 30);
    assert!(screen.contains("12.125%"));
    assert!(screen.contains("USD 90071992547409.93"));
    assert!(screen.contains("Not reported"));
    assert!(!screen.contains("Auto top-up"));
    assert!(!screen.contains("Manage billing"));
    crate::tui_assert_snapshot!("usage_xai", screen);
    app.handle_key(key(KeyCode::Esc));
    assert!(app.command_panel().is_none());
}

#[test]
fn usage_command_reads_the_selected_account_and_renders_both_screen_modes() {
    let mut app = App::new();
    let invocation = submit(&mut app);
    assert!(invocation.arguments.is_empty());
    let (mut client, requests) = client(vec![account("ready"), quota()]);
    let output = execute_product_command(None, &mut client, Path::new("."), invocation).unwrap();
    assert!(output.conversation.is_none());
    assert!(output.conversation_change.is_none());
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        &[
            json!({"method":"account/read", "params":{}}),
            json!({"method":"account/rateLimits/read", "params":{"provider":"chatgpt-subscription", "accountId":"account-1"}}),
        ]
    );
    for event in output.events {
        app.update(event);
    }
    let selection = app.command_panel().unwrap().list_selection().unwrap();
    assert!(
        selection
            .visible_items()
            .iter()
            .all(|item| item.id().is_none())
    );
    assert_eq!(
        selection.visible_items()[2].description(),
        Some("65% left (35% used)")
    );
    let body = Rect::new(0, 0, 80, 24);
    for y in 0..24 {
        for x in 0..80 {
            assert_eq!(
                pointer_target_at(selection, Rect::default(), body, Position::new(x, y)),
                None
            );
        }
    }
    crate::tui_assert_snapshot!("usage_fullscreen", render(&app, 80, 28));
    crate::tui_assert_snapshot!("usage_narrow", render(&app, 48, 28));
    set_mode(&mut app, ScreenMode::Inline);
    crate::tui_assert_snapshot!("usage_inline", render(&app, 80, 24));
    assert!(app.handle_key(key(KeyCode::Enter)).is_none());
    assert!(matches!(app.command_panel(), Some(CommandPanel::Usage(_))));
    app.handle_key(key(KeyCode::Esc));
    assert!(app.command_panel().is_none());
    crate::tui_assert_snapshot!("usage_dismissed", render(&app, 80, 16));
}

#[test]
fn usage_keeps_chatgpt_and_xai_in_separate_keyboard_selectable_groups() {
    let mut accounts = account("ready");
    accounts["accounts"].as_array_mut().unwrap().push(json!({"provider":"xai-subscription","accountId":"xai-1","status":"ready","credentialRevision":1}));
    let (mut client, requests) = client(vec![
        accounts,
        quota(),
        json!({"provider":"xai-subscription","accountId":"xai-1","plan":null,"limits":[],"credits":null,"xai":{"allowed":false,"usedPercent":105.125}}),
    ]);
    let mut app = App::new();
    app.update(crate::usage::load(&mut client).unwrap());
    assert_eq!(requests.lock().unwrap().len(), 3);
    assert_eq!(
        requests.lock().unwrap()[2]["params"]["provider"],
        "xai-subscription"
    );
    assert!(render(&app, 80, 28).contains("ChatGPT plan"));
    app.handle_key(key(KeyCode::Tab));
    let selection = app.list_selection().unwrap();
    assert!(selection.items_focused());
    assert_eq!(selection.selected_item().unwrap().label(), "xAI plan");
    let screen = render(&app, 80, 28);
    assert!(screen.contains("xAI plan"));
    assert!(screen.contains("105.125%"));
    assert!(screen.contains("Unavailable"));
    crate::tui_assert_snapshot!("usage_subscriptions", screen);
}

#[test]
fn usage_missing_fields_stay_unknown_and_additional_limits_can_be_scrolled() {
    let mut data = quota();
    data["credits"] = Value::Null;
    data["limits"][0]["primary"] = Value::Null;
    data["limits"][0]["secondary"] = Value::Null;
    data["limits"].as_array_mut().unwrap().push(json!({
        "id":"review", "name":"Code review", "model":null, "allowed":false,
        "limitReached":true, "primary":{"usedPercent":100,"windowSeconds":604800,"resetsAt":2000000000},"secondary":null
    }));
    let (mut client, _) = client(vec![account("ready"), data]);
    let mut app = App::new();
    app.update(crate::usage::load(&mut client).unwrap());
    let items = app
        .command_panel()
        .unwrap()
        .list_selection()
        .unwrap()
        .visible_items();
    assert_eq!(items[2].description(), Some("Not reported"));
    assert_eq!(items.last().unwrap().description(), Some("Not reported"));
    crate::tui_assert_snapshot!("usage_missing_and_exhausted", render(&app, 80, 28));
    for _ in 0..12 {
        app.handle_key(key(KeyCode::Down));
    }
    assert_eq!(
        app.command_panel()
            .unwrap()
            .list_selection()
            .unwrap()
            .selected_visible_index(),
        Some(7)
    );
    let screen = render(&app, 48, 12);
    assert!(screen.contains("Credits"));
    assert!(!screen.contains("ChatGPT plan"));
    crate::tui_assert_snapshot!("usage_scrolled", screen);
}

#[test]
fn usage_requires_a_ready_chatgpt_account_before_querying_quota() {
    for (name, accounts, expected) in [
        (
            "usage_signed_out",
            json!({"revision":1,"accounts":[]}),
            "Sign in to ChatGPT",
        ),
        (
            "usage_reauthentication",
            account("reauthenticationRequired"),
            "Reconnect ChatGPT",
        ),
    ] {
        let (mut client, requests) = client(vec![accounts]);
        let mut app = App::new();
        app.update(crate::usage::load(&mut client).unwrap());
        assert_eq!(requests.lock().unwrap().len(), 1);
        let screen = render(&app, 80, 20);
        assert!(screen.contains(expected));
        crate::tui_assert_snapshot!(name, screen);
    }
}

#[test]
fn usage_loading_failure_and_late_results_preserve_the_current_panel() {
    let mut app = App::new();
    let invocation = submit(&mut app);
    app.open_command_panel(CommandPanel::loading("Usage", "Loading…"));
    let generation = app.panels().generation();
    crate::tui_assert_snapshot!("usage_loading", render(&app, 80, 20));
    let transport = ScriptedTransport {
        replies: VecDeque::from([
            json!({"result":account("ready")}),
            json!({"error":{
                "code":-32030, "message":"AccountOperationFailed", "data":{"message":"ChatGPT usage query failed"}
            }}),
        ]),
        requests: Arc::default(),
    };
    let mut client = AppServerClient::new(transport);
    let error = execute_product_command(None, &mut client, Path::new("."), invocation)
        .err()
        .unwrap();
    app.update_for_panel(
        generation,
        ThreadEvent::CommandFailed {
            command: "/usage".into(),
            error,
        },
    );
    crate::tui_assert_snapshot!("usage_failed", render(&app, 80, 20));
    app.handle_key(key(KeyCode::Esc));
    app.open_command_panel(CommandPanel::loading("Settings", "Loading…"));
    let (mut client, _) = self::client(vec![account("ready"), quota()]);
    app.update_for_panel(generation, crate::usage::load(&mut client).unwrap());
    assert_eq!(
        app.command_panel().unwrap().body().title(app.language()),
        "Settings"
    );
}

#[test]
#[ignore = "Queries real ChatGPT usage through the local App Server using the installed Codex login"]
fn live_usage_command_through_local_app_server() {
    let _guard = crate::test_support::in_process_test_guard();
    let codex_names = if cfg!(windows) {
        vec!["codex.exe", "codex.cmd", "codex.bat"]
    } else {
        vec!["codex"]
    };
    assert!(
        std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(
            |directory| codex_names
                .iter()
                .any(|name| directory.join(name).is_file())
        )),
        "installed Codex is required so production keeps auth read-only"
    );
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".codex"));
    let before = zeroize::Zeroizing::new(
        std::fs::read(codex_home.join("auth.json"))
            .expect("existing file-based Codex auth is required"),
    );
    let profile = tempfile::tempdir().unwrap();
    let mut client = ash_app_server_client::start_in_process_client(
        ash_app_server_client::InProcessClientOptions::new(
            profile.path(),
            ash_app_server_protocol::protocol::common::ClientInfo {
                name: "ash-usage-test".into(),
                version: "1".into(),
            },
        )
        .without_built_in_skills(),
    )
    .unwrap();
    let mut app = App::new();
    let invocation = submit(&mut app);
    let result = execute_product_command(None, &mut client, profile.path(), invocation);
    let after = zeroize::Zeroizing::new(std::fs::read(codex_home.join("auth.json")).unwrap());
    assert!(*before == *after, "source auth.json changed during /usage");
    let output = result.expect("live /usage must succeed through the production App Server");
    assert!(output.conversation.is_none());
    for event in output.events {
        app.update(event);
    }
    let selection = app.command_panel().unwrap().list_selection().unwrap();
    assert!(
        selection
            .visible_items()
            .iter()
            .any(|item| item.label() == "ChatGPT plan")
    );
    assert!(selection.visible_items().iter().any(|item| {
        item.description()
            .is_some_and(|text| text.contains("% left"))
    }));
    for item in selection.visible_items() {
        println!(
            "{}: {}",
            item.label(),
            item.description().unwrap_or_default()
        );
    }
    assert!(render(&app, 100, 40).contains("% left"));
}

fn submit(app: &mut App) -> SlashCommandInvocation {
    app.insert_text("/usage");
    let command = app
        .handle_key(key(KeyCode::Enter))
        .expect("/usage must emit a command");
    assert_eq!(command.panel_title(), Some("Usage"));
    let AppCommand::Thread(ThreadCommand::ExecuteProductCommand(invocation)) = command else {
        panic!("/usage must use the product dispatcher");
    };
    assert_eq!(invocation.command.name, "usage");
    invocation
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn set_mode(app: &mut App, mode: ScreenMode) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    app.update(ConfigEvent::SettingsReceived(settings));
}

fn account(status: &str) -> Value {
    json!({"revision":1,"accounts":[{"provider":"chatgpt-subscription","accountId":"account-1",
        "email":null,"displayName":null,"organization":null,"plan":"pro","status":status,"credentialRevision":1}]})
}

fn quota() -> Value {
    json!({"provider":"chatgpt-subscription","accountId":"account-1","plan":"pro","limits":[{
        "id":"codex","name":null,"model":null,"allowed":true,"limitReached":false,
        "primary":{"usedPercent":35,"windowSeconds":18000,"resetsAt":2000000000},
        "secondary":{"usedPercent":80,"windowSeconds":604800,"resetsAt":2000500000}}],
        "credits":{"hasCredits":true,"unlimited":false,"balance":"10.25"}})
}

type Requests = Arc<Mutex<Vec<Value>>>;

fn client(results: Vec<Value>) -> (AppServerClient<ScriptedTransport>, Requests) {
    let requests = Arc::default();
    let transport = ScriptedTransport {
        replies: results
            .into_iter()
            .map(|result| json!({"result":result}))
            .collect(),
        requests: Arc::clone(&requests),
    };
    (AppServerClient::new(transport), requests)
}

struct ScriptedTransport {
    replies: VecDeque<Value>,
    requests: Requests,
}

impl JsonRpcTransport for ScriptedTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        self.requests
            .lock()
            .unwrap()
            .push(json!({"method":request["method"],"params":request["params"]}));
        let mut reply = self
            .replies
            .pop_front()
            .expect("unexpected backend request");
        reply["id"] = request["id"].clone();
        reply["jsonrpc"] = json!("2.0");
        Ok(reply.to_string())
    }
}

pub(super) fn render(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|row| {
            let mut text = String::new();
            let mut column = 0;
            while column < width {
                let symbol = buffer[(column, row)].symbol();
                text.push_str(symbol);
                column = column.saturating_add(
                    u16::try_from(UnicodeWidthStr::width(symbol).max(1)).unwrap_or(1),
                );
            }
            text.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
