use crate::scenario_http::ScenarioServer;
use crate::tui_process::Fixture;
use crate::tui_process::LARGE_SIZE;
use crate::tui_process::TuiProcess;
use std::fs;
use std::process::Command;

fn prepare_repository(fixture: &Fixture) {
    fixture.install_issue_provider();
    for args in [
        vec!["init", "--quiet", "--initial-branch=main"],
        vec!["config", "user.name", "Issue Test"],
        vec!["config", "user.email", "issue@example.invalid"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["config", "core.hooksPath", "/dev/null"],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/team/repo.git",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(fixture.workspace())
                .status()
                .unwrap()
                .success()
        );
    }
    fs::write(fixture.workspace().join("tracked.txt"), "base\n").unwrap();
    assert!(
        Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(fixture.workspace())
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("git")
            .args(["commit", "--quiet", "-m", "base"])
            .current_dir(fixture.workspace())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn actual_tui_issue_browser_searches_refreshes_and_restores_cached_results() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    prepare_repository(&fixture);
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("/issue");
    process.wait_for_screen("Repair first issue");
    process.space();
    process.wait_for_screen("1 selected");
    process.tab();
    process.wait_for_screen("Previously resolved issue");
    assert!(process.screen().contains("1 selected"));
    process.back_tab();
    process.wait_for_screen("Repair first issue");
    process.down();
    process.type_text("#5001");
    process.enter();
    process.wait_for_screen("Repair issue outside loaded pages");
    let bin = fixture
        .find_file("issues.json")
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    fs::write(bin.join("issue-offline"), "offline").unwrap();
    process.type_text("r");
    process.wait_for_screen("Fixture offline");
    assert!(
        process
            .screen()
            .contains("Repair issue outside loaded pages")
    );
    fs::remove_file(bin.join("issue-offline")).unwrap();
    let mut rows: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(bin.join("issues.json")).unwrap()).unwrap();
    rows[0]["title"] = "Recovered first issue".into();
    fs::write(bin.join("issues.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
    process.type_text("/");
    process.send(b"\x15");
    process.enter();
    process.wait_for_screen("Recovered first issue");
    process.escape();
    process.quit();
    fs::write(bin.join("issue-offline"), "offline").unwrap();
    let mut reopened = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    reopened.wait_for_screen("Ash Code v");
    reopened.submit("/issue");
    reopened.wait_for_screen("Recovered first issue");
    assert!(reopened.screen().contains("Cached"));
    reopened.escape();
    reopened.quit();
    assert!(server.request_bodies().is_empty());
}

#[test]
fn actual_tui_issue_start_checks_role_dependencies_before_creating_a_session() {
    let fixture = Fixture::new();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());
    prepare_repository(&fixture);
    fs::write(fixture.workspace().join("tracked.txt"), "keep my changes\n").unwrap();
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    assert!(fixture.sessions().is_empty());
    process.submit("/issue");
    process.wait_for_screen("Repair first issue");
    process.space();
    process.down();
    process.space();
    process.wait_for_screen("2 selected");
    process.type_text("d");
    process.wait_for_screen("Agent requires unavailable Skill 'github'");
    assert!(fixture.sessions().is_empty());
    assert_eq!(
        fs::read_to_string(fixture.workspace().join("tracked.txt")).unwrap(),
        "keep my changes\n"
    );
    assert!(server.request_bodies().is_empty());
    process.escape();
    process.quit();
}
