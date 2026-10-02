use crate::scenario_http::HttpResponse;
use crate::scenario_http::ScenarioServer;
use crate::tui_process::Fixture;
use crate::tui_process::LARGE_SIZE;
use crate::tui_process::SMALL_SIZE;
use crate::tui_process::TuiProcess;
use std::fs;

fn select_config_item(process: &mut TuiProcess, label: &str) {
    process.type_text("/");
    process.type_text(label);
    process.down();
    process.wait_for_stable_screen(&format!("> {label}"));
}

fn open_provider(process: &mut TuiProcess, label: &str) {
    process.wait_for_screen("Enter send");
    process.submit("/config");
    process.wait_for_screen("Screen mode");
    process.tab();
    select_config_item(process, label);
    process.enter();
}

#[test]
fn actual_tui_ctrl_g_starts_configured_dictation_through_the_pty() {
    let fixture = Fixture::new().with_missing_voice_host();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    fixture.append_config(
        "\n[tui]\ndictationShortcutEnabled = true\ndictationShortcut = \"ctrl+g\"\n",
    );
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.send(b"\x07");
    process.wait_for_screen("Dictation failed:");
    process.quit();
}

#[test]
fn actual_tui_screen_mode_replaces_obsolete_pointer_settings_on_save() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    fixture.append_config("\n[tui]\nmouseInteractions = false\ncopyOnSelect = false\n");
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_stable_screen("Screen mode");
    assert!(!process.screen().contains("Enhanced TUI"));
    assert!(!process.screen().contains("Copy on select"));
    select_config_item(&mut process, "Screen mode");
    process.enter();
    wait_for_config(&fixture, "screenMode = \"inline\"");
    process.wait_for_stable_screen("inline");
    assert!(!fixture.config_source().contains("mouseInteractions"));
    assert!(!fixture.config_source().contains("copyOnSelect"));
    process.escape();
    process.quit();

    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_stable_screen("Screen mode");
    assert!(process.screen().contains("inline"));
    assert!(!process.screen().contains("Enhanced TUI"));
    assert!(!process.screen().contains("Copy on select"));
    process.escape();
    process.quit();
}

#[test]
fn actual_tui_automatic_update_policy_cycles_and_persists_across_restart() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Automatic updates");
    select_config_item(&mut process, "Automatic updates");
    process.enter();
    wait_for_config(&fixture, "autoUpdate = \"stable\"");
    process.wait_for_stable_screen("Stable");
    assert!(
        process
            .screen()
            .lines()
            .find(|line| line.contains("> Automatic updates"))
            .unwrap()
            .contains("Stable")
    );
    process.enter();
    wait_for_config(&fixture, "autoUpdate = \"never\"");
    process.escape();
    process.quit();

    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Automatic updates");
    assert!(
        process
            .screen()
            .lines()
            .find(|line| line.contains("Automatic updates"))
            .unwrap()
            .contains("Never")
    );
    process.escape();
    process.quit();
    assert!(server.request_bodies().is_empty());
}

#[test]
fn actual_tui_issue_refresh_setting_persists_across_restart() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Screen mode");
    process.back_tab();
    select_config_item(&mut process, "Auto refresh");
    process.enter();
    wait_for_config(&fixture, "autoRefreshMinutes = 30");
    process.wait_for_screen("30m");
    process.escape();
    process.quit();

    let mut reopened = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    reopened.wait_for_screen("Ash Code v");
    reopened.submit("/config");
    reopened.wait_for_screen("Screen mode");
    reopened.back_tab();
    reopened.wait_for_screen("Auto refresh");
    assert!(reopened.screen().contains("30m"));
    reopened.resize(SMALL_SIZE);
    reopened.wait_for_screen("Auto refresh");
    reopened.escape();
    reopened.quit();
    assert!(server.request_bodies().is_empty());
}

#[test]
fn actual_tui_provider_autosaves_and_tests_without_fetching_models() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([
        HttpResponse::responses_streaming("OK"),
        HttpResponse::failure(401, "synthetic-denial"),
    ]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    open_provider(&mut process, "New custom provider");
    process.wait_for_screen("> Provider name");
    for (index, value) in [
        "PTY service",
        &format!("{}/", server.base_url()),
        "pty-synthetic-key",
    ]
    .into_iter()
    .enumerate()
    {
        process.enter();
        process.type_text(value);
        process.enter();
        if index > 0 {
            process.wait_for_screen("Saved");
        }
        process.down();
    }
    wait_for_config(&fixture, "PTY service");
    assert!(fixture.config_source().contains("PTY service"));
    process.wait_for_screen("> Model ID");
    process.enter();
    process.type_text("pty-model-alias");
    process.enter();
    process.wait_for_screen("Saved");
    process.down(); // API type.
    process.down(); // Model context window.
    process.wait_for_screen("Model context window");
    process.right();
    process.wait_for_screen("1m");
    process.wait_for_screen("Saved");
    assert!(fixture.config_source().contains("1000000"));
    process.down();
    process.enter();
    process.wait_for_screen("Passed");
    process.enter();
    process.wait_for_screen("Authentication failed");
    assert!(fixture.config_source().contains("pty-model-alias"));
    assert!(!fixture.config_source().contains("pty-synthetic-key"));
    process.escape();
    process.wait_for_screen("> PTY service");
    process.escape();
    process.submit("/model");
    process.wait_for_screen("Search models");
    select_config_item(&mut process, "GPT-6 Astra");
    process.type_text("p");
    wait_for_config(&fixture, "pinnedModels");
    assert!(fixture.config_source().contains("gpt-6-astra"));
    process.escape();
    process.submit("/model");
    process.wait_for_stable_screen("Pinned");
    process.wait_for_screen("> GPT-6 Astra");
    process.escape();
    open_provider(&mut process, "PTY service");
    process.wait_for_screen("> Provider name");
    process.enter();
    process.type_text("-cancelled");
    process.wait_for_screen("-cancelled");
    process.escape();
    process.wait_for_screen_to_omit("-cancelled");
    assert!(!process.screen().contains("-cancelled"));
    process.down();
    process.down();
    process.wait_for_screen("Key saved");
    process.resize(SMALL_SIZE);
    for _ in 0..4 {
        process.down();
    }
    process.wait_for_screen("Test");
    process.escape();
    process.send(b"\x1b[3~");
    process.wait_for_screen("No matching configuration");
    assert!(!fixture.config_source().contains("PTY service"));
    assert!(!fixture.config_source().contains("pty-model-alias"));
    process.escape();
    process.quit();
    let requests = server.request_bodies();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert!(request.starts_with("POST /v1/responses "));
        assert!(request.contains("pty-model-alias"));
        assert!(request.contains("Bearer pty-synthetic-key"));
    }
}

#[test]
fn actual_tui_opens_chatgpt_subscription_and_returns_to_providers() {
    // Signed-in navigation is covered by App state tests, and Codex credential ownership
    // by ash-chatgpt's disconnect/reconnect test. Opening a ready account here would
    // discover its production model catalog instead of using a scripted boundary.
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    open_provider(&mut process, "ChatGPT");
    process.wait_for_screen("> Sign in to ChatGPT");
    process.resize(SMALL_SIZE);
    process.wait_for_screen("Sign in to ChatGPT");
    process.escape();
    process.wait_for_screen("Providers");
    process.escape();
    process.quit();
    assert!(server.request_bodies().is_empty());
}

#[test]
fn actual_tui_switches_language_and_persists_it() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Screen mode");
    select_config_item(&mut process, "Language");
    process.enter();
    process.wait_for_screen("ダッシュボード");
    process.escape();
    process.quit();

    assert!(fixture.config_source().contains("language = \"ja\""));
}

#[test]
fn actual_tui_config_enables_and_disables_memory_diagnostics() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Memory diagnostics");
    select_config_item(&mut process, "Memory diagnostics");
    process.enter();
    wait_for_config(&fixture, "memoryDiagnostics = true");
    process.escape();

    process.submit("/status");
    process.wait_for_screen("Thread");
    process.tab();
    process.wait_for_screen("Memory diagnostics");
    process.wait_for_stable_screen("Recording");
    process.escape();

    process.submit("/config");
    process.wait_for_screen("Memory diagnostics");
    select_config_item(&mut process, "Memory diagnostics");
    process.enter();
    wait_for_config(&fixture, "memoryDiagnostics = false");
    process.escape();
    process.submit("/status");
    process.wait_for_screen("Thread");
    process.tab();
    process.wait_for_screen("Memory diagnostics");
    process.wait_for_stable_screen("Disabled");
    process.escape();
    process.quit();
    assert!(
        server.request_bodies().is_empty(),
        "diagnostics must not invoke a model"
    );
}

#[test]
fn actual_tui_status_line_style_persists_across_restart() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Screen mode");
    select_config_item(&mut process, "Status bar style");
    process.enter();
    process.wait_for_screen("Expressive");
    process.escape();
    process.wait_for_screen("Enter send");
    process.quit();
    assert!(
        fixture
            .config_source()
            .contains("statusLineStyle = \"rich\"")
    );

    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/config");
    process.wait_for_screen("Expressive");
    select_config_item(&mut process, "Status bar style");
    process.enter();
    process.wait_for_screen("Simple");
    process.escape();
    process.quit();
    assert!(
        fixture
            .config_source()
            .contains("statusLineStyle = \"compact\"")
    );
    assert!(server.request_bodies().is_empty());
}

fn wait_for_config(fixture: &Fixture, expected: &str) {
    let path = fixture
        .find_file("config.toml")
        .expect("the scenario config exists");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let config = fs::read_to_string(&path).unwrap_or_default();
        if config.contains(expected) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "config did not contain {expected:?}:\n{config}"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn actual_tui_marketplace_and_lsp_commands() {
    let fixture = Fixture::new()
        .with_product_services(serde_json::json!({"schemaVersion":2,"marketplaces":[]}));
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    fixture.append_config("\n[languageServers.servers.fixture-lsp]\nmode = \"disabled\"\n");
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Enter send");
    process.submit("/marketplace");
    process.wait_for_screen("No packages in this view");
    process.escape();
    process.escape();
    process.wait_for_screen("Enter send");
    process.submit("/plugins");
    process.wait_for_screen("No packages in this view");
    process.escape();
    process.escape();
    process.wait_for_screen("Enter send");
    process.submit("/lsp rust");
    process.wait_for_screen("Find language servers in Marketplace");
    process.tab();
    process.wait_for_screen("fixture-lsp");
    process.enter();
    process.wait_for_screen("Enable server");
    process.down();
    process.enter();
    wait_for_config(&fixture, "mode = \"enabled\"");
    process.wait_for_screen("Find language servers in Marketplace");
    process.escape();
    process.submit("/skills");
    process.wait_for_stable_screen("create-instructions");
    let skills_screen = process.screen();
    assert!(skills_screen.contains("Extensions"));
    assert!(skills_screen.contains("skill-creator"));
    assert!(!skills_screen.contains("[disable]"));
    assert!(!skills_screen.contains("Get skills"));
    assert!(!skills_screen.contains("built-in"));
    assert!(!skills_screen.contains("Manage"));
    process.escape();
    process.quit();
    assert!(server.request_bodies().is_empty());
}
