use super::App;
use super::AppCommand;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use serde_json::Value;
use serde_json::json;

struct Transport {
    requests: Vec<Value>,
}

impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: Value = serde_json::from_str(request).unwrap();
        let mut entry = json!({"id":"ash-source","kind":"fact","title":"ASH.md","content":"Use pnpm test","accepted":false,"current":true,"source":{"id":"ash-source","kind":"projectFile","label":"ASH.md","revision":"fixture-revision"}});
        let result = match request["method"].as_str().unwrap() {
            "approval/environment/read" => {
                json!({"root":"/project","profile":{"revision":0,"entries":[],"observations":[]}})
            }
            "approval/environment/scan" => {
                assert_eq!(
                    request["params"]["scope"],
                    json!({"type":"directory","root":"/project"})
                );
                assert_eq!(
                    request["params"]["options"],
                    json!({"recentCommands":false,"shellHistory":false,"otherRepositories":false,"summarizeWithModel":false})
                );
                json!({"root":"/project","draft":{"id":request["params"]["operationId"],"baseRevision":0,"entries":[entry]}})
            }
            "approval/environment/save" => {
                assert_eq!(
                    request["params"]["entries"],
                    json!([{"id":"ash-source","kind":"fact","title":"ASH.md","content":"Use pnpm test","sourceId":"ash-source"}])
                );
                assert_eq!(request["params"]["expectedRevision"], 0);
                assert!(request["params"]["draftId"].is_string());
                entry["accepted"] = json!(true);
                json!({"root":"/project","profile":{"revision":1,"entries":[entry],"observations":[]}})
            }
            method => panic!("unexpected method {method}"),
        };
        let response = json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
        self.requests.push(request);
        Ok(response)
    }
}

fn key(app: &mut App, code: KeyCode) -> Option<AppCommand> {
    app.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn render(app: &App) -> String {
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn guardian_setup_scans_reviews_and_saves_in_both_screens_in_chinese() {
    for screen in [
        crate::terminal::ScreenMode::Fullscreen,
        crate::terminal::ScreenMode::Inline,
    ] {
        let mut app = App::new();
        let mut settings = crate::config::TerminalSettings::default();
        settings.set_screen_mode(screen);
        settings.set_language(crate::nls::Language::Chinese);
        app.update(crate::config::Event::SettingsReceived(settings));
        app.insert_text("/guardian setup");
        let Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation))) =
            key(&mut app, KeyCode::Enter)
        else {
            panic!("expected Guardian product command");
        };
        let mut client = AppServerClient::new(Transport {
            requests: Vec::new(),
        });
        let result = super::dispatch::execute_product_command(
            None,
            &mut client,
            std::path::Path::new("/project"),
            invocation,
        )
        .unwrap();
        for event in result.events {
            app.update(event);
        }
        let Some(AppCommand::Guardian(command)) = key(&mut app, KeyCode::Enter) else {
            panic!("expected scan");
        };
        app.update(crate::guardian::execute(&mut client, command).unwrap());
        assert!(app.command_panel().is_some());
        key(&mut app, KeyCode::Down);
        key(&mut app, KeyCode::Down);
        assert_eq!(key(&mut app, KeyCode::Enter), None);
        match screen {
            crate::terminal::ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!("guardian_setup_fullscreen_chinese", render(&app))
            }
            crate::terminal::ScreenMode::Inline => {
                crate::tui_assert_snapshot!("guardian_setup_inline_chinese", render(&app))
            }
        }
        key(&mut app, KeyCode::Up);
        let Some(AppCommand::Guardian(command)) = key(&mut app, KeyCode::Enter) else {
            panic!("expected save");
        };
        app.update(crate::guardian::execute(&mut client, command).unwrap());
        key(&mut app, KeyCode::Esc);
        assert!(app.command_panel().is_none());
        assert!(app.chat_input_focused());
        assert_eq!(client.into_transport().requests.len(), 3);
    }
}
