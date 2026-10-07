//! CLI copy uses the terminal locale without loading a product profile during help or launch.

#[derive(Clone, Copy)]
pub(crate) enum Message {
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
    ExecInvalidTrace,
    ExecChangesHelp,
    ExecChangesFailed,
    ExecChangesUnavailable,
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
        (Message::ExecInvalidTrace, "zh") => "执行 Trace 的数据格式无效。",
        (Message::ExecModelHelp, _) => "Exact provider/model selection for this Turn.",
        (Message::ExecTimeoutHelp, _) => "Execution time in seconds before interrupting the Turn.",
        (Message::ExecTraceHelp, _) => "Save the Session's durable execution trace as JSON.",
        (Message::ExecInvalidModel, _) => "Model selection must use provider/model format.",
        (Message::ExecTraceFailed, _) => "Could not save execution trace: {0}",
        (Message::ExecInvalidTrace, _) => "Invalid execution trace data.",
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
