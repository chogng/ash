use ash_app_server_protocol::protocol::config::ApprovalReviewModelSelectionDto;
use ash_app_server_protocol::protocol::config::CodebaseAutomaticContextDto;
use ash_app_server_protocol::protocol::config::CodebaseConfigDto;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_app_server_protocol::protocol::config::GrepBackendDto;
use ash_app_server_protocol::protocol::config::ToolSearchConfigDto;
use ash_app_server_protocol::protocol::config::ToolSearchEmbeddingStatusDto;
use ash_app_server_protocol::protocol::config::ToolSearchModeDto;
use std::collections::BTreeMap;
use std::fmt::Display;
use std::path::PathBuf;
#[cfg(feature = "in-process-tests")]
use std::sync::Mutex;
#[cfg(feature = "in-process-tests")]
use std::sync::MutexGuard;

#[cfg(feature = "in-process-tests")]
static IN_PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn snapshot_settings(
    module_path: &str,
    mode: Option<crate::terminal::ScreenMode>,
) -> insta::Settings {
    let category = match mode {
        Some(crate::terminal::ScreenMode::Fullscreen) => "fullscreen",
        Some(crate::terminal::ScreenMode::Inline) => "inline",
        None => "shared",
    };
    // An absolute crate path keeps expectations together regardless of the test source's location.
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("snapshots")
        .join(category);
    let mut has_owner = false;
    for module in module_path.split("::").skip(1) {
        if matches!(module, "app" | "fullscreen" | "inline" | "tests") {
            continue;
        }
        path.push(module.strip_suffix("_tests").unwrap_or(module));
        has_owner = true;
    }
    if !has_owner {
        path.push("frame");
    }
    let mut settings = insta::Settings::clone_current();
    settings.set_snapshot_path(path);
    settings.set_prepend_module_to_snapshot(false);
    settings
}

pub(crate) fn snapshot_name(name: impl Display) -> String {
    name.to_string().replace(['/', '\\'], "__")
}

pub(crate) fn snapshot_name_for_function(function_path: &str) -> String {
    let function_name = function_path.rsplit("::").next().unwrap_or(function_path);
    let function_name = function_name.strip_prefix("test_").unwrap_or(function_name);
    snapshot_name(function_name)
}

#[cfg(feature = "in-process-tests")]
pub(crate) fn in_process_test_guard() -> MutexGuard<'static, ()> {
    IN_PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn hook_catalog(
    hooks: Vec<ash_app_server_protocol::protocol::config::HookConfigDto>,
) -> ash_app_server_protocol::protocol::config::HookListResult {
    ash_app_server_protocol::protocol::config::HookListResult {
        sources: vec![ash_app_server_protocol::protocol::config::HookSourceDto {
            namespace: "user".into(),
            config_path: "/profile/config.toml".into(),
            hooks,
        }],
    }
}

pub(crate) fn empty_config_snapshot() -> ConfigReadResult {
    ConfigReadResult {
        trace: None,
        trace_recording:
            ash_app_server_protocol::protocol::config::TraceRecordingStateDto::Disabled,
        context: Default::default(),
        connections: Default::default(),
        active_connections: Default::default(),
        advisor: None,
        time_context: Default::default(),
        features: features::resolve(&Default::default()),
        revision: 0,
        generation: 0,
        model: None,
        model_reasoning_effort: None,
        approval_review_model: ApprovalReviewModelSelectionDto::Automatic,
        commit_message_model: None,
        commit_message_active_dir_authorized: false,
        issues: ash_app_server_protocol::protocol::issues::IssueConfigDto {
            auto_refresh_minutes: 10,
        },
        git: Default::default(),
        git_configured: false,
        tool_mode: ash_protocol::ToolMode::Direct,
        grep_backend: GrepBackendDto::Ripgrep,
        gui: FrontendConfigDto::default(),
        providers: BTreeMap::new(),
        mcp_servers: BTreeMap::new(),
        skill_sources: BTreeMap::new(),
        plugin_requests: BTreeMap::new(),
        hooks: BTreeMap::new(),
        language_servers: BTreeMap::new(),
        tool_search: ToolSearchConfigDto {
            mode: ToolSearchModeDto::Lexical,
            embedding_model: None,
            embedding_status: ToolSearchEmbeddingStatusDto::Disabled,
        },
        codebase: CodebaseConfigDto {
            models: None,
            automatic_context: CodebaseAutomaticContextDto::Off,
        },
        exec_policy_rules: Vec::new(),
        tui: FrontendConfigDto::default(),
    }
}

/// Scripted server acceptance for a text-only queue submission in App simulations.
pub(crate) fn queued_message(command: crate::app::AppCommand) -> ::queue::QueuedMessage {
    let crate::app::AppCommand::Thread(crate::thread::Command::Enqueue {
        command_id,
        submission,
        ..
    }) = command
    else {
        panic!("expected queue enqueue command")
    };
    let input = submission
        .input
        .into_iter()
        .map(|input| match input {
            crate::thread::composer::ChatInputItem::Context { name, content } => {
                ash_protocol::UserInput::Context { name, content }
            }
            crate::thread::composer::ChatInputItem::Text(text) => {
                ash_protocol::UserInput::Text { text }
            }
            crate::thread::composer::ChatInputItem::Attachment(attachment) => {
                ash_protocol::UserInput::ImageAttachment { attachment }
            }
            crate::thread::composer::ChatInputItem::AudioAttachment(attachment) => {
                ash_protocol::UserInput::AudioAttachment { attachment }
            }
            crate::thread::composer::ChatInputItem::Audio { url } => {
                ash_protocol::UserInput::Audio { url }
            }
            crate::thread::composer::ChatInputItem::Skill { skill } => {
                ash_protocol::UserInput::Skill { skill }
            }
            crate::thread::composer::ChatInputItem::Image { .. } => {
                panic!("image tests must provide a materialized server attachment")
            }
        })
        .collect();
    ::queue::QueuedMessage {
        request: ::queue::QueueInput {
            mode: submission.mode,
            model: None,
            reasoning_effort: None,
            command_id,
            session_id: ash_protocol::SessionId::new("session").unwrap(),
            thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
            directory: "/work".into(),
            input,
            tool_mode: Default::default(),
            approval_mode: Default::default(),
            steer_turn: None,
        },
        status: ::queue::QueueStatus::Pending,
        turn_id: None,
        error: None,
        revision: 1,
    }
}
