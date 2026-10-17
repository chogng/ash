//! CLI copy uses the terminal locale without loading a product profile during help or launch.

#[derive(Clone, Copy)]
pub(crate) enum Message {
    SecretsAbout,
    SecretsStatusHelp,
    SecretsAuthorizeHelp,
    SecretsModeHelp,
    McpLoginHelp,
    McpHttpOnly,
    McpCallbackUrl,
    McpLogoutHelp,
    McpLoginUrl,
    McpLoginCancelled,
    McpCallbackInvalid,
    McpCallbackComplete,
    AppAbout,
    Workspace,
    AppPath,
    InvalidWorkspace,
    InvalidApp,
    AppMissing,
    LaunchFailed,
    ExecModelHelp,
    ExecTimeoutHelp,
    ExecTraceHelp,
    ExecInvalidModel,
    ExecTraceFailed,
    ExecChangesHelp,
    ExecChangesFailed,
    ExecChangesUnavailable,
    UpdatePackageFailed,
    InstallFailed,
    Installed,
    InstallLauncherKept,
    InstallUnmanagedCurrent,
    InstallUnsupportedFile,
    #[cfg(windows)]
    InstallForeignLauncher,
    #[cfg(windows)]
    InstallLauncherFailed,
    InstallRecursivePath,
    UpdateSelectFailed,
    UpdateBuildMismatch,
}

pub(crate) fn text(message: Message) -> &'static str {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    localized(message, &locale)
}

pub(crate) fn format(message: Message, argument: impl AsRef<str>) -> String {
    text(message).replacen("{0}", argument.as_ref(), 1)
}

fn localized(message: Message, locale: &str) -> &'static str {
    let language = locale.split(['-', '_', '.']).next().unwrap_or_default();
    match (message, language) {
        (Message::InstallUnmanagedCurrent, "zh") => "拒绝替换非 Ash 管理的版本指针：{0}",
        (Message::InstallUnmanagedCurrent, _) => {
            "Refusing to replace an unmanaged Ash current path: {0}"
        }
        (Message::InstallUnsupportedFile, "zh") => "安装包包含链接或不支持的文件。",
        (Message::InstallUnsupportedFile, _) => "The package contains a link or unsupported file.",
        #[cfg(windows)]
        (Message::InstallForeignLauncher, "zh") => "Windows 启动器的安装绑定无效或属于其他安装。",
        #[cfg(windows)]
        (Message::InstallForeignLauncher, _) => {
            "The Windows launcher binding is invalid or belongs to another installation."
        }
        #[cfg(windows)]
        (Message::InstallLauncherFailed, "zh") => "无法启动已安装的 Ash：{0}",
        #[cfg(windows)]
        (Message::InstallLauncherFailed, _) => "Could not launch the installed Ash: {0}",
        (Message::InstallRecursivePath, "zh") => "安装和启动器路径不能位于包目录内。",
        (Message::InstallRecursivePath, _) => {
            "Installation and launcher paths must not overlap a package directory."
        }
        (Message::UpdateSelectFailed, "zh") => "无法切换 Ash 版本：{0}",
        (Message::UpdateSelectFailed, _) => "Could not select the Ash version: {0}",
        (Message::UpdateBuildMismatch, "zh") => "已安装的 Ash 包具有不同的构建标识。",
        (Message::UpdateBuildMismatch, _) => {
            "The installed Ash package has a different build identity."
        }
        (Message::InstallFailed, "zh") => "无法安装 Ash：{0}",
        (Message::InstallFailed, _) => "Could not install Ash: {0}",
        (Message::Installed, "zh") => "Ash 已安装到 {0}",
        (Message::Installed, _) => "Installed Ash at {0}",
        (Message::InstallLauncherKept, "zh") => {
            "已保留现有启动器 {0}；可直接运行安装目录中的 Ash。"
        }
        (Message::InstallLauncherKept, _) => {
            "Kept the existing launcher at {0}; run Ash from its installation directory directly."
        }
        (Message::SecretsAbout, "zh") => "管理当前配置目录的凭据存储。",
        (Message::SecretsAbout, _) => "Manage credential storage for the current profile.",
        (Message::SecretsStatusHelp, "zh") => "静默检查凭据存储并输出 JSON 状态。",
        (Message::SecretsStatusHelp, _) => {
            "Check credential storage silently and print its JSON status."
        }
        (Message::SecretsAuthorizeHelp, "zh") => {
            "主动请求系统钥匙串授权；可能显示系统密码或授权窗口。"
        }
        (Message::SecretsAuthorizeHelp, _) => {
            "Request system keyring access; may show a system password or authorization dialog."
        }
        (Message::SecretsModeHelp, "zh") => {
            "迁移并选择存储方式：encrypted 使用系统钥匙串加密；file 保存受文件权限保护的未加密凭据。"
        }
        (Message::SecretsModeHelp, _) => {
            "Migrate and select storage: encrypted uses the system keyring; file stores unencrypted credentials protected by file permissions."
        }
        (Message::McpHttpOnly, "zh") => "MCP 登录需要已配置的 HTTPS 服务器。",
        (Message::McpCallbackUrl, "zh") => "OAuth 回调地址：{0}",
        (Message::McpHttpOnly, _) => "MCP sign-in requires a configured HTTPS server.",
        (Message::McpCallbackUrl, _) => "OAuth callback URL: {0}",
        (Message::McpLoginHelp, "zh") => "通过浏览器登录独立 MCP 服务器。",
        (Message::McpLogoutHelp, "zh") => "退出独立 MCP 服务器并删除本地凭据。",
        (Message::McpLoginUrl, "zh") => "打开此网址登录：\n{0}",
        (Message::McpLoginCancelled, "zh") => "MCP 登录已取消或超时。",
        (Message::McpCallbackInvalid, "zh") => "授权回调无效。",
        (Message::McpCallbackComplete, "zh") => "授权回调已收到。可以关闭窗口并返回 Ash。",
        (Message::McpLoginHelp, _) => "Sign in to a standalone MCP server through a browser.",
        (Message::McpLogoutHelp, _) => {
            "Sign out of a standalone MCP server and delete local credentials."
        }
        (Message::McpLoginUrl, _) => "Open this URL to sign in:\n{0}",
        (Message::McpLoginCancelled, _) => "MCP sign-in was cancelled or timed out.",
        (Message::McpCallbackInvalid, _) => "The authorization callback is invalid.",
        (Message::McpCallbackComplete, _) => {
            "Authorization callback received. Close this window and return to Ash."
        }
        (Message::UpdatePackageFailed, "zh") => "无法准备更新包：{0}",
        (Message::UpdatePackageFailed, "ja") => "更新パッケージを準備できません：{0}",
        (Message::UpdatePackageFailed, "fr") => {
            "Impossible de préparer le paquet de mise à jour : {0}"
        }
        (Message::UpdatePackageFailed, _) => "Could not prepare update package: {0}",
        (Message::ExecChangesHelp, "zh") => "保存本次 Turn 的变更记录和保留的文件正文 JSON。",
        (Message::ExecChangesFailed, "zh") => "无法保存 Turn 变更：{0}",
        (Message::ExecChangesUnavailable, "zh") => {
            "本次 Turn 的文件变更尚未封存，或没有 Git 变更记录。"
        }
        (Message::ExecChangesHelp, _) => {
            "Save this Turn's change records and retained file contents as JSON."
        }
        (Message::ExecChangesFailed, _) => "Could not save Turn changes: {0}",
        (Message::ExecChangesUnavailable, _) => {
            "This Turn's file changes are not sealed or have no Git change record."
        }
        (Message::ExecModelHelp, "zh") => "本次 Turn 使用的准确 provider/model 标识。",
        (Message::ExecTimeoutHelp, "zh") => "超时前允许的执行秒数；超时后中断 Turn。",
        (Message::ExecTraceHelp, "zh") => "保存本次会话的持久执行 Trace JSON。",
        (Message::ExecInvalidModel, "zh") => "模型标识必须采用 provider/model 格式。",
        (Message::ExecTraceFailed, "zh") => "无法保存执行 Trace：{0}",
        (Message::ExecModelHelp, _) => "Exact provider/model selection for this Turn.",
        (Message::ExecTimeoutHelp, _) => "Execution time in seconds before interrupting the Turn.",
        (Message::ExecTraceHelp, _) => "Save the Session's durable execution trace as JSON.",
        (Message::ExecInvalidModel, _) => "Model selection must use provider/model format.",
        (Message::ExecTraceFailed, _) => "Could not save execution trace: {0}",
        (Message::AppAbout, "zh") => "打开 Ash 桌面应用及指定工作区。",
        (Message::Workspace, "zh") => "要打开的目录、文件或工作区文件。",
        (Message::AppPath, "zh") => "Ash 桌面可执行文件或 macOS .app 的路径。",
        (Message::InvalidWorkspace, "zh") => "无法打开工作区路径：{0}",
        (Message::InvalidApp, "zh") => "无效的 Ash 桌面应用路径：{0}",
        (Message::AppMissing, "zh") => {
            "未找到 Ash 桌面应用。请安装 Ash，或使用 --app-path 指定应用路径。"
        }
        (Message::LaunchFailed, "zh") => "无法启动 Ash 桌面应用：{0}",
        (Message::AppAbout, "ja") => "Ash デスクトップアプリで指定したワークスペースを開きます。",
        (Message::Workspace, "ja") => "開くフォルダー、ファイル、またはワークスペースファイル。",
        (Message::AppPath, "ja") => "Ash デスクトップ実行ファイルまたは macOS .app のパス。",
        (Message::InvalidWorkspace, "ja") => "ワークスペースのパスを開けません：{0}",
        (Message::InvalidApp, "ja") => "Ash デスクトップアプリのパスが無効です：{0}",
        (Message::AppMissing, "ja") => {
            "Ash デスクトップアプリが見つかりません。Ash をインストールするか、--app-path で指定してください。"
        }
        (Message::LaunchFailed, "ja") => "Ash デスクトップアプリを起動できません：{0}",
        (Message::AppAbout, "fr") => {
            "Ouvrir l’application de bureau Ash et l’espace de travail indiqué."
        }
        (Message::Workspace, "fr") => "Dossier, fichier ou fichier d’espace de travail à ouvrir.",
        (Message::AppPath, "fr") => "Chemin de l’exécutable de bureau Ash ou du .app macOS.",
        (Message::InvalidWorkspace, "fr") => {
            "Impossible d’ouvrir le chemin de l’espace de travail : {0}"
        }
        (Message::InvalidApp, "fr") => "Chemin de l’application de bureau Ash non valide : {0}",
        (Message::AppMissing, "fr") => {
            "Application de bureau Ash introuvable. Installez Ash ou indiquez son chemin avec --app-path."
        }
        (Message::LaunchFailed, "fr") => "Impossible de lancer l’application de bureau Ash : {0}",
        (Message::AppAbout, _) => "Open the Ash desktop app and the selected workspace.",
        (Message::Workspace, _) => "Folder, file, or workspace file to open.",
        (Message::AppPath, _) => "Path to the Ash desktop executable or macOS .app bundle.",
        (Message::InvalidWorkspace, _) => "Could not open workspace path: {0}",
        (Message::InvalidApp, _) => "Invalid Ash desktop app path: {0}",
        (Message::AppMissing, _) => {
            "Ash desktop app was not found. Install Ash or select its path with --app-path."
        }
        (Message::LaunchFailed, _) => "Could not launch the Ash desktop app: {0}",
    }
}

#[cfg(test)]
#[path = "nls_tests.rs"]
mod tests;
