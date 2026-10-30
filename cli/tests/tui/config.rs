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
    process.wait_for_screen("? for shortcuts");
    process.submit("/config");
    process.wait_for_screen("Screen mode");
    process.tab();
    select_config_item(process, label);
    process.enter();
}

#[test]
#[cfg(target_os = "macos")]
#[ignore = "requires pinned installed Codex CLI and three real five-minute subscription ticks"]
fn actual_tui_subscription_catalog_updates_open_picker_across_account_changes() {
    use crate::subscription_catalog::Account;
    use crate::subscription_catalog::Catalog;
    use ash_app_server_protocol::protocol::provider::ProviderModelsAuthorityDto;
    use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureCodeDto;
    use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
    use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
    use std::time::Duration;

    fn belongs_to(update: &ProviderModelsUpdated, account: Account) -> bool {
        update.connection == "chatgpt-subscription"
            && matches!(&update.authority, ProviderModelsAuthorityDto::Subscription {
                account_id, organization: Some(organization), plan: Some(plan),
            } if account_id == account.id() && organization == account.id() && plan == "plus")
    }

    fn has_model(update: &ProviderModelsUpdated, name: &str) -> bool {
        matches!(&update.result, ProviderModelsListResult::Models { models }
            if models.len() == 1 && models[0].display_name == name)
    }

    fn failed(update: &ProviderModelsUpdated) -> bool {
        matches!(&update.result, ProviderModelsListResult::Failed { failure }
            if failure.code == ProviderModelsListFailureCodeDto::InvalidResponse)
    }

    fn expect_effort(process: &mut TuiProcess, name: &str, effort: &str) {
        process.wait_for_stable_screen(name);
        let screen = process.screen();
        let row = screen.lines().find(|line| line.contains(name)).unwrap();
        assert!(row.contains('>'), "model focus was lost: {row}");
        assert!(row.contains(effort), "expected {effort}: {row}");
        assert!(screen.contains("│ TUI catalog "), "search query was lost");
        assert!(screen.contains("─ Model ─"), "model picker closed");
    }

    let fixture = Fixture::new().with_isolated_home();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    let mut cache = Catalog::new(fixture.codex_home());
    cache.set_model("gpt-6.1-sol", "TUI catalog initial", "medium");
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    let mut observer = fixture.connect();
    let events = observer.take_events().unwrap();
    let mut client = observer.client();
    cache.switch_account(Account::A);
    client.read_accounts().unwrap();
    cache.wait_for(&events, Duration::from_secs(90), |update| {
        belongs_to(update, Account::A) && has_model(update, "TUI catalog initial")
    });
    let account_a = client.read_accounts().unwrap();
    assert_eq!(
        account_a
            .accounts
            .iter()
            .map(|account| account.account_id.as_str())
            .collect::<Vec<_>>(),
        vec![Account::A.id()]
    );
    let config = client.read_config().unwrap();
    process.submit("/model");
    process.wait_for_screen("Search models");
    select_config_item(&mut process, "TUI catalog");
    expect_effort(&mut process, "TUI catalog initial", "Medium");
    process.right();
    expect_effort(&mut process, "TUI catalog initial", "Low");
    process.left();
    expect_effort(&mut process, "TUI catalog initial", "Medium");
    println!("Initial open picker:\n{}", process.screen());

    cache.set_model("gpt-6.1-sol", "TUI catalog updated", "high");
    println!("Waiting for metadata at the normal five-minute observer tick.");
    cache.wait_for(&events, Duration::from_secs(370), |update| {
        belongs_to(update, Account::A) && has_model(update, "TUI catalog updated")
    });
    expect_effort(&mut process, "TUI catalog updated", "High");
    assert!(!process.screen().contains("TUI catalog initial"));
    process.right();
    expect_effort(&mut process, "TUI catalog updated", "Low");
    process.right();
    expect_effort(&mut process, "TUI catalog updated", "High");
    let updated = client.list_models().unwrap();
    let metadata = updated
        .models
        .iter()
        .find(|entry| entry.display_name == "TUI catalog updated")
        .unwrap()
        .clone();
    assert_eq!(
        metadata.default_reasoning_effort,
        Some(ash_protocol::ReasoningEffort::High)
    );
    assert_eq!(
        metadata
            .supported_reasoning_efforts
            .iter()
            .map(|option| option.effort)
            .collect::<Vec<_>>(),
        vec![
            ash_protocol::ReasoningEffort::Low,
            ash_protocol::ReasoningEffort::High
        ]
    );
    assert_eq!(client.read_accounts().unwrap(), account_a);
    println!("Updated open picker:\n{}", process.screen());

    // The real CLI returns this row, then the Ash ModelId boundary rejects its whitespace slug.
    cache.set_model(" ", "TUI catalog invalid", "high");
    println!("Waiting for invalidResponse at the next normal five-minute tick.");
    cache.wait_for(&events, Duration::from_secs(370), |update| {
        belongs_to(update, Account::A) && failed(update)
    });
    expect_effort(&mut process, "TUI catalog updated", "High");
    process.left();
    expect_effort(&mut process, "TUI catalog updated", "Low");
    process.right();
    expect_effort(&mut process, "TUI catalog updated", "High");
    assert_eq!(
        client
            .list_models()
            .unwrap()
            .models
            .iter()
            .find(|entry| entry.display_name == "TUI catalog updated"),
        Some(&metadata)
    );
    assert_eq!(client.read_accounts().unwrap(), account_a);
    println!(
        "Same-account failure retained picker:\n{}",
        process.screen()
    );

    // A new identity with failed discovery must retire A, rather than apply A's failure-retention rule.
    cache.switch_account(Account::B);
    cache.wait_for(&events, Duration::from_secs(90), |update| {
        belongs_to(update, Account::B) && failed(update)
    });
    process.wait_for_screen_to_omit("TUI catalog updated");
    assert!(process.screen().contains("─ Model ─"));
    assert!(
        !client
            .list_models()
            .unwrap()
            .models
            .iter()
            .any(|entry| entry.display_name.starts_with("TUI catalog"))
    );
    let account_b = client.read_accounts().unwrap();
    assert_ne!(account_a, account_b);
    assert_eq!(
        account_b
            .accounts
            .iter()
            .map(|account| account.account_id.as_str())
            .collect::<Vec<_>>(),
        vec![Account::B.id()]
    );
    println!(
        "New identity failure retired old catalog:\n{}",
        process.screen()
    );

    cache.set_model("gpt-6-astra", "TUI catalog account B", "medium");
    println!("Waiting for B's catalog at the next normal five-minute tick.");
    cache.wait_for(&events, Duration::from_secs(370), |update| {
        belongs_to(update, Account::B) && has_model(update, "TUI catalog account B")
    });
    expect_effort(&mut process, "TUI catalog account B", "Medium");
    assert!(!process.screen().contains("TUI catalog updated"));
    process.right();
    expect_effort(&mut process, "TUI catalog account B", "Low");
    process.right();
    expect_effort(&mut process, "TUI catalog account B", "Medium");
    let final_config = client.read_config().unwrap();
    assert_eq!(
        (
            final_config.revision,
            final_config.model,
            final_config.model_reasoning_effort,
            final_config.gui,
            final_config.tui
        ),
        (
            config.revision,
            config.model,
            config.model_reasoning_effort,
            config.gui,
            config.tui
        )
    );
    assert_eq!(client.read_accounts().unwrap(), account_b);
    assert!(
        server.request_bodies().is_empty(),
        "viewing model choices must not start a Turn"
    );
    println!("Account B open picker:\n{}", process.screen());
    process.assert_snapshot("subscription_catalog_open_picker_account_b");
    process.escape();
    process.quit();
    observer.shutdown().unwrap();
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
    process.tab();
    process.tab();
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
    reopened.tab();
    reopened.tab();
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
    process.escape();
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
    process.wait_for_screen("? for shortcuts");
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
fn actual_tui_extensions_and_lsp_commands() {
    let fixture = Fixture::new()
        .with_product_services(serde_json::json!({"schemaVersion":3,"extensionSources":[]}));
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    fixture.append_config("\n[languageServers.servers.fixture-lsp]\nmode = \"disabled\"\n");
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("? for shortcuts");
    process.submit("/extensions");
    process.wait_for_screen("No packages in this view");
    process.escape();
    process.escape();
    process.wait_for_screen("? for shortcuts");
    process.submit("/plugins");
    process.wait_for_screen("No packages in this view");
    process.escape();
    process.escape();
    process.wait_for_screen("? for shortcuts");
    process.submit("/lsp rust");
    process.wait_for_screen("Find language servers in Extensions");
    process.tab();
    process.wait_for_screen("fixture-lsp");
    process.enter();
    process.wait_for_screen("Enable server");
    process.down();
    process.enter();
    wait_for_config(&fixture, "mode = \"enabled\"");
    process.wait_for_screen("Find language servers in Extensions");
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
