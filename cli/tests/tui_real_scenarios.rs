#[path = "support/scenario_http.rs"]
mod scenario_http;
#[path = "support/tui_process.rs"]
mod tui_process;

#[cfg(unix)]
#[path = "support/issue_server.rs"]
mod issue_server;

#[path = "tui/config.rs"]
mod config;
#[path = "tui/conversation.rs"]
mod conversation;
#[cfg(unix)]
#[path = "tui/issues.rs"]
mod issues;
#[path = "tui/terminal.rs"]
mod terminal;
