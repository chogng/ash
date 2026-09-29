use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Safe-point event that may request a Hook execution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HookEvent {
    PreToolUse,           // 工具：执行前
    PostToolUse,          // 工具：执行成功后
    PostToolUseFailure,   // 工具：执行失败后
    PostToolBatch,        // 工具：一批调用完成后
    PermissionDenied,     // 权限：调用被拒绝后
    Notification,         // 消息：请求已送达客户端时
    UserPromptSubmit,     // 对话：用户提交提示词时
    UserPromptExpansion,  // 对话：用户输入的命令展开为提示词时
    SessionStart,         // 会话：新会话开始时
    Stop,                 // 对话：助手正常结束回复前
    StopFailure,          // 对话：因错误结束回复时
    SubagentStart,        // 多代理：子代理启动时
    SubagentStop,         // 多代理：子代理结束时
    PreCompact,           // 上下文：压缩前
    PostCompact,          // 上下文：压缩后
    PreModelSwitch,       // 模型：请求切换前
    PostModelSwitch,      // 模型：切换完成后
    SessionEnd,           // 会话：会话结束时
    PermissionRequest,    // 权限：向用户请求授权时
    Setup,                // 项目：执行初始化设置时
    TeammateIdle,         // 多代理：队友空闲时
    TaskCreated,          // 计划：新增步骤时
    TaskCompleted,        // 计划：步骤完成时
    Elicitation,          // MCP：服务端请求用户输入时
    ElicitationResult,    // MCP：用户完成输入后
    ConfigChange,         // 配置：会话期间配置变化时
    InstructionsLoaded,   // 指令：加载指令文件时
    WorktreeCreate,       // 工作区：创建隔离工作树时
    WorktreeRemove,       // 工作区：移除隔离工作树时
    CwdChanged,           // 工作区：工作目录变化后
    FileChanged,          // 文件：受监视文件变化时
    DirectoryAdded,       // 工作区：新增工作目录后
    MessageDisplay,       // 消息：助手文本推送给客户端时
    /// Retained for declarations written before the expanded event catalog.
    BeforeTool,
    /// Retained for declarations written before the expanded event catalog.
    AfterTool,
    /// Retained for declarations written before the expanded event catalog.
    TurnCompleted,
}

impl HookEvent {
    pub const ALL: [Self; 33] = [
        Self::PreToolUse,
        Self::PostToolUse,
        Self::PostToolUseFailure,
        Self::PostToolBatch,
        Self::PermissionDenied,
        Self::Notification,
        Self::UserPromptSubmit,
        Self::UserPromptExpansion,
        Self::SessionStart,
        Self::Stop,
        Self::StopFailure,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::PreCompact,
        Self::PostCompact,
        Self::PreModelSwitch,
        Self::PostModelSwitch,
        Self::SessionEnd,
        Self::PermissionRequest,
        Self::Setup,
        Self::TeammateIdle,
        Self::TaskCreated,
        Self::TaskCompleted,
        Self::Elicitation,
        Self::ElicitationResult,
        Self::ConfigChange,
        Self::InstructionsLoaded,
        Self::WorktreeCreate,
        Self::WorktreeRemove,
        Self::CwdChanged,
        Self::FileChanged,
        Self::DirectoryAdded,
        Self::MessageDisplay,
    ];

    pub fn accepts_tool_matcher(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PostToolUse
                | Self::PostToolUseFailure
                | Self::PermissionDenied
                | Self::PermissionRequest
                | Self::BeforeTool
                | Self::AfterTool
        )
    }
}

#[cfg(test)]
#[path = "hook_tests.rs"]
mod tests;
