use crate::scenario_http::Gate;
use crate::scenario_http::HttpResponse;
use crate::scenario_http::ScenarioServer;
use crate::tui_process::Fixture;
use crate::tui_process::LARGE_SIZE;
use crate::tui_process::TuiProcess;
use std::fs;
use std::process::Command;

#[test]
fn actual_tui_recalls_input_history_after_process_restart() {
    let fixture = Fixture::new();
    let server =
        ScenarioServer::start([HttpResponse::streaming(["Input saved and answered."], None)]);
    fixture.write_config(&server.base_url());
    let mut first = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    first.wait_for_stable_screen("Ash Code v");
    first.submit("Remember this input across restarts");
    first.wait_for_stable_screen("Input saved and answered.");
    first.quit();

    let mut second = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    second.wait_for_stable_screen("Ash Code v");
    second.up();
    second.wait_for_stable_screen("> Remember this input across restarts");
    second.assert_snapshot("real/14-input-history/recalled-after-restart");
    assert_eq!(server.request_count(), 1);
    second.down();
    second.send(&[0x12]);
    second.type_text("across");
    second.wait_for_stable_screen("History search: across · ↑/↓ browse");
    second.enter();
    second.wait_for_stable_screen("> Remember this input across restarts");
    assert_eq!(server.request_count(), 1);
    second.quit();
}

#[test]
fn actual_tui_runs_three_complete_conversation_turns() {
    let fixture = Fixture::new();
    let first = Gate::new();
    let second = Gate::new();
    let third = Gate::new();
    let server = ScenarioServer::start([
        HttpResponse::streaming(
            [
                "第一轮正在流式回答：",
                "Ash 已收到中文、English 与 emoji 🚀。",
            ],
            Some(first.clone()),
        ),
        HttpResponse::streaming(
            ["第二轮会引用上一轮：", "上下文仍然完整。"],
            Some(second.clone()),
        ),
        HttpResponse::streaming(
            ["第三轮最终结论：", "连续多轮对话已完成。"],
            Some(third.clone()),
        ),
    ]);
    fixture.write_config(&server.base_url());

    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Start a task below, or continue a previous session.");
    process.assert_snapshot("real/01-conversation/00-started");

    process.type_text("第一轮：请确认输入、流式输出和 Unicode 🚀");
    process.enter();
    first.wait_until_reached();
    process.wait_for_screen("第一轮正在流式回答");
    first.release();
    process.wait_for_stable_screen("Ash 已收到中文、English 与 emoji");

    process.type_text("第二轮：请明确引用上一轮上下文");
    process.enter();
    second.wait_until_reached();
    process.wait_for_screen("第二轮会引用上一轮");
    second.release();
    process.wait_for_stable_screen("上下文仍然完整");

    process.type_text("第三轮：总结前三轮是否稳定");
    process.enter();
    third.wait_until_reached();
    process.wait_for_screen("第三轮最终结论");
    third.release();
    process.wait_for_stable_screen("连续多轮对话已完成");
    process.assert_snapshot("real/01-conversation/02-third-turn-complete");

    let bodies = server.request_bodies();
    assert_eq!(bodies.len(), 3);
    assert!(bodies[1].contains("第一轮正在流式回答"));
    assert!(bodies[2].contains("第二轮会引用上一轮"));
    assert!(bodies[2].contains("第三轮：总结前三轮是否稳定"));
    process.quit();
}

#[test]
fn actual_tui_displays_git_branch_and_changes() {
    let fixture = Fixture::new();
    let initialized = Command::new("git")
        .args(["init", "--quiet", "--initial-branch=main"])
        .current_dir(fixture.workspace())
        .status()
        .unwrap();
    assert!(initialized.success());
    fs::write(fixture.workspace().join("changed.txt"), "uncommitted\n").unwrap();
    let server = ScenarioServer::start([]);
    fixture.write_config(&server.base_url());

    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_stable_screen("1 change");
    assert!(process.screen().lines().next().unwrap().contains("main"));
    process.assert_snapshot("real/08-git/00-branch-and-change");
    process.quit();
}

#[test]
fn actual_tui_queues_restores_and_completes_messages() {
    let fixture = Fixture::new();
    let first_gate = Gate::new();
    let server = ScenarioServer::start([
        HttpResponse::streaming(
            ["首轮仍在运行，队列可以编辑。", "首轮现在完成。"],
            Some(first_gate.clone()),
        ),
        HttpResponse::streaming(["队列中保留的消息已经发送。"], None),
    ]);
    fixture.write_config(&server.base_url());
    let mut process = TuiProcess::start(&fixture, &[], LARGE_SIZE);
    process.wait_for_screen("Ash Code v");
    process.submit("首轮：保持运行以便操作队列");
    first_gate.wait_until_reached();
    process.wait_for_screen("首轮仍在运行");

    process.type_text("第二条：应该保留并自动发送");
    process.enter();
    process.wait_for_screen("第二条：应该保留并自动发送");
    process.type_text("第三条：稍后恢复到输入框");
    process.enter();
    process.wait_for_screen("第三条：稍后恢复到输入框");
    process.wait_for_screen("shift+tab to cycle policy");

    process.alt_up();
    process.wait_for_screen("> Queue 2: 第三条：稍后恢复到输入框");
    process.enter();
    process.wait_for_screen("│ > 第三条：稍后恢复到输入框");

    first_gate.release();
    process.wait_for_stable_screen("队列中保留的消息已经发送");
    assert_eq!(server.request_count(), 2);
    let bodies = server.request_bodies();
    assert!(bodies[1].contains("第二条：应该保留并自动发送"));
    assert!(!bodies[1].contains("第三条：稍后恢复到输入框"));
    process.quit();
}

#[test]
fn actual_tui_approves_and_declines_real_file_tool_calls() {
    let approve_fixture = Fixture::new();
    let approve_gate = Gate::new();
    let approve_server = ScenarioServer::start([
        HttpResponse::tool_call(
            "call-approve",
            "write_file",
            serde_json::json!({
                "path": "approved-by-tui.txt",
                "content": "approved through the real TUI\n",
            }),
        ),
        HttpResponse::streaming(
            ["工具已获批准并执行。", "文件写入完成。"],
            Some(approve_gate.clone()),
        ),
    ]);
    approve_fixture.write_config(&approve_server.base_url());
    let mut approve = TuiProcess::start(&approve_fixture, &[], LARGE_SIZE);
    approve.wait_for_screen("Start a task below, or continue a previous session.");
    approve.type_text("请创建 approved-by-tui.txt");
    approve.enter();
    approve.wait_for_screen("Approval required");
    approve.assert_snapshot("real/03-approval/00-approve-request");
    approve.down();
    approve.up();
    approve.enter();
    approve_gate.wait_until_reached();
    approve.wait_for_screen("工具已获批准并执行");
    approve_gate.release();
    approve.wait_for_stable_screen("文件写入完成");
    approve.wait_for_stable_screen("ask permissions on");
    approve.assert_snapshot("real/03-approval/01-approved-final");
    approve.control_up();
    approve.up();
    approve.space();
    approve.wait_for_screen("approved through the real TUI");
    approve.assert_snapshot("real/03-approval/04-ask-permissions-details");
    let approve_bodies = approve_server.request_bodies();
    assert!(
        approve_bodies[1].contains("wrote"),
        "tool result request: {}",
        approve_bodies[1]
    );
    let approved_thread_path = approve_fixture.find_file("approved-by-tui.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(approved_thread_path).unwrap(),
        "approved through the real TUI\n"
    );
    approve.quit();

    let decline_fixture = Fixture::new();
    let decline_gate = Gate::new();
    let decline_server = ScenarioServer::start([
        HttpResponse::tool_call(
            "call-decline",
            "write_file",
            serde_json::json!({
                "path": "declined-by-tui.txt",
                "content": "this must never be written\n",
            }),
        ),
        HttpResponse::streaming(
            ["工具调用被用户拒绝。", "没有写入文件。"],
            Some(decline_gate.clone()),
        ),
    ]);
    decline_fixture.write_config(&decline_server.base_url());
    let mut decline = TuiProcess::start(&decline_fixture, &[], LARGE_SIZE);
    decline.wait_for_screen("Start a task below, or continue a previous session.");
    decline.submit("请尝试创建 declined-by-tui.txt");
    decline.wait_for_screen("Approval required");
    decline.down();
    decline.assert_snapshot("real/03-approval/02-decline-selected");
    decline.enter();
    decline_gate.wait_until_reached();
    decline.wait_for_screen("工具调用被用户拒绝");
    decline_gate.release();
    decline.wait_for_stable_screen("没有写入文件");
    decline.assert_snapshot("real/03-approval/03-declined-final");
    assert!(decline_fixture.find_file("declined-by-tui.txt").is_none());
    assert!(decline_server.request_bodies()[1].contains("declin"));
    decline.quit();
}

#[test]
fn actual_tui_approval_modes_change_file_tool_authority() {
    let auto_fixture = Fixture::new();
    let auto_gate = Gate::new();
    let auto_review = serde_json::json!({
        "recommendation": "deny",
        "reason": "the fixture automatic reviewer denied this file mutation",
    });
    let auto_server = ScenarioServer::start([
        HttpResponse::streaming(["AUTO-SETUP-DONE"], None),
        HttpResponse::tool_call(
            "call-auto-review",
            "write_file",
            serde_json::json!({
                "path": "auto-reviewed.txt",
                "content": "approved by automatic review\n",
            }),
        ),
        HttpResponse::streaming([auto_review.to_string()], None),
        HttpResponse::streaming(
            ["自动审查拒绝了工具。", "文件没有写入。"],
            Some(auto_gate.clone()),
        ),
    ]);
    auto_fixture.write_config(&auto_server.base_url());
    let mut auto = TuiProcess::start(&auto_fixture, &[], LARGE_SIZE);
    auto.wait_for_screen("Start a task below, or continue a previous session.");
    auto.submit("start a session before automatic review");
    auto.wait_for_stable_screen("AUTO-SETUP-DONE");
    auto.back_tab();
    auto.wait_for_screen("auto review on");
    auto.submit("请通过自动审查创建 auto-reviewed.txt");
    auto.wait_for_screen("自动审查拒绝了工具");
    auto_gate.wait_until_reached();
    assert!(auto_fixture.find_file("auto-reviewed.txt").is_none());
    auto.back_tab();
    auto.wait_for_screen("current: auto review on");
    auto.control_up();
    auto.up();
    auto.space();
    auto.wait_for_screen("fixture automatic reviewer denied");
    auto_gate.release();
    auto.wait_for_stable_screen("文件没有写入");
    let auto_bodies = auto_server.request_bodies();
    assert_eq!(auto_bodies.len(), 4);
    assert!(auto_bodies[2].contains("Return JSON matching this response schema"));
    assert!(auto_bodies[3].contains(r#"ash_action_policy_feedback:{\"kind\":\"denied\""#));
    auto.quit();

    let bypass_fixture = Fixture::new();
    let bypass_server = ScenarioServer::start([
        HttpResponse::streaming(["BYPASS-SETUP-DONE"], None),
        HttpResponse::tool_call(
            "call-bypass",
            "write_file",
            serde_json::json!({
                "path": "permission-bypassed.txt",
                "content": "written with permission bypass\n",
            }),
        ),
        HttpResponse::streaming(["权限确认已绕过。", "文件直接写入完成。"], None),
    ]);
    bypass_fixture.write_config(&bypass_server.base_url());
    let mut bypass = TuiProcess::start(&bypass_fixture, &[], LARGE_SIZE);
    bypass.wait_for_screen("Start a task below, or continue a previous session.");
    bypass.submit("start a session before permission bypass");
    bypass.wait_for_stable_screen("BYPASS-SETUP-DONE");
    bypass.back_tab();
    bypass.back_tab();
    bypass.wait_for_screen("bypass permissions on");
    bypass.submit("请直接创建 permission-bypassed.txt");
    bypass.wait_for_stable_screen("文件直接写入完成");
    bypass.assert_snapshot("real/03-approval/07-bypass-final");
    bypass.control_up();
    bypass.up();
    bypass.space();
    bypass.wait_for_screen("written with permission bypass");
    bypass.assert_snapshot("real/03-approval/08-bypass-details");
    let bypassed_thread_path = bypass_fixture.find_file("permission-bypassed.txt").unwrap();
    assert_eq!(
        fs::read_to_string(bypassed_thread_path).unwrap(),
        "written with permission bypass\n"
    );
    assert_eq!(bypass_server.request_count(), 3);
    assert!(bypass_server.request_bodies()[2].contains("wrote"));
    bypass.quit();
}
